//! Hotkey action dispatch — the DISPLAY hotkeys' engine effects.
//!
//! The hotkey registry ([`super`]) owns the OS-level registration and fires
//! `hotkey:triggered` on every key-down edge. This module owns the seven display
//! actions and wires to them through exactly two one-line delegations from the
//! registry, so the behaviour is defined purely here:
//!
//!   * [`super::apply_hotkey_settings`] owns the complete persisted roster and
//!     arms these action ids alongside every other shortcut at boot and save.
//!   * [`handle_action`] runs an action's effect — called from
//!     [`super::on_hotkey_triggered`]. Ids this module does not own (e.g.
//!     `toggleMain`) are ignored, so the trigger path can call it blindly.
//!
//! ## Action ids (match the `settings.hotkeys` field names, camelCase)
//! - `brightnessUp` / `brightnessDown` — step the active mode's brightness by
//!   ±[`BRIGHTNESS_STEP`] %, clamped to the display range.
//! - `tempUp` / `tempDown` — step the active mode's colour temperature by
//!   ±[`TEMP_STEP`] K, clamped (default vs. wide range).
//!
//! Both steppers edit the day/night endpoint that DOMINATES the current output
//! ([`scheduler::current_edit_phase`]), not the raw phase — mid-ramp the two are
//! different, and editing the fading one is a keypress with no visible effect.
//! - `toggleFilter` — swap the active mode to `pause` and back (blue-light
//!   filter off/on), remembering the previous mode.
//! - `toggleReading` — swap Reading mode (full-screen grayscale) on/off.
//! - `toggleEditing` — swap Editing mode (colour invert) on/off.
//!
//! Each effect mutates `settings.display` through the shared settings store,
//! broadcasts `settings:changed` (so every window's store re-syncs), and calls
//! [`engine::refresh`] so the new values apply live.

use std::sync::Mutex;

use tauri::AppHandle;

use crate::display::engine;
use crate::display::scheduler::{self, Phase};
use crate::display::values::{self, DisplayAxis, DisplayEdit, DisplayPhase};
use crate::settings::AppSettings;
use crate::settings::commands;
use crate::settings::store;

/// Brightness step (percentage points) per press.
const BRIGHTNESS_STEP: i64 = 5;
/// Colour-temperature step (Kelvin) per press (CareUEyes' ~55 K increment,
/// FEATURE-PARITY F10.4).
const TEMP_STEP: i64 = 55;
/// Brightness clamp bounds (percent) — CareUEyes' default 10 % floor, or 0 %
/// when the brightness wide range (FEATURE-PARITY F2.2) is enabled.
const BRIGHTNESS_MIN: i64 = 10;
const BRIGHTNESS_MIN_WIDE: i64 = 0;
const BRIGHTNESS_MAX: i64 = 100;
/// Colour-temperature clamp bounds (Kelvin) for the default range.
const TEMP_MIN: i64 = 1000;
const TEMP_MAX: i64 = 6500;
/// …and for the wide range (`settings.display.wide_range`, FEATURE-PARITY F1.2).
const TEMP_MIN_WIDE: i64 = 1000;
const TEMP_MAX_WIDE: i64 = 10000;

/// The mode a toggle came from, so a second press returns to it (one slot per
/// toggle so the three toggles never clobber each other's memory).
static FILTER_PREV: Mutex<Option<String>> = Mutex::new(None);
static READING_PREV: Mutex<Option<String>> = Mutex::new(None);
static EDITING_PREV: Mutex<Option<String>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Dispatch a display hotkey action by id. Ids not owned here (e.g. `toggleMain`)
/// are ignored, so the shared trigger path can call this unconditionally.
pub fn handle_action(app: &AppHandle, id: &str) {
    match id {
        "brightnessUp" => adjust_brightness(app, BRIGHTNESS_STEP),
        "brightnessDown" => adjust_brightness(app, -BRIGHTNESS_STEP),
        "tempUp" => adjust_temperature(app, TEMP_STEP),
        "tempDown" => adjust_temperature(app, -TEMP_STEP),
        "toggleFilter" => toggle_mode(app, "pause", &FILTER_PREV, "health"),
        "toggleReading" => toggle_mode(app, "reading", &READING_PREV, "pause"),
        "toggleEditing" => toggle_mode(app, "editing", &EDITING_PREV, "pause"),
        "focusRead" => {
            crate::focus::read::toggle();
        }
        "focusBlur" => {
            crate::focus::blur::toggle();
        }
        // magicx (F9.4) — toggle the per-window Dark / Gray effect on the Magic
        // Toolbar's current target (foreground fallback), mirroring the
        // `magicx_toggle_effect` command. No-op when MagicX is disabled.
        "magicDark" => toggle_magic_effect(app, crate::magicx::Effect::Dark),
        "magicGray" => toggle_magic_effect(app, crate::magicx::Effect::Gray),
        _ => {}
    }
}

/// Toggle a MagicX per-window effect on the toolbar's current target (falling
/// back to the foreground window), gated on the MagicX master switch so a bound
/// combo is inert while the feature is off (FEATURE-PARITY F9.7).
fn toggle_magic_effect(app: &AppHandle, effect: crate::magicx::Effect) {
    if !store::read_settings(app).magicx.enabled {
        return;
    }
    let target =
        crate::magicx::toolbar::current_target().unwrap_or_else(crate::magicx::foreground_hwnd);
    if target != 0 {
        crate::magicx::engine::toggle_effect(target, effect);
    }
}

// ── Effects ───────────────────────────────────────────────────────────────

fn adjust_brightness(app: &AppHandle, delta: i64) {
    // The endpoint that dominates the screen, never the raw phase: mid-ramp the
    // output is a blend, so stepping the fading endpoint is a keypress the user
    // cannot see (see `scheduler::current_edit_phase`).
    let phase = scheduler::current_edit_phase();
    // Edit the mode that is actually on screen: when a rule override is active
    // the displayed mode is the override, not `settings.display.mode`, so
    // editing the latter would be invisible (the override re-applies on refresh).
    let mode = engine::current_output().mode;
    patch_and_apply(app, move |s| step_active_brightness(s, delta, phase, &mode));
}

fn adjust_temperature(app: &AppHandle, delta: i64) {
    let phase = scheduler::current_edit_phase();
    let mode = engine::current_output().mode;
    patch_and_apply(app, move |s| {
        step_active_temperature(s, delta, phase, &mode)
    });
}

fn toggle_mode(
    app: &AppHandle,
    target: &str,
    prev: &'static Mutex<Option<String>>,
    fallback: &str,
) {
    let previous = lock(prev).clone();
    let current = store::read_settings(app).display.mode;
    let (next_mode, remember) = next_toggle_mode(&current, target, previous.as_deref(), fallback);
    *lock(prev) = remember;
    patch_and_apply(app, move |s| {
        if s.display.mode == next_mode {
            return false;
        }
        s.display.mode = next_mode;
        true
    });
}

/// Commit one settings mutation and refresh the display as part of the SAME
/// serialized commit. Keeping refresh inside `mutate_settings_with_effect`
/// prevents a later write from overtaking this action between persistence,
/// native application, and the `settings:changed` broadcast.
fn patch_and_apply(app: &AppHandle, mutate: impl FnOnce(&mut AppSettings) -> bool) {
    if let Err(err) = commands::mutate_settings_with_effect(app, mutate, |_| engine::refresh()) {
        log::warn!("[hotkeys] failed to commit display action: {err}");
    }
}

// ── Pure helpers (unit-tested below) ────────────────────────────────────────

/// Clamp a brightness percentage into the adjustable range (floor 10 %, or 0 %
/// when the brightness wide range is on).
fn clamp_brightness(value: i64, wide: bool) -> u32 {
    let min = if wide {
        BRIGHTNESS_MIN_WIDE
    } else {
        BRIGHTNESS_MIN
    };
    value.clamp(min, BRIGHTNESS_MAX) as u32
}

/// The colour-temperature clamp bounds for the active range mode.
fn temp_bounds(wide: bool) -> (i64, i64) {
    if wide {
        (TEMP_MIN_WIDE, TEMP_MAX_WIDE)
    } else {
        (TEMP_MIN, TEMP_MAX)
    }
}

/// Clamp a colour temperature (Kelvin) into the active range.
fn clamp_temperature(value: i64, wide: bool) -> u32 {
    let (min, max) = temp_bounds(wide);
    value.clamp(min, max) as u32
}

fn edit_phase(phase: Phase) -> DisplayPhase {
    match phase {
        Phase::Night => DisplayPhase::Night,
        _ => DisplayPhase::Day,
    }
}

fn offset_value(value: u32, delta: i64) -> u32 {
    (i64::from(value) + delta).clamp(0, i64::from(u32::MAX)) as u32
}

/// Step the active mode's current-phase brightness by `delta`, clamped. Returns
/// whether the stored value actually changed (a no-op step at a bound skips the
/// write). Pure over the settings tree so the clamp maths is unit-testable.
fn step_active_brightness(
    settings: &mut AppSettings,
    delta: i64,
    phase: Phase,
    mode: &str,
) -> bool {
    let Some(preset) = settings.display.modes.get(mode) else {
        return false;
    };
    let current = match phase {
        Phase::Night => preset.brightness_night,
        _ => preset.brightness_day,
    };
    let next = offset_value(current, delta);

    // The ordinary (non-rule-override) path uses the same intent helper as the
    // sliders and tray. Crucially, an edit while Pause is selected seeds Custom
    // from the passthrough preset and switches to it instead of mutating the
    // deliberately inert Pause preset.
    if settings.display.mode == mode {
        let before = settings.display.clone();
        values::apply_edit_to(
            settings,
            &DisplayEdit {
                axis: DisplayAxis::Brightness,
                phase: edit_phase(phase),
                monitor_id: None,
                value: next,
            },
        );
        return settings.display != before;
    }

    // A per-app rule can make a different mode visible without changing the
    // persisted selected mode. Preserve that established behavior: step the
    // visible override preset directly because DisplayEdit intentionally has no
    // rule-override target field.
    let wide = settings.display.brightness_wide_range;
    let next = clamp_brightness(i64::from(current) + delta, wide);
    let preset = settings
        .display
        .modes
        .get_mut(mode)
        .expect("the preset was checked above");
    let field = match phase {
        Phase::Night => &mut preset.brightness_night,
        _ => &mut preset.brightness_day,
    };
    if next == *field {
        return false;
    }
    *field = next;
    true
}

/// Step the active mode's current-phase colour temperature by `delta`, clamped
/// to the default or wide range. Returns whether the value changed.
fn step_active_temperature(
    settings: &mut AppSettings,
    delta: i64,
    phase: Phase,
    mode: &str,
) -> bool {
    let Some(preset) = settings.display.modes.get(mode) else {
        return false;
    };
    let current = match phase {
        Phase::Night => preset.kelvin_night,
        _ => preset.kelvin_day,
    };
    let next = offset_value(current, delta);

    if settings.display.mode == mode {
        let before = settings.display.clone();
        values::apply_edit_to(
            settings,
            &DisplayEdit {
                axis: DisplayAxis::Kelvin,
                phase: edit_phase(phase),
                monitor_id: None,
                value: next,
            },
        );
        return settings.display != before;
    }

    let wide = settings.display.wide_range;
    let next = clamp_temperature(i64::from(current) + delta, wide);
    let preset = settings
        .display
        .modes
        .get_mut(mode)
        .expect("the preset was checked above");
    let field = match phase {
        Phase::Night => &mut preset.kelvin_night,
        _ => &mut preset.kelvin_day,
    };
    if next == *field {
        return false;
    }
    *field = next;
    true
}

/// Compute the mode a toggle press switches to and the mode to remember. ON
/// (current != target) stashes the current mode and switches to `target`; OFF
/// restores the remembered previous (or `fallback`) and clears the memory.
fn next_toggle_mode(
    current: &str,
    target: &str,
    previous: Option<&str>,
    fallback: &str,
) -> (String, Option<String>) {
    if current == target {
        (previous.unwrap_or(fallback).to_string(), None)
    } else {
        (target.to_string(), Some(current.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;

    fn settings_with(mode: &str, wide: bool) -> AppSettings {
        let mut s = AppSettings::default();
        s.display.mode = mode.to_string();
        s.display.wide_range = wide;
        s
    }

    #[test]
    fn brightness_clamps_to_range() {
        assert_eq!(clamp_brightness(150, false), 100);
        assert_eq!(clamp_brightness(0, false), 10);
        assert_eq!(clamp_brightness(55, false), 55);
        // Wide range lets brightness reach 0 % (fully black).
        assert_eq!(clamp_brightness(0, true), 0);
        assert_eq!(clamp_brightness(5, true), 5);
        assert_eq!(clamp_brightness(150, true), 100);
    }

    #[test]
    fn temperature_bounds_follow_wide_flag() {
        assert_eq!(temp_bounds(false), (1000, 6500));
        assert_eq!(temp_bounds(true), (1000, 10000));
        assert_eq!(clamp_temperature(9000, false), 6500);
        assert_eq!(clamp_temperature(9000, true), 9000);
        assert_eq!(clamp_temperature(-500, true), 1000);
    }

    #[test]
    fn step_brightness_adjusts_day_endpoint_and_clamps() {
        let mut s = settings_with("health", false);
        // health day brightness defaults to 90.
        assert!(step_active_brightness(&mut s, 5, Phase::Day, "health"));
        assert_eq!(s.display.modes["health"].brightness_day, 95);
        assert!(step_active_brightness(&mut s, 5, Phase::Day, "health"));
        assert_eq!(s.display.modes["health"].brightness_day, 100);
        // Already at the ceiling — no further change, reports false.
        assert!(!step_active_brightness(&mut s, 5, Phase::Day, "health"));
        assert_eq!(s.display.modes["health"].brightness_day, 100);
    }

    #[test]
    fn step_brightness_targets_night_endpoint_in_night_phase() {
        let mut s = settings_with("health", false);
        // health night brightness defaults to 80; day must stay untouched.
        assert!(step_active_brightness(&mut s, -5, Phase::Night, "health"));
        assert_eq!(s.display.modes["health"].brightness_night, 75);
        assert_eq!(s.display.modes["health"].brightness_day, 90);
    }

    #[test]
    fn step_brightness_targets_the_given_mode_not_the_settings_mode() {
        // A rule override drives "game" while the user's chosen mode is "health":
        // the step must land on the visible (override) mode's preset.
        let mut s = settings_with("health", false);
        assert!(step_active_brightness(&mut s, -5, Phase::Day, "game"));
        assert_eq!(s.display.modes["game"].brightness_day, 85);
        assert_eq!(s.display.modes["health"].brightness_day, 90);
    }

    #[test]
    fn step_temperature_uses_wide_ceiling() {
        let mut s = settings_with("custom", true);
        // custom day kelvin defaults to 5500; +100 steps stay under the wide max.
        assert!(step_active_temperature(&mut s, 100, Phase::Day, "custom"));
        assert_eq!(s.display.modes["custom"].kelvin_day, 5600);
    }

    #[test]
    fn step_temperature_clamps_to_default_ceiling() {
        let mut s = settings_with("pause", false);
        // Even at the numerical ceiling, a display intent made while paused
        // resumes filtering through Custom; the inert Pause preset stays put.
        assert!(step_active_temperature(&mut s, 100, Phase::Day, "pause"));
        assert_eq!(s.display.modes["pause"].kelvin_day, 6500);
        assert_eq!(s.display.mode, "custom");
        assert_eq!(s.display.modes["custom"].kelvin_day, 6500);
    }

    #[test]
    fn brightness_step_in_pause_uses_canonical_custom_redirect() {
        let mut s = settings_with("pause", false);
        assert!(step_active_brightness(&mut s, -5, Phase::Day, "pause"));
        assert_eq!(s.display.mode, "custom");
        assert_eq!(s.display.modes["custom"].brightness_day, 95);
        assert_eq!(s.display.modes["custom"].kelvin_day, 6500);
        assert_eq!(s.display.modes["pause"].brightness_day, 100);
    }

    #[test]
    fn toggle_on_remembers_current_and_switches() {
        let (next, remember) = next_toggle_mode("health", "pause", None, "health");
        assert_eq!(next, "pause");
        assert_eq!(remember, Some("health".to_string()));
    }

    #[test]
    fn toggle_off_restores_previous_then_fallback() {
        let (next, remember) = next_toggle_mode("pause", "pause", Some("office"), "health");
        assert_eq!(next, "office");
        assert_eq!(remember, None);

        let (next, remember) = next_toggle_mode("pause", "pause", None, "health");
        assert_eq!(next, "health");
        assert_eq!(remember, None);
    }
}
