//! App-window geometry persistence and visibility: load/save/restore position,
//! monitor-bounds check, and the show / hide / close paths for
//! [`crate::windows::PRIMARY_WINDOW`].
//!
//! DimRead has ONE top-level window (the settings window). Everything in here
//! used to be keyed on a separate `main` window; when that window was removed
//! the settings window inherited the role, so these helpers are the single
//! place that decides where the app window sits and whether closing it hides to
//! the tray or quits.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::windows::PRIMARY_WINDOW;

/// Dedicated store for window geometry persisted across runs. Kept separate
/// from the settings store so it never collides with a user-facing setting and
/// can be cleared independently. Only the APP window is tracked — every
/// secondary window (picker, gallery) is positioned dynamically each time.
const WINDOW_STATE_STORE: &str = "window-state.json";
const APP_POSITION_KEY: &str = "app_position";
const INITIAL_REVEAL_FALLBACK_DELAY: Duration = Duration::from_secs(3);

/// Set by every successful reveal path. Besides representing renderer startup,
/// this prevents the fallback from reopening a window the user already showed
/// and then deliberately hid during the first few seconds.
static INITIAL_REVEAL_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Read the persisted app-window position (physical pixels), if any.
fn load_window_position(app: &AppHandle) -> Option<(i32, i32)> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store(crate::portable::store_path(WINDOW_STATE_STORE))
        .ok()?;
    let value = store.get(APP_POSITION_KEY)?;
    let x = value.get("x")?.as_i64()? as i32;
    let y = value.get("y")?.as_i64()? as i32;
    Some((x, y))
}

/// Persist the app-window position (physical pixels). A plain `set` is
/// enough: the store plugin debounce-saves to disk, so a drag that fires
/// dozens of `Moved` events only writes once after the movement settles.
pub(crate) fn save_window_position(app: &AppHandle, x: i32, y: i32) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(crate::portable::store_path(WINDOW_STATE_STORE)) else {
        return;
    };
    store.set(APP_POSITION_KEY, serde_json::json!({ "x": x, "y": y }));
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

/// Restore the saved app-window position after the window is built. The
/// builder already centered it (the first-run default); this overrides that
/// with the remembered spot when one exists AND is still on-screen. Runs while
/// the window is still `visible(false)`, so there is no visible jump.
pub(crate) fn restore_window_position(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some((x, y)) = load_window_position(app) else {
        return;
    };
    if !position_on_any_monitor(window, x, y) {
        log::info!("Saved app window position ({x}, {y}) is off-screen; keeping it centered.");
        return;
    }
    if let Err(e) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
        log::warn!("Failed to restore app window position: {e}");
    }
}

/// Show + raise + focus the app window. Secondary-window prewarming is driven
/// by the app renderer's page-load callback in `lib.rs`.
pub(crate) fn show_primary_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PRIMARY_WINDOW) else {
        log::error!(
            "App window '{PRIMARY_WINDOW}' not found. Webview labels: {:?}",
            app.webview_windows().keys().collect::<Vec<_>>()
        );
        return;
    };
    INITIAL_REVEAL_REQUESTED.store(true, Ordering::Release);
    if let Err(e) = window.unminimize() {
        log::warn!("Failed to unminimize app window: {e}");
    }
    if let Err(e) = window.show() {
        log::error!("Failed to show app window: {e}");
    }
    // Force the window ABOVE every other app's window. On Windows
    // `set_focus()` alone is unreliable when another process owns the
    // foreground (SetForegroundWindow is restricted to the foreground-owning
    // process), so the window would come up BEHIND whatever the user was
    // typing into. Briefly toggling always-on-top reliably raises it.
    #[cfg(target_os = "windows")]
    {
        let _ = window.set_always_on_top(true);
        let _ = window.set_always_on_top(false);
    }
    if let Err(e) = window.set_focus() {
        log::warn!("Failed to focus app window: {e}");
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            log::warn!("Failed to set activation policy to Regular: {e}");
        }
    }
}

/// Safety net for renderer startup. Normal startup is renderer-driven so the
/// window's first visible frame is already painted. If the renderer fails
/// before sending that acknowledgement, reveal the window after a short grace
/// period rather than leaving the app invisibly running.
pub(crate) fn schedule_initial_reveal_fallback(app: &AppHandle) {
    let fallback_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("app-reveal-fallback".into())
        .spawn(move || {
            std::thread::sleep(INITIAL_REVEAL_FALLBACK_DELAY);
            if !INITIAL_REVEAL_REQUESTED.load(Ordering::Acquire) {
                log::warn!("App renderer did not request its initial reveal; showing the window.");
                show_primary_window(&fallback_app);
            }
        });
    if let Err(error) = spawned {
        log::warn!("Failed to schedule app-window reveal fallback: {error}");
        show_primary_window(app);
    }
}

/// Hide the app window to the tray.
pub(crate) fn hide_primary_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PRIMARY_WINDOW) else {
        return;
    };
    if let Err(err) = window.hide() {
        log::warn!("failed to hide app window: {err}");
    }
}

/// Close the app window: hide it to the tray, or quit the whole app when the
/// user has turned `general.minimizeToTray` off.
///
/// This is the ONE place that decision is made. Every close path — the
/// renderer's X button (`close_self_window`) and a native close such as Alt+F4
/// (`CloseRequested` in `lib.rs`) — routes here so the two cannot drift.
/// Quitting goes through `app_exit::request_app_exit` rather than a bare close
/// so the store plugin gets its flush and the display filters are restored.
pub(crate) fn close_primary_window(app: &AppHandle) {
    if crate::settings::store::read_settings(app)
        .general
        .minimize_to_tray
    {
        log::debug!("App window close requested - hiding to tray.");
        hide_primary_window(app);
    } else {
        crate::app_exit::request_app_exit(app, "App window closed");
    }
}
