//! Monitor work-area geometry.
//!
//! Self-contained: monitor work-area lookup, plain-window centering, and the
//! virtual-screen bounds the full-screen `focus-overlay` is sized to.

use tauri::{AppHandle, LogicalPosition, Manager, PhysicalPosition, PhysicalSize};

// ── Monitor work-area helpers (logical px) ──────────────────────────────────

fn monitor_for_point(app: &AppHandle, point: (f64, f64)) -> Option<tauri::Monitor> {
    let (px, py) = point;
    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let scale = monitor.scale_factor();
            let mx = monitor.position().x as f64 / scale;
            let my = monitor.position().y as f64 / scale;
            let mw = monitor.size().width as f64 / scale;
            let mh = monitor.size().height as f64 / scale;
            if px >= mx && px < mx + mw && py >= my && py < my + mh {
                return Some(monitor);
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Logical-pixel monitor rect (x, y, width, height) for a point.
pub(crate) fn work_area_for_point(app: &AppHandle, point: (f64, f64)) -> (f64, f64, f64, f64) {
    if let Some(monitor) = monitor_for_point(app, point) {
        let scale = monitor.scale_factor();
        let PhysicalPosition { x, y } = *monitor.position();
        let PhysicalSize { width, height } = *monitor.size();
        return (
            x as f64 / scale,
            y as f64 / scale,
            width as f64 / scale,
            height as f64 / scale,
        );
    }
    (0.0, 0.0, 1920.0, 1080.0)
}

/// The virtual-screen bounds spanning ALL monitors, in PHYSICAL px:
/// `(left, top, width, height)`. This is the footprint the `focus-overlay`
/// window is sized/positioned to so its tint covers every display (the Focus
/// Read band + Focus Blur shade are multi-monitor aware).
///
/// On Windows this is `GetSystemMetrics(SM_{X,Y}VIRTUALSCREEN,
/// SM_C{X,Y}VIRTUALSCREEN)`. Off-Windows it falls back to a single 1080p
/// origin-anchored screen so the crate still builds and the seam is inert.
#[cfg(windows)]
pub fn virtual_screen_bounds() -> (i32, i32, i32, i32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    // SAFETY: GetSystemMetrics reads a documented system metric; no pointers.
    let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 {
        return (0, 0, 1920, 1080);
    }
    (left, top, width, height)
}

/// Non-Windows fallback: a single origin-anchored 1080p screen.
#[cfg(not(windows))]
pub fn virtual_screen_bounds() -> (i32, i32, i32, i32) {
    (0, 0, 1920, 1080)
}

/// Outer position of a window in LOGICAL px.
fn outer_position_logical(window: &tauri::WebviewWindow) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .outer_position()
        .map_or((0.0, 0.0), |p| (p.x as f64 / scale, p.y as f64 / scale))
}

// ── Centering (plain windows) ───────────────────────────────────────────────

/// Center `window` over the app window if it's visible (and
/// `center_on_primary`), else on the primary display work area. Frameless
/// windows have no titlebar to drag them back, so the result is clamped fully
/// on-screen.
pub(crate) fn center_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    center_on_primary: bool,
) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, h) = window.inner_size().map_or((900.0, 640.0), |s| {
        (s.width as f64 / scale, s.height as f64 / scale)
    });

    if center_on_primary
        && let Some(main) = app.get_webview_window(crate::windows::PRIMARY_WINDOW)
        && main.is_visible().unwrap_or(false)
    {
        let mscale = main.scale_factor().unwrap_or(1.0);
        let (mx, my) = outer_position_logical(&main);
        let (mw, mh) = main.outer_size().map_or((480.0, 180.0), |s| {
            (s.width as f64 / mscale, s.height as f64 / mscale)
        });
        let x = (mx + (mw - w) / 2.0).round();
        let y = (my + (mh - h) / 2.0).round();
        let work = work_area_for_point(app, (mx + mw / 2.0, my + mh / 2.0));
        let (cx, cy) = clamp_into_work_area(x, y, w, h, work);
        let _ = window.set_position(LogicalPosition::new(cx, cy));
        return;
    }

    let (wx, wy, ww, wh) = work_area_for_point(app, (0.0, 0.0));
    let x = (wx + (ww - w) / 2.0).round();
    let y = (wy + (wh - h) / 2.0).round();
    let (cx, cy) = clamp_into_work_area(x, y, w, h, (wx, wy, ww, wh));
    let _ = window.set_position(LogicalPosition::new(cx, cy));
}

/// Clamp a window's top-left so the ENTIRE window (w×h) stays inside the work
/// area `(wx, wy, ww, wh)`.
fn clamp_into_work_area(x: f64, y: f64, w: f64, h: f64, work: (f64, f64, f64, f64)) -> (f64, f64) {
    let (wx, wy, ww, wh) = work;
    let max_x = (wx + ww - w).max(wx);
    let max_y = (wy + wh - h).max(wy);
    (x.clamp(wx, max_x), y.clamp(wy, max_y))
}

#[cfg(test)]
mod tests {
    use super::clamp_into_work_area;

    #[test]
    fn clamp_keeps_window_fully_on_screen() {
        let work = (0.0, 0.0, 1920.0, 1080.0);
        assert_eq!(
            clamp_into_work_area(-50.0, -20.0, 400.0, 300.0, work),
            (0.0, 0.0)
        );
        assert_eq!(
            clamp_into_work_area(1900.0, 1000.0, 400.0, 300.0, work),
            (1520.0, 780.0)
        );
    }
}
