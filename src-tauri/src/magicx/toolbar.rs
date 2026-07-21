//! Magic Toolbar (FEATURE-PARITY F9.2-F9.4) — a tiny floating toolbar (Dark /
//! Gray / Close) that appears when the cursor hovers the top-center of a window,
//! driven by `settings.magicx` (`toolbar_enabled`, `toolbar_color`,
//! `toolbar_align`, `toolbar_offset`, `toolbar_delay_ms`).
//!
//! ## Seam (frozen)
//! - [`init`] — start the hover tracker (slice) and remember state.
//! - [`current_target`] — the window the toolbar is currently attached to (the
//!   default effect target for `magicx_toggle_effect`). `None` when hidden.
//! - [`set_target`] — record the attached window (slice, on show/hide).
//!
//! ## What this slice implements
//! [`init`] spawns a ~150 ms hover tracker (Windows-only) that, while
//! `settings.magicx.enabled` and `toolbar_enabled`:
//!   1. samples the foreground window (`GetForegroundWindow` + `GetWindowRect`)
//!      and the cursor (`GetCursorPos`), skipping our own windows, minimized
//!      windows, and zero-size rects,
//!   2. computes a small hover zone at the window's TOP edge, aligned per
//!      `toolbar_align` + `toolbar_offset` (the pure geometry in [`geometry`]),
//!   3. once the cursor dwells in that zone for `toolbar_delay_ms`, positions +
//!      shows the prewarmed `magic-toolbar` window there (non-activating),
//!      records the target via [`set_target`], and emits
//!      `magictoolbar:show { x, y, target_dark, target_gray }`
//!      ([`crate::events::MagicToolbarShowEvent`], flags from
//!      [`super::engine::state_of`]),
//!   4. hides the window (+ emits `magictoolbar:hide`,
//!      [`crate::events::MagicToolbarHideEvent`]) and clears the target when the
//!      cursor leaves the zone or the foreground window changes.
//!
//! The per-window pixel effect itself lives in [`super::engine`] (this slice
//! only drives its seam). Off Windows [`init`] is inert.

use std::sync::Mutex;

use tauri::AppHandle;

use super::Hwnd;

/// The window the toolbar is currently attached to (`None` when hidden).
static TARGET: Mutex<Option<Hwnd>> = Mutex::new(None);

/// Start the hover tracker. On Windows this spawns the polling watcher thread;
/// elsewhere it is inert. Called from [`super::init`]; idempotent.
pub fn init(app: &AppHandle) {
    #[cfg(windows)]
    windows_impl::start(app.clone());
    #[cfg(not(windows))]
    let _ = app;
}

/// The window the toolbar is attached to (the default effect target), or `None`.
pub fn current_target() -> Option<Hwnd> {
    (*TARGET.lock().unwrap_or_else(|p| p.into_inner())).filter(|&h| h != 0)
}

/// Record (or clear) the attached window. The slice calls this on toolbar
/// show/hide so `magicx_toggle_effect` / `magicx_clear_target` act on the right
/// window.
pub fn set_target(hwnd: Option<Hwnd>) {
    *TARGET.lock().unwrap_or_else(|p| p.into_inner()) = hwnd.filter(|&h| h != 0);
}

// ── Pure geometry (unit-tested on every platform) ───────────────────────────

/// Toolbar placement math, kept free of any Win32 dependency so the alignment /
/// offset / hover-zone logic is unit-tested on every platform. All values are
/// logical pixels; the watcher converts the physical Win32 rects/cursor to
/// logical via the target monitor's scale factor before calling in.
#[cfg(any(windows, test))]
mod geometry {
    /// Toolbar footprint (logical px) — mirrors the `magic-toolbar`
    /// `WINDOW_SPECS` entry (132×36).
    pub(super) const TB_WIDTH: f64 = 132.0;
    /// Horizontal slack added to each side of the toolbar for the hover zone.
    const HOVER_PAD_X: f64 = 20.0;
    /// Height of the top-edge band that triggers / keeps the toolbar (covers the
    /// 36 px toolbar plus slack so the cursor stays "inside" while on it).
    const HOVER_ZONE_HEIGHT: f64 = 46.0;

    /// Toolbar alignment on the target window (FEATURE-PARITY F9.3).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Align {
        Center,
        Left,
        Right,
    }

    impl Align {
        /// Parse the `settings.magicx.toolbar_align` wire string (`left`/`right`,
        /// anything else → `center`).
        pub(super) fn from_wire(value: &str) -> Self {
            match value.trim().to_ascii_lowercase().as_str() {
                "left" => Self::Left,
                "right" => Self::Right,
                _ => Self::Center,
            }
        }
    }

    /// The toolbar's desired left edge (logical px) for a window spanning
    /// `[win_left, win_right]`, before clamping into the window.
    pub(super) fn toolbar_left(
        win_left: f64,
        win_right: f64,
        tb_width: f64,
        align: Align,
        offset: f64,
    ) -> f64 {
        match align {
            Align::Center => (win_left + win_right) / 2.0 - tb_width / 2.0 + offset,
            Align::Left => win_left + offset,
            Align::Right => win_right - tb_width - offset,
        }
    }

    /// Clamp the toolbar's left edge so the whole toolbar stays within the
    /// window horizontally (a large offset can never push it off the window).
    pub(super) fn clamp_toolbar_left(
        desired: f64,
        win_left: f64,
        win_right: f64,
        tb_width: f64,
    ) -> f64 {
        let max_left = (win_right - tb_width).max(win_left);
        desired.clamp(win_left, max_left)
    }

    /// A hover/keep-alive rectangle (logical px), half-open on the right/bottom.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub(super) struct Zone {
        pub(super) left: f64,
        pub(super) top: f64,
        pub(super) right: f64,
        pub(super) bottom: f64,
    }

    /// The top-edge hover zone around the toolbar's landing area, clamped
    /// horizontally into the window so hovering just outside it never triggers.
    pub(super) fn hover_zone(
        win_left: f64,
        win_top: f64,
        win_right: f64,
        toolbar_left: f64,
        tb_width: f64,
    ) -> Zone {
        let left = (toolbar_left - HOVER_PAD_X).max(win_left);
        let right = (toolbar_left + tb_width + HOVER_PAD_X).min(win_right);
        Zone {
            left,
            top: win_top,
            right,
            bottom: win_top + HOVER_ZONE_HEIGHT,
        }
    }

    /// Whether `(x, y)` falls inside `zone` (half-open on right/bottom).
    pub(super) fn zone_contains(zone: Zone, x: f64, y: f64) -> bool {
        x >= zone.left && x < zone.right && y >= zone.top && y < zone.bottom
    }
}

// ── Windows hover tracker ────────────────────────────────────────────────────

#[cfg(windows)]
mod windows_impl {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Manager, PhysicalPosition};
    use tauri_specta::Event as _;
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    };

    use super::geometry::{
        Align, TB_WIDTH, clamp_toolbar_left, hover_zone, toolbar_left, zone_contains,
    };
    use super::{Hwnd, set_target};
    use crate::events::{MagicToolbarHideEvent, MagicToolbarShowEvent};
    use crate::magicx::engine;

    /// The `magic-toolbar` window label (see `windows::WINDOW_SPECS`).
    const LABEL: &str = "magic-toolbar";
    /// How often the tracker samples the cursor / foreground window.
    const POLL_MS: u64 = 150;
    /// Delay before the OS window hides after `magictoolbar:hide` — long enough
    /// for the renderer's exit frame to composite before the native hide.
    const HIDE_GRACE_MS: u64 = 130;

    /// One-shot guard so [`start`] spawns the watcher at most once.
    static STARTED: AtomicBool = AtomicBool::new(false);
    /// Monotonic show/hide counter: a delayed hide only fires while still
    /// current, so a re-show (which bumps it) cancels the pending hide.
    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// Spawn the detached hover watcher (dies with the process). Idempotent.
    pub(super) fn start(app: AppHandle) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("magic-toolbar".into())
            .spawn(move || watcher_loop(&app));
        if let Err(err) = spawned {
            log::warn!("[magicx] failed to start toolbar watcher: {err}");
            STARTED.store(false, Ordering::SeqCst);
        }
    }

    /// The toolbar's current shown state (its target + last-emitted effect
    /// flags + a small re-emit budget for the first-show listener race).
    struct Shown {
        target: Hwnd,
        dark: bool,
        gray: bool,
        reasserts: u8,
    }

    /// Poll the cursor + foreground window forever, showing/hiding the toolbar.
    /// Re-reads the settings snapshot each tick so enabling/disabling MagicX or
    /// editing the toolbar options takes effect without a restart.
    fn watcher_loop(app: &AppHandle) {
        let mut shown: Option<Shown> = None;
        let mut hover: Option<(Hwnd, Instant)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            let settings = crate::settings::store::read_settings(app);
            let magicx = &settings.magicx;
            if !(magicx.enabled && magicx.toolbar_enabled) {
                if shown.take().is_some() {
                    hide(app);
                }
                hover = None;
                continue;
            }

            let align = Align::from_wire(&magicx.toolbar_align);
            let offset = f64::from(magicx.toolbar_offset);
            let delay = Duration::from_millis(u64::from(magicx.toolbar_delay_ms));

            // Foreground target (skip our own windows, minimized, zero-size).
            let Some((fg, rect, is_self)) = foreground_target() else {
                if shown.take().is_some() {
                    hide(app);
                }
                hover = None;
                continue;
            };
            if is_self {
                if shown.take().is_some() {
                    hide(app);
                }
                hover = None;
                continue;
            }

            let Some((cursor_x, cursor_y, scale)) = cursor_logical(app, &rect) else {
                continue;
            };
            let win_left = f64::from(rect.left) / scale;
            let win_top = f64::from(rect.top) / scale;
            let win_right = f64::from(rect.right) / scale;
            let desired_left = toolbar_left(win_left, win_right, TB_WIDTH, align, offset);
            let tb_left = clamp_toolbar_left(desired_left, win_left, win_right, TB_WIDTH);
            let zone = hover_zone(win_left, win_top, win_right, tb_left, TB_WIDTH);
            let inside = zone_contains(zone, cursor_x, cursor_y);

            match shown {
                // Still hovering the same window's zone — stay up; refresh the
                // button-highlight state and re-assert the show for the race.
                Some(ref mut s) if s.target == fg && inside => {
                    let (dark, gray) = engine::state_of(fg);
                    if s.reasserts > 0 || dark != s.dark || gray != s.gray {
                        emit_show(app, tb_left, win_top, scale, dark, gray);
                        s.dark = dark;
                        s.gray = gray;
                        s.reasserts = s.reasserts.saturating_sub(1);
                    }
                }
                // Foreground changed or the cursor left the zone — hide.
                Some(_) => {
                    shown = None;
                    hide(app);
                    hover = if inside {
                        Some((fg, Instant::now()))
                    } else {
                        None
                    };
                }
                // Not shown — dwell-detect, then show once the delay elapses.
                None => {
                    if inside {
                        let dwelled = match hover {
                            Some((h, since)) if h == fg => since.elapsed() >= delay,
                            _ => {
                                hover = Some((fg, Instant::now()));
                                false
                            }
                        };
                        if dwelled {
                            let (dark, gray) = engine::state_of(fg);
                            set_target(Some(fg));
                            show(app, tb_left, win_top, scale);
                            emit_show(app, tb_left, win_top, scale, dark, gray);
                            shown = Some(Shown {
                                target: fg,
                                dark,
                                gray,
                                reasserts: 2,
                            });
                            hover = None;
                        }
                    } else {
                        hover = None;
                    }
                }
            }
        }
    }

    /// The foreground window as `(hwnd, rect, is_self)`, or `None` when there is
    /// no usable target (no focus, minimized, or a zero-size rect).
    fn foreground_target() -> Option<(Hwnd, RECT, bool)> {
        // SAFETY: returns the foreground HWND or a null handle (no focus).
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        // SAFETY: `hwnd` is a valid window handle.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return None;
        }
        let mut rect = RECT::default();
        // SAFETY: `hwnd` valid; `rect` is a live out-param.
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
            return None;
        }
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        let mut pid: u32 = 0;
        // SAFETY: `hwnd` valid; `pid` is a live out-param.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let is_self = pid == std::process::id();
        Some((hwnd.0 as Hwnd, rect, is_self))
    }

    /// The cursor position converted to logical px on the target's monitor, plus
    /// that monitor's scale factor. `None` when the cursor can't be read.
    fn cursor_logical(app: &AppHandle, rect: &RECT) -> Option<(f64, f64, f64)> {
        let mut point = POINT::default();
        // SAFETY: `point` is a live out-param.
        if unsafe { GetCursorPos(&mut point) }.is_err() {
            return None;
        }
        let scale = scale_for_rect(app, rect);
        Some((
            f64::from(point.x) / scale,
            f64::from(point.y) / scale,
            scale,
        ))
    }

    /// The scale factor of the monitor containing the target window's centre,
    /// falling back to the primary monitor's (or 1.0).
    fn scale_for_rect(app: &AppHandle, rect: &RECT) -> f64 {
        let center_x = (rect.left + rect.right) / 2;
        let center_y = (rect.top + rect.bottom) / 2;
        if let Ok(monitors) = app.available_monitors() {
            for monitor in monitors {
                let pos = monitor.position();
                let size = monitor.size();
                if center_x >= pos.x
                    && center_x < pos.x + size.width as i32
                    && center_y >= pos.y
                    && center_y < pos.y + size.height as i32
                {
                    return monitor.scale_factor();
                }
            }
        }
        app.primary_monitor()
            .ok()
            .flatten()
            .map_or(1.0, |m| m.scale_factor())
    }

    /// Physical top-left the toolbar is placed at (logical position × scale;
    /// `win_top` logical × scale is the original physical rect top).
    fn physical_position(tb_left: f64, win_top: f64, scale: f64) -> (i32, i32) {
        (
            (tb_left * scale).round() as i32,
            (win_top * scale).round() as i32,
        )
    }

    /// Position + show the prewarmed toolbar window (non-activating: never
    /// focused). Runs the native ops on the main thread.
    fn show(app: &AppHandle, tb_left: f64, win_top: f64, scale: f64) {
        SEQ.fetch_add(1, Ordering::SeqCst);
        let (x, y) = physical_position(tb_left, win_top, scale);
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.set_position(PhysicalPosition::new(x, y));
                let _ = window.show();
                let _ = window.set_always_on_top(true);
                // Deliberately NO set_focus(): the toolbar must never activate.
            }
        });
    }

    /// Emit `magictoolbar:show` with the toolbar's physical position + the
    /// target's effect flags (so the renderer highlights the active buttons).
    fn emit_show(app: &AppHandle, tb_left: f64, win_top: f64, scale: f64, dark: bool, gray: bool) {
        let (x, y) = physical_position(tb_left, win_top, scale);
        if let Err(err) = (MagicToolbarShowEvent {
            x,
            y,
            target_dark: dark,
            target_gray: gray,
        })
        .emit(app)
        {
            log::warn!("[magicx] failed to emit magictoolbar:show: {err}");
        }
    }

    /// Clear the target, emit `magictoolbar:hide` (renderer plays its exit), and
    /// hide the OS window after the exit grace — unless a re-show took over.
    fn hide(app: &AppHandle) {
        set_target(None);
        let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        if let Err(err) = (MagicToolbarHideEvent {}).emit(app) {
            log::warn!("[magicx] failed to emit magictoolbar:hide: {err}");
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(HIDE_GRACE_MS));
            if SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            let _ = app.clone().run_on_main_thread(move || {
                if SEQ.load(Ordering::SeqCst) != seq {
                    return;
                }
                if let Some(window) = app.get_webview_window(LABEL) {
                    let _ = window.hide();
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use geometry::{Align, TB_WIDTH, clamp_toolbar_left, hover_zone, toolbar_left, zone_contains};

    #[test]
    fn target_round_trips_and_ignores_zero() {
        set_target(None);
        assert_eq!(current_target(), None);
        set_target(Some(1234));
        assert_eq!(current_target(), Some(1234));
        set_target(Some(0));
        assert_eq!(current_target(), None);
        set_target(None);
    }

    #[test]
    fn align_parses_from_wire() {
        assert_eq!(Align::from_wire("center"), Align::Center);
        assert_eq!(Align::from_wire("LEFT"), Align::Left);
        assert_eq!(Align::from_wire(" right "), Align::Right);
        assert_eq!(Align::from_wire("nonsense"), Align::Center);
    }

    #[test]
    fn toolbar_left_centres_and_offsets() {
        // Window 0..1000, toolbar 132 → centred left = 434.
        assert_eq!(
            toolbar_left(0.0, 1000.0, TB_WIDTH, Align::Center, 0.0),
            434.0
        );
        // Offset shifts the centred toolbar right.
        assert_eq!(
            toolbar_left(0.0, 1000.0, TB_WIDTH, Align::Center, 40.0),
            474.0
        );
        // Left-aligned = window left + offset.
        assert_eq!(
            toolbar_left(100.0, 900.0, TB_WIDTH, Align::Left, 12.0),
            112.0
        );
        // Right-aligned = window right − toolbar − offset.
        assert_eq!(
            toolbar_left(0.0, 1000.0, TB_WIDTH, Align::Right, 20.0),
            1000.0 - 132.0 - 20.0
        );
    }

    #[test]
    fn clamp_keeps_toolbar_within_window() {
        // A huge left offset can't push the toolbar off the right edge.
        assert_eq!(
            clamp_toolbar_left(5000.0, 0.0, 1000.0, TB_WIDTH),
            1000.0 - 132.0
        );
        // A negative position clamps back to the window left.
        assert_eq!(clamp_toolbar_left(-50.0, 0.0, 1000.0, TB_WIDTH), 0.0);
        // A window narrower than the toolbar pins to the left edge.
        assert_eq!(clamp_toolbar_left(80.0, 0.0, 100.0, TB_WIDTH), 0.0);
    }

    #[test]
    fn hover_zone_bands_the_top_edge_and_clamps() {
        // Centred toolbar (left 434) in a 0..1000 window at top 200.
        let zone = hover_zone(0.0, 200.0, 1000.0, 434.0, TB_WIDTH);
        assert_eq!(zone.left, 434.0 - 20.0);
        assert_eq!(zone.right, 434.0 + 132.0 + 20.0);
        assert_eq!(zone.top, 200.0);
        assert_eq!(zone.bottom, 200.0 + 46.0);

        // A left-aligned toolbar's zone can't extend past the window's left.
        let clamped = hover_zone(100.0, 0.0, 900.0, 100.0, TB_WIDTH);
        assert_eq!(clamped.left, 100.0);
    }

    #[test]
    fn zone_contains_is_half_open() {
        let zone = hover_zone(0.0, 0.0, 1000.0, 434.0, TB_WIDTH);
        // Cursor over the toolbar's top edge is inside.
        assert!(zone_contains(zone, 500.0, 10.0));
        // Just below the band is outside.
        assert!(!zone_contains(zone, 500.0, 60.0));
        // The right edge is exclusive.
        assert!(!zone_contains(zone, zone.right, 10.0));
        // Far to the side is outside.
        assert!(!zone_contains(zone, 50.0, 10.0));
    }
}
