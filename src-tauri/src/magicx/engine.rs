//! Per-window MagicX effects (FEATURE-PARITY F9.1) — apply a **Dark**
//! (colour-invert) or **Gray** (grayscale) effect to any single window, keyed by
//! its `HWND`.
//!
//! ## Seam (frozen)
//! - [`toggle_effect`]`(hwnd, effect)` — toggle Dark or Gray on one window. Dark
//!   and Gray are **mutually exclusive** per target: switching from one to the
//!   other replaces it; toggling the active effect again clears it.
//! - [`clear`]`(hwnd)` — remove the effect from one window.
//! - [`clear_all`]`()` — remove every window's effect (app exit / feature off).
//! - [`state_of`]`(hwnd) -> (dark, gray)` — the window's current effect flags
//!   (at most one is ever `true`).
//!
//! ## Implementation (F9.1)
//! This module keeps the authoritative in-memory `HWND -> Effect` map (so the
//! command + toolbar wiring and [`state_of`] stay coherent) and forwards each
//! mutation to a platform backend:
//!
//! - On Windows the backend is a dedicated thread (`engine_win.rs`) that hosts
//!   one **Windowed Magnification API** overlay per target: a layered,
//!   click-through host window pinned over the target's DWM frame bounds, with a
//!   `WC_MAGNIFIER` child at 1.0× carrying an invert / luminance colour matrix.
//!   The thread runs a message pump + refresh loop, tracks each target's rect and
//!   z-order, hides while minimized, and auto-clears when the target dies.
//! - Off-Windows (and under `cfg(test)`) the backend is an inert no-op, so state
//!   bookkeeping stays deterministic and the crate builds on every platform.
//!
//! If the Magnification runtime or a host window fails to initialise the backend
//! logs once and every seam call degrades to a graceful no-op (the state map is
//! still tracked so the UI reflects intent).

use std::collections::HashMap;
use std::sync::Mutex;

use super::Hwnd;

/// A per-window MagicX effect. Dark and Gray are alternatives for one window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Colour-invert ("dark") the window.
    Dark,
    /// Grayscale the window.
    Gray,
}

impl Effect {
    /// Parse the wire string from `magicx_toggle_effect` (`"gray"`/`"grey"` →
    /// [`Effect::Gray`], anything else → [`Effect::Dark`]).
    pub fn from_wire(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "gray" | "grey" => Self::Gray,
            _ => Self::Dark,
        }
    }
}

/// `(dark, gray)` effect flags for a window (at most one is `true`).
type EffectFlags = (bool, bool);

/// Authoritative in-memory effect map, keyed by `HWND`. The Win32 pixel overlay
/// is applied by the backend; this is the source of truth for command/toolbar
/// state and survives a backend that failed to initialise.
static EFFECTS: Mutex<Option<HashMap<Hwnd, Effect>>> = Mutex::new(None);

fn with_effects<R>(f: impl FnOnce(&mut HashMap<Hwnd, Effect>) -> R) -> R {
    let mut guard = EFFECTS.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

/// Toggle one effect on a window. Dark and Gray are mutually exclusive: toggling
/// the currently-active effect clears the window; toggling the other effect
/// replaces it.
pub fn toggle_effect(hwnd: Hwnd, effect: Effect) {
    if hwnd == 0 {
        return;
    }
    // Decide AND dispatch under the same lock so two same-hwnd toggles racing
    // across the command/hotkey paths can't reorder the map update against the
    // backend send (which would leave the map and the on-screen host desynced).
    // `backend::apply` only enqueues on an mpsc channel / is a no-op, so it never
    // re-enters `with_effects` — holding the lock across it can't deadlock.
    with_effects(|map| {
        let applied = if map.get(&hwnd).copied() == Some(effect) {
            map.remove(&hwnd);
            None
        } else {
            map.insert(hwnd, effect);
            Some(effect)
        };
        backend::apply(hwnd, applied);
    });
}

/// Remove the effect from one window.
pub fn clear(hwnd: Hwnd) {
    if hwnd == 0 {
        return;
    }
    with_effects(|map| {
        map.remove(&hwnd);
        backend::apply(hwnd, None);
    });
}

/// Remove every window's effect (app exit / MagicX disabled).
pub fn clear_all() {
    with_effects(HashMap::clear);
    backend::clear_all();
}

/// The `(dark, gray)` flags currently applied to a window.
pub fn state_of(hwnd: Hwnd) -> EffectFlags {
    with_effects(|map| match map.get(&hwnd) {
        Some(Effect::Dark) => (true, false),
        Some(Effect::Gray) => (false, true),
        None => (false, false),
    })
}

/// Drop a window from the state map without touching the backend. Called by the
/// Windows backend when it discovers a target window has been destroyed, so
/// [`state_of`] stops reporting a stale effect.
#[cfg(all(windows, not(test)))]
fn forget(hwnd: Hwnd) {
    with_effects(|map| {
        map.remove(&hwnd);
    });
}

// ── Colour matrices (5×5 `MAGCOLOREFFECT`, row-major: `[R G B A 1] × M`) ───────
//
// Same layout the full-screen Reading-mode grayscale uses (`display::grayscale`):
// each of the first three rows is an input channel's contribution to the output
// R/G/B, the fourth row passes alpha, and the last row is the constant offset.

/// Colour-invert: `out = 1 − in` for R/G/B (diagonal `−1`, `+1` offsets), alpha
/// unchanged. Drives the **Dark** effect.
#[cfg(any(windows, test))]
#[rustfmt::skip]
const INVERT_MATRIX: [f32; 25] = [
    -1.0,  0.0,  0.0, 0.0, 0.0,
     0.0, -1.0,  0.0, 0.0, 0.0,
     0.0,  0.0, -1.0, 0.0, 0.0,
     0.0,  0.0,  0.0, 1.0, 0.0,
     1.0,  1.0,  1.0, 0.0, 1.0,
];

/// Rec. 601 luminance broadcast across R/G/B. Drives the **Gray** effect.
#[cfg(any(windows, test))]
#[rustfmt::skip]
const GRAYSCALE_MATRIX: [f32; 25] = [
    0.299, 0.299, 0.299, 0.0, 0.0,
    0.587, 0.587, 0.587, 0.0, 0.0,
    0.114, 0.114, 0.114, 0.0, 0.0,
    0.0,   0.0,   0.0,   1.0, 0.0,
    0.0,   0.0,   0.0,   0.0, 1.0,
];

/// Convert an `(left, top, right, bottom)` rect to `(x, y, width, height)`,
/// clamping negative extents to zero. Pure so the geometry is unit-testable off
/// the Win32 paths.
#[cfg(any(windows, test))]
fn rect_xywh(left: i32, top: i32, right: i32, bottom: i32) -> (i32, i32, i32, i32) {
    (left, top, (right - left).max(0), (bottom - top).max(0))
}

/// Whether a rect has a strictly positive area (a usable host size).
#[cfg(any(windows, test))]
fn rect_is_valid(left: i32, top: i32, right: i32, bottom: i32) -> bool {
    right > left && bottom > top
}

// ── Platform backend ──────────────────────────────────────────────────────────

/// The real Windows backend (dedicated Magnification-API thread). Excluded under
/// `cfg(test)` so state-bookkeeping tests never spawn the thread or mutate the
/// shared map asynchronously.
#[cfg(all(windows, not(test)))]
#[path = "engine_win.rs"]
mod backend;

/// Inert backend for non-Windows targets and test builds.
#[cfg(not(all(windows, not(test))))]
mod backend {
    use super::Effect;
    use crate::magicx::Hwnd;

    pub fn apply(_hwnd: Hwnd, _effect: Option<Effect>) {}
    pub fn clear_all() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that mutate the shared `EFFECTS` map (in particular
    /// `clear_all`, which wipes every window) so they don't race each other.
    static STATE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn effect_from_wire_defaults_to_dark() {
        assert_eq!(Effect::from_wire("dark"), Effect::Dark);
        assert_eq!(Effect::from_wire("GRAY"), Effect::Gray);
        assert_eq!(Effect::from_wire(" grey "), Effect::Gray);
        assert_eq!(Effect::from_wire("nonsense"), Effect::Dark);
    }

    #[test]
    fn toggle_is_mutually_exclusive_and_clears() {
        let _guard = STATE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let hwnd: Hwnd = 4242;
        clear(hwnd);
        assert_eq!(state_of(hwnd), (false, false));

        // Dark on.
        toggle_effect(hwnd, Effect::Dark);
        assert_eq!(state_of(hwnd), (true, false));

        // Switching to Gray replaces Dark (never both on at once).
        toggle_effect(hwnd, Effect::Gray);
        assert_eq!(state_of(hwnd), (false, true));

        // Switching back to Dark replaces Gray.
        toggle_effect(hwnd, Effect::Dark);
        assert_eq!(state_of(hwnd), (true, false));

        // Toggling the active effect again clears it (and forgets the window).
        toggle_effect(hwnd, Effect::Dark);
        assert_eq!(state_of(hwnd), (false, false));
    }

    #[test]
    fn clear_and_clear_all_reset_state() {
        let _guard = STATE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let a: Hwnd = 111;
        let b: Hwnd = 222;
        toggle_effect(a, Effect::Dark);
        toggle_effect(b, Effect::Gray);
        assert_eq!(state_of(a), (true, false));
        assert_eq!(state_of(b), (false, true));

        clear(a);
        assert_eq!(state_of(a), (false, false));
        assert_eq!(state_of(b), (false, true));

        clear_all();
        assert_eq!(state_of(b), (false, false));
    }

    #[test]
    fn zero_handle_is_ignored() {
        toggle_effect(0, Effect::Dark);
        assert_eq!(state_of(0), (false, false));
        clear(0);
        assert_eq!(state_of(0), (false, false));
    }

    #[test]
    fn invert_matrix_negates_rgb_with_unit_offsets() {
        // Diagonal R/G/B negation.
        assert_eq!(INVERT_MATRIX[0], -1.0);
        assert_eq!(INVERT_MATRIX[6], -1.0);
        assert_eq!(INVERT_MATRIX[12], -1.0);
        // Alpha + homogeneous pass-through.
        assert_eq!(INVERT_MATRIX[18], 1.0);
        assert_eq!(INVERT_MATRIX[24], 1.0);
        // +1 offset row for R/G/B (last row).
        assert_eq!(INVERT_MATRIX[20], 1.0);
        assert_eq!(INVERT_MATRIX[21], 1.0);
        assert_eq!(INVERT_MATRIX[22], 1.0);
    }

    #[test]
    fn grayscale_matrix_uses_rec_601_weights() {
        assert_eq!(GRAYSCALE_MATRIX[0], 0.299);
        assert_eq!(GRAYSCALE_MATRIX[5], 0.587);
        assert_eq!(GRAYSCALE_MATRIX[10], 0.114);
        // Each output column shares the same weight (broadcast to R/G/B).
        assert_eq!(GRAYSCALE_MATRIX[0], GRAYSCALE_MATRIX[1]);
        assert_eq!(GRAYSCALE_MATRIX[1], GRAYSCALE_MATRIX[2]);
        // Alpha row untouched.
        assert_eq!(GRAYSCALE_MATRIX[18], 1.0);
    }

    #[test]
    fn rect_xywh_converts_and_clamps() {
        assert_eq!(rect_xywh(10, 20, 110, 220), (10, 20, 100, 200));
        // Inverted/degenerate rects clamp to zero extent (never negative).
        assert_eq!(rect_xywh(100, 100, 50, 50), (100, 100, 0, 0));
        assert_eq!(rect_xywh(-5, -5, 5, 15), (-5, -5, 10, 20));
    }

    #[test]
    fn rect_is_valid_requires_positive_area() {
        assert!(rect_is_valid(0, 0, 1, 1));
        assert!(!rect_is_valid(0, 0, 0, 10));
        assert!(!rect_is_valid(0, 0, 10, 0));
        assert!(!rect_is_valid(10, 10, 5, 5));
    }
}
