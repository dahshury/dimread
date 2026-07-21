//! Main-window geometry persistence and visibility: load/save/restore
//! position, monitor-bounds check, `show_main_window`.

use tauri::{AppHandle, Manager};

/// Dedicated store for window geometry persisted across runs. Kept separate
/// from the settings store so it never collides with a user-facing setting and
/// can be cleared independently. Only the MAIN window is tracked — every
/// secondary window (settings modal, picker, gallery) is positioned
/// dynamically each time.
const WINDOW_STATE_STORE: &str = "window-state.json";
const MAIN_POSITION_KEY: &str = "main_position";

/// Read the persisted main-window position (physical pixels), if any.
fn load_main_window_position(app: &AppHandle) -> Option<(i32, i32)> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store(crate::portable::store_path(WINDOW_STATE_STORE))
        .ok()?;
    let value = store.get(MAIN_POSITION_KEY)?;
    let x = value.get("x")?.as_i64()? as i32;
    let y = value.get("y")?.as_i64()? as i32;
    Some((x, y))
}

/// Persist the main-window position (physical pixels). A plain `set` is
/// enough: the store plugin debounce-saves to disk, so a drag that fires
/// dozens of `Moved` events only writes once after the movement settles.
pub(crate) fn save_main_window_position(app: &AppHandle, x: i32, y: i32) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(crate::portable::store_path(WINDOW_STATE_STORE)) else {
        return;
    };
    store.set(MAIN_POSITION_KEY, serde_json::json!({ "x": x, "y": y }));
}

/// True if the point `(x, y)` (physical) falls inside any currently-connected
/// monitor. Guards against restoring the window onto a display that has since
/// been unplugged, which would otherwise strand it off-screen.
fn position_on_any_monitor(window: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        let right = pos.x + size.width as i32;
        let bottom = pos.y + size.height as i32;
        x >= pos.x && x < right && y >= pos.y && y < bottom
    })
}

/// Restore the saved main-window position after the window is built. The
/// builder already centered it (the first-run default); this overrides that
/// with the remembered spot when one exists AND is still on-screen. Runs while
/// the window is still `visible(false)`, so there is no visible jump.
pub(crate) fn restore_main_window_position(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some((x, y)) = load_main_window_position(app) else {
        return;
    };
    if !position_on_any_monitor(window, x, y) {
        log::info!("Saved main window position ({x}, {y}) is off-screen; keeping it centered.");
        return;
    }
    if let Err(e) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
        log::warn!("Failed to restore main window position: {e}");
    }
}

/// Show + raise + focus the main window, then schedule the secondary-window
/// prewarm (idempotent).
pub(crate) fn show_main_window(app: &AppHandle) {
    let Some(main_window) = app.get_webview_window("main") else {
        log::error!(
            "Main window not found. Webview labels: {:?}",
            app.webview_windows().keys().collect::<Vec<_>>()
        );
        return;
    };
    if let Err(e) = main_window.unminimize() {
        log::warn!("Failed to unminimize main window: {e}");
    }
    if let Err(e) = main_window.show() {
        log::error!("Failed to show main window: {e}");
    }
    // Force the window ABOVE every other app's window. On Windows
    // `set_focus()` alone is unreliable when another process owns the
    // foreground (SetForegroundWindow is restricted to the foreground-owning
    // process), so the window would come up BEHIND whatever the user was
    // typing into. Briefly toggling always-on-top reliably raises it.
    #[cfg(target_os = "windows")]
    {
        let _ = main_window.set_always_on_top(true);
        let _ = main_window.set_always_on_top(false);
    }
    if let Err(e) = main_window.set_focus() {
        log::warn!("Failed to focus main window: {e}");
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            log::warn!("Failed to set activation policy to Regular: {e}");
        }
    }
    crate::windows::schedule_post_startup_prewarm(app);
}

/// Hide the main window to the tray.
///
/// NOT a bare `main.hide()`: the settings window is an owner-CHILD of main and
/// disables main's input while it is open (`set_main_modal`). Hiding main
/// underneath it would strand that input-disable — main comes back from the
/// tray permanently unclickable, and the orphaned settings child stays on
/// screen. Route the child through its normal close path first, which releases
/// the modal lock.
///
/// Shared by every hide-to-tray caller (the `CloseRequested` handler and the
/// `toggleMain` hotkey) so the teardown can't drift between them again.
pub(crate) fn hide_main_window(app: &AppHandle) {
    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };
    let settings_open = app
        .get_webview_window("settings")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if settings_open && let Err(err) = crate::windows::close_window_internal(app, "settings") {
        log::warn!("failed to close settings before hiding main: {err}");
    }
    if let Err(err) = main_window.hide() {
        log::warn!("failed to hide main window: {err}");
    }
}
