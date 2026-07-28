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
//! That same loop owns a hidden top-level Win32 window for `WM_DISPLAYCHANGE`
//! and `WM_SETTINGCHANGE` work-area broadcasts. Settings edits wake it through
//! the process-wide `settings:changed` callback. There is no timer/watchdog:
//! when the desktop is idle the tracker thread stays blocked in `GetMessageW`.
//!
//! Every emitted anchor carries the `HWND` as `window_id` so the renderer can
//! distinguish a MOVE (snap the cutout) from a SWITCH (glide it) — a spring
//! chasing a dragged window is itself perceived as lag.
//!
//! ## The anchor carries the ENVIRONMENT too, so it must survive an idle desktop
//! Each anchor ships the whole dimmable region set (`monitors`), which is the
//! only channel the renderer has for `include_taskbar`, the work areas and the
//! display topology. So an anchor is not optional bookkeeping that can be skipped
//! whenever no window is worth highlighting: skipping it freezes the shade's
//! GEOMETRY as well as its cutout. The tracker therefore RETAINS its last target
//! (`TrackerState::target`) and re-resolves that window when the
//! foreground is not anchorable, so every environment change reaches the
//! renderer — including the one that arrives while our own settings window is
//! focused, which is every settings edit there is.
//!
//! Coordinates are emitted **window-local** (the absolute rects minus the
//! virtual-screen origin) so the overlay renderer only has to divide by its
//! device-pixel-ratio — no origin bookkeeping in the webview.
//!
//! The tracker skips our own windows (the overlay included) and the
//! desktop/shell surfaces, and exits when [`stop`] clears [`ACTIVE`]. Windows of
//! elevated (admin) apps can't be inspected by a non-elevated process, so those
//! never receive a cutout — surfaced as a tooltip hint in the panel.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::AppHandle;
#[cfg(windows)]
use tauri::Listener;

/// Whether Focus Blur currently owns the overlay.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Bumped on every [`start`]/[`stop`] so a superseded foreground tracker winds
/// down even if a `stop()`+`start()` pair lands before the old tracker has
/// processed its `WM_QUIT` (each tracker captures its generation and exits when
/// the current one moves past it). Without this the first tracker could outlive
/// the second and both would emit `focus:anchor`.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Monotonic ordering for the cached/event anchor handshake. A renderer can
/// safely apply the snapshot after subscribing without overwriting an anchor
/// event that arrived while the command was in flight.
#[cfg(windows)]
static ANCHOR_SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Latest emitted anchor. The overlay renderer reads this after registering its
/// event listener, closing the startup gap where the tracker's immediate first
/// event could otherwise arrive before React subscribed.
static LAST_ANCHOR: Mutex<Option<crate::events::FocusAnchorEvent>> = Mutex::new(None);
/// One-shot guard for the persisted-state restore. The overlay can navigate or
/// reload later in the process lifetime; those page loads must not resurrect
/// Blur after the user has explicitly turned it off.
static AUTOSTART_CHECKED: AtomicBool = AtomicBool::new(false);

/// The shared tint window's label (from `WINDOW_SPECS`), hosted by both Focus
/// sub-engines.
const OVERLAY_LABEL: &str = "focus-overlay";

/// Per-sub-engine init hook. Restores the persisted `enabled` state across
/// restarts (CareUEyes parity). The actual restore is callback-driven by
/// [`on_page_load`], once the overlay renderer has finished loading; [`start`]
/// otherwise lazily shows the overlay + tracker.
pub fn init(_app: &AppHandle) {
    #[cfg(windows)]
    let _ = _app.listen_any("settings:changed", |_event| {
        windows_impl::request_environment_refresh();
    });
}

/// Handle Tauri's page-load callback. Persisted Focus Blur is restored exactly
/// once, when the `focus-overlay` renderer reports `Finished`, instead of
/// guessing renderer readiness with a startup sleep.
pub(crate) fn on_page_load(label: &str, event: tauri::webview::PageLoadEvent) {
    if label != OVERLAY_LABEL
        || event != tauri::webview::PageLoadEvent::Finished
        || AUTOSTART_CHECKED.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let Some(app) = super::app() else {
        log::warn!("[focus-blur] overlay loaded before the focus engine was initialized");
        return;
    };
    if crate::settings::store::read_settings(&app)
        .focus_blur
        .enabled
        && !is_active()
    {
        start();
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
    *LAST_ANCHOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    show_overlay();
    #[cfg(windows)]
    if let Some(app) = super::app() {
        windows_impl::start_tracker(app, generation);
    }
    // The generation guard only drives the Windows environment tracker; the
    // bump still runs on every platform so the counter stays monotonic.
    #[cfg(not(windows))]
    let _ = generation;
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
    // The tracker blocks in `GetMessageW`, so stopping explicitly posts
    // `WM_QUIT` to wake and terminate that event loop.
    #[cfg(windows)]
    windows_impl::stop_tracker();
    *LAST_ANCHOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
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

/// Refit an already-active overlay after a native display topology change.
/// This intentionally does not create or show a window when Blur is inactive.
#[cfg(windows)]
fn resize_overlay() {
    if !is_active() {
        return;
    }
    let Some(app) = super::app() else {
        return;
    };
    let Some(window) = tauri::Manager::get_webview_window(&app, OVERLAY_LABEL) else {
        return;
    };
    let (left, top, width, height) = crate::windows::virtual_screen_bounds();
    let _ = window.set_position(tauri::PhysicalPosition::new(left, top));
    let _ = window.set_size(tauri::PhysicalSize::new(width.max(1), height.max(1)));
}

/// Snapshot the latest cached Blur anchor. Renderers call this only after their
/// `focus:anchor` listener is installed (subscribe-then-snapshot handshake).
#[tauri::command]
#[specta::specta]
pub fn focus_blur_anchor_snapshot() -> Option<crate::events::FocusAnchorEvent> {
    if !is_active() {
        return None;
    }
    LAST_ANCHOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
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
/// Alt+Tab. Kept in sync with the same table in [`crate::rules`].
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
        sequence: 0,
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

/// Pick the window one sync should anchor to, and the target to retain for the
/// next one: the live foreground candidate wins, otherwise the previously
/// retained one is re-measured against the CURRENT environment, and a retained
/// window that can no longer be measured (it closed) is dropped.
///
/// Generic over the handle and the measurement so the policy is unit-tested
/// without Win32. The fallback is what makes `include_taskbar` (and a taskbar
/// move, and a display hot-plug) take effect: those all arrive while an
/// un-anchorable window owns the foreground — our own settings window, for a
/// settings edit — and the anchor is the only channel carrying the region set the
/// renderer shades.
#[cfg(any(windows, test))]
fn resolve_anchor<H: Copy, A>(
    foreground: Option<H>,
    retained: Option<H>,
    measure: impl Fn(H) -> Option<A>,
) -> (Option<A>, Option<H>) {
    if let Some(candidate) = foreground
        && let Some(anchor) = measure(candidate)
    {
        return (Some(anchor), Some(candidate));
    }
    match retained.map(|candidate| (candidate, measure(candidate))) {
        Some((candidate, Some(anchor))) => (Some(anchor), Some(candidate)),
        // Either nothing was retained, or what was retained is gone: emit
        // nothing and stop pinning a handle that no longer resolves.
        _ => (None, None),
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::Mutex;
    use std::sync::atomic::Ordering;

    use tauri::AppHandle;
    use tauri_specta::Event as _;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, TRUE, WPARAM};
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO,
        MonitorFromWindow,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        CHILDID_SELF, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND,
        EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART,
        GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowThreadProcessId,
        MSG, OBJID_WINDOW, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, RegisterClassW,
        TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT,
        WINEVENT_SKIPOWNPROCESS, WM_APP, WM_DISPLAYCHANGE, WM_QUIT, WM_SETTINGCHANGE, WNDCLASSW,
    };
    use windows::core::{BOOL, w};

    use super::{is_shell_class, to_local_anchor};
    use crate::events::FocusAnchorEvent;

    /// Private thread message posted by the process-wide `settings:changed`
    /// listener. Unlike `WM_SETTINGCHANGE`, this represents DimRead settings,
    /// not Windows system settings.
    const WM_DIMREAD_SETTINGS_CHANGED: u32 = WM_APP + 1;

    #[derive(Clone, Copy, Default)]
    struct TrackerSlot {
        generation: u64,
        thread_id: u32,
    }

    /// Generation-tagged tracker identity. The tag prevents a late thread from
    /// overwriting or clearing the slot belonging to a newer activation.
    static TRACKER: Mutex<TrackerSlot> = Mutex::new(TrackerSlot {
        generation: 0,
        thread_id: 0,
    });

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
        /// Cached monitor rects; refreshed by native display/settings messages
        /// so the WinEvent hot path never calls `EnumDisplayMonitors`.
        monitors: Vec<(i32, i32, i32, i32)>,
        /// Cached `settings.focus_blur.include_taskbar`, likewise refreshed by
        /// the settings-change callback rather than read per WinEvent.
        include_taskbar: bool,
        /// The window the shade is currently anchored to — RETAINED across
        /// foreground changes we deliberately ignore (our own windows, the
        /// desktop/shell, the task switcher).
        ///
        /// This is what makes an ENVIRONMENT change re-emit. Without it,
        /// [`refresh_environment`] could only republish while a real application
        /// window happened to own the foreground — and the one moment that is
        /// never true is the moment the environment actually changes from a
        /// settings edit, because the user is looking at OUR settings window. So
        /// toggling "include taskbar" off recomputed the monitor rects
        /// internally and then emitted nothing, leaving the renderer shading the
        /// full monitor rect (i.e. a tinted taskbar) until some other app was
        /// clicked — or, if Blur was left on, until the app restarted.
        target: Option<HWND>,
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
    /// no tracker is running. The callbacks also guard on
    /// `is_active()`/generation so already-queued events cannot emit stale data.
    pub(super) fn stop_tracker() {
        let thread_id = {
            let mut tracker = TRACKER
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let thread_id = tracker.thread_id;
            *tracker = TrackerSlot::default();
            thread_id
        };
        if thread_id == 0 {
            return;
        }
        // SAFETY: posting WM_QUIT to a thread id is safe regardless of whether
        // that thread is still alive — it fails with an error we ignore.
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }

    /// Wake the tracker for an authoritative settings broadcast. A settings
    /// event before the tracker publishes its queue is harmless because startup
    /// reads the current snapshot before installing hooks.
    pub(super) fn request_environment_refresh() {
        let thread_id = TRACKER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .thread_id;
        if thread_id == 0 {
            return;
        }
        // SAFETY: the message carries no pointers and targets the queue created
        // by `PeekMessageW` before the tracker slot is published.
        unsafe {
            let _ =
                PostThreadMessageW(thread_id, WM_DIMREAD_SETTINGS_CHANGED, WPARAM(0), LPARAM(0));
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
            target: None,
        }));
        // Force creation of the thread message queue before publishing its id.
        // This closes the start→immediate-stop race where PostThreadMessageW can
        // otherwise fail because GetMessageW has not created the queue yet.
        let mut seed_message = MSG::default();
        // SAFETY: a no-remove peek with a live out-param only initializes and
        // observes this thread's queue.
        unsafe {
            let _ = PeekMessageW(&mut seed_message, None, 0, 0, PM_NOREMOVE);
        }
        // SAFETY: always succeeds; returns the calling thread's id.
        let thread_id = unsafe { GetCurrentThreadId() };
        if !publish_tracker(generation, thread_id) {
            STATE.set(None);
            return;
        }

        let hooks = install_hooks();
        if hooks.is_empty() {
            log::warn!(
                "[focus-blur] no WinEvent hooks installed — foreground tracking unavailable"
            );
        }
        let notification_window = create_notification_window();
        // Don't make the user wait for the first OS event to see a cutout.
        sync_anchor();
        pump_messages();

        if let Some(window) = notification_window {
            // SAFETY: the hidden window was created on this tracker thread and
            // is destroyed exactly once before the thread exits.
            unsafe {
                let _ = DestroyWindow(window);
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
        clear_tracker(generation, thread_id);
    }

    fn publish_tracker(generation: u64, thread_id: u32) -> bool {
        let mut tracker = TRACKER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !super::is_active() || super::GENERATION.load(Ordering::SeqCst) != generation {
            return false;
        }
        *tracker = TrackerSlot {
            generation,
            thread_id,
        };
        true
    }

    fn clear_tracker(generation: u64, thread_id: u32) {
        let mut tracker = TRACKER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tracker.generation == generation && tracker.thread_id == thread_id {
            *tracker = TrackerSlot::default();
        }
    }

    /// Create the hidden top-level window that receives reliable display and
    /// work-area broadcasts. A message-only window is intentionally not used:
    /// Windows does not deliver broadcast messages to message-only windows.
    fn create_notification_window() -> Option<HWND> {
        // SAFETY: static class strings and callback remain valid for the process;
        // the returned window is owned and destroyed by this thread.
        unsafe {
            let module = GetModuleHandleW(None).ok()?;
            let class_name = w!("DimReadFocusBlurEnvironmentListener");
            let class = WNDCLASSW {
                lpfnWndProc: Some(environment_wnd_proc),
                hInstance: module.into(),
                lpszClassName: class_name,
                ..Default::default()
            };
            // RegisterClassW returning zero is also expected on later tracker
            // activations because the process class already exists.
            let _ = RegisterClassW(&class);
            match CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                class_name,
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                None,
                None,
                Some(module.into()),
                None,
            ) {
                Ok(window) => Some(window),
                Err(err) => {
                    log::warn!("[focus-blur] failed to create environment listener window: {err}");
                    None
                }
            }
        }
    }

    unsafe extern "system" fn environment_wnd_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_DISPLAYCHANGE {
            super::resize_overlay();
            refresh_environment();
        } else if message == WM_SETTINGCHANGE {
            // Includes SPI_SETWORKAREA and taskbar placement/size changes.
            refresh_environment();
        }
        // SAFETY: messages retain their default window semantics after our
        // read-only notification handling.
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    /// Install the hooks that make tracking push-based. Split into narrow ranges
    /// rather than one wide one so the callback is not woken for the hundreds of
    /// unrelated accessibility events the system emits.
    ///
    /// `WINEVENT_SKIPOWNPROCESS` keeps our own windows (the overlay included) from
    /// waking the callback at all; `foreground_target` still re-checks the pid to
    /// reject a foreground switch racing the queued event.
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
    ///
    /// The live foreground window wins; when there is none to highlight the
    /// RETAINED target ([`TrackerState::target`]) is re-resolved against the
    /// cached environment instead, so a settings/display/work-area change always
    /// reaches the renderer. A retained window that can no longer be resolved
    /// (it closed) is dropped rather than pinning a dead handle.
    fn sync_anchor() {
        let emitted = STATE.with_borrow_mut(|slot| {
            let state = slot.as_mut()?;
            if !super::is_active() || super::GENERATION.load(Ordering::SeqCst) != state.generation {
                return None;
            }
            let (geometry, target) =
                super::resolve_anchor(foreground_target(), state.target, |hwnd| {
                    anchor_for(hwnd, state.include_taskbar, &state.monitors)
                });
            state.target = target;
            let geometry = geometry?;
            if state.last.as_ref() == Some(&geometry) {
                return None;
            }
            state.last = Some(geometry.clone());
            let mut event = geometry;
            event.sequence = super::ANCHOR_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
            *super::LAST_ANCHOR
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(event.clone());
            Some(event)
        });
        let (Some(event), Some(app)) = (emitted, crate::focus::app()) else {
            return;
        };
        if let Err(err) = event.emit(&app) {
            log::warn!("[focus-blur] failed to emit focus:anchor: {err}");
        }
    }

    /// Re-read `include_taskbar`, re-enumerate monitors, then re-sync. This only
    /// runs for a settings callback or a native display/work-area notification;
    /// it is never timer-driven.
    ///
    /// The re-sync is the point: the refreshed rects are what the renderer shades,
    /// so they have to be published, not just cached. [`sync_anchor`]'s retained
    /// target is what lets that happen while DimRead's own settings window (the
    /// window the user just clicked the toggle in) owns the foreground.
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
    fn pump_messages() {
        let mut msg = MSG::default();
        loop {
            // SAFETY: `msg` is a live out-param; a NULL hwnd retrieves messages
            // for the whole thread (including our settings and shutdown posts).
            let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };
            // 0 is WM_QUIT, -1 is an error — both end the loop.
            if result.0 <= 0 {
                return;
            }
            if msg.message == WM_DIMREAD_SETTINGS_CHANGED {
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

    /// The foreground window the shade should highlight, or `None` when there is
    /// nothing to highlight (no focus, one of our own windows, a desktop/shell
    /// surface).
    fn foreground_target() -> Option<HWND> {
        // SAFETY: returns the foreground HWND or a null handle (no focus).
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        // SAFETY: `hwnd` is valid; `pid` is a live out-param.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        // Our own windows (settings, the overlay itself) must never punch a
        // hole — that would flash the shade off whenever DimRead is focused.
        if pid == std::process::id() {
            return None;
        }
        if is_shell_class(&class_name_of(hwnd)) {
            return None;
        }
        Some(hwnd)
    }

    /// Resolve one window into a window-local anchor against the cached
    /// environment, or `None` when it can no longer be measured (it closed, or it
    /// is un-inspectable).
    ///
    /// `monitors` is the caller's cached enumeration — this is the hot path, so
    /// it must not re-enumerate displays.
    fn anchor_for(
        hwnd: HWND,
        include_taskbar: bool,
        monitors: &[(i32, i32, i32, i32)],
    ) -> Option<FocusAnchorEvent> {
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
    use super::{is_shell_class, resolve_anchor, to_local_anchor};

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

    /// Stand-in for `anchor_for`: every window measures to its own handle except
    /// the ones listed as gone (a closed window can no longer be measured).
    fn measuring(gone: &[u64]) -> impl Fn(u64) -> Option<u64> + '_ {
        move |hwnd| (!gone.contains(&hwnd)).then_some(hwnd)
    }

    #[test]
    fn anchor_resolution_prefers_the_live_foreground_and_retains_it() {
        let (anchor, retained) = resolve_anchor(Some(HWND_A), Some(HWND_A + 1), measuring(&[]));
        assert_eq!(anchor, Some(HWND_A));
        assert_eq!(retained, Some(HWND_A));
    }

    #[test]
    fn anchor_resolution_falls_back_to_the_retained_target() {
        // THE include_taskbar REGRESSION. An environment change (the taskbar
        // toggle, a taskbar move, a display hot-plug) is republished through the
        // anchor, and it always lands while a window we refuse to highlight owns
        // the foreground — DimRead's own settings window, for a settings edit.
        // Emitting nothing there froze the shade on the previous region set, so
        // turning "include taskbar" off left the taskbar tinted.
        let (anchor, retained) = resolve_anchor(None, Some(HWND_A), measuring(&[]));
        assert_eq!(anchor, Some(HWND_A));
        assert_eq!(retained, Some(HWND_A), "the target must stay retained");
    }

    #[test]
    fn anchor_resolution_drops_a_retained_target_that_is_gone() {
        // A closed window must not pin the cutout forever.
        let (anchor, retained) = resolve_anchor(None, Some(HWND_A), measuring(&[HWND_A]));
        assert_eq!(anchor, None);
        assert_eq!(retained, None);
    }

    #[test]
    fn anchor_resolution_falls_back_when_the_foreground_cannot_be_measured() {
        // An un-inspectable foreground window (elevated, or racing its own close)
        // keeps the shade on the last window it could measure.
        let (anchor, retained) =
            resolve_anchor(Some(HWND_A + 1), Some(HWND_A), measuring(&[HWND_A + 1]));
        assert_eq!(anchor, Some(HWND_A));
        assert_eq!(retained, Some(HWND_A));
    }

    #[test]
    fn anchor_resolution_emits_nothing_before_the_first_target() {
        // Activating Blur while DimRead itself is focused: there is nothing to
        // highlight yet, and the renderer must not flash a hole-less shade.
        let (anchor, retained) = resolve_anchor(None, None, measuring(&[]));
        assert_eq!(anchor, None);
        assert_eq!(retained, None);
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
