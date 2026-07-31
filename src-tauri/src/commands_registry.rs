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
    diagnostics, display, events, focus, hotkeys, magicx, rules, settings, tray_menu, update,
    windows,
};

/// `show_app_window` — surface + focus the app's one top-level window (the
/// settings window). The tray, second-instance launches, and the renderer's
/// startup reveal all funnel here.
#[tauri::command]
#[specta::specta]
pub(crate) fn show_app_window(app: AppHandle) {
    crate::window_state::show_primary_window(&app);
}

/// `hide_app_window` — dismiss the app window to the tray WITHOUT consulting
/// `general.minimizeToTray`.
///
/// Distinct from `close_self_window` on purpose. Closing is a decision ("am I
/// done with this app?") and may quit; the Escape key is a dismissal ("get this
/// off my screen") and must never take the app down with it — Escape quitting
/// DimRead would also drop the user's display filters.
#[tauri::command]
#[specta::specta]
pub(crate) fn hide_app_window(app: AppHandle) {
    crate::window_state::hide_primary_window(&app);
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
        show_app_window,
        hide_app_window,
        app_quit,
        // ── tray flyout ──
        tray_menu::commands::tray_menu_hide,
        tray_menu::commands::tray_menu_resize,
        // ── settings ──
        settings::commands::settings_load_snapshot,
        settings::commands::settings_save,
        settings::transfer::settings_export_backup,
        settings::transfer::settings_import_backup,
        settings::transfer::settings_reset_defaults,
        // ── diagnostics ──
        diagnostics::diagnostics_open_logs_folder,
        diagnostics::diagnostics_save_bundle,
        diagnostics::diagnostics_recent_issues,
        diagnostics::diagnostics_clear_issues,
        diagnostics::diagnostics_set_log_streaming,
        // ── hotkeys ──
        hotkeys::hotkey_register,
        hotkeys::hotkey_unregister,
        hotkeys::hotkey_list,
        // ── display ──
        display::engine::display_list_monitors,
        display::engine::display_current,
        display::engine::display_preview,
        display::engine::display_preview_end,
        display::engine::display_set_value,
        display::location::daynight_list_timezones,
        display::location::daynight_location_status,
        // ── rules ──
        rules::rules_list_windows,
        // ── focus (F8) ──
        focus::focus_read_toggle,
        focus::focus_blur_toggle,
        focus::focus_active_state,
        focus::blur::focus_blur_anchor_snapshot,
        // ── magicx (F9) ──
        magicx::magicx_toggle_effect,
        magicx::magicx_clear_target,
        magicx::toolbar::magictoolbar_renderer_ready,
        magicx::toolbar::magictoolbar_hide_complete,
        // ── updates ──
        update::commands::update_check,
    ]);

    builder.events(collect_events![
        events::SettingsChangedEvent,
        events::HotkeyTriggeredEvent,
        events::DisplayStateEvent,
        events::DisplayTopologyEvent,
        events::FocusStateEvent,
        events::FocusCursorEvent,
        events::FocusAnchorEvent,
        events::MagicToolbarShowEvent,
        events::MagicToolbarHideEvent,
        events::AutoDarkChangedEvent,
        events::DiagnosticsLogLineEvent,
    ])
}
