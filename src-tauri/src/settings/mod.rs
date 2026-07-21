//! Settings schema + persistence + IPC commands.
//!
//! The schema is deliberately demo-sized (three FLAT sections). The
//! infrastructure is the part worth keeping when you build on the template:
//!   * `store` — durable atomic persistence (`dimread-settings.json` via
//!     tauri-plugin-store), a process-wide write lock, and a monotonic
//!     REVISION for optimistic concurrency across windows.
//!   * `commands` — `settings_load_snapshot` / `settings_save(patch, revision)`
//!     plus the `settings:changed` broadcast that keeps every window in sync.
//!
//! Add a section by (1) adding a struct + field here, (2) adding the matching
//! `Option<...>` to [`PartialSettings`], (3) merging it in `merge_patch`, and
//! (4) mirroring the Zod schema on the frontend.

pub mod commands;
pub mod store;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Appearance section — renderer-owned presentation knobs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    /// BCP-47 locale tag the renderer's i18n layer loads ("en", "de", …).
    pub locale: String,
    /// Skip/shorten motion for users who prefer reduced motion.
    pub reduced_motion: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            locale: "en".into(),
            reduced_motion: false,
        }
    }
}

/// General section — desktop-shell behavior.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    /// Launch the app at login (wired to tauri-plugin-autostart on save).
    pub autostart: bool,
    /// Closing the main window hides to the tray instead of quitting.
    pub minimize_to_tray: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        // NOT `derive(Default)`: `minimize_to_tray` has to default to TRUE to
        // match `generalSettingsSchema` on the frontend, which has always
        // defaulted it to `true`. This struct is the one that governs the
        // behaviour — `CloseRequested` (see `lib.rs`) reads it to decide
        // hide-to-tray vs quit — so the derived `false` silently won, and the
        // X button quit the app.
        Self {
            autostart: false,
            minimize_to_tray: true,
        }
    }
}

/// Downloads section — download-manager tuning.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadsSettings {
    /// Parallel download worker count, clamped to `1..=4`.
    pub concurrency: u32,
}

impl Default for DownloadsSettings {
    fn default() -> Self {
        Self { concurrency: 2 }
    }
}

/// Hotkeys section — persisted global accelerators (Tauri accelerator strings
/// like `"Ctrl+Shift+Space"`). An empty string means "unbound". Registered at
/// startup and hot-swapped on every save (see `crate::hotkeys`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct HotkeysSettings {
    /// Toggles main-window visibility (show + focus / hide). "" disables it.
    pub toggle_main: String,
    /// Raise brightness one step. "" = unbound. (Effect wired by Agent D via
    /// `crate::hotkeys::actions`.)
    pub brightness_up: String,
    /// Lower brightness one step.
    pub brightness_down: String,
    /// Warmer/cooler colour temperature one step (~55 K).
    pub temp_up: String,
    /// The opposite colour-temperature step.
    pub temp_down: String,
    /// Toggle the blue-light filter on/off.
    pub toggle_filter: String,
    /// Toggle Reading mode (full-screen grayscale).
    pub toggle_reading: String,
    /// Toggle Editing mode (colour invert).
    pub toggle_editing: String,
    /// Toggle Focus Read (moving clear band, rest of screen dimmed). "" = unbound.
    /// (Effect wired by the focus-read slice via `crate::focus`.)
    pub focus_read: String,
    /// Toggle Focus Blur (dim/tint all background windows). "" = unbound.
    pub focus_blur: String,
    /// Toggle Magic Window dark (per-window colour invert) on the current target.
    pub magic_dark: String,
    /// Toggle Magic Window grayscale on the current target.
    pub magic_gray: String,
}

/// A single mode's colour-temperature + brightness endpoints. Day and night
/// values are interpolated by the display scheduler; `brightness_*` are
/// percentages (0..=100), `kelvin_*` are absolute Kelvin.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ModePreset {
    pub kelvin_day: u32,
    pub kelvin_night: u32,
    pub brightness_day: u32,
    pub brightness_night: u32,
}

impl Default for ModePreset {
    fn default() -> Self {
        // Neutral custom-ish default (matches the display engine's fallback).
        Self {
            kelvin_day: 5500,
            kelvin_night: 5500,
            brightness_day: 90,
            brightness_night: 90,
        }
    }
}

/// A per-monitor colour/brightness override (same shape as a [`ModePreset`],
/// applied when `display.sync_monitors` is off).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorOverride {
    pub kelvin_day: u32,
    pub kelvin_night: u32,
    pub brightness_day: u32,
    pub brightness_night: u32,
}

impl Default for MonitorOverride {
    fn default() -> Self {
        Self {
            kelvin_day: 5500,
            kelvin_night: 5500,
            brightness_day: 90,
            brightness_night: 90,
        }
    }
}

/// The eight CareUEyes preset modes, seeded from FEATURE-PARITY F1.3.
fn default_modes() -> HashMap<String, ModePreset> {
    fn preset(kd: u32, kn: u32, bd: u32, bn: u32) -> ModePreset {
        ModePreset {
            kelvin_day: kd,
            kelvin_night: kn,
            brightness_day: bd,
            brightness_night: bn,
        }
    }
    HashMap::from([
        ("pause".to_string(), preset(6500, 6500, 100, 100)),
        ("health".to_string(), preset(5000, 3700, 90, 80)),
        ("game".to_string(), preset(6500, 6000, 90, 90)),
        ("movie".to_string(), preset(6000, 5500, 90, 90)),
        ("office".to_string(), preset(5500, 5000, 85, 80)),
        ("editing".to_string(), preset(6500, 6500, 85, 85)),
        ("reading".to_string(), preset(5500, 5500, 85, 85)),
        ("custom".to_string(), preset(5500, 5500, 90, 90)),
    ])
}

/// Display section — colour temperature / brightness / mode + per-monitor state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DisplaySettings {
    /// Active mode id: `pause`|`health`|`game`|`movie`|`office`|`editing`|
    /// `reading`|`custom`.
    pub mode: String,
    /// Widen the temperature range to 0..=10000 K (default 1000..=6500 K).
    pub wide_range: bool,
    /// Extend the brightness range down to 0 % (default floor 10 %), letting the
    /// screen dim to fully black (FEATURE-PARITY F2.2).
    pub brightness_wide_range: bool,
    /// Suspend filtering while a full-screen app (e.g. a game) is foreground
    /// (FEATURE-PARITY F1.11). On by default, like CareUEyes.
    pub disable_on_fullscreen: bool,
    /// Animate colour/brightness changes over ~400 ms.
    pub smooth_transition: bool,
    /// Apply one value to every monitor; when off, use `monitor_overrides`.
    pub sync_monitors: bool,
    /// Per-monitor overrides keyed by GDI device name (`\\.\DISPLAY1`).
    pub monitor_overrides: HashMap<String, MonitorOverride>,
    /// The eight editable preset modes keyed by mode id.
    pub modes: HashMap<String, ModePreset>,
}

impl Default for DisplaySettings {
    fn default() -> Self {
        Self {
            mode: "pause".to_string(),
            wide_range: false,
            brightness_wide_range: false,
            disable_on_fullscreen: true,
            smooth_transition: true,
            sync_monitors: true,
            monitor_overrides: HashMap::new(),
            modes: default_modes(),
        }
    }
}

/// Day/night section — the sunrise/sunset schedule the display scheduler reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct DayNightSettings {
    pub enabled: bool,
    /// Derive sun times from `latitude`/`longitude` instead of the manual
    /// `sunrise`/`sunset` strings.
    pub use_location: bool,
    pub latitude: f64,
    pub longitude: f64,
    /// Manual sunrise time, "HH:MM" (used when `use_location` is off).
    pub sunrise: String,
    /// Manual sunset time, "HH:MM".
    pub sunset: String,
    /// Width of the day↔night ramp window, in minutes.
    pub transition_minutes: u32,
}

impl Default for DayNightSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            use_location: false,
            latitude: 0.0,
            longitude: 0.0,
            sunrise: "07:00".to_string(),
            sunset: "19:00".to_string(),
            transition_minutes: 60,
        }
    }
}

/// One custom per-app rule: switch to `mode` while a matching window is active.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Rule {
    pub id: String,
    /// `process`|`class`|`title`.
    pub match_kind: String,
    pub pattern: String,
    /// Mode id to apply while the rule matches.
    pub mode: String,
}

impl Default for Rule {
    fn default() -> Self {
        Self {
            id: String::new(),
            match_kind: "process".to_string(),
            pattern: String::new(),
            mode: "pause".to_string(),
        }
    }
}

/// Rules section — the per-app auto-switch rules (engine owned by Agent C).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct RulesSettings {
    pub enabled: bool,
    pub items: Vec<Rule>,
}

/// Focus Read section (FEATURE-PARITY F8.1) — a horizontal clear band that
/// tracks the cursor while the rest of the screen is tinted/dimmed. Owned by
/// the focus-read slice; the engine seam is `crate::focus::read`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusReadSettings {
    /// Shade opacity as a percentage (0..=100) — how strongly the area outside
    /// the clear band is dimmed.
    pub transparency: u32,
    /// Shade colour, `#rrggbb`.
    pub color: String,
    /// Height (px) of the transparent clear band that follows the cursor.
    pub height: u32,
}

impl Default for FocusReadSettings {
    fn default() -> Self {
        Self {
            transparency: 50,
            color: "#000000".to_string(),
            height: 300,
        }
    }
}

/// Focus Blur section (FEATURE-PARITY F8.2) — dim/tint every background window
/// while the active window stays highlighted (Hazeover-style). Owned by the
/// focus-blur slice; the engine seam is `crate::focus::blur`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusBlurSettings {
    pub enabled: bool,
    /// Include the taskbar in the dimmed area.
    pub include_taskbar: bool,
    /// Only dim the monitor the active window is on.
    pub only_current_monitor: bool,
    /// Animate the shade following the active window.
    pub animate: bool,
    /// Shade opacity as a percentage (0..=100).
    pub transparency: u32,
    /// Shade colour, `#rrggbb`.
    pub color: String,
}

impl Default for FocusBlurSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            include_taskbar: false,
            only_current_monitor: false,
            animate: true,
            transparency: 50,
            color: "#000000".to_string(),
        }
    }
}

/// MagicX section (FEATURE-PARITY F9.1-F9.4, F9.7) — per-window dark/grayscale
/// effect plus the hover Magic Toolbar. Disabled by default. Owned by the
/// magic-toolbar slice; the engine seam is `crate::magicx`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct MagicxSettings {
    /// Master switch for the whole MagicX feature (default off, F9.7).
    pub enabled: bool,
    /// Show the hover Magic Toolbar (Dark / Gray / Close) at the top of windows.
    pub toolbar_enabled: bool,
    /// Toolbar accent colour, `#rrggbb`.
    pub toolbar_color: String,
    /// Toolbar horizontal alignment on the target window: `center`|`left`|`right`.
    pub toolbar_align: String,
    /// Horizontal offset (px) applied to the aligned toolbar.
    pub toolbar_offset: i32,
    /// Hover delay (ms) before the toolbar appears (0.3-0.5 s recommended).
    pub toolbar_delay_ms: u32,
}

impl Default for MagicxSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            toolbar_enabled: true,
            toolbar_color: "#14b8a6".to_string(),
            toolbar_align: "center".to_string(),
            toolbar_offset: 0,
            toolbar_delay_ms: 400,
        }
    }
}

/// Auto Dark section (FEATURE-PARITY F9.5-F9.6) — schedule the Windows SYSTEM
/// theme, optionally driven by the day/night times, plus the taskbar
/// transparency effect. Owned by the auto-dark slice; the seam is
/// `crate::magicx::theme`.
///
/// There is deliberately no app-theme field. DimRead's own UI is permanently
/// dark, and the removed `app_theme` wrote `AppsUseLightTheme` — i.e. it
/// re-themed every OTHER Windows app rather than this one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoDarkSettings {
    /// Windows system-theme schedule: `light`|`dark`|`auto`|`disable`.
    pub system_theme: String,
    /// Sunrise for the SYSTEM theme's `auto` (day→night) schedule, `"HH:MM"`.
    /// Decoupled from the Display-tab blue-light schedule.
    pub system_sunrise: String,
    /// Sunset for the SYSTEM theme's `auto` schedule, `"HH:MM"`.
    pub system_sunset: String,
    /// Apply the transparent-taskbar effect (F9.6).
    pub taskbar_transparent: bool,
}

impl Default for AutoDarkSettings {
    fn default() -> Self {
        Self {
            system_theme: "disable".to_string(),
            system_sunrise: "07:00".to_string(),
            system_sunset: "19:00".to_string(),
            taskbar_transparent: false,
        }
    }
}

/// The full persisted settings tree. Every field is `#[serde(default)]` so a
/// missing/partial persisted blob falls back per-field instead of failing the
/// whole parse (mirrors Zod `.catch` on the frontend).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub appearance: AppearanceSettings,
    pub general: GeneralSettings,
    pub downloads: DownloadsSettings,
    pub hotkeys: HotkeysSettings,
    pub display: DisplaySettings,
    pub day_night: DayNightSettings,
    pub rules: RulesSettings,
    pub focus_read: FocusReadSettings,
    pub focus_blur: FocusBlurSettings,
    pub magicx: MagicxSettings,
    pub auto_dark: AutoDarkSettings,
}

/// A section-granular patch: only the sections present are replaced (whole
/// section at a time, exactly like the renderer posts them).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct PartialSettings {
    #[specta(optional)]
    pub appearance: Option<AppearanceSettings>,
    #[specta(optional)]
    pub general: Option<GeneralSettings>,
    #[specta(optional)]
    pub downloads: Option<DownloadsSettings>,
    #[specta(optional)]
    pub hotkeys: Option<HotkeysSettings>,
    #[specta(optional)]
    pub display: Option<DisplaySettings>,
    #[specta(optional)]
    pub day_night: Option<DayNightSettings>,
    #[specta(optional)]
    pub rules: Option<RulesSettings>,
    #[specta(optional)]
    pub focus_read: Option<FocusReadSettings>,
    #[specta(optional)]
    pub focus_blur: Option<FocusBlurSettings>,
    #[specta(optional)]
    pub magicx: Option<MagicxSettings>,
    #[specta(optional)]
    pub auto_dark: Option<AutoDarkSettings>,
}

/// Clamp cross-field invariants after every read/merge so out-of-range
/// persisted values can never leak into consumers.
pub(crate) fn normalize_settings(settings: &mut AppSettings) {
    settings.downloads.concurrency = settings.downloads.concurrency.clamp(1, 4);
    // Hotkeys are stored trimmed so "  " can never masquerade as a binding
    // (the registrar treats empty as "unbound").
    fn trim_in_place(field: &mut String) {
        let trimmed = field.trim();
        if trimmed.len() != field.len() {
            *field = trimmed.to_string();
        }
    }
    let h = &mut settings.hotkeys;
    for field in [
        &mut h.toggle_main,
        &mut h.brightness_up,
        &mut h.brightness_down,
        &mut h.temp_up,
        &mut h.temp_down,
        &mut h.toggle_filter,
        &mut h.toggle_reading,
        &mut h.toggle_editing,
        &mut h.focus_read,
        &mut h.focus_blur,
        &mut h.magic_dark,
        &mut h.magic_gray,
    ] {
        trim_in_place(field);
    }
    // Shade opacities are percentages; the clear band has a sane floor.
    settings.focus_read.transparency = settings.focus_read.transparency.min(100);
    settings.focus_read.height = settings.focus_read.height.clamp(20, 4000);
    settings.focus_blur.transparency = settings.focus_blur.transparency.min(100);
}

/// Merge a partial patch over the current tree, section-wholesale.
pub(crate) fn merge_patch(current: &AppSettings, patch: PartialSettings) -> AppSettings {
    let mut next = current.clone();
    if let Some(appearance) = patch.appearance {
        next.appearance = appearance;
    }
    if let Some(general) = patch.general {
        next.general = general;
    }
    if let Some(downloads) = patch.downloads {
        next.downloads = downloads;
    }
    if let Some(hotkeys) = patch.hotkeys {
        next.hotkeys = hotkeys;
    }
    if let Some(display) = patch.display {
        next.display = display;
    }
    if let Some(day_night) = patch.day_night {
        next.day_night = day_night;
    }
    if let Some(rules) = patch.rules {
        next.rules = rules;
    }
    if let Some(focus_read) = patch.focus_read {
        next.focus_read = focus_read;
    }
    if let Some(focus_blur) = patch.focus_blur {
        next.focus_blur = focus_blur;
    }
    if let Some(magicx) = patch.magicx {
        next.magicx = magicx;
    }
    if let Some(auto_dark) = patch.auto_dark {
        next.auto_dark = auto_dark;
    }
    normalize_settings(&mut next);
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let settings = AppSettings::default();
        assert_eq!(settings.appearance.locale, "en");
        assert!(!settings.general.autostart);
        assert_eq!(settings.downloads.concurrency, 2);
    }

    #[test]
    fn merge_patch_replaces_only_present_sections() {
        let current = AppSettings::default();
        let next = merge_patch(
            &current,
            PartialSettings {
                general: Some(GeneralSettings {
                    autostart: true,
                    minimize_to_tray: true,
                }),
                ..Default::default()
            },
        );
        assert!(next.general.autostart);
        assert_eq!(next.appearance, current.appearance);
        assert_eq!(next.downloads, current.downloads);
    }

    #[test]
    fn merge_patch_clamps_concurrency() {
        let next = merge_patch(
            &AppSettings::default(),
            PartialSettings {
                downloads: Some(DownloadsSettings { concurrency: 99 }),
                ..Default::default()
            },
        );
        assert_eq!(next.downloads.concurrency, 4);

        let next = merge_patch(
            &AppSettings::default(),
            PartialSettings {
                downloads: Some(DownloadsSettings { concurrency: 0 }),
                ..Default::default()
            },
        );
        assert_eq!(next.downloads.concurrency, 1);
    }

    #[test]
    fn merge_patch_replaces_and_trims_hotkeys() {
        let current = AppSettings::default();
        assert_eq!(current.hotkeys.toggle_main, "");

        let next = merge_patch(
            &current,
            PartialSettings {
                hotkeys: Some(HotkeysSettings {
                    toggle_main: "  Ctrl+Shift+Space  ".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(next.hotkeys.toggle_main, "Ctrl+Shift+Space");
        assert_eq!(next.general, current.general);

        let cleared = merge_patch(
            &next,
            PartialSettings {
                hotkeys: Some(HotkeysSettings {
                    toggle_main: "   ".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(cleared.hotkeys.toggle_main, "");
    }

    #[test]
    fn display_defaults_seed_eight_modes() {
        let settings = AppSettings::default();
        assert_eq!(settings.display.mode, "pause");
        assert!(settings.display.smooth_transition);
        assert!(settings.display.sync_monitors);
        assert_eq!(settings.display.modes.len(), 8);
        let health = settings.display.modes.get("health").expect("health preset");
        assert_eq!(health.kelvin_day, 5000);
        assert_eq!(health.kelvin_night, 3700);
        assert_eq!(health.brightness_day, 90);
        assert_eq!(health.brightness_night, 80);
    }

    #[test]
    fn day_night_and_rules_defaults() {
        let settings = AppSettings::default();
        assert!(settings.day_night.enabled);
        assert!(!settings.day_night.use_location);
        assert_eq!(settings.day_night.sunrise, "07:00");
        assert_eq!(settings.day_night.transition_minutes, 60);
        assert!(!settings.rules.enabled);
        assert!(settings.rules.items.is_empty());
    }

    #[test]
    fn general_defaults_match_the_frontend_schema() {
        // Must stay in lockstep with `generalSettingsSchema` in
        // `src/shared/config/settings-schema/index.ts`. `minimize_to_tray` is
        // the load-bearing one: `CloseRequested` reads it to decide whether the
        // X button hides to the tray or quits the app.
        let settings = AppSettings::default();
        assert!(settings.general.minimize_to_tray);
        assert!(!settings.general.autostart);
    }

    #[test]
    fn focus_and_magicx_defaults() {
        let settings = AppSettings::default();
        assert_eq!(settings.focus_read.transparency, 50);
        assert_eq!(settings.focus_read.color, "#000000");
        assert_eq!(settings.focus_read.height, 300);
        assert!(!settings.focus_blur.enabled);
        assert!(settings.focus_blur.animate);
        assert!(!settings.magicx.enabled);
        assert!(settings.magicx.toolbar_enabled);
        assert_eq!(settings.magicx.toolbar_color, "#14b8a6");
        assert_eq!(settings.magicx.toolbar_align, "center");
        assert_eq!(settings.magicx.toolbar_delay_ms, 400);
        assert_eq!(settings.auto_dark.system_theme, "disable");
        assert_eq!(settings.auto_dark.system_sunrise, "07:00");
        assert_eq!(settings.auto_dark.system_sunset, "19:00");
        assert!(!settings.auto_dark.taskbar_transparent);
    }

    #[test]
    fn focus_normalize_clamps_percentages_and_band() {
        let mut next = merge_patch(
            &AppSettings::default(),
            PartialSettings {
                focus_read: Some(FocusReadSettings {
                    transparency: 250,
                    color: "#111111".into(),
                    height: 9000,
                }),
                focus_blur: Some(FocusBlurSettings {
                    transparency: 300,
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(next.focus_read.transparency, 100);
        assert_eq!(next.focus_read.height, 4000);
        assert_eq!(next.focus_blur.transparency, 100);

        next = merge_patch(
            &AppSettings::default(),
            PartialSettings {
                hotkeys: Some(HotkeysSettings {
                    focus_read: "  Ctrl+Alt+R  ".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(next.hotkeys.focus_read, "Ctrl+Alt+R");
    }

    #[test]
    fn missing_fields_default_on_parse() {
        let settings: AppSettings =
            serde_json::from_value(serde_json::json!({ "general": { "autostart": true } }))
                .unwrap();
        assert!(settings.general.autostart);
        assert_eq!(settings.appearance.locale, "en");
        assert_eq!(settings.downloads.concurrency, 2);
    }
}
