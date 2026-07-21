//! The tray flyout: a transparent webview popup anchored to the tray icon,
//! replacing the native context menu so the tray can host REAL controls (the
//! brightness / colour-temperature sliders) instead of the quick-set submenus a
//! native `CheckMenuItem` roster is limited to.
//!
//! Ported from WinSTT's `tray_menu` module. The load-bearing details, each of
//! which fixes a specific observed bug:
//!
//!  - **The window is never hidden.** It is PARKED off-screen at
//!    {@link OFFSCREEN} on dismiss and moved back on open. WebView2 re-presents
//!    the last composited frame when a hidden window is shown, so a real
//!    hide/show cycle flashes the previous frame at the previous position; and
//!    the cold-composite on first show eats the whole open animation. Because
//!    of this, "is it open?" is a POSITION test ({@link is_on_screen}), never
//!    `is_visible()`.
//!  - **Blur dismisses, but not during a self-resize.** The renderer sizes the
//!    OS window to its content (`ResizeObserver` → `tray_menu_resize`), and
//!    `set_size` makes WebView2 momentarily drop and regain focus — which would
//!    otherwise collapse the popup on every resize. {@link RESIZE_BLUR_GRACE}
//!    suppresses the dismiss for a beat after each resize.
//!  - **Resizes re-anchor.** Growing the popup downward would push it under the
//!    taskbar, so every accepted resize re-runs the clamp.
//!
//! Placement is a pure clamp into the monitor work area (see
//! {@link clamp_to_work_area}): the tray sits at a screen corner, so clamping a
//! popup anchored there naturally pulls it back on-screen — no explicit
//! "flip above the anchor" branch is needed.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalPosition, Manager};

pub mod commands;

/// The popup's window label (== the Vite entry key == its `WINDOW_SPECS` entry).
pub(crate) const TRAY_MENU_LABEL: &str = "tray-menu";

/// Work-area fudge for the taskbar. Windows 11's rounded taskbar overlaps the
/// reported work area, so a popup flush against the bottom edge clips.
const TASKBAR_MARGIN: f64 = 8.0;

/// Where the popup is parked while dismissed — far enough off-screen that it
/// can never peek onto any monitor arrangement.
const OFFSCREEN: f64 = -9999.0;

/// How long after a self-resize a focus loss is ignored. `set_size` bounces
/// WebView2's focus; without this grace, self-sizing and blur-to-dismiss are
/// mutually incompatible.
const RESIZE_BLUR_GRACE: Duration = Duration::from_millis(500);

/// The screen point the popup is anchored to (logical px) — the tray click
/// position. Kept so a resize can re-clamp against the same anchor.
static ANCHOR: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// When the renderer last resized the window (see {@link RESIZE_BLUR_GRACE}).
static LAST_RESIZE: Mutex<Option<Instant>> = Mutex::new(None);

/// The blur-to-dismiss handler is installed once, on the first open.
static LIFECYCLE_INSTALLED: AtomicBool = AtomicBool::new(false);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── Geometry ────────────────────────────────────────────────────────────────

/// Clamp a desired top-left so the whole popup stays inside the work area,
/// keeping {@link TASKBAR_MARGIN} clear of the bottom edge.
///
/// Pure: unit-tested below without a running app.
fn clamp_to_work_area(
    desired: (f64, f64),
    size: (f64, f64),
    work: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (dx, dy) = desired;
    let (w, h) = size;
    let (wx, wy, ww, wh) = work;
    let max_x = (wx + ww - w).max(wx);
    let max_y = (wy + wh - h - TASKBAR_MARGIN).max(wy);
    (dx.clamp(wx, max_x), dy.clamp(wy, max_y))
}

/// The popup's current size in LOGICAL px (it self-sizes, so this is read back
/// rather than assumed from the spec).
fn popup_size(window: &tauri::WebviewWindow) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    window.inner_size().map_or(SEED_SIZE, |s| {
        (s.width as f64 / scale, s.height as f64 / scale)
    })
}

/// Fallback footprint when the window can't report its size (matches the
/// `WINDOW_SPECS` seed).
const SEED_SIZE: (f64, f64) = (300.0, 460.0);

fn position_at(app: &AppHandle, window: &tauri::WebviewWindow, anchor: (f64, f64)) {
    let work = crate::windows::placement::work_area_for_point(app, anchor);
    let (x, y) = clamp_to_work_area(anchor, popup_size(window), work);
    if let Err(err) = window.set_position(LogicalPosition::new(x, y)) {
        log::warn!("[tray-menu] failed to position popup: {err}");
    }
}

/// Open state is a POSITION test — the window is always `visible`, just parked
/// off-screen while dismissed (see the module docs).
fn is_on_screen(window: &tauri::WebviewWindow) -> bool {
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .outer_position()
        .is_ok_and(|p| (f64::from(p.y) / scale) > OFFSCREEN / 2.0)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/// Park the popup off-screen. Deliberately NOT a `hide()` — see module docs.
fn park(window: &tauri::WebviewWindow) {
    let _ = window.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
}

/// Dismiss the popup (idempotent) and forget its anchor.
pub(crate) fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        park(&window);
    }
    *lock(&ANCHOR) = None;
}

/// Blur-to-dismiss, suppressed during the renderer's self-resize bounce.
fn install_lifecycle(app: &AppHandle) {
    if LIFECYCLE_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        // Nothing to attach to yet; let the next open retry.
        LIFECYCLE_INSTALLED.store(false, Ordering::SeqCst);
        return;
    };
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Focused(false)) {
            return;
        }
        let Some(window) = app_handle.get_webview_window(TRAY_MENU_LABEL) else {
            return;
        };
        if !is_on_screen(&window) {
            return;
        }
        // A `set_size` from the renderer's ResizeObserver bounces focus; that is
        // not a user click-away.
        let resizing = lock(&LAST_RESIZE).is_some_and(|at| at.elapsed() < RESIZE_BLUR_GRACE);
        if !resizing {
            hide(&app_handle);
        }
    });
}

/// Record a renderer-driven resize so the next blur is treated as a bounce.
pub(crate) fn note_resize() {
    *lock(&LAST_RESIZE) = Some(Instant::now());
}

/// Re-clamp the popup against its stored anchor after it self-sizes — growing
/// downward would otherwise push it under the taskbar. Position only: no show
/// or focus call, which would flicker mid-resize.
pub(crate) fn reanchor(app: &AppHandle) {
    let Some(anchor) = *lock(&ANCHOR) else {
        return;
    };
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        return;
    };
    if !is_on_screen(&window) {
        return;
    }
    position_at(app, &window, anchor);
}

/// Place + focus the popup at a logical-px screen anchor.
fn place(app: &AppHandle, anchor: (f64, f64)) {
    let window = match crate::windows::ensure_window(app, TRAY_MENU_LABEL) {
        Ok(window) => window,
        Err(err) => {
            log::warn!("[tray-menu] failed to ensure popup window: {err}");
            return;
        }
    };
    install_lifecycle(app);
    *lock(&ANCHOR) = Some(anchor);
    position_at(app, &window, anchor);
    // The window stays `visible` for its whole life (it is parked, not hidden),
    // but show() is cheap and idempotent and repairs a stray external hide.
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
}

/// Open the popup at a tray-click position reported in PHYSICAL px (what
/// `TrayIconEvent` carries) — converted to the logical px placement works in.
pub fn show_at_physical(app: &AppHandle, physical_x: f64, physical_y: f64) {
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |m| m.scale_factor());
    place(app, (physical_x / scale, physical_y / scale));
}

/// Tray-click handler: open the popup, or dismiss it if it is already up (a
/// second click on the tray icon closes it, like every OS flyout).
pub fn toggle_at_physical(app: &AppHandle, physical_x: f64, physical_y: f64) {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL)
        && is_on_screen(&window)
    {
        hide(app);
        return;
    }
    show_at_physical(app, physical_x, physical_y);
}

/// Startup warmup: park the popup off-screen and SHOW it, so WebView2 builds
/// its composition surface and the renderer reports its true content size
/// before the first real click. Called from the post-startup prewarm pass.
pub(crate) fn prewarm(window: &tauri::WebviewWindow) {
    park(window);
    let _ = window.show();
}

#[cfg(test)]
mod tests {
    use super::{OFFSCREEN, SEED_SIZE, TASKBAR_MARGIN, clamp_to_work_area};

    const WORK: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn anchor_inside_the_work_area_is_left_alone() {
        let (x, y) = clamp_to_work_area((400.0, 300.0), (300.0, 400.0), WORK);
        assert_eq!((x, y), (400.0, 300.0));
    }

    #[test]
    fn bottom_right_tray_anchor_is_pulled_fully_on_screen() {
        // The realistic case: the tray sits at the bottom-right corner, so the
        // popup must be pulled up and left to fit.
        let (w, h) = SEED_SIZE;
        let (x, y) = clamp_to_work_area((1900.0, 1050.0), (w, h), WORK);
        assert_eq!(x, 1920.0 - w);
        assert_eq!(y, 1080.0 - h - TASKBAR_MARGIN);
        assert!(x + w <= 1920.0);
        assert!(y + h + TASKBAR_MARGIN <= 1080.0);
    }

    #[test]
    fn taskbar_margin_is_kept_clear() {
        let (_x, y) = clamp_to_work_area((0.0, 5000.0), (300.0, 400.0), WORK);
        assert_eq!(y, 1080.0 - 400.0 - TASKBAR_MARGIN);
    }

    #[test]
    fn a_popup_larger_than_the_work_area_pins_to_the_origin() {
        let (x, y) = clamp_to_work_area((900.0, 900.0), (4000.0, 4000.0), WORK);
        assert_eq!((x, y), (0.0, 0.0));
    }

    #[test]
    fn secondary_monitor_origin_is_respected() {
        // A monitor to the right of the primary: clamping must use ITS origin,
        // not the desktop origin.
        let work = (1920.0, 0.0, 1920.0, 1080.0);
        let (x, y) = clamp_to_work_area((3900.0, 1050.0), (300.0, 400.0), work);
        assert_eq!(x, 3840.0 - 300.0);
        assert!(x >= 1920.0);
        assert_eq!(y, 1080.0 - 400.0 - TASKBAR_MARGIN);
    }

    #[test]
    fn a_real_placement_never_reads_as_parked() {
        // `is_on_screen` calls the popup open when its y is above OFFSCREEN/2,
        // so a genuine placement on ANY monitor arrangement — including
        // monitors positioned left of, or above, the primary — must land well
        // clear of that threshold or the popup would dismiss itself.
        for work in [
            WORK,
            (-1920.0, 0.0, 1920.0, 1080.0),
            (0.0, -1080.0, 1920.0, 1080.0),
            (-3840.0, -2160.0, 1920.0, 1080.0),
        ] {
            let (_x, y) = clamp_to_work_area((0.0, 0.0), SEED_SIZE, work);
            assert!(
                y > OFFSCREEN / 2.0,
                "placement at y={y} would read as parked"
            );
        }
    }
}
