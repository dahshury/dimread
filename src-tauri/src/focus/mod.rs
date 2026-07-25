//! Focus tab engine (FEATURE-PARITY F8) — the two mutually-exclusive full-screen
//! tint surfaces hosted by the `focus-overlay` window:
//!
//!   * [`read`] — **Focus Read** (F8.1): a horizontal clear band that tracks the
//!     cursor while the rest of the screen is dimmed. Owned by the focus-read
//!     slice.
//!   * [`blur`] — **Focus Blur** (F8.2): dim/tint every background window while
//!     the active window stays highlighted (Hazeover-style). Owned by the
//!     focus-blur slice.
//!
//! ## Stable seam (frozen — do not reshape)
//! - [`init`] — capture the [`AppHandle`] and initialise both sub-engines. Wired
//!   from `lib.rs` setup as `crate::focus::init(&app_handle)`.
//! - [`read::toggle`] / [`read::is_active`] / [`read::start`] / [`read::stop`]
//! - [`blur::toggle`] / [`blur::is_active`] / [`blur::start`] / [`blur::stop`]
//! - Commands [`focus_read_toggle`] / [`focus_blur_toggle`] / [`focus_active_state`].
//! - Event `focus:state` ([`crate::events::FocusStateEvent`]) is emitted on every
//!   activation change so the `focus-overlay` renderer knows which mode to draw;
//!   `focus:cursor` (Read active) and `focus:anchor` (Blur active) carry the
//!   per-frame geometry.
//!
//! Read and Blur are mutually exclusive: starting one stops the other (they
//! share the single `focus-overlay` tint window). This is enforced in
//! [`read::start`] / [`blur::start`] so a single seam call keeps the invariant.
//!
//! All the runtime machinery (the mouse-hook tracker for Read, the
//! foreground-window tracker for Blur, the actual overlay show/hide) is
//! implemented by the phase-2 slices; the foundation ships no-op-safe flag
//! tracking + the event emit so an un-wired build is inert rather than wrong.

pub mod blur;
pub mod read;

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event as _;

use crate::events::FocusStateEvent;

/// `AppHandle` captured by [`init`] — used by the sub-engines to show/hide the
/// `focus-overlay` window and emit events from a background context.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Combined Focus activation state — the `focus_active_state` return value and
/// the `focus:state` event payload.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    /// Focus Read (clear band) is active.
    pub read: bool,
    /// Focus Blur (background dim) is active.
    pub blur: bool,
}

/// Capture the app handle and initialise both sub-engines. Idempotent.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    read::init(app);
    blur::init(app);
}

/// The captured app handle, if [`init`] has run. Exposed for the phase-2 slices
/// (overlay show/hide, background emits).
pub fn app() -> Option<AppHandle> {
    APP.get().cloned()
}

/// Snapshot the combined activation state.
pub fn state() -> FocusState {
    FocusState {
        read: read::is_active(),
        blur: blur::is_active(),
    }
}

/// Broadcast the combined activation state on `focus:state`. Safe before
/// [`init`] (no-op when no handle is captured yet).
pub(crate) fn emit_state() {
    if let Some(app) = APP.get()
        && let Err(err) = FocusStateEvent(state()).emit(app)
    {
        log::warn!("[focus] failed to emit focus:state: {err}");
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// `focus_read_toggle` — flip Focus Read; returns the new active state.
#[tauri::command]
#[specta::specta]
pub fn focus_read_toggle() -> bool {
    read::toggle()
}

/// `focus_blur_toggle` — flip Focus Blur; returns the new active state.
#[tauri::command]
#[specta::specta]
pub fn focus_blur_toggle() -> bool {
    blur::toggle()
}

/// `focus_active_state` — the current `{ read, blur }` activation.
#[tauri::command]
#[specta::specta]
pub fn focus_active_state() -> FocusState {
    state()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Read and Blur share process-global activation flags, so the toggle tests
    /// run under one lock (the crate's test binary runs tests in parallel).
    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn toggle_and_mutual_exclusion() {
        let _guard = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        read::stop();
        blur::stop();

        assert!(read::toggle());
        assert_eq!(
            state(),
            FocusState {
                read: true,
                blur: false
            }
        );
        // Turning Blur on releases Read (they share the overlay).
        assert!(blur::toggle());
        assert_eq!(
            state(),
            FocusState {
                read: false,
                blur: true
            }
        );
        // Toggling Blur off clears everything.
        assert!(!blur::toggle());
        assert_eq!(state(), FocusState::default());
    }
}
