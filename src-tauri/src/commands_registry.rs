//! The tauri-specta `Builder` construction: full command list + event registry.
//! Single source of truth for both `run()` (which mounts it on the live app)
//! and the `export_bindings` test (which calls `.export(...)` without starting
//! the app). Pure declarative, no shared state.
//!
//! EVERY `#[tauri::command]` in the crate must be listed in
//! `collect_commands![]` and every typed event in `collect_events![]` —
//! otherwise it is invisible to the renderer and missing from the generated
//! `src/bindings.ts`.

use tauri::AppHandle;
use tauri_specta::{Builder, collect_commands, collect_events};

use crate::{
    display, downloads, events, focus, hotkeys, magicx, overlay, rules, settings, tray_menu,
    windows,
};

/// `show_main_window` — surface + focus the main window (tray, second-instance
/// launches, and renderer flows all funnel here).
#[tauri::command]
#[specta::specta]
pub(crate) fn show_main_window(app: AppHandle) {
    crate::window_state::show_main_window(&app);
}

/// `app_quit` — exit the app. The tray flyout's Quit row is the only caller
/// (the native tray menu it replaced owned this action).
#[tauri::command]
#[specta::specta]
pub(crate) fn app_quit(app: AppHandle) {
    crate::app_exit::request_app_exit(&app, "Quit requested from the tray menu");
}

/// Build the tauri-specta `Builder` with the full command + event registry.
pub fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        // ── windows ──
        windows::open_window,
        windows::close_window,
        windows::close_self_window,
        show_main_window,
        app_quit,
        // ── tray flyout ──
        tray_menu::commands::tray_menu_hide,
        tray_menu::commands::tray_menu_resize,
        // ── settings ──
        settings::commands::settings_load_snapshot,
        settings::commands::settings_save,
        // ── downloads ──
        downloads::commands::download_start,
        downloads::commands::download_pause,
        downloads::commands::download_resume,
        downloads::commands::download_cancel,
        downloads::commands::download_remove,
        downloads::commands::download_list,
        downloads::commands::open_downloads_dir,
        // ── hotkeys ──
        hotkeys::hotkey_register,
        hotkeys::hotkey_unregister,
        hotkeys::hotkey_list,
        // ── overlay ──
        overlay::overlay_notify,
        overlay::overlay_dismiss,
        // ── display ──
        display::engine::display_list_monitors,
        display::engine::display_current,
        display::engine::display_preview,
        display::engine::display_preview_end,
        display::engine::display_set_value,
        // ── rules ──
        rules::rules_list_windows,
        // ── focus (F8) ──
        focus::focus_read_toggle,
        focus::focus_blur_toggle,
        focus::focus_active_state,
        // ── magicx (F9) ──
        magicx::magicx_toggle_effect,
        magicx::magicx_clear_target,
    ]);

    builder.events(collect_events![
        events::SettingsChangedEvent,
        events::DownloadUpdateEvent,
        events::PickerAnchorEvent,
        events::PickerClosingEvent,
        events::HotkeyTriggeredEvent,
        events::OverlayNotifyEvent,
        events::OverlayDismissEvent,
        events::DisplayStateEvent,
        events::FocusStateEvent,
        events::FocusCursorEvent,
        events::FocusAnchorEvent,
        events::MagicToolbarShowEvent,
        events::MagicToolbarHideEvent,
        events::AutoDarkChangedEvent,
    ])
}
