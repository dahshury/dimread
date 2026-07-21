//! MagicX tab engine (FEATURE-PARITY F9) — per-window dark/grayscale effects,
//! the hover Magic Toolbar, and the Auto Dark theme scheduler.
//!
//! Module map:
//!   * [`engine`] — per-window Dark (colour invert) / Gray effects on any window
//!     (F9.1). **Stable seam** the toolbar + hotkey actions drive.
//!   * [`toolbar`] — the hover Magic Toolbar (F9.2-F9.4): tracks the foreground
//!     window, shows the `magic-toolbar` window (Dark / Gray / Close) near its
//!     top, and remembers the current effect target.
//!   * [`theme`] — Auto Dark (F9.5-F9.6): schedules the Windows app + system
//!     theme and the taskbar-transparency effect.
//!
//! ## Stable seam (frozen — do not reshape)
//! - [`init`] — initialise the toolbar + theme sub-engines. Wired from `lib.rs`
//!   setup as `crate::magicx::init(&app_handle)`.
//! - [`engine::toggle_effect`] / [`engine::clear`] / [`engine::clear_all`] /
//!   [`engine::state_of`]
//! - [`toolbar::init`], [`theme::init`], [`theme::apply_now`]
//! - Commands [`magicx_toggle_effect`] / [`magicx_clear_target`].
//! - Events `magictoolbar:show` / `magictoolbar:hide` / `autodark:changed`.
//!
//! Everything Win32 (Magnification per-window effects, DWM, theme registry keys)
//! is implemented by the phase-2 slices; the foundation ships no-op-safe seams
//! so an un-wired build compiles and is inert on every platform. A native window
//! handle is represented as a raw `isize` ([`Hwnd`]) so the seam signatures stay
//! platform-neutral.

pub mod engine;
pub mod theme;
pub mod toolbar;

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

pub use engine::Effect;

/// Last observed `settings.magicx.enabled`, so [`watch_enabled`] can detect the
/// enabled→disabled edge and tear down every per-window effect (otherwise
/// inverted/grayscaled windows stay effected with no in-app way to restore them).
static LAST_ENABLED: AtomicBool = AtomicBool::new(false);

/// A native window handle as a raw `isize` (the Win32 `HWND` value on Windows).
/// `0` denotes "no window".
pub type Hwnd = isize;

/// `AppHandle` captured by [`init`], used by the sub-engines to show/hide the
/// `magic-toolbar` window and emit events from a background context.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Initialise the MagicX sub-engines. Idempotent.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    toolbar::init(app);
    theme::init(app);
    watch_enabled(app);
}

/// Watch `settings.magicx.enabled` and clear every per-window effect on the
/// enabled→disabled edge (the toolbar watcher already hides the toolbar on the
/// same edge, but nothing restored the Magnification overlays until now).
fn watch_enabled(app: &AppHandle) {
    use tauri::Listener;

    // Seed from current settings so a boot with MagicX already enabled isn't
    // mistaken for a disable edge on the first unrelated save.
    LAST_ENABLED.store(
        crate::settings::store::read_settings(app).magicx.enabled,
        Ordering::SeqCst,
    );
    let handle = app.clone();
    let _ = app.listen_any("settings:changed", move |_event| {
        let enabled = crate::settings::store::read_settings(&handle)
            .magicx
            .enabled;
        if LAST_ENABLED.swap(enabled, Ordering::SeqCst) && !enabled {
            engine::clear_all();
        }
    });
}

/// The captured app handle, if [`init`] has run. Exposed for the phase-2 slices
/// (toolbar window show/hide, background emits).
pub fn app() -> Option<AppHandle> {
    APP.get().cloned()
}

/// The current foreground window handle (`0` when none / off-Windows). Used as
/// the default effect target when no toolbar target is set.
pub(crate) fn foreground_hwnd() -> Hwnd {
    #[cfg(windows)]
    {
        // SAFETY: returns the foreground HWND or a null handle (no focus).
        let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        hwnd.0 as Hwnd
    }
    #[cfg(not(windows))]
    {
        0
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// `magicx_toggle_effect` — toggle a per-window effect (`"dark"` | `"gray"`) on
/// the current Magic Toolbar target, falling back to the foreground window.
#[tauri::command]
#[specta::specta]
pub fn magicx_toggle_effect(effect: String) {
    let effect = Effect::from_wire(&effect);
    let target = toolbar::current_target().unwrap_or_else(foreground_hwnd);
    if target != 0 {
        engine::toggle_effect(target, effect);
    }
}

/// `magicx_clear_target` — clear all effects on the current toolbar target (the
/// toolbar's "Close" button; F9.2).
#[tauri::command]
#[specta::specta]
pub fn magicx_clear_target() {
    if let Some(target) = toolbar::current_target() {
        engine::clear(target);
    }
}
