//! Unclean-shutdown recovery — "nothing DimRead does outlives DimRead".
//!
//! Almost everything the app applies dies with the process: overlays, the magic
//! toolbar, the tray icon and flyout, global hotkeys, the focus windows. Two
//! effects do NOT, because they live in state owned by something else:
//!
//!   * the per-monitor **gamma ramp**, which lives in the OS/compositor display
//!     pipeline — a force-kill can leave the screen dimmed, tinted, or (Editing
//!     mode) inverted with no app left to fix it, and
//!   * the **taskbar accent policy**, which lives on Explorer's `Shell_TrayWnd`.
//!
//! Both are undone at exit from an in-memory snapshot of the pre-DimRead state
//! ([`crate::display::engine`]'s `originals`, `magicx::theme::ORIGINAL_ACCENT`).
//! A kill destroys those snapshots, so the graceful path never runs and the
//! effect is stranded. Worse, `display::engine::init` snapshots whatever ramp is
//! already on the device at boot, so a run that died dirty gets its own tint
//! laundered into the next run's "original" — permanently baking in the dimming,
//! a little more with every crash.
//!
//! This module mirrors those two snapshots to a small JSON journal beside the
//! settings file. The journal exists for exactly as long as the process may have
//! system state applied: it is written once the engine has captured the
//! originals, and DELETED by the graceful teardown ([`crate::app_exit`]).
//! Therefore **finding a journal at boot means the previous run did not clean
//! up** — and it carries the state needed to put the system back.
//!
//! Recovery runs before the engine takes its own snapshot, so the restored
//! (true) originals are what the new run captures.
//!
//! Note the residual gap this cannot close: between a force-kill and the next
//! launch the ramp stays applied, because no code of ours is running to undo it.
//! Repair-on-next-boot is the best a single process can do; closing that window
//! entirely would need a separate watchdog process.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::display::gamma::GammaRamp;

/// Journal file name, written beside `dimread-settings.json`.
pub const JOURNAL_FILE: &str = "dimread-session-guard.json";

/// The resolved absolute journal path, captured at [`init`] so the panic hook
/// and the exit teardown can reach it without an `AppHandle`.
static JOURNAL_PATH: OnceLock<PathBuf> = OnceLock::new();

/// The journal as it should exist on disk. Kept in memory so a later update
/// (e.g. the taskbar accent captured minutes after boot) rewrites the whole
/// file without re-reading it.
static JOURNAL: Mutex<SessionJournal> = Mutex::new(SessionJournal::empty());

/// What the previous run left applied, and what is needed to undo it.
///
/// Every field is `#[serde(default)]` so a truncated or older journal still
/// parses and recovers whatever it does carry.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournal {
    /// Pre-DimRead gamma ramp per durable native display id, flattened to 768
    /// `u16`s (R then G then B, 256 entries each).
    #[serde(default)]
    pub gamma_originals: BTreeMap<String, Vec<u16>>,
    /// Pre-override taskbar accent policy as its four raw `u32` fields
    /// (`accent_state`, `accent_flags`, `gradient_color`, `animation_id`).
    /// `None` when the taskbar effect was never engaged (or could not be read).
    #[serde(default)]
    pub taskbar_accent: Option<[u32; 4]>,
}

impl SessionJournal {
    /// `const` empty value so the static can be initialized without a lazy lock.
    const fn empty() -> Self {
        Self {
            gamma_originals: BTreeMap::new(),
            taskbar_accent: None,
        }
    }

    fn is_empty(&self) -> bool {
        self.gamma_originals.is_empty() && self.taskbar_accent.is_none()
    }
}

/// Flatten a `[[u16; 256]; 3]` ramp for storage.
fn flatten(ramp: &GammaRamp) -> Vec<u16> {
    let mut flat = Vec::with_capacity(768);
    for channel in ramp {
        flat.extend_from_slice(channel);
    }
    flat
}

/// Rebuild a ramp from its flat form. `None` unless the length is exactly 768,
/// so a truncated journal is ignored rather than producing a half-black ramp.
fn unflatten(flat: &[u16]) -> Option<GammaRamp> {
    if flat.len() != 768 {
        return None;
    }
    let mut ramp: GammaRamp = [[0u16; 256]; 3];
    for (channel, chunk) in ramp.iter_mut().zip(flat.chunks_exact(256)) {
        channel.copy_from_slice(chunk);
    }
    Some(ramp)
}

fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Resolve the journal path (next to the settings file) and read whatever the
/// previous run left behind. Returns `Some` only when a journal was present,
/// i.e. when the previous run did NOT shut down cleanly.
///
/// Call once, from the tauri setup hook, AFTER `settings::store` has resolved
/// the data directory and BEFORE `display::engine::init`.
pub fn init(app: &tauri::AppHandle) -> Option<SessionJournal> {
    let path = crate::settings::store::data_file_path(app, JOURNAL_FILE);
    let _ = JOURNAL_PATH.set(path.clone());

    let stale = read_journal(&path)?;
    log::warn!(
        "[session-guard] previous run did not shut down cleanly ({} monitor ramp(s){}) - repairing",
        stale.gamma_originals.len(),
        if stale.taskbar_accent.is_some() {
            ", taskbar accent"
        } else {
            ""
        },
    );
    Some(stale)
}

fn read_journal(path: &Path) -> Option<SessionJournal> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<SessionJournal>(&text) {
        Ok(journal) => Some(journal),
        Err(err) => {
            // A corrupt journal still proves the previous run died dirty, but we
            // have no originals to restore from. Report an empty journal so the
            // caller falls back to the identity ramp rather than trusting the
            // (possibly tinted) ramp currently on the device.
            log::warn!(
                "[session-guard] journal at {} is unreadable ({err}); falling back to the identity ramp",
                path.display()
            );
            Some(SessionJournal::default())
        }
    }
}

/// The gamma ramp to restore for `device`, if the journal carries one.
pub fn recover_ramp(journal: &SessionJournal, device: &str) -> Option<GammaRamp> {
    journal
        .gamma_originals
        .get(device)
        .map(Vec::as_slice)
        .and_then(unflatten)
}

/// Record the pre-DimRead gamma ramps. Called by the engine once it has
/// captured (or repaired) the true originals, which is also the moment the
/// process starts being able to strand a filter on the display.
pub fn record_gamma_originals(originals: &BTreeMap<String, GammaRamp>) {
    update(|journal| {
        journal.gamma_originals = originals
            .iter()
            .map(|(device, ramp)| (device.clone(), flatten(ramp)))
            .collect();
    });
}

/// Record the pre-override taskbar accent policy, captured on the off→on edge.
pub fn record_taskbar_accent(policy: [u32; 4]) {
    update(|journal| journal.taskbar_accent = Some(policy));
}

/// Apply `mutate` to the in-memory journal and rewrite the file.
fn update(mutate: impl FnOnce(&mut SessionJournal)) {
    let snapshot = {
        let mut journal = lock_recover(&JOURNAL);
        mutate(&mut journal);
        journal.clone()
    };
    let Some(path) = JOURNAL_PATH.get() else {
        // `init` never ran (unit tests, or a boot that failed before setup) —
        // nothing to persist to.
        return;
    };
    if snapshot.is_empty() {
        if let Err(err) = std::fs::remove_file(path)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            log::warn!(
                "[session-guard] failed to remove now-empty journal {}: {err}",
                path.display()
            );
        }
        return;
    }
    if let Err(err) = write_journal(path, &snapshot) {
        log::warn!("[session-guard] failed to write {}: {err}", path.display());
    }
}

/// Atomic write (temp file + rename) so a kill mid-write can never leave a
/// half-written journal that would be mistaken for a real snapshot.
fn write_journal(path: &Path, journal: &SessionJournal) -> std::io::Result<()> {
    let text = serde_json::to_string(journal)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, path)
}

/// Drop the journal — the system state has been put back, so a journal found by
/// the next boot would be a false "we died dirty" report.
///
/// This is the LAST step of the graceful teardown: it must not run before the
/// ramps and the taskbar have actually been restored, or a kill in the gap
/// would strand them with no record of how to undo it.
pub fn clear() {
    *lock_recover(&JOURNAL) = SessionJournal::default();
    let Some(path) = JOURNAL_PATH.get() else {
        return;
    };
    match std::fs::remove_file(path) {
        Ok(()) => log::debug!("[session-guard] clean shutdown - journal cleared"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::warn!("[session-guard] failed to clear {}: {err}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp_with(value: u16) -> GammaRamp {
        [[value; 256]; 3]
    }

    #[test]
    fn flatten_round_trips_through_unflatten() {
        let mut ramp = ramp_with(0);
        ramp[0][0] = 7;
        ramp[1][255] = 65535;
        ramp[2][128] = 300;
        let restored = unflatten(&flatten(&ramp)).expect("768 entries should rebuild");
        assert_eq!(restored, ramp);
    }

    #[test]
    fn unflatten_rejects_a_truncated_ramp() {
        // A short journal must be ignored, not padded with zeros — a zero-filled
        // ramp is a BLACK screen, far worse than the tint we are repairing.
        assert!(unflatten(&[0u16; 767]).is_none());
        assert!(unflatten(&[]).is_none());
        assert!(unflatten(&[0u16; 769]).is_none());
    }

    #[test]
    fn journal_round_trips_through_json() {
        let mut originals = BTreeMap::new();
        originals.insert(r"\\.\DISPLAY1".to_string(), ramp_with(11));
        originals.insert(r"\\.\DISPLAY2".to_string(), ramp_with(22));

        let journal = SessionJournal {
            gamma_originals: originals
                .iter()
                .map(|(device, ramp)| (device.clone(), flatten(ramp)))
                .collect(),
            taskbar_accent: Some([2, 0, 0, 0]),
        };

        let text = serde_json::to_string(&journal).expect("serializes");
        let parsed: SessionJournal = serde_json::from_str(&text).expect("parses");
        assert_eq!(parsed, journal);
        assert_eq!(
            recover_ramp(&parsed, r"\\.\DISPLAY1"),
            Some(ramp_with(11)),
            "the recorded ramp should come back verbatim"
        );
        assert_eq!(recover_ramp(&parsed, r"\\.\DISPLAY3"), None);
    }

    #[test]
    fn a_partial_journal_still_parses() {
        // Older/truncated journals must not fail the whole recovery.
        let parsed: SessionJournal =
            serde_json::from_str(r#"{"gammaOriginals":{}}"#).expect("parses");
        assert!(parsed.taskbar_accent.is_none());
        assert!(parsed.gamma_originals.is_empty());
    }
}
