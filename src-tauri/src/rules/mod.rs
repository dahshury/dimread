//! Custom per-app rules — auto-switch the display mode by foreground window.
//!
//! CareUEyes' rules engine forces a preset mode while a matching window owns the
//! foreground (e.g. Photoshop → Editing, a game → Game) and reverts on focus
//! change (FEATURE-PARITY F4). We replicate it with a lightweight polling
//! watcher instead of `SetWinEventHook`:
//!
//!   * [`init`] — on Windows, spawns a background thread that samples
//!     `GetForegroundWindow` every [`windows_impl::POLL_INTERVAL_MS`] ms,
//!     resolves the window's process image name / class / title, matches it
//!     against `settings.rules`, and calls
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
    use std::time::Duration;

    use tauri::AppHandle;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, MAX_PATH, RECT, TRUE};
    use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONULL, MONITORINFO, MonitorFromWindow,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GWL_EXSTYLE, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW,
        GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, IsZoomed, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    use windows::core::{BOOL, PWSTR};

    use super::OpenWindow;
    use super::matcher::resolve_override;

    /// How often the watcher samples the foreground window. 700 ms is well below
    /// human focus-switch cadence yet negligible CPU — deliberately simpler than
    /// a `SetWinEventHook` message loop.
    pub(super) const POLL_INTERVAL_MS: u64 = 700;

    /// The foreground window's identity for one poll.
    struct ForegroundInfo {
        process: String,
        title: String,
        class_name: String,
        /// True when the foreground window belongs to our own process.
        is_self: bool,
    }

    /// Spawn the detached foreground watcher thread (dies with the process).
    pub(super) fn start_watcher(app: AppHandle) {
        let spawned = std::thread::Builder::new()
            .name("rules-watcher".into())
            .spawn(move || watcher_loop(&app));
        if let Err(err) = spawned {
            log::warn!("[rules] failed to start foreground watcher: {err}");
        }
    }

    /// Poll the foreground window forever, driving the engine's rule override.
    /// Re-reads the settings snapshot each tick so enabling/disabling rules or
    /// editing them takes effect without a restart.
    fn watcher_loop(app: &AppHandle) {
        let mut last_override: Option<String> = None;
        let mut last_fullscreen = false;
        let mut fullscreen_streak = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            let settings = crate::settings::store::read_settings(app);
            let rules = &settings.rules;

            // Full-screen app detection (F1.11): suspend filtering while a
            // game/full-screen window owns the foreground. Independent of the
            // per-app rules toggle; only re-applies when the state flips, and
            // debounced so a transient full-screen shell surface (the Alt+Tab
            // switcher above all) cannot flash the user's filter off.
            let sample = settings.display.disable_on_fullscreen && is_fullscreen_foreground();
            let fullscreen = confirm_fullscreen(&mut fullscreen_streak, sample);
            if fullscreen != last_fullscreen {
                crate::display::engine::set_fullscreen_suspend(fullscreen);
                last_fullscreen = fullscreen;
            }

            let next = if !rules.enabled {
                None
            } else {
                match foreground_info() {
                    // Our own window in front: leave whatever override is active
                    // (don't let opening DimRead's window clear a rule).
                    Some(info) if info.is_self => last_override.clone(),
                    Some(info) => {
                        resolve_override(rules, &info.process, &info.class_name, &info.title)
                    }
                    None => last_override.clone(),
                }
            };

            if next != last_override {
                crate::display::engine::set_rule_override(next.clone());
                last_override = next;
            }
        }
    }

    /// Resolve the current foreground window's process / class / title.
    fn foreground_info() -> Option<ForegroundInfo> {
        // SAFETY: returns the foreground HWND or a null handle (no focus).
        let hwnd = unsafe { GetForegroundWindow() };
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
    /// exclusion a poll landing while the switcher is up read as "a game went
    /// full-screen" and restored the original gamma ramps, so Alt-tabbing
    /// flashed the screen back to full brightness with no blue filter for a
    /// poll interval — see also the maximized-window exclusion below, the same
    /// bug from a different direction.
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

    /// Consecutive full-screen samples required before filtering is suspended.
    /// Belt-and-braces on top of [`is_shell_class`]: the shell has more
    /// transient full-screen surfaces than we can enumerate by class (snap
    /// assist, splash screens, a switcher class we have not met yet), and a
    /// wrong suspension is a *visible gamma flash*, whereas a wrong 700 ms
    /// delay before a game suspends filtering is imperceptible. Asymmetric on
    /// purpose — see [`confirm_fullscreen`].
    const FULLSCREEN_CONFIRM_TICKS: u32 = 2;

    /// Advance the full-screen confirmation `streak` with one `sample` and
    /// report whether a suspension is confirmed.
    ///
    /// Engaging needs [`FULLSCREEN_CONFIRM_TICKS`] consecutive full-screen
    /// samples; releasing is immediate, so leaving a game restores filtering on
    /// the very next poll. Split out from the loop so the debounce is
    /// unit-tested without a foreground window.
    fn confirm_fullscreen(streak: &mut u32, sample: bool) -> bool {
        *streak = if sample { streak.saturating_add(1) } else { 0 };
        *streak >= FULLSCREEN_CONFIRM_TICKS
    }

    /// Whether the foreground window fully covers its monitor — a game or other
    /// full-screen app (FEATURE-PARITY F1.11). Excludes our own windows and the
    /// desktop/shell surfaces (which also span the screen but are not apps).
    fn is_fullscreen_foreground() -> bool {
        // SAFETY: returns the foreground HWND or a null handle (no focus).
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return false;
        }
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

    /// The pure geometry rule behind [`is_fullscreen_foreground`], split out so
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
            FULLSCREEN_CONFIRM_TICKS, RECT, confirm_fullscreen, is_fullscreen_geometry,
            is_shell_class,
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
        fn fullscreen_must_be_seen_twice_before_it_engages() {
            let mut streak = 0;
            assert!(!confirm_fullscreen(&mut streak, true));
            assert!(confirm_fullscreen(&mut streak, true));
            assert!(confirm_fullscreen(&mut streak, true));
        }

        #[test]
        fn a_single_transient_fullscreen_sample_never_engages() {
            // One poll landing on an unknown full-screen shell surface must
            // not suspend filtering.
            let mut streak = 0;
            assert!(!confirm_fullscreen(&mut streak, true));
            assert!(!confirm_fullscreen(&mut streak, false));
            assert!(!confirm_fullscreen(&mut streak, true));
        }

        #[test]
        fn leaving_fullscreen_releases_immediately() {
            let mut streak = 0;
            for _ in 0..FULLSCREEN_CONFIRM_TICKS {
                confirm_fullscreen(&mut streak, true);
            }
            assert!(!confirm_fullscreen(&mut streak, false));
        }

        #[test]
        fn a_long_fullscreen_run_cannot_overflow_the_streak() {
            let mut streak = u32::MAX;
            assert!(confirm_fullscreen(&mut streak, true));
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
