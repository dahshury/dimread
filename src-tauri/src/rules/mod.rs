//! Custom per-app rules — auto-switch the display mode by foreground window.
//!
//! CareUEyes' rules engine forces a preset mode while a matching window owns the
//! foreground (e.g. Photoshop → Editing, a game → Game) and reverts on focus
//! change (FEATURE-PARITY F4). The watcher is push-based:
//!
//!   * [`init`] — on Windows, spawns a background thread with narrow WinEvent
//!     hooks for foreground, title, and foreground-window geometry changes.
//!     Settings edits wake the same message loop through `settings:changed`.
//!     The watcher resolves the window's process image name / class / title,
//!     matches it against `settings.rules`, and calls
//!     `crate::display::engine::set_rule_override(Some(mode))` /
//!     `set_rule_override(None)` as the active rule changes. Non-Windows: no-op.
//!   * [`rules_list_windows`] — the `rules_list_windows` IPC command backing the
//!     rule editor's window picker (our replacement for CareUEyes' drag "Finder
//!     Tool"): enumerates visible top-level windows, each tagged with a stable
//!     `id` (its `HWND`) so two windows of the same process stay distinguishable.
//!
//! Rule persistence already exists: `settings.rules` (`enabled` + a `Vec<Rule>`
//! of `{ id, match_kind: "process"|"class"|"title", pattern, mode }`) — no new
//! settings section is needed. The matcher ([`matcher::resolve_override`]) is a
//! pure function so it is unit-tested without any Win32 dependency.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

/// A top-level window as reported by [`rules_list_windows`], used by the rule
/// editor's window picker / Finder Tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindow {
    /// Stable per-window identity for this listing (the Win32 `HWND` as a
    /// decimal string). Distinguishes two windows of the SAME process so the
    /// picker can capture the exact title/class the user chose.
    pub id: String,
    /// Owning process image name (e.g. `photoshop.exe`).
    pub process: String,
    /// Window title bar text.
    pub title: String,
    /// Win32 window class name.
    pub class_name: String,
}

/// Pure rule-matching logic — shared by the Windows watcher and the unit tests,
/// so it is compiled whenever either needs it (a runtime Windows build, or any
/// `cargo test` build on any platform).
#[cfg(any(windows, test))]
mod matcher {
    use crate::settings::{Rule, RulesSettings};

    /// Whether one rule matches a foreground window's identity.
    ///
    /// `process` and `class` compare the WHOLE string case-insensitively (the
    /// window picker feeds back exact process/class names); `title` matches as a
    /// case-insensitive substring. A blank pattern or unknown match kind never
    /// matches.
    pub(crate) fn rule_matches(rule: &Rule, process: &str, class_name: &str, title: &str) -> bool {
        let pattern = rule.pattern.trim();
        if pattern.is_empty() {
            return false;
        }
        let needle = pattern.to_lowercase();
        match rule.match_kind.as_str() {
            "process" => process.to_lowercase() == needle,
            "class" => class_name.to_lowercase() == needle,
            "title" => title.to_lowercase().contains(needle.as_str()),
            _ => false,
        }
    }

    /// The mode id the FIRST matching rule forces, or `None` when rules are
    /// disabled or nothing matches (the caller then clears the override).
    pub(crate) fn resolve_override(
        rules: &RulesSettings,
        process: &str,
        class_name: &str,
        title: &str,
    ) -> Option<String> {
        if !rules.enabled {
            return None;
        }
        rules
            .items
            .iter()
            .find(|rule| rule_matches(rule, process, class_name, title))
            .map(|rule| rule.mode.clone())
    }
}

/// Initialize the rules engine. On Windows this starts the foreground-window
/// watcher thread; elsewhere it is a no-op (the feature is Windows-only).
#[cfg(windows)]
pub fn init(app: &AppHandle) {
    windows_impl::start_watcher(app.clone());
}

/// Non-Windows: no rules engine.
#[cfg(not(windows))]
pub fn init(_app: &AppHandle) {}

/// `rules_list_windows` — enumerate candidate top-level windows for the rule
/// editor's picker, each with a stable `id` (its `HWND`) so same-process windows
/// stay distinguishable. Empty off-Windows.
#[tauri::command]
#[specta::specta]
pub fn rules_list_windows() -> Vec<OpenWindow> {
    #[cfg(windows)]
    {
        windows_impl::list_windows()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU32, Ordering};

    use tauri::{AppHandle, Listener};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, MAX_PATH, RECT, TRUE};
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONULL, MONITORINFO, MonitorFromWindow,
    };
    use windows::Win32::System::Threading::{
        GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        CHILDID_SELF, DispatchMessageW, EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_NAMECHANGE,
        EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART,
        EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART, EnumWindows, GWL_EXSTYLE,
        GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowLongPtrW, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, IsZoomed,
        KillTimer, MSG, OBJID_WINDOW, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetTimer,
        TranslateMessage, WINEVENT_OUTOFCONTEXT, WM_APP, WM_TIMER, WS_EX_APPWINDOW,
        WS_EX_TOOLWINDOW,
    };
    use windows::core::{BOOL, PWSTR};

    use super::OpenWindow;
    use super::matcher::resolve_override;

    /// Time a window must remain full-screen before filtering is suspended.
    /// This preserves the old watcher's two-sample debounce without waking the
    /// process periodically: a one-shot thread timer exists only while a
    /// full-screen candidate is pending.
    const FULLSCREEN_CONFIRM_MS: u32 = 700;

    /// Thread message posted by the `settings:changed` listener.
    const SETTINGS_CHANGED_MESSAGE: u32 = WM_APP + 1;

    /// Message-loop thread id, used to wake the watcher after settings edits.
    /// Zero until the thread has created its message queue.
    static WATCHER_THREAD_ID: AtomicU32 = AtomicU32::new(0);

    /// The foreground window's identity for one event-driven refresh.
    struct ForegroundInfo {
        process: String,
        title: String,
        class_name: String,
        /// True when the foreground window belongs to our own process.
        is_self: bool,
    }

    /// Mutable watcher state. Out-of-context WinEvent callbacks run on the
    /// thread that pumps their message queue, so a thread-local avoids locking.
    struct WatcherState {
        app: AppHandle,
        last_override: Option<String>,
        fullscreen_active: bool,
        fullscreen_pending: bool,
        fullscreen_timer: usize,
    }

    thread_local! {
        static STATE: RefCell<Option<WatcherState>> = const { RefCell::new(None) };
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct FullscreenTransition {
        active: bool,
        pending: bool,
        output: Option<bool>,
    }

    /// Pure transition behind the one-shot full-screen debounce.
    fn transition_fullscreen(
        active: bool,
        pending: bool,
        sample: bool,
        confirmation: bool,
    ) -> FullscreenTransition {
        if !sample {
            return FullscreenTransition {
                active: false,
                pending: false,
                output: active.then_some(false),
            };
        }
        if active {
            return FullscreenTransition {
                active,
                pending: false,
                output: None,
            };
        }
        // A confirmation is meaningful only for the candidate that armed the
        // timer. This also makes a stale or unrelated WM_TIMER harmless.
        if confirmation && pending {
            return FullscreenTransition {
                active: true,
                pending: false,
                output: Some(true),
            };
        }
        FullscreenTransition {
            active,
            pending: true,
            output: None,
        }
    }

    #[derive(Clone, Copy)]
    enum SyncReason {
        Foreground,
        Identity,
        Geometry,
        Settings,
        FullscreenConfirmation,
    }

    impl SyncReason {
        fn refreshes_rules(self) -> bool {
            matches!(self, Self::Foreground | Self::Identity | Self::Settings)
        }
    }

    /// Spawn the detached foreground watcher thread (dies with the process).
    pub(super) fn start_watcher(app: AppHandle) {
        let _ = app.listen_any("settings:changed", |_event| request_settings_sync());
        let spawned = std::thread::Builder::new()
            .name("rules-watcher".into())
            .spawn(move || watcher_loop(app));
        if let Err(err) = spawned {
            log::warn!("[rules] failed to start foreground watcher: {err}");
        }
    }

    /// Wake the watcher so settings edits take effect without polling.
    fn request_settings_sync() {
        let thread_id = WATCHER_THREAD_ID.load(Ordering::SeqCst);
        if thread_id == 0 {
            return;
        }
        // SAFETY: posting to a thread id is safe even if it exited between the
        // atomic load and this call; failure merely means there is no watcher.
        unsafe {
            let _ = PostThreadMessageW(
                thread_id,
                SETTINGS_CHANGED_MESSAGE,
                Default::default(),
                Default::default(),
            );
        }
    }

    /// Install hooks, seed the current foreground state, and pump callbacks.
    fn watcher_loop(app: AppHandle) {
        STATE.set(Some(WatcherState {
            app,
            last_override: None,
            fullscreen_active: false,
            fullscreen_pending: false,
            fullscreen_timer: 0,
        }));

        // Force creation of this thread's message queue before publishing its
        // id; otherwise an early PostThreadMessageW can race the first GetMessageW.
        let mut queue_probe = MSG::default();
        // SAFETY: `queue_probe` is a live out-param; PM_NOREMOVE leaves any
        // matching message in the newly-created queue.
        unsafe {
            let _ = PeekMessageW(&mut queue_probe, None, 0, 0, PM_NOREMOVE);
        }
        // SAFETY: always succeeds and returns the calling thread's id.
        let thread_id = unsafe { GetCurrentThreadId() };
        WATCHER_THREAD_ID.store(thread_id, Ordering::SeqCst);

        let hooks = install_hooks();
        if hooks.is_empty() {
            log::warn!("[rules] no WinEvent hooks installed; foreground changes cannot be tracked");
        }
        sync_foreground(SyncReason::Foreground);
        pump_messages();

        STATE.with_borrow_mut(|slot| {
            if let Some(state) = slot.as_mut() {
                cancel_fullscreen_timer(state);
            }
            *slot = None;
        });
        for hook in hooks {
            // SAFETY: every handle came from SetWinEventHook and is unhooked
            // exactly once before this thread exits.
            unsafe {
                let _ = UnhookWinEvent(hook);
            }
        }
        let _ =
            WATCHER_THREAD_ID.compare_exchange(thread_id, 0, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// Narrow hook ranges avoid waking for unrelated accessibility traffic.
    fn install_hooks() -> Vec<HWINEVENTHOOK> {
        const RANGES: [(u32, u32); 5] = [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE),
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
        ];
        let mut hooks = Vec::with_capacity(RANGES.len());
        for (min, max) in RANGES {
            // SAFETY: the callback is static and remains valid until every hook
            // is removed below; NULL module is required out-of-context.
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
                log::warn!("[rules] SetWinEventHook failed for range {min:#x}..={max:#x}");
            } else {
                hooks.push(hook);
            }
        }
        hooks
    }

    /// Route relevant WinEvents into a foreground-state refresh.
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
        if event == EVENT_SYSTEM_FOREGROUND {
            sync_foreground(SyncReason::Foreground);
            return;
        }
        // Background windows generate the same title/geometry events. Only the
        // foreground one can affect an active rule or full-screen suspension.
        // SAFETY: GetForegroundWindow returns a handle or NULL.
        if unsafe { GetForegroundWindow() } != hwnd {
            return;
        }
        let reason = if event == EVENT_OBJECT_NAMECHANGE {
            SyncReason::Identity
        } else {
            SyncReason::Geometry
        };
        sync_foreground(reason);
    }

    /// Process WinEvents, settings messages, and the one-shot debounce timer.
    fn pump_messages() {
        let mut msg = MSG::default();
        loop {
            // SAFETY: `msg` is a live out-param; NULL hwnd retrieves this
            // thread's complete queue and dispatches out-of-context callbacks.
            let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };
            if result.0 <= 0 {
                return;
            }
            if msg.message == SETTINGS_CHANGED_MESSAGE {
                sync_foreground(SyncReason::Settings);
                continue;
            }
            if msg.message == WM_TIMER && is_fullscreen_timer(msg.wParam.0) {
                sync_foreground(SyncReason::FullscreenConfirmation);
                continue;
            }
            // SAFETY: GetMessageW just initialized `msg`.
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    fn is_fullscreen_timer(timer: usize) -> bool {
        STATE.with_borrow(|slot| {
            slot.as_ref()
                .is_some_and(|state| state.fullscreen_timer != 0 && state.fullscreen_timer == timer)
        })
    }

    /// Re-evaluate the current foreground window and apply only changed outputs.
    fn sync_foreground(reason: SyncReason) {
        let Some(app) = STATE.with_borrow(|slot| slot.as_ref().map(|state| state.app.clone()))
        else {
            return;
        };
        let settings = crate::settings::store::read_settings(&app);
        let foreground = unsafe { GetForegroundWindow() };
        let fullscreen_sample = settings.display.disable_on_fullscreen
            && !foreground.0.is_null()
            && is_fullscreen_window(foreground);
        let info = reason
            .refreshes_rules()
            .then(|| foreground_info(foreground))
            .flatten();

        let (fullscreen_output, override_output) = STATE.with_borrow_mut(|slot| {
            let Some(state) = slot.as_mut() else {
                return (None, None);
            };
            let confirmation = matches!(reason, SyncReason::FullscreenConfirmation);
            let mut transition = transition_fullscreen(
                state.fullscreen_active,
                state.fullscreen_pending,
                fullscreen_sample,
                confirmation,
            );
            if !state.fullscreen_pending && transition.pending {
                // SAFETY: NULL hwnd creates a timer on this thread's queue.
                state.fullscreen_timer = unsafe { SetTimer(None, 0, FULLSCREEN_CONFIRM_MS, None) };
                if state.fullscreen_timer == 0 {
                    log::warn!("[rules] failed to arm full-screen confirmation timer");
                    transition = transition_fullscreen(
                        state.fullscreen_active,
                        true,
                        fullscreen_sample,
                        true,
                    );
                }
            } else if state.fullscreen_pending && !transition.pending {
                cancel_fullscreen_timer(state);
            }
            state.fullscreen_active = transition.active;
            state.fullscreen_pending = transition.pending;

            let override_output = if reason.refreshes_rules() {
                let next = if !settings.rules.enabled {
                    None
                } else {
                    match info.as_ref() {
                        // Our own window in front leaves an active override in
                        // place, matching the previous watcher semantics.
                        Some(info) if info.is_self => state.last_override.clone(),
                        Some(info) => resolve_override(
                            &settings.rules,
                            &info.process,
                            &info.class_name,
                            &info.title,
                        ),
                        None => state.last_override.clone(),
                    }
                };
                (next != state.last_override).then(|| {
                    state.last_override = next.clone();
                    next
                })
            } else {
                None
            };
            (transition.output, override_output)
        });

        if let Some(fullscreen) = fullscreen_output {
            crate::display::engine::set_fullscreen_suspend(fullscreen);
        }
        if let Some(next) = override_output {
            crate::display::engine::set_rule_override(next);
        }
    }

    fn cancel_fullscreen_timer(state: &mut WatcherState) {
        if state.fullscreen_timer == 0 {
            return;
        }
        // SAFETY: NULL hwnd and the id returned by SetTimer identify this
        // thread timer. A queued stale WM_TIMER is rejected by id afterwards.
        unsafe {
            let _ = KillTimer(None, state.fullscreen_timer);
        }
        state.fullscreen_timer = 0;
    }

    /// Resolve the current foreground window's process / class / title.
    fn foreground_info(hwnd: HWND) -> Option<ForegroundInfo> {
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        // SAFETY: `hwnd` is valid; `pid` is a live out-param.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        Some(ForegroundInfo {
            process: process_name(pid).unwrap_or_default(),
            title: title_of(hwnd),
            class_name: class_name_of(hwnd),
            is_self: pid == std::process::id(),
        })
    }

    /// Window classes that cover the screen but are SHELL surfaces rather than
    /// applications, so they must never suspend filtering.
    ///
    /// The desktop/tray entries are the obvious ones. The task-switcher entries
    /// are the load-bearing ones: on Windows 11 the Alt+Tab / Win+Tab UI is a
    /// full-screen, NON-maximized `XamlExplorerHostIslandWindow` owned by
    /// explorer.exe, which satisfies every other test here. Without this
    /// exclusion a foreground callback landing while the switcher is up read
    /// as "a game went
    /// full-screen" and restored the original gamma ramps, so Alt-tabbing
    /// flashed the screen back to full brightness with no blue filter for a
    /// until the next foreground callback — see also the maximized-window
    /// exclusion below, the same bug from a different direction.
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

    /// Whether the foreground window fully covers its monitor — a game or other
    /// full-screen app (FEATURE-PARITY F1.11). Excludes our own windows and the
    /// desktop/shell surfaces (which also span the screen but are not apps).
    fn is_fullscreen_window(hwnd: HWND) -> bool {
        let mut pid: u32 = 0;
        // SAFETY: `hwnd` is valid; `pid` is a live out-param.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == std::process::id() {
            return false;
        }
        if is_shell_class(&class_name_of(hwnd)) {
            return false;
        }
        let Some(rect) = visible_frame(hwnd) else {
            return false;
        };
        // SAFETY: `hwnd` valid; `MONITOR_DEFAULTTONULL` returns null off-screen.
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL) };
        if monitor.0.is_null() {
            return false;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: `monitor` valid; `info.cbSize` is set as the API requires.
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return false;
        }
        // SAFETY: `hwnd` is valid.
        let maximized = unsafe { IsZoomed(hwnd) }.as_bool();
        is_fullscreen_geometry(maximized, rect, info.rcMonitor)
    }

    /// The window's VISIBLE frame.
    ///
    /// `GetWindowRect` includes the invisible resize border (~8 px a side), so
    /// an ordinary window measures as spilling past the monitor edges. DWM's
    /// extended frame bounds are what the user actually sees, which is what the
    /// "covers the whole monitor" test is trying to ask about. Falls back to
    /// `GetWindowRect` if DWM has no bounds for the window.
    fn visible_frame(hwnd: HWND) -> Option<RECT> {
        let mut rect = RECT::default();
        // SAFETY: `hwnd` is valid; `rect` is a live out-param whose size is
        // passed explicitly, as the API requires.
        let bounds = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                std::ptr::from_mut(&mut rect).cast(),
                std::mem::size_of::<RECT>() as u32,
            )
        };
        if bounds.is_ok() {
            return Some(rect);
        }
        // SAFETY: `hwnd` valid; `rect` is a live out-param.
        unsafe { GetWindowRect(hwnd, &mut rect) }
            .ok()
            .map(|()| rect)
    }

    /// The pure geometry rule behind [`is_fullscreen_window`], split out so
    /// it can be unit-tested without a foreground window.
    ///
    /// A MAXIMIZED window is never full-screen, even when it covers the monitor
    /// edge to edge — and it often does, because a monitor with no taskbar of
    /// its own (a secondary display, or an auto-hidden taskbar) has a work area
    /// equal to its full area. Without this exclusion, clicking from DimRead
    /// onto any maximized window read as "a game went full-screen" and
    /// suspended filtering, so the screen reverted to undimmed whenever the app
    /// was not in focus.
    fn is_fullscreen_geometry(maximized: bool, window: RECT, monitor: RECT) -> bool {
        !maximized
            && window.left <= monitor.left
            && window.top <= monitor.top
            && window.right >= monitor.right
            && window.bottom >= monitor.bottom
    }

    /// Enumerate visible, titled, non-tool top-level windows (excluding our own).
    /// Every window is listed individually (keyed by `HWND`) so two windows of
    /// the same process can be told apart by title/class in the picker.
    pub(super) fn list_windows() -> Vec<OpenWindow> {
        let mut raw: Vec<OpenWindow> = Vec::new();
        // SAFETY: `enum_proc` runs synchronously for each top-level window and
        // only pushes into the `Vec<OpenWindow>` referenced by the LPARAM.
        unsafe {
            let _ = EnumWindows(
                Some(enum_proc),
                LPARAM(&mut raw as *mut Vec<OpenWindow> as isize),
            );
        }
        raw
    }

    /// `EnumWindows` callback — collects listable windows into the LPARAM vec.
    unsafe extern "system" fn enum_proc(hwnd: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the `&mut Vec<OpenWindow>` pointer passed to
        // `EnumWindows`; the callback runs on this thread for that borrow.
        let out = unsafe { &mut *(data.0 as *mut Vec<OpenWindow>) };
        if should_list(hwnd) {
            let mut pid: u32 = 0;
            // SAFETY: `hwnd` is valid; `pid` is a live out-param.
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if pid != std::process::id() {
                let process = process_name(pid).unwrap_or_default();
                if !process.is_empty() {
                    out.push(OpenWindow {
                        id: (hwnd.0 as isize).to_string(),
                        process,
                        title: title_of(hwnd),
                        class_name: class_name_of(hwnd),
                    });
                }
            }
        }
        TRUE
    }

    /// Keep only real, user-facing windows: visible, titled, not a tool window
    /// (unless it opts back into the taskbar via `WS_EX_APPWINDOW`).
    fn should_list(hwnd: HWND) -> bool {
        // SAFETY: `hwnd` from EnumWindows is a valid top-level window handle.
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return false;
        }
        // SAFETY: `hwnd` valid; `GWL_EXSTYLE` is a defined long-ptr index.
        let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        if (ex & WS_EX_TOOLWINDOW.0) != 0 && (ex & WS_EX_APPWINDOW.0) == 0 {
            return false;
        }
        // SAFETY: `hwnd` valid.
        (unsafe { GetWindowTextLengthW(hwnd) }) > 0
    }

    /// The process image basename (e.g. `photoshop.exe`) for a pid, or `None`.
    fn process_name(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        // SAFETY: query-limited access is enough for the image name; the handle
        // is closed below and never used afterwards.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buf = [0u16; MAX_PATH as usize];
        let mut size = buf.len() as u32;
        // SAFETY: `handle` is valid; `buf`/`size` describe the output buffer.
        let query = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
        };
        // SAFETY: `handle` came from OpenProcess and is dropped here.
        let _ = unsafe { CloseHandle(handle) };
        query.ok()?;
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        let base = full.rsplit(['\\', '/']).next().unwrap_or(full.as_str());
        if base.is_empty() {
            None
        } else {
            Some(base.to_string())
        }
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

    /// The window's title bar text (`GetWindowTextW`).
    fn title_of(hwnd: HWND) -> String {
        // SAFETY: `hwnd` valid.
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        // SAFETY: `buf` holds len+1 code units for the NUL-terminated copy.
        let copied = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if copied <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..copied as usize])
    }

    #[cfg(test)]
    mod tests {
        use super::{
            FullscreenTransition, RECT, is_fullscreen_geometry, is_shell_class,
            transition_fullscreen,
        };

        const MONITOR: RECT = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };

        fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
            RECT {
                left,
                top,
                right,
                bottom,
            }
        }

        #[test]
        fn borderless_window_covering_the_monitor_is_fullscreen() {
            assert!(is_fullscreen_geometry(false, MONITOR, MONITOR));
        }

        #[test]
        fn maximized_window_covering_the_monitor_is_not_fullscreen() {
            // The regression: on a display whose work area == its full area
            // (no taskbar of its own, or an auto-hidden one) an ordinary
            // maximized window covers every edge. It must NOT suspend filtering.
            assert!(!is_fullscreen_geometry(true, MONITOR, MONITOR));
        }

        #[test]
        fn window_leaving_the_taskbar_visible_is_not_fullscreen() {
            assert!(!is_fullscreen_geometry(
                false,
                rect(0, 0, 1920, 1032),
                MONITOR
            ));
        }

        #[test]
        fn windowed_app_is_not_fullscreen() {
            assert!(!is_fullscreen_geometry(
                false,
                rect(100, 100, 900, 700),
                MONITOR
            ));
        }

        #[test]
        fn window_overhanging_every_edge_is_fullscreen() {
            assert!(is_fullscreen_geometry(
                false,
                rect(-8, -8, 1928, 1088),
                MONITOR
            ));
        }

        #[test]
        fn task_switcher_hosts_are_shell_classes() {
            // The regression: Windows 11's Alt+Tab UI is a full-screen,
            // non-maximized explorer.exe window, so it passes every geometry
            // test. Treating it as a game suspended filtering mid-switch and
            // flashed the screen back to unfiltered maximum brightness.
            assert!(is_shell_class("XamlExplorerHostIslandWindow"));
            assert!(is_shell_class("MultitaskingViewFrame"));
            assert!(is_shell_class("TaskSwitcherWnd"));
            assert!(is_shell_class("TaskSwitcherOverlayWnd"));
            assert!(is_shell_class("ForegroundStaging"));
        }

        #[test]
        fn desktop_and_taskbar_are_shell_classes() {
            assert!(is_shell_class("Progman"));
            assert!(is_shell_class("WorkerW"));
            assert!(is_shell_class("Shell_TrayWnd"));
            assert!(is_shell_class("Shell_SecondaryTrayWnd"));
            assert!(is_shell_class("Button"));
        }

        #[test]
        fn ordinary_app_windows_are_not_shell_classes() {
            assert!(!is_shell_class("Chrome_WidgetWin_1"));
            assert!(!is_shell_class("UnityWndClass"));
            assert!(!is_shell_class(""));
        }

        #[test]
        fn fullscreen_sample_arms_confirmation_without_engaging() {
            assert_eq!(
                transition_fullscreen(false, false, true, false),
                FullscreenTransition {
                    active: false,
                    pending: true,
                    output: None,
                }
            );
        }

        #[test]
        fn fullscreen_confirmation_engages_suspension() {
            assert_eq!(
                transition_fullscreen(false, true, true, true),
                FullscreenTransition {
                    active: true,
                    pending: false,
                    output: Some(true),
                }
            );
        }

        #[test]
        fn unarmed_confirmation_does_not_engage_suspension() {
            assert_eq!(
                transition_fullscreen(false, false, true, true),
                FullscreenTransition {
                    active: false,
                    pending: true,
                    output: None,
                }
            );
        }

        #[test]
        fn transient_fullscreen_cancels_pending_confirmation() {
            assert_eq!(
                transition_fullscreen(false, true, false, false),
                FullscreenTransition {
                    active: false,
                    pending: false,
                    output: None,
                }
            );
        }

        #[test]
        fn leaving_fullscreen_releases_immediately() {
            assert_eq!(
                transition_fullscreen(true, false, false, false),
                FullscreenTransition {
                    active: false,
                    pending: false,
                    output: Some(false),
                }
            );
        }

        #[test]
        fn repeated_fullscreen_events_do_not_rearm_pending_confirmation() {
            assert_eq!(
                transition_fullscreen(false, true, true, false),
                FullscreenTransition {
                    active: false,
                    pending: true,
                    output: None,
                }
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::matcher::{resolve_override, rule_matches};
    use crate::settings::{Rule, RulesSettings};

    fn rule(kind: &str, pattern: &str, mode: &str) -> Rule {
        Rule {
            id: "r1".into(),
            match_kind: kind.into(),
            pattern: pattern.into(),
            mode: mode.into(),
        }
    }

    #[test]
    fn process_match_is_whole_string_case_insensitive() {
        let r = rule("process", "Photoshop.exe", "editing");
        assert!(rule_matches(&r, "photoshop.EXE", "SomeClass", "Untitled-1"));
        // Not a substring match: a longer/shorter process name must not match.
        assert!(!rule_matches(&r, "notphotoshop.exe", "SomeClass", "x"));
        assert!(!rule_matches(&r, "photoshop", "SomeClass", "x"));
    }

    #[test]
    fn class_match_is_whole_string_case_insensitive() {
        let r = rule("class", "Chrome_WidgetWin_1", "game");
        assert!(rule_matches(
            &r,
            "chrome.exe",
            "chrome_widgetwin_1",
            "Title"
        ));
        assert!(!rule_matches(
            &r,
            "chrome.exe",
            "Chrome_WidgetWin_11",
            "Title"
        ));
    }

    #[test]
    fn title_match_is_substring_case_insensitive() {
        let r = rule("title", "Visual Studio", "office");
        assert!(rule_matches(
            &r,
            "code.exe",
            "Cls",
            "my-project - Visual Studio Code"
        ));
        assert!(!rule_matches(&r, "code.exe", "Cls", "Notepad"));
    }

    #[test]
    fn blank_pattern_and_unknown_kind_never_match() {
        assert!(!rule_matches(
            &rule("process", "   ", "editing"),
            "photoshop.exe",
            "Cls",
            "Title"
        ));
        assert!(!rule_matches(
            &rule("weird", "photoshop.exe", "editing"),
            "photoshop.exe",
            "Cls",
            "Title"
        ));
    }

    #[test]
    fn resolve_returns_none_when_disabled() {
        let rules = RulesSettings {
            enabled: false,
            items: vec![rule("process", "photoshop.exe", "editing")],
        };
        assert_eq!(
            resolve_override(&rules, "photoshop.exe", "Cls", "Title"),
            None
        );
    }

    #[test]
    fn resolve_returns_first_matching_rule_mode() {
        let rules = RulesSettings {
            enabled: true,
            items: vec![
                rule("process", "chrome.exe", "game"),
                rule("title", "photoshop", "editing"),
            ],
        };
        assert_eq!(
            resolve_override(&rules, "photoshop.exe", "Cls", "Adobe Photoshop"),
            Some("editing".to_string())
        );
    }

    #[test]
    fn resolve_reverts_to_none_when_nothing_matches() {
        let rules = RulesSettings {
            enabled: true,
            items: vec![rule("process", "photoshop.exe", "editing")],
        };
        assert_eq!(
            resolve_override(&rules, "notepad.exe", "Cls", "Untitled"),
            None
        );
    }
}
