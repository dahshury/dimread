//! System tray: theme-aware icon + the tray FLYOUT trigger.
//!
//! There is deliberately NO native context menu. A native tray menu can only
//! host labels and check marks, so brightness had to ship as a ten-row
//! quick-set submenu — which is not a brightness control, it is ten buttons
//! shaped like one. Instead the tray icon opens a transparent webview popup
//! (`crate::tray_menu`, the `tray-menu` window) that renders the real Display
//! controls: the same gradient brightness / colour-temperature sliders the main
//! window uses, plus the mode grid. RIGHT click toggles it — that is where the
//! native context menu used to be; the popup's own rows cover Show / Settings /
//! Quit. LEFT click is the plain "give me the app" gesture and surfaces the main
//! window (same path as the `toggleMain` hotkey's show branch).
//!
//! What stays in Rust is the icon, the tooltip, and the click routing. Every
//! display mutation now flows through the renderer's normal
//! `settings_save` / `display_preview` path (`features/display`), so the tray
//! and the main window share ONE persistence contract instead of the tray
//! keeping a parallel Rust-side writer. In particular the "dimming while
//! paused redirects the edit into `custom`" rule lives in
//! `buildSliderCommitPatch` and now applies to the tray sliders too.
//!
//! The tooltip shows the live engine output (e.g. `DimRead — 5000K · 85%`) and
//! follows the `display:state` event.
//!
//! The taskbar/menu-bar theme can differ from the app theme, so the icon is
//! chosen from the OS: on Windows the `SystemUsesLightTheme` registry value
//! (the app theme registry key is `AppsUseLightTheme` — the WRONG one for the
//! tray), elsewhere the main window's reported theme. A dark taskbar gets the
//! light glyph and vice versa. Repainted on `WindowEvent::ThemeChanged`.

use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Listener, Manager, Theme};
use tauri_specta::Event as _;

use crate::display::DisplayOutput;
use crate::events::DisplayStateEvent;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppTheme {
    Dark,
    Light,
}

/// The compact full-color app mark shown on a DARK taskbar.
const TRAY_ICON_ON_DARK: &[u8] = include_bytes!("../icons/tray-on-dark.png");
/// The compact full-color app mark shown on a LIGHT taskbar.
const TRAY_ICON_ON_LIGHT: &[u8] = include_bytes!("../icons/tray-on-light.png");

/// Product name shown in the tooltip.
const APP_NAME: &str = "DimRead";
/// Tooltip fragment shown while filtering is paused.
const PAUSED_LABEL: &str = "Paused";

/// `pause` is the "no filtering" mode.
fn is_paused(mode: &str) -> bool {
    mode == "pause"
}

/// Tooltip text for the current engine output, e.g. `DimRead — 5000K · 85%`
/// (or `DimRead — Paused` while filtering is off).
fn tray_tooltip_text(output: &DisplayOutput) -> String {
    if is_paused(&output.mode) {
        format!("{APP_NAME} — {PAUSED_LABEL}")
    } else {
        format!("{APP_NAME} — {}K · {}%", output.kelvin, output.brightness)
    }
}

pub fn get_current_theme(app: &AppHandle) -> AppTheme {
    #[cfg(target_os = "windows")]
    if let Some(theme) = windows_taskbar_theme() {
        return theme;
    }
    match app.get_webview_window("main") {
        Some(main_window) => match main_window.theme().unwrap_or(Theme::Dark) {
            Theme::Light => AppTheme::Light,
            _ => AppTheme::Dark,
        },
        None => AppTheme::Dark,
    }
}

#[cfg(any(target_os = "windows", test))]
fn taskbar_theme_from_registry_value(value: u32) -> Option<AppTheme> {
    match value {
        0 => Some(AppTheme::Dark),
        1 => Some(AppTheme::Light),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn windows_taskbar_theme() -> Option<AppTheme> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let personalize = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        .ok()?;
    let system_uses_light: u32 = personalize.get_value("SystemUsesLightTheme").ok()?;
    taskbar_theme_from_registry_value(system_uses_light)
}

fn tray_icon_for_theme(theme: AppTheme) -> Result<Image<'static>, tauri::Error> {
    Image::from_bytes(match theme {
        AppTheme::Dark => TRAY_ICON_ON_DARK,
        AppTheme::Light => TRAY_ICON_ON_LIGHT,
    })
}

/// Build the tray icon and stash its handle in managed state so
/// `refresh_tray_icon` can repaint it on theme changes and the `display:state`
/// listener can keep its tooltip live.
pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    let output = crate::display::engine::current_output();

    let tray = TrayIconBuilder::new()
        .icon(tray_icon_for_theme(get_current_theme(app))?)
        .tooltip(tray_tooltip_text(&output))
        // macOS: template icons are recolored by the system for the menu bar.
        .icon_as_template(true)
        // No `.menu(...)`: right click opens the webview flyout, left click
        // raises the main window (see the `on_tray_icon_event` handler below).
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray_handle, event| {
            let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            else {
                return;
            };
            let app = tray_handle.app_handle();
            match button {
                // Left click is the plain "give me the app" gesture: surface +
                // focus the main window. Any open flyout is dismissed first so
                // the two tray surfaces are never up at once.
                MouseButton::Left => {
                    crate::tray_menu::hide(app);
                    crate::window_state::show_main_window(app);
                }
                // Right click keeps the flyout — it is where the native context
                // menu used to be.
                // `position` is PHYSICAL px; the flyout converts it.
                MouseButton::Right => {
                    crate::tray_menu::toggle_at_physical(app, position.x, position.y);
                }
                _ => {}
            }
        })
        .build(app)?;
    app.manage(tray);

    // Keep the tooltip in lockstep with the engine.
    let handle = app.clone();
    app.listen(DisplayStateEvent::NAME, move |event| {
        let Ok(output) = serde_json::from_str::<DisplayOutput>(event.payload()) else {
            return;
        };
        // Tray mutation must run on the main thread (display:state can be
        // emitted from an IPC command thread during a slider-drag preview).
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || sync_tray_to_output(&app, &output));
    });

    Ok(())
}

/// Update the tray tooltip from the latest engine output.
fn sync_tray_to_output(app: &AppHandle, output: &DisplayOutput) {
    if let Some(tray) = app.try_state::<TrayIcon>()
        && let Err(err) = tray.set_tooltip(Some(tray_tooltip_text(output)))
    {
        log::warn!("[tray] failed to set tooltip: {err}");
    }
}

/// Repaint the tray icon for the current OS theme (ThemeChanged handler).
pub fn refresh_tray_icon(app: &AppHandle) {
    let Some(tray) = app.try_state::<TrayIcon>() else {
        return;
    };
    match tray_icon_for_theme(get_current_theme(app)) {
        Ok(image) => {
            if let Err(err) = tray.set_icon(Some(image)) {
                log::warn!("[tray] failed to set tray icon: {err}");
            }
        }
        Err(err) => log::warn!("[tray] failed to decode tray icon: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taskbar_theme_is_dark_when_registry_value_is_zero() {
        assert_eq!(taskbar_theme_from_registry_value(0), Some(AppTheme::Dark));
    }

    #[test]
    fn taskbar_theme_is_light_when_registry_value_is_one() {
        assert_eq!(taskbar_theme_from_registry_value(1), Some(AppTheme::Light));
    }

    #[test]
    fn taskbar_theme_falls_back_when_registry_value_is_invalid() {
        assert_eq!(taskbar_theme_from_registry_value(2), None);
    }

    #[test]
    fn embedded_tray_icons_decode() {
        assert!(tray_icon_for_theme(AppTheme::Dark).is_ok());
        assert!(tray_icon_for_theme(AppTheme::Light).is_ok());
    }

    #[test]
    fn only_pause_reads_as_paused() {
        assert!(is_paused("pause"));
        assert!(!is_paused("health"));
        assert!(!is_paused("custom"));
    }

    #[test]
    fn tooltip_shows_paused_or_output() {
        let paused = DisplayOutput {
            kelvin: 6500,
            brightness: 100,
            mode: "pause".into(),
            phase: "day".into(),
        };
        assert_eq!(tray_tooltip_text(&paused), "DimRead — Paused");

        let active = DisplayOutput {
            kelvin: 5000,
            brightness: 85,
            mode: "health".into(),
            phase: "night".into(),
        };
        assert_eq!(tray_tooltip_text(&active), "DimRead — 5000K · 85%");
    }
}
