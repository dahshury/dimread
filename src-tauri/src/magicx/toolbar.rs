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
//! [`init`] spawns an event-driven hover tracker (Windows-only) that, while
//! `settings.magicx.enabled` and `toolbar_enabled`:
//!   1. reacts to foreground/window accessibility callbacks plus a low-level
//!      mouse-move hook, skipping our own windows, minimized windows, and
//!      zero-size rects,
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

use tauri::{AppHandle, Manager};

use super::Hwnd;

/// The window the toolbar is currently attached to (`None` when hidden).
static TARGET: Mutex<Option<Hwnd>> = Mutex::new(None);

/// Start the hover tracker. On Windows this spawns the native-hook watcher;
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

/// Re-emit the current target's effect flags after the effect engine mutates.
/// This explicit callback replaces the old periodic toolbar-state reassertion.
pub(crate) fn refresh_effect_state() {
    #[cfg(windows)]
    windows_impl::request_effect_refresh();
}

/// Renderer subscribe handshake: re-emit the current shown state only after the
/// webview confirms both toolbar listeners are registered.
#[tauri::command]
#[specta::specta]
pub fn magictoolbar_renderer_ready() {
    #[cfg(windows)]
    windows_impl::request_renderer_sync();
}

/// Renderer exit-animation callback. The target guard makes a late completion
/// harmless if the toolbar was shown again before the old exit finished.
#[tauri::command]
#[specta::specta]
pub fn magictoolbar_hide_complete(app: AppHandle) {
    if current_target().is_some() {
        return;
    }
    if let Some(window) = app.get_webview_window("magic-toolbar") {
        let _ = window.hide();
    }
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
    /// Horizontal slack added to each side of the toolbar for the TRIGGER zone.
    const HOVER_PAD_X: f64 = 20.0;
    /// Height of the top-edge band that triggers the toolbar.
    const HOVER_ZONE_HEIGHT: f64 = 46.0;
    /// Horizontal slack for the KEEP-ALIVE zone, once the toolbar is up.
    const KEEP_PAD_X: f64 = 56.0;
    /// Height of the keep-alive band. Deliberately much taller than the trigger
    /// band: without hysteresis the two are the same rectangle, so a few pixels
    /// of cursor drift dismisses the toolbar and re-triggers it, which reads as
    /// hard flicker and eats clicks (the toolbar vanishes under the press).
    /// The gap between the bands is what makes dismissal deliberate.
    const KEEP_ZONE_HEIGHT: f64 = 120.0;

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
        zone_with(
            win_left,
            win_top,
            win_right,
            toolbar_left,
            tb_width,
            HOVER_PAD_X,
            HOVER_ZONE_HEIGHT,
        )
    }

    /// The larger band that KEEPS an already-visible toolbar alive. Always a
    /// superset of [`hover_zone`], so a cursor that just triggered the toolbar
    /// can never be outside it.
    pub(super) fn keep_zone(
        win_left: f64,
        win_top: f64,
        win_right: f64,
        toolbar_left: f64,
        tb_width: f64,
    ) -> Zone {
        zone_with(
            win_left,
            win_top,
            win_right,
            toolbar_left,
            tb_width,
            KEEP_PAD_X,
            KEEP_ZONE_HEIGHT,
        )
    }

    /// Shared band builder: `pad_x` of horizontal slack each side (clamped into
    /// the window) and `height` downward from the window's top edge.
    fn zone_with(
        win_left: f64,
        win_top: f64,
        win_right: f64,
        toolbar_left: f64,
        tb_width: f64,
        pad_x: f64,
        height: f64,
    ) -> Zone {
        let left = (toolbar_left - pad_x).max(win_left);
        let right = (toolbar_left + tb_width + pad_x).min(win_right);
        Zone {
            left,
            top: win_top,
            right,
            bottom: win_top + height,
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
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
    use tauri::{AppHandle, Listener, Manager, PhysicalPosition};
    use tauri_specta::Event as _;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        CHILDID_SELF, CallNextHookEx, DispatchMessageW, EVENT_OBJECT_DESTROY,
        EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND,
        EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART,
        GetCursorPos, GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowThreadProcessId,
        HC_ACTION, HHOOK, IsIconic, KillTimer, MSG, MSLLHOOKSTRUCT, OBJID_WINDOW, PM_NOREMOVE,
        PeekMessageW, PostThreadMessageW, SetTimer, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WM_APP, WM_MOUSEMOVE, WM_TIMER,
    };

    use super::geometry::{
        Align, TB_WIDTH, clamp_toolbar_left, hover_zone, keep_zone, toolbar_left, zone_contains,
    };
    use super::{Hwnd, current_target, set_target};
    use crate::events::{MagicToolbarHideEvent, MagicToolbarShowEvent};
    use crate::magicx::engine;

    /// The `magic-toolbar` window label (see `windows::WINDOW_SPECS`).
    const LABEL: &str = "magic-toolbar";
    /// One-shot guard so [`start`] spawns the watcher at most once.
    static STARTED: AtomicBool = AtomicBool::new(false);
    const SETTINGS_CHANGED_MESSAGE: u32 = WM_APP + 1;
    const CURSOR_MOVED_MESSAGE: u32 = WM_APP + 2;
    const WINDOW_CHANGED_MESSAGE: u32 = WM_APP + 3;
    const EFFECT_CHANGED_MESSAGE: u32 = WM_APP + 4;
    const RENDERER_READY_MESSAGE: u32 = WM_APP + 5;

    static WATCHER_THREAD_ID: AtomicU32 = AtomicU32::new(0);
    static CURSOR_PENDING: AtomicBool = AtomicBool::new(false);
    static WINDOW_PENDING: AtomicBool = AtomicBool::new(false);
    static CURSOR_X: AtomicI32 = AtomicI32::new(0);
    static CURSOR_Y: AtomicI32 = AtomicI32::new(0);

    /// Spawn the detached hover watcher (dies with the process). Idempotent.
    pub(super) fn start(app: AppHandle) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = app.listen_any("settings:changed", |_event| {
            post_message(SETTINGS_CHANGED_MESSAGE);
        });
        let spawned = std::thread::Builder::new()
            .name("magic-toolbar".into())
            .spawn(move || watcher_loop(app));
        if let Err(err) = spawned {
            log::warn!("[magicx] failed to start toolbar watcher: {err}");
            STARTED.store(false, Ordering::SeqCst);
        }
    }

    /// The toolbar's current shown state (target, last-emitted effect flags,
    /// and position) cached for the renderer-ready callback.
    struct Shown {
        target: Hwnd,
        dark: bool,
        gray: bool,
        x: i32,
        y: i32,
    }

    #[derive(Clone, Copy)]
    struct Config {
        enabled: bool,
        align: Align,
        offset: f64,
        delay_ms: u32,
    }

    impl Config {
        fn read(app: &AppHandle) -> Self {
            let settings = crate::settings::store::read_settings(app);
            Self {
                enabled: settings.magicx.enabled && settings.magicx.toolbar_enabled,
                align: Align::from_wire(&settings.magicx.toolbar_align),
                offset: f64::from(settings.magicx.toolbar_offset),
                delay_ms: settings.magicx.toolbar_delay_ms,
            }
        }
    }

    struct WatcherState {
        app: AppHandle,
        config: Config,
        shown: Option<Shown>,
        hover_target: Option<Hwnd>,
        dwell_timer: usize,
        dwell_ready: bool,
    }

    thread_local! {
        static STATE: RefCell<Option<WatcherState>> = const { RefCell::new(None) };
    }

    pub(super) fn request_effect_refresh() {
        post_message(EFFECT_CHANGED_MESSAGE);
    }

    pub(super) fn request_renderer_sync() {
        post_message(RENDERER_READY_MESSAGE);
    }

    fn post_message(message: u32) {
        let thread_id = WATCHER_THREAD_ID.load(Ordering::Acquire);
        if thread_id != 0 {
            // SAFETY: posting to a thread queue is race-safe; failure means the
            // process-lifetime watcher has not started or is already gone.
            let _ = unsafe { PostThreadMessageW(thread_id, message, WPARAM(0), LPARAM(0)) };
        }
    }

    fn watcher_loop(app: AppHandle) {
        STATE.set(Some(WatcherState {
            config: Config::read(&app),
            app,
            shown: None,
            hover_target: None,
            dwell_timer: 0,
            dwell_ready: false,
        }));

        let mut probe = MSG::default();
        // SAFETY: materialize the queue before publishing the thread id.
        unsafe {
            let _ = PeekMessageW(&mut probe, None, 0, 0, PM_NOREMOVE);
        }
        let thread_id = unsafe { GetCurrentThreadId() };
        WATCHER_THREAD_ID.store(thread_id, Ordering::Release);

        let win_hooks = install_win_event_hooks();
        let mouse_hook = install_mouse_hook();
        sync(None);
        pump_messages();

        STATE.with_borrow_mut(|slot| {
            if let Some(state) = slot.as_mut() {
                cancel_dwell(state);
            }
            *slot = None;
        });
        if let Some(hook) = mouse_hook {
            unsafe {
                let _ = UnhookWindowsHookEx(hook);
            }
        }
        for hook in win_hooks {
            unsafe {
                let _ = UnhookWinEvent(hook);
            }
        }
        let _ =
            WATCHER_THREAD_ID.compare_exchange(thread_id, 0, Ordering::AcqRel, Ordering::Acquire);
    }

    fn pump_messages() {
        let mut msg = MSG::default();
        loop {
            let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };
            if result.0 <= 0 {
                return;
            }
            match msg.message {
                SETTINGS_CHANGED_MESSAGE => {
                    STATE.with_borrow_mut(|slot| {
                        if let Some(state) = slot.as_mut() {
                            state.config = Config::read(&state.app);
                            cancel_dwell(state);
                            state.hover_target = None;
                        }
                    });
                    sync(None);
                }
                CURSOR_MOVED_MESSAGE => {
                    CURSOR_PENDING.store(false, Ordering::Release);
                    sync(Some(POINT {
                        x: CURSOR_X.load(Ordering::Acquire),
                        y: CURSOR_Y.load(Ordering::Acquire),
                    }));
                }
                WINDOW_CHANGED_MESSAGE => {
                    WINDOW_PENDING.store(false, Ordering::Release);
                    sync(None);
                }
                EFFECT_CHANGED_MESSAGE => refresh_effect_flags(),
                RENDERER_READY_MESSAGE => reemit_shown(),
                WM_TIMER if consume_dwell_timer(msg.wParam.0) => sync(None),
                _ => unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                },
            }
        }
    }

    fn consume_dwell_timer(timer: usize) -> bool {
        STATE.with_borrow_mut(|slot| {
            let Some(state) = slot.as_mut() else {
                return false;
            };
            if state.dwell_timer == 0 || state.dwell_timer != timer {
                return false;
            }
            unsafe {
                let _ = KillTimer(None, timer);
            }
            state.dwell_timer = 0;
            state.dwell_ready = true;
            true
        })
    }

    fn sync(cursor: Option<POINT>) {
        STATE.with_borrow_mut(|slot| {
            let Some(state) = slot.as_mut() else {
                return;
            };
            if !state.config.enabled {
                if state.shown.take().is_some() {
                    hide_because(&state.app, "MagicX/toolbar switched off");
                }
                clear_hover(state);
                return;
            }
            let Some((fg, native, rect, is_self)) = foreground_target() else {
                if state.shown.take().is_some() {
                    hide_because(&state.app, "no usable foreground window");
                }
                clear_hover(state);
                return;
            };
            if is_self {
                if state.shown.take().is_some() {
                    hide_because(&state.app, "foreground is one of our own windows");
                }
                clear_hover(state);
                return;
            }
            let Some((cursor_x, cursor_y, scale)) = cursor_logical(native, cursor) else {
                return;
            };
            let win_left = f64::from(rect.left) / scale;
            let win_top = f64::from(rect.top) / scale;
            let win_right = f64::from(rect.right) / scale;
            let desired = toolbar_left(
                win_left,
                win_right,
                TB_WIDTH,
                state.config.align,
                state.config.offset,
            );
            let tb_left = clamp_toolbar_left(desired, win_left, win_right, TB_WIDTH);
            // Trigger on the tight band, but stay alive across the loose one
            // (hysteresis) so drifting a few pixels can't dismiss the toolbar
            // out from under a click.
            let zone = keep_zone(win_left, win_top, win_right, tb_left, TB_WIDTH);
            let inside = zone_contains(zone, cursor_x, cursor_y);
            let trigger_zone = hover_zone(win_left, win_top, win_right, tb_left, TB_WIDTH);
            let inside_trigger = zone_contains(trigger_zone, cursor_x, cursor_y);
            let (x, y) = physical_position(tb_left, win_top, scale);

            if let Some(shown) = state.shown.as_mut() {
                if shown.target == fg && inside {
                    if shown.x != x || shown.y != y {
                        show(&state.app, x, y);
                        shown.x = x;
                        shown.y = y;
                    }
                    return;
                }
                let reason = if shown.target != fg {
                    format!("foreground changed {:#x} -> {fg:#x}", shown.target)
                } else {
                    format!(
                        "cursor ({cursor_x:.0}, {cursor_y:.0}) left zone \
                         [{:.0},{:.0}]x[{:.0},{:.0}]",
                        zone.left, zone.right, zone.top, zone.bottom
                    )
                };
                state.shown = None;
                hide_because(&state.app, &reason);
                clear_hover(state);
            }

            if !inside_trigger {
                clear_hover(state);
                return;
            }
            if state.hover_target != Some(fg) {
                cancel_dwell(state);
                state.hover_target = Some(fg);
                state.dwell_ready = state.config.delay_ms == 0;
                if !state.dwell_ready {
                    state.dwell_timer =
                        unsafe { SetTimer(None, 0, state.config.delay_ms.max(1), None) };
                    if state.dwell_timer == 0 {
                        log::warn!("[magicx] failed to arm toolbar dwell timer");
                    }
                }
            }
            if !state.dwell_ready {
                return;
            }

            let (dark, gray) = engine::state_of(fg);
            set_target(Some(fg));
            show(&state.app, x, y);
            emit_show(&state.app, x, y, dark, gray);
            state.shown = Some(Shown {
                target: fg,
                dark,
                gray,
                x,
                y,
            });
            clear_hover(state);
        });
    }

    fn refresh_effect_flags() {
        STATE.with_borrow_mut(|slot| {
            let Some(state) = slot.as_mut() else {
                return;
            };
            let Some(shown) = state.shown.as_mut() else {
                return;
            };
            let (dark, gray) = engine::state_of(shown.target);
            if dark == shown.dark && gray == shown.gray {
                return;
            }
            shown.dark = dark;
            shown.gray = gray;
            emit_show(&state.app, shown.x, shown.y, dark, gray);
        });
    }

    fn reemit_shown() {
        STATE.with_borrow(|slot| {
            let Some(state) = slot.as_ref() else {
                return;
            };
            let Some(shown) = state.shown.as_ref() else {
                // A hide may have landed before the renderer listeners were
                // installed. Reconcile the native window immediately.
                let app = state.app.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    if current_target().is_none()
                        && let Some(window) = app.get_webview_window(LABEL)
                    {
                        let _ = window.hide();
                    }
                });
                return;
            };
            emit_show(&state.app, shown.x, shown.y, shown.dark, shown.gray);
        });
    }

    fn clear_hover(state: &mut WatcherState) {
        cancel_dwell(state);
        state.hover_target = None;
        state.dwell_ready = false;
    }

    fn cancel_dwell(state: &mut WatcherState) {
        if state.dwell_timer != 0 {
            unsafe {
                let _ = KillTimer(None, state.dwell_timer);
            }
            state.dwell_timer = 0;
        }
        state.dwell_ready = false;
    }

    /// The foreground window as `(hwnd_id, native_hwnd, rect, is_self)`, or
    /// `None` when there is no usable target (no focus, minimized, or a
    /// zero-size rect). The first two fields are the SAME window in different
    /// forms — the numeric id the renderer speaks, then the raw Win32 handle —
    /// so the positional order is worth stating explicitly.
    fn foreground_target() -> Option<(Hwnd, HWND, RECT, bool)> {
        // SAFETY: returns the foreground HWND or a null handle (no focus).
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        // SAFETY: `hwnd` is a valid window handle.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return None;
        }
        let rect = frame_bounds(hwnd)?;
        let mut pid: u32 = 0;
        // SAFETY: `hwnd` valid; `pid` is a live out-param.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let is_self = pid == std::process::id();
        Some((hwnd.0 as Hwnd, hwnd, rect, is_self))
    }

    /// The target's on-screen bounds, preferring the DWM extended frame bounds
    /// over `GetWindowRect`. They differ: `GetWindowRect` includes the invisible
    /// resize border, so a MAXIMIZED window reports a top edge ~8 logical px
    /// above the visible frame — which parked the toolbar partly off-screen and
    /// wasted that much of the hover band. This also matches what the effect
    /// engine pins its magnifier host to (`engine_win::frame_bounds`).
    fn frame_bounds(target: HWND) -> Option<RECT> {
        let mut dwm_rect = RECT::default();
        // SAFETY: DWM writes a RECT into `dwm_rect`; the size is that of `RECT`.
        let dwm = unsafe {
            DwmGetWindowAttribute(
                target,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut dwm_rect as *mut RECT).cast(),
                core::mem::size_of::<RECT>() as u32,
            )
        };
        if dwm.is_ok() && dwm_rect.right > dwm_rect.left && dwm_rect.bottom > dwm_rect.top {
            return Some(dwm_rect);
        }
        let mut rect = RECT::default();
        // SAFETY: `target` valid; `rect` is a live out-param.
        if unsafe { GetWindowRect(target, &mut rect) }.is_err() {
            return None;
        }
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        Some(rect)
    }

    /// The cursor position converted to logical px on the target's monitor, plus
    /// that monitor's scale factor. `None` when the cursor can't be read.
    fn cursor_logical(target: HWND, supplied: Option<POINT>) -> Option<(f64, f64, f64)> {
        let point = match supplied {
            Some(point) => point,
            None => {
                let mut point = POINT::default();
                if unsafe { GetCursorPos(&mut point) }.is_err() {
                    return None;
                }
                point
            }
        };
        let dpi = unsafe { GetDpiForWindow(target) };
        let scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
        Some((
            f64::from(point.x) / scale,
            f64::from(point.y) / scale,
            scale,
        ))
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
    fn show(app: &AppHandle, x: i32, y: i32) {
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
    fn emit_show(app: &AppHandle, x: i32, y: i32, dark: bool, gray: bool) {
        log::debug!("[magicx] toolbar show at ({x}, {y}) dark={dark} gray={gray}");
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

    /// Clear the target and ask the renderer to play its exit. The renderer
    /// calls `magictoolbar_hide_complete` when that animation actually ends.
    /// [`hide`] with the triggering condition recorded — the toolbar
    /// disappearing at the wrong moment is the failure mode worth tracing.
    fn hide_because(app: &AppHandle, reason: &str) {
        log::debug!("[magicx] toolbar hide: {reason}");
        hide(app);
    }

    fn hide(app: &AppHandle) {
        set_target(None);
        if let Err(err) = (MagicToolbarHideEvent {}).emit(app) {
            log::warn!("[magicx] failed to emit magictoolbar:hide: {err}");
        }
    }

    fn install_win_event_hooks() -> Vec<HWINEVENTHOOK> {
        const RANGES: [(u32, u32); 4] = [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_LOCATIONCHANGE),
        ];
        let mut hooks = Vec::with_capacity(RANGES.len());
        for (min, max) in RANGES {
            let hook = unsafe {
                SetWinEventHook(
                    min,
                    max,
                    None,
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            if hook.0.is_null() {
                log::warn!("[magicx] toolbar WinEvent hook failed for {min:#x}..={max:#x}");
            } else {
                hooks.push(hook);
            }
        }
        hooks
    }

    unsafe extern "system" fn win_event_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if event >= EVENT_OBJECT_DESTROY
            && (id_object != OBJID_WINDOW.0 || id_child != CHILDID_SELF as i32)
        {
            return;
        }
        if event == EVENT_OBJECT_LOCATIONCHANGE && unsafe { GetForegroundWindow() } != hwnd {
            return;
        }
        if !WINDOW_PENDING.swap(true, Ordering::AcqRel) {
            post_message(WINDOW_CHANGED_MESSAGE);
        }
    }

    fn install_mouse_hook() -> Option<HHOOK> {
        let module = match unsafe { GetModuleHandleW(None) } {
            Ok(module) => module,
            Err(err) => {
                log::warn!("[magicx] failed to resolve toolbar hook module: {err}");
                return None;
            }
        };
        match unsafe {
            SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(mouse_hook_proc),
                Some(HINSTANCE(module.0)),
                0,
            )
        } {
            Ok(hook) => Some(hook),
            Err(err) => {
                log::warn!("[magicx] failed to install toolbar mouse hook: {err}");
                None
            }
        }
    }

    unsafe extern "system" fn mouse_hook_proc(
        code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 && w_param.0 as u32 == WM_MOUSEMOVE {
            // SAFETY: Windows supplies an `MSLLHOOKSTRUCT` for `WH_MOUSE_LL`
            // callbacks while this function is executing.
            let point = unsafe { (*(l_param.0 as *const MSLLHOOKSTRUCT)).pt };
            CURSOR_X.store(point.x, Ordering::Release);
            CURSOR_Y.store(point.y, Ordering::Release);
            if !CURSOR_PENDING.swap(true, Ordering::AcqRel) {
                post_message(CURSOR_MOVED_MESSAGE);
            }
        }
        unsafe { CallNextHookEx(None, code, w_param, l_param) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use geometry::{
        Align, TB_WIDTH, clamp_toolbar_left, hover_zone, keep_zone, toolbar_left, zone_contains,
    };

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
    fn keep_zone_is_a_strict_superset_of_the_trigger_zone() {
        // Hysteresis invariant: anything that can TRIGGER the toolbar must also
        // KEEP it, or it would dismiss itself the instant it appeared.
        let trigger = hover_zone(0.0, 200.0, 1000.0, 434.0, TB_WIDTH);
        let keep = keep_zone(0.0, 200.0, 1000.0, 434.0, TB_WIDTH);
        assert!(keep.left <= trigger.left);
        assert!(keep.right >= trigger.right);
        assert_eq!(keep.top, trigger.top);
        assert!(keep.bottom > trigger.bottom);

        // Every corner of the trigger band is inside the keep band.
        for (x, y) in [
            (trigger.left, trigger.top),
            (trigger.right - 1.0, trigger.top),
            (trigger.left, trigger.bottom - 1.0),
            (trigger.right - 1.0, trigger.bottom - 1.0),
        ] {
            assert!(zone_contains(keep, x, y), "keep zone missed ({x}, {y})");
        }
    }

    #[test]
    fn keep_zone_survives_drift_that_leaves_the_trigger_zone() {
        let trigger = hover_zone(0.0, 0.0, 1000.0, 434.0, TB_WIDTH);
        let keep = keep_zone(0.0, 0.0, 1000.0, 434.0, TB_WIDTH);
        // A cursor that drifts just below the trigger band (the flicker case)
        // still keeps the toolbar alive.
        let drift_y = trigger.bottom + 1.0;
        assert!(!zone_contains(trigger, 500.0, drift_y));
        assert!(zone_contains(keep, 500.0, drift_y));
        // Far below still dismisses it — hysteresis, not stickiness.
        assert!(!zone_contains(keep, 500.0, keep.bottom + 1.0));
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
