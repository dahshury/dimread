//! System tray: theme-aware icon + the tray FLYOUT trigger.
//!
//! There is deliberately NO native context menu. A native tray menu can only
//! host labels and check marks, so brightness had to ship as a ten-row
//! quick-set submenu — which is not a brightness control, it is ten buttons
//! shaped like one. Instead the tray icon opens a transparent webview popup
//! (`crate::tray_menu`, the `tray-menu` window) that renders the real Display
//! controls: the same gradient brightness / colour-temperature sliders the app
//! window uses, plus the mode grid. RIGHT click toggles it — that is where the
//! native context menu used to be; the popup's own rows cover Settings / Quit.
//! LEFT click is the plain "give me the app" gesture and surfaces the app
//! window (same path as the `toggleMain` hotkey's show branch).
//!
//! What stays in Rust is the icon, the tooltip, and the click routing. Every
//! display mutation now flows through the renderer's normal
//! `settings_save` / `display_preview` path (`features/display`), so the tray
//! and the app window share ONE persistence contract instead of the tray
//! keeping a parallel Rust-side writer. In particular the "dimming while
//! paused redirects the edit into `custom`" rule lives in
//! `buildSliderCommitPatch` and now applies to the tray sliders too.
//!
//! The tooltip shows the live engine output (e.g. `DimRead — 5000K · 85%`) and
//! follows the `display:state` event.
//!
//! # The icon is STATEFUL
//!
//! The tray glyph is not one image — it is a family, picked from three axes:
//!
//!   * **display mode** — one variant per entry in `DISPLAY_MODE_IDS` (pause,
//!     health, game, movie, office, editing, reading, custom), so the tray shows
//!     what the engine is doing without opening anything. `pause` is the
//!     "filtering off" member of the family.
//!   * **day / night phase** — the same mark tinted cool for the day profile and
//!     warm for the night one, following the scheduler. `transition` renders as
//!     day (there is no third artwork; the tooltip carries the exact numbers).
//!   * **taskbar theme** — a dark taskbar gets the light-optimised rendering and
//!     vice versa. The taskbar/menu-bar theme can differ from the app theme, so
//!     this comes from the OS: on Windows the `SystemUsesLightTheme` registry
//!     value (the app-theme key is `AppsUseLightTheme` — the WRONG one for the
//!     tray), elsewhere the app window's reported theme.
//!
//! All 8 x 2 x 2 renderings are generated from ONE base mark by
//! `tools/assets/generate-icons.py` into `icons/tray/` and embedded here with
//! `include_bytes!`, so adding a display mode means adding its artwork to that
//! generator and its id to `TRAY_ICON_VARIANTS` — the compile fails otherwise,
//! which is the point.
//!
//! Repainted on `display:state` (mode/phase changed) and on
//! `WindowEvent::ThemeChanged` (taskbar theme changed).

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

/// Which day/night rendering of the mark to show. `transition` maps to `Day`:
/// the scheduler is mid-blend and a third artwork would only add flicker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayPhase {
    Day,
    Night,
}

impl TrayPhase {
    fn from_engine_phase(phase: &str) -> Self {
        if phase == "night" {
            Self::Night
        } else {
            Self::Day
        }
    }
}

/// The four renderings of one display mode's mark.
struct TrayIconVariant {
    mode: &'static str,
    day_on_dark: &'static [u8],
    day_on_light: &'static [u8],
    night_on_dark: &'static [u8],
    night_on_light: &'static [u8],
}

/// Expand one mode id into its four embedded PNGs. Keeps the roster a plain
/// list of ids instead of 32 hand-written `include_bytes!` lines that could
/// silently pair the wrong file with the wrong state.
macro_rules! tray_icon_variants {
    ($($mode:literal),+ $(,)?) => {
        &[$(TrayIconVariant {
            mode: $mode,
            day_on_dark: include_bytes!(concat!("../icons/tray/", $mode, "-day-on-dark.png")),
            day_on_light: include_bytes!(concat!("../icons/tray/", $mode, "-day-on-light.png")),
            night_on_dark: include_bytes!(concat!("../icons/tray/", $mode, "-night-on-dark.png")),
            night_on_light: include_bytes!(concat!("../icons/tray/", $mode, "-night-on-light.png")),
        }),+]
    };
}

/// Must mirror `DISPLAY_MODE_IDS` in `settings/mod.rs` — a test asserts it.
const TRAY_ICON_VARIANTS: &[TrayIconVariant] = tray_icon_variants![
    "pause", "health", "game", "movie", "office", "editing", "reading", "custom",
];

/// Rendering used when the persisted mode is not in the roster (a settings file
/// from a newer build, or a hand-edited one). `custom` is the neutral member.
const TRAY_ICON_FALLBACK_MODE: &str = "custom";

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
    match app.get_webview_window(crate::windows::PRIMARY_WINDOW) {
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

/// Pick the embedded PNG for a (mode, phase, taskbar theme) triple, falling
/// back to [`TRAY_ICON_FALLBACK_MODE`] for an unknown mode.
fn tray_icon_bytes(mode: &str, phase: TrayPhase, theme: AppTheme) -> &'static [u8] {
    let variant = TRAY_ICON_VARIANTS
        .iter()
        .find(|variant| variant.mode == mode)
        .or_else(|| {
            TRAY_ICON_VARIANTS
                .iter()
                .find(|variant| variant.mode == TRAY_ICON_FALLBACK_MODE)
        })
        .expect("the tray icon roster always contains the fallback mode");
    match (phase, theme) {
        // A DARK taskbar gets the on-dark rendering, and vice versa.
        (TrayPhase::Day, AppTheme::Dark) => variant.day_on_dark,
        (TrayPhase::Day, AppTheme::Light) => variant.day_on_light,
        (TrayPhase::Night, AppTheme::Dark) => variant.night_on_dark,
        (TrayPhase::Night, AppTheme::Light) => variant.night_on_light,
    }
}

/// Decode the tray icon for the engine's current output on the current taskbar
/// theme.
fn tray_icon_for(output: &DisplayOutput, theme: AppTheme) -> Result<Image<'static>, tauri::Error> {
    Image::from_bytes(tray_icon_bytes(
        &output.mode,
        TrayPhase::from_engine_phase(&output.phase),
        theme,
    ))
}

/// Build the tray icon and stash its handle in managed state so
/// `refresh_tray_icon` can repaint it on theme changes and the `display:state`
/// listener can keep its tooltip live.
pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    let output = crate::display::engine::current_output();

    let tray = TrayIconBuilder::new()
        .icon(tray_icon_for(&output, get_current_theme(app))?)
        .tooltip(tray_tooltip_text(&output))
        // NOT a template icon. A macOS template is drawn from its alpha channel
        // alone, which would flatten every mode/phase variant into the same
        // silhouette — and the variant's COLOUR is the state signal here. The
        // on-dark / on-light pair already covers menu-bar contrast manually.
        .icon_as_template(false)
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
                // focus the app window (the settings window — the app's only
                // top-level surface). Any open flyout is dismissed first so the
                // two tray surfaces are never up at once.
                MouseButton::Left => {
                    crate::tray_menu::hide(app);
                    crate::window_state::show_primary_window(app);
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

/// Update the tray tooltip AND glyph from the latest engine output — the mode
/// and phase in that output are two of the icon's three axes.
fn sync_tray_to_output(app: &AppHandle, output: &DisplayOutput) {
    let Some(tray) = app.try_state::<TrayIcon>() else {
        return;
    };
    if let Err(err) = tray.set_tooltip(Some(tray_tooltip_text(output))) {
        log::warn!("[tray] failed to set tooltip: {err}");
    }
    set_tray_icon(&tray, output, get_current_theme(app));
}

/// Repaint the tray icon for the current OS theme (ThemeChanged handler),
/// keeping the mode/phase the engine is currently in.
pub fn refresh_tray_icon(app: &AppHandle) {
    let Some(tray) = app.try_state::<TrayIcon>() else {
        return;
    };
    let output = crate::display::engine::current_output();
    set_tray_icon(&tray, &output, get_current_theme(app));
}

fn set_tray_icon(tray: &TrayIcon, output: &DisplayOutput, theme: AppTheme) {
    match tray_icon_for(output, theme) {
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

    /// The tray roster IS the display-mode roster. If a mode is added to the
    /// settings schema without artwork, the tray would silently fall back to
    /// `custom` and the icon would stop meaning anything.
    #[test]
    fn tray_icon_roster_matches_the_display_modes() {
        let modes: Vec<&str> = TRAY_ICON_VARIANTS.iter().map(|v| v.mode).collect();
        assert_eq!(modes, crate::settings::DISPLAY_MODE_IDS.to_vec());
        assert!(modes.contains(&TRAY_ICON_FALLBACK_MODE));
    }

    #[test]
    fn every_embedded_tray_icon_decodes() {
        for variant in TRAY_ICON_VARIANTS {
            for phase in [TrayPhase::Day, TrayPhase::Night] {
                for theme in [AppTheme::Dark, AppTheme::Light] {
                    assert!(
                        Image::from_bytes(tray_icon_bytes(variant.mode, phase, theme)).is_ok(),
                        "{} {phase:?} {theme:?} does not decode",
                        variant.mode
                    );
                }
            }
        }
    }

    /// Every (mode, phase, theme) triple must resolve to a DISTINCT image —
    /// otherwise the generator silently emitted duplicates and the tray stops
    /// communicating state.
    #[test]
    fn each_tray_state_has_its_own_artwork() {
        let mut seen: Vec<&[u8]> = Vec::new();
        for variant in TRAY_ICON_VARIANTS {
            for phase in [TrayPhase::Day, TrayPhase::Night] {
                for theme in [AppTheme::Dark, AppTheme::Light] {
                    let bytes = tray_icon_bytes(variant.mode, phase, theme);
                    assert!(
                        !seen.contains(&bytes),
                        "{} {phase:?} {theme:?} duplicates another tray icon",
                        variant.mode
                    );
                    seen.push(bytes);
                }
            }
        }
        assert_eq!(seen.len(), TRAY_ICON_VARIANTS.len() * 4);
    }

    #[test]
    fn an_unknown_mode_falls_back_instead_of_panicking() {
        assert_eq!(
            tray_icon_bytes("mode-from-the-future", TrayPhase::Day, AppTheme::Dark),
            tray_icon_bytes(TRAY_ICON_FALLBACK_MODE, TrayPhase::Day, AppTheme::Dark),
        );
    }

    #[test]
    fn only_night_renders_the_warm_variant() {
        assert_eq!(TrayPhase::from_engine_phase("night"), TrayPhase::Night);
        assert_eq!(TrayPhase::from_engine_phase("day"), TrayPhase::Day);
        // Mid-blend has no third artwork; the tooltip carries the numbers.
        assert_eq!(TrayPhase::from_engine_phase("transition"), TrayPhase::Day);
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
            factor: 1.0,
            grayscale_applied: false,
        };
        assert_eq!(tray_tooltip_text(&paused), "DimRead — Paused");

        let active = DisplayOutput {
            kelvin: 5000,
            brightness: 85,
            mode: "health".into(),
            phase: "night".into(),
            factor: 0.0,
            grayscale_applied: false,
        };
        assert_eq!(tray_tooltip_text(&active), "DimRead — 5000K · 85%");
    }
}
