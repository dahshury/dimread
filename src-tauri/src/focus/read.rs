//! Focus Read (FEATURE-PARITY F8.1) — a horizontal clear band that tracks the
//! cursor while the rest of the screen is dimmed by `settings.focus_read`
//! (`transparency` %, `color`, band `height`).
//!
//! ## Seam (frozen)
//! - [`toggle`] — flip active; returns the new state.
//! - [`is_active`] — current activation.
//! - [`start`] / [`stop`] — force on/off (used by [`toggle`], the hotkey action,
//!   and Blur's mutual-exclusion stop).
//!
//! ## What this slice implements
//! [`start`]:
//!   1. Shows the shared `focus-overlay` window sized/positioned to the whole
//!      virtual screen (see [`crate::windows::virtual_screen_bounds`]) so the
//!      renderer draws the Read shade across every monitor.
//!   2. Registers **Escape** as a global shortcut (via the global-shortcut
//!      plugin) so the user can quit the preview from anywhere without focusing
//!      the click-through overlay.
//!   3. Spawns a **cursor-poll thread** sampling `GetCursorPos` at ~30 Hz and
//!      emitting `focus:cursor { x, y }` ([`crate::events::FocusCursorEvent`])
//!      only when the pointer actually moved, so the renderer slides the clear
//!      band with the cursor. The thread exits when [`stop`] clears [`ACTIVE`]
//!      or a newer [`start`] supersedes its [`GENERATION`].
//!
//! [`stop`] hides the overlay (unless Blur is taking it over), unregisters
//! Escape, and lets the poll thread wind down.
//!
//! Off-Windows the cursor sampling is a no-op, so the crate still builds and the
//! seam stays inert (no band motion) rather than wrong.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, PhysicalPosition, PhysicalSize};
use tauri_specta::Event as _;

use crate::events::FocusCursorEvent;

/// Whether Focus Read currently owns the overlay.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Bumped on every [`start`]/[`stop`] so a superseded cursor-poll thread winds
/// down even across a rapid stop→start (each thread captures its generation and
/// exits when the current one moves past it).
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Whether THIS slice armed the global Escape shortcut (so [`stop`] only
/// unregisters an Escape it actually owns — never one bound by the user).
static ESC_ARMED: AtomicBool = AtomicBool::new(false);

/// The shared full-virtual-screen tint window (see `windows::WINDOW_SPECS`).
const FOCUS_OVERLAY_LABEL: &str = "focus-overlay";
/// Cursor sampling period (~30 Hz).
const POLL_INTERVAL: Duration = Duration::from_millis(33);

/// Per-sub-engine init hook. No-op in this slice (all state is lazy). Called
/// from [`super::init`].
pub fn init(_app: &AppHandle) {}

/// Whether Focus Read is active.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Flip Focus Read on/off; returns the new active state.
pub fn toggle() -> bool {
    if is_active() {
        stop();
        false
    } else {
        start();
        true
    }
}

/// Force Focus Read on. Stops Focus Blur first (they share the overlay), sets
/// the flag, shows the overlay + arms Escape + spawns the cursor poll, then
/// emits `focus:state`.
pub fn start() {
    // Mutually exclusive with Blur — release the overlay before we claim it.
    super::blur::stop();
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(app) = super::app() {
        show_overlay(&app);
        register_escape(&app);
        spawn_cursor_poll(app, generation);
    }
    super::emit_state();
}

/// Force Focus Read off. Idempotent; emits `focus:state` only on a real change.
pub fn stop() {
    if !ACTIVE.swap(false, Ordering::SeqCst) {
        return;
    }
    // Supersede the running poll thread (belt-and-suspenders alongside the
    // `is_active()` guard it already checks).
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(app) = super::app() {
        unregister_escape(&app);
        // Hide the shared overlay unless Blur is taking it over.
        if !super::blur::is_active() {
            hide_overlay(&app);
        }
    }
    super::emit_state();
}

// ── Overlay window ───────────────────────────────────────────────────────────

/// Show the `focus-overlay` window spanning the whole virtual screen (all
/// monitors), kept click-through and always-on-top. Creating it if the prewarm
/// has not landed yet.
fn show_overlay(app: &AppHandle) {
    let window = match crate::windows::ensure_window(app, FOCUS_OVERLAY_LABEL) {
        Ok(window) => window,
        Err(err) => {
            log::warn!("[focus-read] focus-overlay window unavailable: {err}");
            return;
        }
    };
    let (left, top, width, height) = crate::windows::virtual_screen_bounds();
    let _ = window.set_position(PhysicalPosition::new(left, top));
    let _ = window.set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
    // Re-assert passthrough: creation sets it on Windows, but Linux defers it to
    // after the first show, and it must hold on every show path anyway.
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    // Deliberately NO set_focus(): the overlay must never steal keyboard focus.
}

/// Hide the shared overlay window.
fn hide_overlay(app: &AppHandle) {
    if let Some(window) = tauri::Manager::get_webview_window(app, FOCUS_OVERLAY_LABEL) {
        let _ = window.hide();
    }
}

// ── Escape-to-quit global shortcut ───────────────────────────────────────────

/// Arm Escape as a global shortcut that stops Focus Read from anywhere. Skips
/// arming (leaving it untouched) when something already owns Escape, so a
/// user-bound Escape is never clobbered.
fn register_escape(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let Ok(esc) = "Escape".parse::<Shortcut>() else {
        return;
    };
    if app.global_shortcut().is_registered(esc) {
        return;
    }
    let armed = app
        .global_shortcut()
        .on_shortcut(esc, move |app, fired, event| {
            if fired == &esc && event.state == ShortcutState::Pressed {
                // Defer off the shortcut handler so we never mutate the shortcut
                // registration (unregister Escape) from inside its own callback.
                let _ = app.run_on_main_thread(stop);
            }
        });
    match armed {
        Ok(()) => ESC_ARMED.store(true, Ordering::SeqCst),
        Err(err) => log::warn!("[focus-read] failed to register Escape: {err}"),
    }
}

/// Disarm the Escape shortcut, but only if this slice armed it.
fn unregister_escape(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    if !ESC_ARMED.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Ok(esc) = "Escape".parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(esc);
    }
}

// ── Cursor poll ──────────────────────────────────────────────────────────────

/// Spawn the ~30 Hz `GetCursorPos` sampler. It emits `focus:cursor` only on a
/// real move and exits as soon as Read is stopped or superseded.
fn spawn_cursor_poll(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let mut last: Option<(i32, i32)> = None;
        loop {
            if !is_active() || GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            if let Some(position) = cursor_position()
                && cursor_moved(last, position)
            {
                last = Some(position);
                let (x, y) = position;
                if let Err(err) = (FocusCursorEvent { x, y }).emit(&app) {
                    log::warn!("[focus-read] failed to emit focus:cursor: {err}");
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Whether the cursor position changed since the last emitted sample (the first
/// sample, with no prior value, always counts as a move so the band snaps to the
/// pointer immediately on start).
fn cursor_moved(last: Option<(i32, i32)>, current: (i32, i32)) -> bool {
    last != Some(current)
}

/// Read the global cursor position in physical screen pixels.
#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    // SAFETY: `GetCursorPos` writes the cursor position into the out-param; no
    // pointers are retained past the call.
    if unsafe { GetCursorPos(&mut point) }.is_ok() {
        Some((point.x, point.y))
    } else {
        None
    }
}

/// Off-Windows the cursor sampler is inert (the seam stays a no-op).
#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::cursor_moved;

    #[test]
    fn first_sample_always_counts_as_moved() {
        assert!(cursor_moved(None, (0, 0)));
        assert!(cursor_moved(None, (10, 20)));
    }

    #[test]
    fn same_position_is_not_a_move() {
        assert!(!cursor_moved(Some((10, 20)), (10, 20)));
    }

    #[test]
    fn any_axis_change_is_a_move() {
        assert!(cursor_moved(Some((10, 20)), (11, 20)));
        assert!(cursor_moved(Some((10, 20)), (10, 21)));
        assert!(cursor_moved(Some((10, 20)), (0, 0)));
    }
}
