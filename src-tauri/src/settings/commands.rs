//! Settings IPC: `settings_load_snapshot` + `settings_save(patch, revision)`.
//!
//! Optimistic concurrency: every snapshot carries the monotonic revision it was
//! read at; a save based on a stale revision is REJECTED (the caller re-reads,
//! rebases its patch, and retries) instead of silently overwriting a newer
//! write from another window. After a successful durable write the full
//! authoritative snapshot is broadcast to ALL windows via `settings:changed`.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use super::{AppSettings, PartialSettings, merge_patch, store};
use crate::events::SettingsChangedEvent;

/// The authoritative settings snapshot: the tree plus the revision it was
/// read/written at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub revision: u32,
    pub settings: AppSettings,
}

/// Read the current settings tree with its revision.
#[tauri::command]
#[specta::specta]
pub fn settings_load_snapshot(app: AppHandle) -> SettingsSnapshot {
    let (revision, settings) = store::read_settings_snapshot(&app);
    SettingsSnapshot { revision, settings }
}

/// Replace the complete tree for import/reset flows, reconcile native side
/// effects, and broadcast the authoritative snapshot.
pub(crate) fn replace_settings(
    app: &AppHandle,
    mut next: AppSettings,
) -> Result<SettingsSnapshot, String> {
    super::normalize_settings(&mut next);
    store::with_settings_write_lock(|| {
        let (_, previous) = store::read_settings_snapshot(app);
        commit_locked(app, previous, next, |_| {})
    })
}

fn apply_runtime_side_effects(app: &AppHandle, previous: &AppSettings, next: &AppSettings) {
    if previous.general.autostart != next.general.autostart {
        sync_autostart(app, next.general.autostart);
    }
    if previous.hotkeys != next.hotkeys {
        crate::hotkeys::apply_hotkey_settings(app, &next.hotkeys);
    }
}

fn broadcast_snapshot(app: &AppHandle, snapshot: &SettingsSnapshot) {
    if let Err(err) = (SettingsChangedEvent {
        revision: snapshot.revision,
        settings: snapshot.settings.clone(),
    })
    .emit(app)
    {
        log::warn!("[settings] failed to broadcast settings:changed: {err}");
    }
}

/// Finish one canonical commit while the settings write lock is held. Native
/// effects and the event are kept in the same serialized span as persistence,
/// so an older commit can never run after or broadcast after a newer one.
fn commit_locked(
    app: &AppHandle,
    previous: AppSettings,
    next: AppSettings,
    effect: impl FnOnce(&SettingsSnapshot),
) -> Result<SettingsSnapshot, String> {
    if next == previous {
        let (revision, settings) = store::read_settings_snapshot(app);
        return Ok(SettingsSnapshot { revision, settings });
    }

    store::write_settings_value(app, &next)?;
    let (revision, settings) = store::read_settings_snapshot(app);
    let snapshot = SettingsSnapshot { revision, settings };
    apply_runtime_side_effects(app, &previous, &snapshot.settings);
    effect(&snapshot);
    broadcast_snapshot(app, &snapshot);
    Ok(snapshot)
}

/// Read → mutate → durably write the settings tree under the write lock, then
/// broadcast `settings:changed`.
///
/// This is the path for edits that originate as INTENT rather than state — a
/// caller says "set this one field", and the read-modify-write happens here
/// against the authoritative tree. Contrast [`settings_save`], which takes a
/// whole section from a renderer's own copy: that is safe only for the settings
/// window (one editor, one section at a time), and is precisely what let two
/// display surfaces overwrite each other's work. Anything with concurrent
/// editors should come through here instead.
///
/// No revision is involved because there is nothing to conflict ON: the caller
/// never held a copy to go stale.
///
/// Returns the authoritative post-write snapshot. Callers exposed as commands
/// must hand this back to the renderer rather than relying on the
/// `settings:changed` broadcast alone: the broadcast is delivered
/// asynchronously, so a renderer that drops its optimistic value the moment the
/// command resolves renders a frame (or more) of the PRE-edit value first — the
/// slider snapping back on release before jumping to the committed value.
pub(crate) fn mutate_settings(
    app: &AppHandle,
    mutate: impl FnOnce(&mut AppSettings),
) -> Result<SettingsSnapshot, String> {
    store::with_settings_write_lock(|| {
        let (_, previous) = store::read_settings_snapshot(app);
        let mut next = previous.clone();
        mutate(&mut next);
        super::normalize_settings(&mut next);
        commit_locked(app, previous, next, |_| {})
    })
}

/// Conditionally mutate settings and run an additional native effect before
/// the ordered `settings:changed` broadcast. `None` means the mutator reported
/// no intent to change the tree. The effect runs only when normalization leaves
/// an actual canonical change.
pub(crate) fn mutate_settings_with_effect(
    app: &AppHandle,
    mutate: impl FnOnce(&mut AppSettings) -> bool,
    effect: impl FnOnce(&SettingsSnapshot),
) -> Result<Option<SettingsSnapshot>, String> {
    store::with_settings_write_lock(|| {
        let (_, previous) = store::read_settings_snapshot(app);
        let mut next = previous.clone();
        if !mutate(&mut next) {
            return Ok(None);
        }
        super::normalize_settings(&mut next);
        let changed = next != previous;
        let snapshot = commit_locked(app, previous, next, |snapshot| {
            if changed {
                effect(snapshot);
            }
        })?;
        Ok(Some(snapshot))
    })
}

/// Apply a section-granular patch on top of revision `revision`.
///
/// Errors with a "settings revision conflict" message when `revision` is no
/// longer current; succeeds with the NEW snapshot otherwise. Runtime
/// side-effects (autostart registration) and the `settings:changed` broadcast
/// run AFTER the write lock is released.
#[tauri::command]
#[specta::specta]
pub fn settings_save(
    app: AppHandle,
    patch: PartialSettings,
    revision: u32,
) -> Result<SettingsSnapshot, String> {
    store::with_settings_write_lock(|| {
        let (actual, previous) = store::read_settings_snapshot(&app);
        if revision != actual {
            return Err(format!(
                "settings revision conflict: expected {revision}, current {actual}"
            ));
        }
        let next = merge_patch(&previous, patch);
        commit_locked(&app, previous, next, |_| {})
    })
}

/// Reconcile the OS launch-at-login registration with the persisted setting.
/// Called on save (when the flag flips) and once at startup so a registry/plist
/// wiped by the OS or another tool converges back to the stored intent.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        let result = if enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        if let Err(err) = result {
            log::warn!("[autostart] failed to set launch-at-login = {enabled}: {err}");
            crate::diagnostics::record_issue(
                "startup",
                "autostart",
                "Start-on-login registration failed",
                err.to_string(),
            );
        } else {
            log::debug!("[autostart] launch-at-login = {enabled}");
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
    }
}
