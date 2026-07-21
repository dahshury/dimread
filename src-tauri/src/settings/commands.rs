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
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub revision: u32,
    pub settings: AppSettings,
}

/// Read the current settings tree with its revision.
#[tauri::command]
#[specta::specta]
pub fn settings_load_snapshot(app: AppHandle) -> SettingsSnapshot {
    SettingsSnapshot {
        revision: store::settings_revision(),
        settings: store::read_settings(&app),
    }
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
    let next = store::with_settings_write_lock(|| {
        let mut settings = store::read_settings(app);
        mutate(&mut settings);
        super::normalize_settings(&mut settings);
        store::write_settings_value(app, &settings)?;
        Ok::<_, String>(settings)
    })?;

    let snapshot = SettingsSnapshot {
        revision: store::settings_revision(),
        settings: next,
    };
    if let Err(err) = (SettingsChangedEvent {
        revision: snapshot.revision,
        settings: snapshot.settings.clone(),
    })
    .emit(app)
    {
        log::warn!("[settings] failed to broadcast settings:changed: {err}");
    }
    Ok(snapshot)
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
    let (previous, next, new_revision) = store::with_settings_write_lock(|| {
        let actual = store::settings_revision();
        if revision != actual {
            return Err(format!(
                "settings revision conflict: expected {revision}, current {actual}"
            ));
        }
        let previous = store::read_settings(&app);
        let next = merge_patch(&previous, patch);
        if next == previous {
            // No-op save: skip the disk write, keep the revision stable.
            return Ok((previous, next, actual));
        }
        store::write_settings_value(&app, &next)?;
        Ok((previous, next, store::settings_revision()))
    })?;

    if previous.general.autostart != next.general.autostart {
        sync_autostart(&app, next.general.autostart);
    }
    // Hot-swap global hotkeys the moment the section changes — no restart.
    // Failures are logged inside (a bad persisted combo must not fail the
    // save that is correcting it).
    if previous.hotkeys != next.hotkeys {
        crate::hotkeys::apply_hotkey_settings(&app, &next.hotkeys);
    }

    let snapshot = SettingsSnapshot {
        revision: new_revision,
        settings: next,
    };
    if let Err(err) = (SettingsChangedEvent {
        revision: snapshot.revision,
        settings: snapshot.settings.clone(),
    })
    .emit(&app)
    {
        log::warn!("[settings] failed to broadcast settings:changed: {err}");
    }
    Ok(snapshot)
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
        } else {
            log::debug!("[autostart] launch-at-login = {enabled}");
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
    }
}
