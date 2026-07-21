//! Focus Blur (FEATURE-PARITY F8.2) — dim/tint every background window while the
//! active window stays highlighted (Hazeover-style), driven by
//! `settings.focus_blur` (`enabled`, `include_taskbar`, `only_current_monitor`,
//! `animate`, `transparency` %, `color`).
//!
//! ## Seam (frozen)
//! - [`toggle`] — flip active; returns the new state.
//! - [`is_active`] — current activation.
//! - [`start`] / [`stop`] — force on/off (used by [`toggle`], the hotkey action,
//!   and Read's mutual-exclusion stop).
//!
//! ## How the tint is composited
//! The shared `focus-overlay` window stays always-on-top and CLICK-THROUGH and
//! spans the whole virtual screen ([`crate::windows::virtual_screen_bounds`]).
//! We do NOT try to sandwich the overlay under the foreground window in the
//! z-order (fragile) — instead a background **foreground-window tracker** watches
//! the active window's visible rect (`DwmGetWindowAttribute` extended frame
//! bounds, `GetWindowRect` fallback) plus its monitor bounds (work area vs. full
//! depending on `include_taskbar`), and emits `focus:anchor`
//! ([`crate::events::FocusAnchorEvent`]). The renderer masks a hole for that
//! rect out of the shade so the active window shows through while everything
//! else dims.
//!
//! ## Why the tracker is push-based (`SetWinEventHook`), not a poll
//! Tracking latency is the whole feel of this feature: any delay shows up as the
//! hole visibly trailing a dragged window. The tracker therefore hooks
//! `EVENT_OBJECT_LOCATIONCHANGE` / `EVENT_SYSTEM_FOREGROUND` /
//! `EVENT_SYSTEM_MOVESIZE*` / `EVENT_SYSTEM_MINIMIZE*` and recomputes the anchor
//! the moment the OS reports a change — which is both dramatically lower latency
//! AND lower CPU than the sampling loop it replaced (an idle desktop delivers no
//! events at all, where a poll wakes regardless).
//!
//! A `SetWinEventHook` with `WINEVENT_OUTOFCONTEXT` delivers its callbacks on a
//! thread that pumps messages, so the tracker thread owns a real message loop.
//! On top of it sits a slow [`windows_impl::WATCHDOG_INTERVAL_MS`] timer, which
//! is NOT the tracking mechanism — it re-reads `include_taskbar`, refreshes the
//! cached monitor list (display hot-plug) and re-emits as a safety net for the
//! changes WinEvents can miss (notably windows of elevated processes). Keeping
//! the settings read and `EnumDisplayMonitors` on that slow path is what lets the
//! hot path stay two Win32 calls wide.
//!
//! Every emitted anchor carries the `HWND` as `window_id` so the renderer can
//! distinguish a MOVE (snap the cutout) from a SWITCH (glide it) — a spring
//! chasing a dragged window is itself perceived as lag.
//!
//! Coordinates are emitted **window-local** (the absolute rects minus the
//! virtual-screen origin) so the overlay renderer only has to divide by its
//! device-pixel-ratio — no origin bookkeeping in the webview.
//!
//! The tracker skips our own windows (the overlay included) and the
//! desktop/shell surfaces, and exits when [`stop`] clears [`ACTIVE`]. Windows of
//! elevated (admin) apps can't be inspected by a non-elevated process, so those
//! never receive a cutout — surfaced as a tooltip hint in the panel.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::AppHandle;

/// Whether Focus Blur currently owns the overlay.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Bumped on every [`start`]/[`stop`] so a superseded foreground tracker winds
/// down even if a `stop()`+`start()` pair lands before the old tracker has
/// processed its `WM_QUIT` (each tracker captures its generation and exits when
/// the current one moves past it). Without this the first tracker could outlive
/// the second and both would emit `focus:anchor`.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The shared tint window's label (from `WINDOW_SPECS`), hosted by both Focus
/// sub-engines.
const OVERLAY_LABEL: &str = "focus-overlay";

/// Delay before the boot auto-start check so the settings store + the prewarmed
/// overlay webview are up (and subscribed to `focus:anchor`) first.
const AUTOSTART_DELAY_MS: u64 = 1500;

/// Per-sub-engine init hook. Restores the persisted `enabled` state across
/// restarts (CareUEyes parity): if Focus Blur was left on, start it once the
/// store + overlay are ready. Called from [`super::init`] (after the app handle
/// is captured). [`start`] otherwise lazily shows the overlay + tracker.
pub fn init(_app: &AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("focus-blur-autostart".into())
        .spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(AUTOSTART_DELAY_MS));
            let Some(app) = super::app() else {
                return;
            };
            if crate::settings::store::read_settings(&app)
                .focus_blur
                .enabled
                && !is_active()
            {
                start();
            }
        });
    if let Err(err) = spawned {
        log::warn!("[focus-blur] failed to schedule auto-start: {err}");
    }
}

/// Whether Focus Blur is active.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Flip Focus Blur on/off; returns the new active state.
pub fn toggle() -> bool {
    if is_active() {
        stop();
        false
    } else {
        start();
        true
    }
}

/// Force Focus Blur on. Stops Focus Read first (shared overlay), sets the flag,
/// shows the overlay in Blur mode, spawns the foreground-window tracker, then
/// emits `focus:state`.
pub fn start() {
    // Mutually exclusive with Read — release the overlay before we claim it.
    super::read::stop();
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    show_overlay();
    #[cfg(windows)]
    if let Some(app) = super::app() {
        windows_impl::start_tracker(app, generation);
    }
    super::emit_state();
}

/// Force Focus Blur off. Idempotent; hides the overlay (unless Read is taking it
/// over), lets the tracker wind down (it guards on [`is_active`]), and emits
/// `focus:state` only on a real change.
pub fn stop() {
    if !ACTIVE.swap(false, Ordering::SeqCst) {
        return;
    }
    // Supersede the running tracker (belt-and-suspenders alongside the
    // `is_active()` guard it already checks) so a rapid stop→start can't leave a
    // zombie tracker from the previous activation alive.
    GENERATION.fetch_add(1, Ordering::SeqCst);
    // The tracker now blocks in `GetMessageW` rather than sleeping between polls,
    // so it has to be woken to notice: without this it would idle until its next
    // watchdog tick.
    #[cfg(windows)]
    windows_impl::stop_tracker();
    hide_overlay();
    super::emit_state();
}

/// Show + size the shared `focus-overlay` window to the whole virtual screen and
/// re-assert click-through / always-on-top. Cross-platform (Tauri window ops);
/// the tint stays empty until a `focus:anchor` lands, so an un-tracked platform
/// is inert.
fn show_overlay() {
    let Some(app) = super::app() else {
        return;
    };
    let (left, top, width, height) = crate::windows::virtual_screen_bounds();
    let window = match crate::windows::ensure_window(&app, OVERLAY_LABEL) {
        Ok(window) => window,
        Err(err) => {
            log::warn!("[focus-blur] failed to ensure overlay window: {err}");
            return;
        }
    };
    // Idempotent re-assert: a click-through window must never swallow input, and
    // the seed spec size is only 1920×1080 — grow it to cover every monitor.
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_position(tauri::PhysicalPosition::new(left, top));
    let _ = window.set_size(tauri::PhysicalSize::new(width.max(1), height.max(1)));
    if let Err(err) = window.show() {
        log::warn!("[focus-blur] failed to show overlay window: {err}");
    }
    let _ = window.set_always_on_top(true);
}

/// Hide the shared overlay — unless Focus Read is (still) using it.
fn hide_overlay() {
    if super::read::is_active() {
        return;
    }
    let Some(app) = super::app() else {
        return;
    };
    if let Some(window) = tauri::Manager::get_webview_window(&app, OVERLAY_LABEL) {
        let _ = window.hide();
    }
}

// ── Pure geometry (shared by the Windows tracker + the tests) ────────────────

/// Window classes that span the screen but are the desktop / shell rather than a
/// real application window — a cutout for these would look broken, so the
/// tracker leaves the shade whole when one owns the foreground.
///
/// The desktop/tray entries are the obvious ones. The task-switcher entries are
/// the load-bearing ones: on Windows 11 the Alt+Tab / Win+Tab UI is a
/// full-screen, NON-maximized `XamlExplorerHostIslandWindow` owned by
/// explorer.exe, so without this exclusion the tracker anchors on it and emits a
/// whole-screen cutout — the shade visibly vanishes for the duration of every
/// Alt+Tab. Kept in sync with the same table in [`crate::rules`] (plan 09 step 1
/// folds both into `focus/mask.rs`).
#[cfg(any(windows, test))]
fn is_shell_class(class: &str) -> bool {
    matches!(
        class,
        // Desktop, taskbar and start button.
        "Progman"
            | "WorkerW"
            | "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "Button"
            // Alt+Tab / Task View hosts: Windows 11's XAML switcher, the
            // Windows 10 equivalents, and the transient staging window the
            // shell raises to the foreground mid-switch.
            | "XamlExplorerHostIslandWindow"
            | "MultitaskingViewFrame"
            | "TaskSwitcherWnd"
            | "TaskSwitcherOverlayWnd"
            | "ForegroundStaging"
    )
}

/// Translate an absolute window rect + its monitor rect + EVERY monitor's
/// dimmable rect (all physical px, `(left, top, right, bottom)`) into a
/// window-local [`FocusAnchorEvent`] by subtracting the virtual-screen origin.
///
/// `monitors` is what the whole-virtual-screen mode shades, so `include_taskbar`
/// is honoured on every display rather than only the active window's: the caller
/// passes each monitor's work area when the taskbar is excluded and its full rect
/// when it is included. Pure so the offset maths is unit-tested without any Win32
/// dependency.
///
/// `window_id` is passed through verbatim (the `HWND` as a `u64`) so the renderer
/// can tell a move of the focused window apart from a switch to a new one.
#[cfg(any(windows, test))]
fn to_local_anchor(
    window_id: u64,
    win: (i32, i32, i32, i32),
    monitor: (i32, i32, i32, i32),
    monitors: &[(i32, i32, i32, i32)],
    origin: (i32, i32),
    taskbar: bool,
) -> crate::events::FocusAnchorEvent {
    let (wl, wt, wr, wb) = win;
    let (ml, mt, mr, mb) = monitor;
    let (ox, oy) = origin;
    crate::events::FocusAnchorEvent {
        window_id,
        x: wl - ox,
        y: wt - oy,
        width: (wr - wl).max(0),
        height: (wb - wt).max(0),
        monitor_left: ml - ox,
        monitor_top: mt - oy,
        monitor_right: mr - ox,
        monitor_bottom: mb - oy,
        taskbar,
        monitors: monitors
            .iter()
            .map(|&(l, t, r, b)| crate::events::AnchorRect {
                left: l - ox,
                top: t - oy,
                right: r - ox,
                bottom: b - oy,
            })
            .collect(),
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU32, Ordering};

    use tauri::AppHandle;
    use tauri_specta::Event as _;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE, WPARAM};
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO,
        MonitorFromWindow,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        CHILDID_SELF, DispatchMessageW, EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND,
        EVENT_SYSTEM_MOVESIZESTART, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowRect,
        GetWindowThreadProcessId, KillTimer, MSG, OBJID_WINDOW, PostThreadMessageW, SetTimer,
        TranslateMessage, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_QUIT, WM_TIMER,
    };
    use windows::core::BOOL;

    use super::{is_shell_class, to_local_anchor};
    use crate::events::FocusAnchorEvent;

    /// Safety-net cadence for the things WinEvents do not reliably report:
    /// `include_taskbar` edits, display hot-plug, and geometry changes on windows
    /// we cannot hook (elevated processes). This is deliberately slow — it is a
    /// watchdog, NOT the tracking mechanism, which is push-based.
    pub(super) const WATCHDOG_INTERVAL_MS: u32 = 500;

    /// Tracker-thread id, so [`stop_tracker`] can post `WM_QUIT` to its message
    /// loop. 0 when no tracker is running.
    static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);

    /// Mutable tracker state. Lives in a thread-local because the WinEvent
    /// callback and the message loop are the same thread by construction
    /// (`WINEVENT_OUTOFCONTEXT` delivers on whichever thread pumps messages), so
    /// this needs no synchronisation.
    struct TrackerState {
        /// The [`super::GENERATION`] this tracker was started for.
        generation: u64,
        /// Previous emission — the dedupe key. The event derives `Eq` and covers
        /// the monitor list, so a display hot-plug compares unequal and re-emits.
        last: Option<FocusAnchorEvent>,
        /// Cached monitor rects; refreshed on the watchdog tick so the hot path
        /// never calls `EnumDisplayMonitors`.
        monitors: Vec<(i32, i32, i32, i32)>,
        /// Cached `settings.focus_blur.include_taskbar`, likewise refreshed on
        /// the watchdog tick rather than read per event.
        include_taskbar: bool,
    }

    thread_local! {
        static STATE: RefCell<Option<TrackerState>> = const { RefCell::new(None) };
    }

    /// Spawn the detached foreground tracker: a thread that installs the WinEvent
    /// hooks and pumps their message loop. It winds down when `super::is_active()`
    /// clears, when its captured generation is superseded, or when
    /// [`stop_tracker`] posts `WM_QUIT`.
    pub(super) fn start_tracker(app: AppHandle, generation: u64) {
        let spawned = std::thread::Builder::new()
            .name("focus-blur-tracker".into())
            .spawn(move || tracker_thread(&app, generation));
        if let Err(err) = spawned {
            log::warn!("[focus-blur] failed to start foreground tracker: {err}");
        }
    }

    /// Ask the running tracker's message loop to exit. Idempotent: a no-op when
    /// no tracker is running. The thread ALSO guards on `is_active()`/generation
    /// at every watchdog tick, so a lost `WM_QUIT` costs at most one tick rather
    /// than leaking the thread.
    pub(super) fn stop_tracker() {
        let thread_id = HOOK_THREAD_ID.swap(0, Ordering::SeqCst);
        if thread_id == 0 {
            return;
        }
        // SAFETY: posting WM_QUIT to a thread id is safe regardless of whether
        // that thread is still alive — it fails with an error we ignore.
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }

    /// The tracker thread body: seed the cached environment, install the hooks,
    /// emit an immediate first anchor, then pump messages until told to stop.
    fn tracker_thread(app: &AppHandle, generation: u64) {
        let include_taskbar = crate::settings::store::read_settings(app)
            .focus_blur
            .include_taskbar;
        STATE.set(Some(TrackerState {
            generation,
            last: None,
            monitors: all_monitor_rects(include_taskbar),
            include_taskbar,
        }));
        // SAFETY: always succeeds; returns the calling thread's id.
        let thread_id = unsafe { GetCurrentThreadId() };
        HOOK_THREAD_ID.store(thread_id, Ordering::SeqCst);

        let hooks = install_hooks();
        if hooks.is_empty() {
            log::warn!(
                "[focus-blur] no WinEvent hooks installed — tracking falls back to the {WATCHDOG_INTERVAL_MS} ms watchdog"
            );
        }
        // Don't make the user wait for the first OS event to see a cutout.
        sync_anchor();

        // SAFETY: a NULL hwnd creates a thread timer; the returned id is the one
        // WM_TIMER carries in wParam and the one KillTimer needs.
        let timer = unsafe { SetTimer(None, 0, WATCHDOG_INTERVAL_MS, None) };
        if timer == 0 {
            log::warn!("[focus-blur] failed to install the tracker watchdog timer");
        }
        pump_messages(generation, timer);

        if timer != 0 {
            // SAFETY: NULL hwnd + the id SetTimer returned, as the API requires.
            unsafe {
                let _ = KillTimer(None, timer);
            }
        }
        for hook in hooks {
            // SAFETY: each handle came from a successful SetWinEventHook and is
            // unhooked exactly once, on the thread that installed it.
            unsafe {
                let _ = UnhookWinEvent(hook);
            }
        }
        STATE.set(None);
        // Only clear the slot if it is still OURS: a tracker that exited via the
        // generation guard (rather than `stop_tracker`) may already have been
        // superseded, and clearing unconditionally would strand the live tracker
        // with no way to be woken.
        let _ = HOOK_THREAD_ID.compare_exchange(thread_id, 0, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// Install the hooks that make tracking push-based. Split into narrow ranges
    /// rather than one wide one so the callback is not woken for the hundreds of
    /// unrelated accessibility events the system emits.
    ///
    /// `WINEVENT_SKIPOWNPROCESS` keeps our own windows (the overlay included) from
    /// waking the callback at all — `compute_anchor` still re-checks the pid,
    /// because the watchdog path queries the foreground window directly.
    fn install_hooks() -> Vec<HWINEVENTHOOK> {
        const RANGES: [(u32, u32); 4] = [
            // Focus moved to a different window.
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            // Drag/resize start + end (start also tells us a move is beginning).
            (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
            // Minimize/restore, which move the window off/on screen.
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            // The high-frequency one: every geometry change during a drag.
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
        ];
        let mut hooks = Vec::with_capacity(RANGES.len());
        for (min, max) in RANGES {
            // SAFETY: standard out-of-context hook registration. `win_event_proc`
            // is a valid callback for the whole lifetime of the hook (it is
            // unhooked before the thread returns), and a NULL module handle is
            // correct for WINEVENT_OUTOFCONTEXT.
            let hook = unsafe {
                SetWinEventHook(
                    min,
                    max,
                    None,
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            if hook.0.is_null() {
                log::warn!("[focus-blur] SetWinEventHook failed for range {min:#x}..={max:#x}");
            } else {
                hooks.push(hook);
            }
        }
        hooks
    }

    /// WinEvent callback — runs on the tracker thread during message retrieval.
    ///
    /// Two filters keep the hot path cheap. `OBJID_WINDOW`/`CHILDID_SELF` drops
    /// the flood of per-control and caret events (`EVENT_OBJECT_LOCATIONCHANGE`
    /// in particular fires for the mouse cursor itself). Then location changes
    /// are narrowed to the foreground window, so dragging a background window,
    /// or a video repainting behind the shade, costs one `GetForegroundWindow`
    /// rather than a full DWM + monitor recompute.
    unsafe extern "system" fn win_event_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if id_object != OBJID_WINDOW.0 || id_child != CHILDID_SELF as i32 {
            return;
        }
        if event == EVENT_OBJECT_LOCATIONCHANGE {
            // SAFETY: returns the foreground HWND or a null handle.
            let foreground = unsafe { GetForegroundWindow() };
            if foreground != hwnd {
                return;
            }
        }
        sync_anchor();
    }

    /// Recompute the anchor from the cached environment and emit it if it
    /// changed. The guards mirror the old poll's: a superseded or stopped tracker
    /// emits nothing even if a queued event still reaches the callback.
    fn sync_anchor() {
        let emitted = STATE.with_borrow_mut(|slot| {
            let state = slot.as_mut()?;
            if !super::is_active() || super::GENERATION.load(Ordering::SeqCst) != state.generation {
                return None;
            }
            let event = compute_anchor(state.include_taskbar, &state.monitors)?;
            if state.last.as_ref() == Some(&event) {
                return None;
            }
            state.last = Some(event.clone());
            Some(event)
        });
        let (Some(event), Some(app)) = (emitted, crate::focus::app()) else {
            return;
        };
        if let Err(err) = event.emit(&app) {
            log::warn!("[focus-blur] failed to emit focus:anchor: {err}");
        }
    }

    /// Watchdog tick: re-read `include_taskbar`, re-enumerate the monitors, then
    /// re-sync. Keeping both off the event path is what lets a drag recompute
    /// with two Win32 calls instead of a settings read plus a monitor
    /// enumeration.
    fn refresh_environment() {
        STATE.with_borrow_mut(|slot| {
            let Some(state) = slot.as_mut() else {
                return;
            };
            let Some(app) = crate::focus::app() else {
                return;
            };
            state.include_taskbar = crate::settings::store::read_settings(&app)
                .focus_blur
                .include_taskbar;
            state.monitors = all_monitor_rects(state.include_taskbar);
        });
        // Deliberately outside the borrow above — `sync_anchor` borrows STATE too.
        sync_anchor();
    }

    /// Pump the tracker thread's message queue. `GetMessageW` is what delivers
    /// the out-of-context WinEvent callbacks, so this loop IS the tracker.
    /// Returns on `WM_QUIT`, on a queue error, or when the generation guard trips.
    fn pump_messages(generation: u64, timer: usize) {
        let mut msg = MSG::default();
        loop {
            // SAFETY: `msg` is a live out-param; a NULL hwnd retrieves messages
            // for the whole thread (which is where thread timers land).
            let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };
            // 0 is WM_QUIT, -1 is an error — both end the loop.
            if result.0 <= 0 {
                return;
            }
            if msg.message == WM_TIMER && msg.wParam.0 == timer {
                if !super::is_active() || super::GENERATION.load(Ordering::SeqCst) != generation {
                    return;
                }
                refresh_environment();
                continue;
            }
            // SAFETY: `msg` was just filled by GetMessageW.
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    /// Resolve the current foreground window into a window-local anchor, or
    /// `None` when there is nothing to highlight (no focus, our own window, a
    /// desktop/shell surface, or an un-inspectable window).
    ///
    /// `monitors` is the caller's cached enumeration — this is the hot path, so
    /// it must not re-enumerate displays.
    fn compute_anchor(
        include_taskbar: bool,
        monitors: &[(i32, i32, i32, i32)],
    ) -> Option<FocusAnchorEvent> {
        // SAFETY: returns the foreground HWND or a null handle (no focus).
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        // SAFETY: `hwnd` is valid; `pid` is a live out-param.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        // Our own windows (main, settings, the overlay itself) must never punch a
        // hole — that would flash the shade off whenever DimRead is focused.
        if pid == std::process::id() {
            return None;
        }
        if is_shell_class(&class_name_of(hwnd)) {
            return None;
        }
        let win = window_bounds(hwnd)?;
        let monitor = monitor_bounds(hwnd, include_taskbar)?;
        let (ox, oy, _, _) = crate::windows::virtual_screen_bounds();
        Some(to_local_anchor(
            hwnd.0 as u64,
            win,
            monitor,
            monitors,
            (ox, oy),
            include_taskbar,
        ))
    }

    /// `EnumDisplayMonitors` callback — collects raw `HMONITOR` handles into the
    /// `Vec<HMONITOR>` handed through `dwdata`.
    unsafe extern "system" fn collect_proc(
        monitor: HMONITOR,
        _hdc: HDC,
        _clip: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        // SAFETY: `data` is the `&mut Vec<HMONITOR>` pointer we passed to
        // `EnumDisplayMonitors`; the callback runs synchronously on this thread
        // for the lifetime of that borrow.
        let monitors = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        monitors.push(monitor);
        TRUE
    }

    /// EVERY monitor's dimmable rect: the work area (taskbar left clear) when
    /// `include_taskbar` is false, otherwise the full monitor rect. This is the
    /// region set the whole-virtual-screen mode shades, so the taskbar setting
    /// applies to all displays and not just the active window's.
    fn all_monitor_rects(include_taskbar: bool) -> Vec<(i32, i32, i32, i32)> {
        let mut handles: Vec<HMONITOR> = Vec::new();
        // SAFETY: standard EnumDisplayMonitors invocation; `collect_proc` only
        // pushes into the `handles` vec pointed to by the LPARAM.
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(collect_proc),
                LPARAM(std::ptr::from_mut(&mut handles) as isize),
            );
        }
        let mut out = Vec::with_capacity(handles.len());
        for monitor in handles {
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            // SAFETY: `monitor` valid; `info.cbSize` is set as the API requires.
            if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
                continue;
            }
            let r = if include_taskbar {
                info.rcMonitor
            } else {
                info.rcWork
            };
            if r.right > r.left && r.bottom > r.top {
                out.push((r.left, r.top, r.right, r.bottom));
            }
        }
        out
    }

    /// The active window's VISIBLE rect (`(left, top, right, bottom)`), preferring
    /// the DWM extended frame bounds (excludes the invisible resize-border shadow
    /// so the cutout hugs the window) and falling back to `GetWindowRect`.
    fn window_bounds(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
        let mut rect = RECT::default();
        // SAFETY: `hwnd` is valid; the out-param buffer + size match the attribute.
        let dwm = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                std::ptr::from_mut(&mut rect).cast::<c_void>(),
                std::mem::size_of::<RECT>() as u32,
            )
        };
        if dwm.is_err() {
            // SAFETY: `hwnd` valid; `rect` is a live out-param.
            if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
                return None;
            }
        }
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        Some((rect.left, rect.top, rect.right, rect.bottom))
    }

    /// The bounds of the monitor the window is on: the work area (taskbar
    /// excluded) when `include_taskbar` is false, otherwise the full monitor.
    fn monitor_bounds(hwnd: HWND, include_taskbar: bool) -> Option<(i32, i32, i32, i32)> {
        // SAFETY: `hwnd` valid; `MONITOR_DEFAULTTONEAREST` always returns a monitor.
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        if monitor.0.is_null() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: `monitor` valid; `info.cbSize` is set as the API requires.
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return None;
        }
        let r = if include_taskbar {
            info.rcMonitor
        } else {
            info.rcWork
        };
        Some((r.left, r.top, r.right, r.bottom))
    }

    /// The window's class name (`GetClassNameW`).
    fn class_name_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        // SAFETY: `buf` is a valid mutable slice; returns the char count copied.
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::{is_shell_class, to_local_anchor};

    /// Stand-in window handle for the geometry tests — `to_local_anchor`
    /// passes it straight through, so its value only has to be stable.
    const HWND_A: u64 = 0x1234;

    #[test]
    fn shell_classes_are_skipped() {
        assert!(is_shell_class("Progman"));
        assert!(is_shell_class("WorkerW"));
        assert!(is_shell_class("Shell_TrayWnd"));
        assert!(is_shell_class("Shell_SecondaryTrayWnd"));
        assert!(!is_shell_class("Chrome_WidgetWin_1"));
        assert!(!is_shell_class("Notepad"));
    }

    #[test]
    fn task_switcher_classes_are_skipped() {
        // The Alt+Tab / Task View hosts are full-screen windows owned by
        // explorer.exe; anchoring on one punches a whole-screen hole in the
        // shade, so the blur appears to drop out for every switch.
        assert!(is_shell_class("XamlExplorerHostIslandWindow"));
        assert!(is_shell_class("MultitaskingViewFrame"));
        assert!(is_shell_class("TaskSwitcherWnd"));
        assert!(is_shell_class("TaskSwitcherOverlayWnd"));
        assert!(is_shell_class("ForegroundStaging"));
    }

    #[test]
    fn local_anchor_subtracts_the_virtual_origin() {
        // Window at (100,200)-(500,600) on a monitor (0,0)-(1920,1040, taskbar
        // excluded), virtual-screen origin at (0,0): local == absolute.
        let ev = to_local_anchor(
            HWND_A,
            (100, 200, 500, 600),
            (0, 0, 1920, 1040),
            &[(0, 0, 1920, 1040)],
            (0, 0),
            false,
        );
        assert_eq!((ev.x, ev.y), (100, 200));
        assert_eq!((ev.width, ev.height), (400, 400));
        assert_eq!(
            (
                ev.monitor_left,
                ev.monitor_top,
                ev.monitor_right,
                ev.monitor_bottom
            ),
            (0, 0, 1920, 1040)
        );
        assert!(!ev.taskbar);
    }

    #[test]
    fn local_anchor_handles_a_negative_secondary_monitor_origin() {
        // A left-hand secondary monitor puts the virtual origin at (-1920, 0);
        // a window on it lands at negative absolute x but non-negative local x.
        let ev = to_local_anchor(
            HWND_A,
            (-1820, 100, -1420, 500),
            (-1920, 0, 0, 1080),
            &[(-1920, 0, 0, 1080)],
            (-1920, 0),
            true,
        );
        assert_eq!((ev.x, ev.y), (100, 100));
        assert_eq!((ev.width, ev.height), (400, 400));
        assert_eq!(ev.monitor_left, 0);
        assert_eq!(ev.monitor_right, 1920);
        assert_eq!(ev.monitor_bottom, 1080);
        assert!(ev.taskbar);
    }

    #[test]
    fn local_anchor_never_reports_a_negative_size() {
        // A degenerate/backwards rect clamps to a zero extent rather than wrap.
        let ev = to_local_anchor(
            HWND_A,
            (500, 500, 100, 100),
            (0, 0, 800, 600),
            &[(0, 0, 800, 600)],
            (0, 0),
            false,
        );
        assert_eq!((ev.width, ev.height), (0, 0));
    }

    #[test]
    fn local_anchor_maps_every_monitor_region_to_window_local_px() {
        // Two monitors with the virtual origin on the left-hand secondary; each
        // work area (taskbar excluded) is rebased by the same origin as the
        // window rect, so the renderer needs no origin bookkeeping.
        let ev = to_local_anchor(
            HWND_A,
            (100, 100, 500, 500),
            (0, 0, 1920, 1040),
            &[(-1920, 0, 0, 1040), (0, 0, 1920, 1040)],
            (-1920, 0),
            false,
        );
        let rects: Vec<_> = ev
            .monitors
            .iter()
            .map(|r| (r.left, r.top, r.right, r.bottom))
            .collect();
        assert_eq!(rects, vec![(0, 0, 1920, 1040), (1920, 0, 3840, 1040)]);
    }

    #[test]
    fn local_anchor_keeps_per_monitor_taskbar_carve_outs_distinct() {
        // The taskbar may sit on a different edge per display: monitor 1 has a
        // 40 px bottom bar, monitor 2 a 40 px left bar. Excluding the taskbar
        // must shrink each region on ITS own edge, which is exactly why the
        // backend resolves work areas per monitor instead of one global inset.
        let ev = to_local_anchor(
            HWND_A,
            (0, 0, 100, 100),
            (0, 0, 1920, 1040),
            &[(0, 0, 1920, 1040), (1960, 0, 3840, 1080)],
            (0, 0),
            false,
        );
        let rects: Vec<_> = ev
            .monitors
            .iter()
            .map(|r| (r.left, r.top, r.right, r.bottom))
            .collect();
        assert_eq!(rects, vec![(0, 0, 1920, 1040), (1960, 0, 3840, 1080)]);
    }

    #[test]
    fn anchor_carries_the_window_handle_through_untouched() {
        // The renderer keys "same window moved" vs "focus switched" off this, so
        // it must survive the coordinate rebase verbatim — including on a
        // negative-origin secondary monitor, where every other field shifts.
        let ev = to_local_anchor(
            HWND_A,
            (-1820, 100, -1420, 500),
            (-1920, 0, 0, 1080),
            &[(-1920, 0, 0, 1080)],
            (-1920, 0),
            false,
        );
        assert_eq!(ev.window_id, HWND_A);
    }

    #[test]
    fn anchor_equality_notices_a_focus_switch_at_identical_geometry() {
        // Tab-sized windows land on identical rects all the time (maximized, or
        // snapped to the same half). Dedupe is on the whole event, so without the
        // handle in it the switch would be swallowed and the cutout would glide
        // to a window it no longer belongs to.
        let win = (100, 100, 500, 500);
        let mon = (0, 0, 1920, 1040);
        let mons = [(0, 0, 1920, 1040)];
        let one = to_local_anchor(HWND_A, win, mon, &mons, (0, 0), false);
        let two = to_local_anchor(HWND_A + 1, win, mon, &mons, (0, 0), false);
        assert_ne!(one, two);
    }

    #[test]
    fn anchor_equality_notices_a_changed_monitor_set() {
        // The tracker dedupes on the event itself, so hot-plugging a display (or
        // toggling include_taskbar) must compare unequal and re-emit.
        let win = (100, 100, 500, 500);
        let mon = (0, 0, 1920, 1040);
        let one = to_local_anchor(HWND_A, win, mon, &[(0, 0, 1920, 1040)], (0, 0), false);
        let two = to_local_anchor(
            HWND_A,
            win,
            mon,
            &[(0, 0, 1920, 1040), (1920, 0, 3840, 1080)],
            (0, 0),
            false,
        );
        assert_ne!(one, two);
        assert_eq!(
            one,
            to_local_anchor(HWND_A, win, mon, &[(0, 0, 1920, 1040)], (0, 0), false)
        );
    }
}
