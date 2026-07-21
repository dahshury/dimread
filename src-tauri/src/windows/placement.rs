//! Monitor work-area geometry + picker placement.
//!
//! Self-contained geometry: monitor work-area lookup, plain-window centering,
//! the pure `compute_*` panel math, and the placement/close paths that anchor
//! the transparent picker. Ported from WinSTT's placement module.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize};
use tauri_specta::Event;

use super::{PickerAnchor, with_picker_state};
use crate::events::{PickerAnchorEvent, PickerClosingEvent};

// ── Picker placement sequencing ─────────────────────────────────────────────

/// Monotonic open/close counter for the picker. Every open and every hide
/// bumps it; the delayed re-emits and the delayed hide capture the value at
/// schedule time and only fire while it's still current — so a close (or a
/// reopen at a new anchor) during the wait invalidates stale work.
static PICKER_SEQ: AtomicU64 = AtomicU64::new(0);

// ── Constants ───────────────────────────────────────────────────────────────

/// Work-area fudge for the taskbar: `monitor.size()` is the FULL monitor rect
/// (the pinned `dpi` crate version has no `work_area()`), so a fixed margin
/// keeps popups off the taskbar edge.
const TASKBAR_MARGIN: f64 = 8.0;
/// Gap between the popup's edge and the trigger that opened it.
const ANCHOR_GAP: f64 = 6.0;
/// How long after the close starts the OS window is actually hidden. MUST stay
/// longer than the renderer's close fade so the fully-faded (transparent)
/// frame is composited BEFORE the hide: WebView2 re-presents the last
/// composited frame when the window is next shown, and if that frame still
/// holds the visible panel it flashes at the PREVIOUS trigger's position on
/// the next open. The window ignores cursor events for this whole grace, so
/// the extra invisible backdrop cannot swallow clicks.
const PICKER_HIDE_DELAY_MS: u64 = 260;
/// First-open / long-idle race: the renderer's listener may not have
/// registered (or a hidden webview needs a beat after show), so the anchor is
/// re-emitted at these offsets. Duplicate anchors are cheap and idempotent.
const PICKER_ANCHOR_REEMIT_MS: &[u64] = &[75, 250, 700];
/// Smallest usable picker panel height before we pin it to the screen top.
const PICKER_MIN_HEIGHT: f64 = 160.0;

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

/// CLIENT-AREA origin of a window in LOGICAL px. Trigger rects arrive in the
/// opener's viewport (client) coordinates, so anchors must be offset from the
/// client origin — NOT `outer_position`, which on Windows includes the
/// invisible `WS_THICKFRAME` resize border that decorationless-but-shadowed
/// windows carry (~7px left + ~1px top at 200% DPI). Falls back to the outer
/// origin if the platform can't report the client origin.
fn client_origin_logical(window: &tauri::WebviewWindow) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    window.inner_position().map_or_else(
        |_| outer_position_logical(window),
        |p| (p.x as f64 / scale, p.y as f64 / scale),
    )
}

// ── Centering (plain windows) ───────────────────────────────────────────────

/// Center `window` over the main window if it's visible (and `center_on_main`),
/// else on the primary display work area. Frameless windows have no titlebar
/// to drag them back, so the result is clamped fully on-screen.
pub(crate) fn center_window(app: &AppHandle, window: &tauri::WebviewWindow, center_on_main: bool) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, h) = window.inner_size().map_or((900.0, 640.0), |s| {
        (s.width as f64 / scale, s.height as f64 / scale)
    });

    if center_on_main
        && let Some(main) = app.get_webview_window("main")
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

// ── Picker geometry ─────────────────────────────────────────────────────────

struct PanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Y-axis placement: open toward whichever side (above OR below the trigger)
/// has more room, gluing the popup `ANCHOR_GAP` away from that trigger edge
/// and shrinking the height to the available room. Ties favour ABOVE. When
/// neither side has comfortable room the trigger is hogging the screen, so we
/// pin to the work-area top as a last resort.
fn compute_y_axis(
    anchor: PickerAnchor,
    desired_height: f64,
    work_y: f64,
    work_h: f64,
    min_height: f64,
) -> (f64, f64) {
    let ceiling = work_h - TASKBAR_MARGIN;
    let room_above = anchor.screen_top - work_y - ANCHOR_GAP;
    let room_below = work_y + work_h - anchor.screen_bottom - ANCHOR_GAP;
    if room_below > room_above && room_below >= min_height {
        let height = desired_height.min(room_below).min(ceiling);
        (anchor.screen_bottom + ANCHOR_GAP, height)
    } else if room_above >= min_height {
        let height = desired_height.min(room_above).min(ceiling);
        (anchor.screen_top - height - ANCHOR_GAP, height)
    } else {
        (work_y, desired_height.min(ceiling))
    }
}

/// X-axis placement: right-align the popup to the trigger's right edge,
/// clamped into the work area.
fn compute_x_axis(anchor: PickerAnchor, width: f64, work_x: f64, work_w: f64) -> f64 {
    let desired_x = anchor.screen_right - width;
    let max_x = work_x + work_w - width;
    desired_x.max(work_x).min(max_x.max(work_x))
}

/// Compute the on-screen popup rect (logical px) from the anchor + desired
/// size, clamped into the monitor work area.
fn compute_panel(
    anchor: PickerAnchor,
    desired: (f64, f64),
    work: (f64, f64, f64, f64),
    min_height: f64,
) -> PanelBounds {
    let (work_x, work_y, work_w, work_h) = work;
    let width = desired.0.min(work_w);
    let (y, height) = compute_y_axis(anchor, desired.1, work_y, work_h, min_height);
    let x = compute_x_axis(anchor, width, work_x, work_w);
    PanelBounds {
        x,
        y: y.max(work_y),
        width,
        height,
    }
}

// ── Picker lifecycle ────────────────────────────────────────────────────────

pub(crate) fn close_picker_with_animation(app: &AppHandle, window: &tauri::WebviewWindow) {
    let seq = PICKER_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    // Mark the grace so nothing re-places (and thereby re-shows) the
    // still-visible window before the delayed hide lands. Cleared on the next
    // anchored open.
    with_picker_state(|s| s.closing = true);
    if let Err(err) = (PickerClosingEvent {}).emit(app) {
        log::warn!("failed to emit picker:closing: {err}");
    }
    // The backdrop's job is done the instant the close starts: let every
    // further click fall through to whatever is underneath while the fade
    // plays and the transparent post-fade frame is composited. Re-enabled on
    // the next open.
    let _ = window.set_ignore_cursor_events(true);

    let app2 = app.clone();
    let window2 = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(PICKER_HIDE_DELAY_MS));
        if PICKER_SEQ.load(Ordering::SeqCst) != seq {
            return;
        }
        let _ = app2.run_on_main_thread(move || {
            if PICKER_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            let _ = window2.hide();
            with_picker_state(|s| {
                s.anchor = None;
                s.closing = false;
            });
        });
    });
}

/// Where the picker is parked for its startup compositor warmup — far enough
/// off-screen that the seed window can never peek into the desktop.
const PICKER_WARMUP_PARK: f64 = -9999.0;
/// How long the warmup keeps the window shown off-screen. Long enough for
/// WebView2 to create its composition surface and present a few frames.
const PICKER_WARMUP_MS: u64 = 800;

/// One-time compositor warmup at startup. The picker window is pre-CREATED
/// hidden, but WebView2 only builds its composition surface on the first
/// show — so the FIRST user open would pay a several-hundred-ms cold-composite
/// during which the whole open animation elapses invisibly. Show the window
/// once, parked off-screen and non-focusable, then hide it again so the first
/// real open behaves like every subsequent one.
pub(crate) fn warm_picker_compositor(app: &AppHandle, window: &tauri::WebviewWindow) {
    let seq = PICKER_SEQ.load(Ordering::SeqCst);
    let _ = window.set_focusable(false);
    let _ = window.set_position(LogicalPosition::new(PICKER_WARMUP_PARK, PICKER_WARMUP_PARK));
    let _ = window.show();
    let app2 = app.clone();
    let window2 = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(PICKER_WARMUP_MS));
        let _ = app2.run_on_main_thread(move || {
            let _ = window2.set_focusable(true);
            // A real open landed during the warmup — the window is theirs now.
            if PICKER_SEQ.load(Ordering::SeqCst) == seq {
                let _ = window2.hide();
            }
        });
    });
}

/// Place + show the picker: the window fills the display work area as a
/// transparent click-to-dismiss backdrop, and we emit `picker:anchor` with the
/// window-local panel rect so the renderer draws the visible panel around the
/// trigger.
pub(crate) fn place_picker(app: &AppHandle, window: &tauri::WebviewWindow) {
    let state = with_picker_state(|s| s.clone());
    let Some(anchor) = state.anchor else {
        // A full-screen transparent picker without a panel looks like the app
        // hung and captures input. Keep it hidden until a real anchored open.
        log::warn!("picker open requested without an anchor; keeping it hidden");
        PICKER_SEQ.fetch_add(1, Ordering::SeqCst);
        let _ = window.hide();
        return;
    };
    // Treat open as a repair/re-anchor operation. This cancels any delayed
    // hide from a close animation before it can race a fresh click.
    let seq = PICKER_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    with_picker_state(|s| s.closing = false);
    let work = work_area_for_point(app, (anchor.screen_left, anchor.screen_top));
    let (work_x, work_y, work_w, work_h) = work;
    // Match the panel to the width of the trigger that opened it, flooring at
    // the picker's natural footprint so a tiny trigger still yields a usable
    // panel. `compute_x_axis` right-aligns the panel to the trigger's right
    // edge, so when the panel width equals the trigger width it spans it
    // exactly.
    let trigger_width = anchor.screen_right - anchor.screen_left;
    let panel_width = trigger_width.max(state.width).min(work_w);
    let panel = compute_panel(anchor, (panel_width, state.height), work, PICKER_MIN_HEIGHT);

    // The window fills the whole work area; the panel is positioned inside it.
    let _ = window.set_position(LogicalPosition::new(work_x, work_y));
    let _ = window.set_size(LogicalSize::new(work_w, work_h));

    // Window-local panel coords = screen coords minus the work-area origin.
    let payload = PickerAnchorEvent {
        x: panel.x - work_x,
        y: panel.y - work_y,
        width: panel.width,
        height: panel.height,
    };

    // A close leaves the backdrop click-through; restore input before showing.
    // The startup compositor warmup leaves the window non-focusable — restore
    // that too in case an open lands mid-warmup.
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.set_focusable(true);
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    // Show FIRST so a hidden/suspended WebView2 has resumed before the event.
    if let Err(err) = payload.emit(app) {
        log::warn!("failed to emit picker:anchor: {err}");
    }

    // First-open and long-idle race: re-emit the anchor a few times. Duplicate
    // anchors are idempotent; the sequence guard cancels stale retries after a
    // close or re-open.
    let app2 = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        for delay_ms in PICKER_ANCHOR_REEMIT_MS {
            let target = Duration::from_millis(*delay_ms);
            let elapsed = started.elapsed();
            if target > elapsed {
                std::thread::sleep(target - elapsed);
            }
            if PICKER_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            if let Err(err) = payload.emit(&app2) {
                log::warn!("failed to re-emit picker:anchor: {err}");
            }
        }
    });
}

/// Convert a trigger rect reported in the OPENER window's viewport coords into
/// a screen-space anchor (logical px).
pub(crate) fn anchor_from_rect(
    opener: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> PickerAnchor {
    let (ox, oy) = client_origin_logical(opener);
    let screen_left = ox + x;
    let screen_top = oy + y;
    PickerAnchor {
        screen_left,
        screen_right: screen_left + width,
        screen_top,
        screen_bottom: screen_top + height,
    }
}

/// Resolve the OPENER window — the one whose viewport the trigger rect is
/// measured in. The calling webview is the opener unless it IS the picker
/// window (a re-emit); never anchor a picker to itself.
pub(crate) fn resolve_opener(
    app: &AppHandle,
    caller: &tauri::WebviewWindow,
    picker: &str,
) -> Option<tauri::WebviewWindow> {
    if caller.label() != picker {
        return Some(caller.clone());
    }
    app.get_webview_window("main")
}

#[cfg(test)]
mod tests {
    use super::super::PickerAnchor;
    use super::{
        ANCHOR_GAP, PICKER_MIN_HEIGHT, TASKBAR_MARGIN, clamp_into_work_area, compute_panel,
        compute_x_axis, compute_y_axis,
    };

    #[test]
    fn y_axis_glues_above_trigger_when_more_room_above() {
        // Trigger low on the screen: far more room above than below → open above.
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 900.0,
            screen_bottom: 952.0,
        };
        let (y, h) = compute_y_axis(anchor, 420.0, 0.0, 1080.0, PICKER_MIN_HEIGHT);
        assert_eq!(y + h + ANCHOR_GAP, anchor.screen_top);
        assert_eq!(h, 420.0);
    }

    #[test]
    fn y_axis_opens_below_when_more_room_below() {
        // Trigger near the top: little room above, lots below → open below.
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 40.0,
            screen_bottom: 92.0,
        };
        let (y, h) = compute_y_axis(anchor, 420.0, 0.0, 1080.0, PICKER_MIN_HEIGHT);
        assert_eq!(y, anchor.screen_bottom + ANCHOR_GAP);
        assert_eq!(h, 420.0);
    }

    #[test]
    fn y_axis_shrinks_to_ceiling() {
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 1080.0,
            screen_bottom: 1132.0,
        };
        let (_y, h) = compute_y_axis(anchor, 5000.0, 0.0, 1080.0, PICKER_MIN_HEIGHT);
        assert_eq!(h, 1080.0 - TASKBAR_MARGIN);
    }

    #[test]
    fn x_axis_right_aligns_and_clamps() {
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 500.0,
            screen_top: 900.0,
            screen_bottom: 952.0,
        };
        assert_eq!(compute_x_axis(anchor, 200.0, 0.0, 1920.0), 300.0);
        let near_left = PickerAnchor {
            screen_left: 0.0,
            screen_right: 50.0,
            screen_top: 900.0,
            screen_bottom: 952.0,
        };
        assert_eq!(compute_x_axis(near_left, 200.0, 0.0, 1920.0), 0.0);
    }

    #[test]
    fn panel_stays_inside_work_area() {
        let anchor = PickerAnchor {
            screen_left: 1900.0,
            screen_right: 1920.0,
            screen_top: 1070.0,
            screen_bottom: 1122.0,
        };
        let panel = compute_panel(
            anchor,
            (360.0, 420.0),
            (0.0, 0.0, 1920.0, 1080.0),
            PICKER_MIN_HEIGHT,
        );
        assert!(panel.x >= 0.0);
        assert!(panel.x + panel.width <= 1920.0 + 0.01);
        assert!(panel.y >= 0.0);
    }

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
