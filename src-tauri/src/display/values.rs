//! The ONE place a display value is written.
//!
//! # Why this module exists
//!
//! Colour temperature and brightness used to be mutated by four independent
//! writers — the Display tab, the tray flyout, and the two hotkey steppers —
//! each re-deriving the same rules, and each persisting through a
//! whole-`display`-section save built from its OWN renderer-side copy of the
//! settings tree.
//!
//! That is a last-writer-wins model with several concurrent writers holding
//! mutable copies, and it loses data exactly as you would expect. Observed:
//! a slider release wrote `kelvinNight: 4200`, and 1.9 s later a second window
//! — whose store had drifted — wrote its whole stale section back, restoring
//! `6500`. Nothing "reverted"; a stale copy overwrote a fresh one. Any window
//! that lagged for any reason silently destroyed every other window's work.
//!
//! The fix is structural: renderers no longer send STATE, they send INTENT.
//! [`apply_edit_to`] performs the read → resolve → modify → write cycle here,
//! under the settings write lock, against the authoritative tree. A caller can
//! only ever change the one field it names, so a stale caller is now incapable
//! of clobbering a field it did not touch.
//!
//! Every rule that used to be duplicated lives here once: the pause redirect,
//! phase selection, per-monitor targeting, and range clamping.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::settings::{AppSettings, ModePreset, MonitorOverride};

/// Which axis an edit targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DisplayAxis {
    Brightness,
    Kelvin,
}

/// Which day/night endpoint an edit lands on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DisplayPhase {
    Day,
    Night,
}

/// A single display-value edit: "set `axis` to `value` for `phase`, on
/// `monitor_id` (or every monitor when `None`)".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DisplayEdit {
    pub axis: DisplayAxis,
    pub phase: DisplayPhase,
    /// `None` = the active mode's preset (all monitors); `Some(id)` = that
    /// monitor's override.
    pub monitor_id: Option<String>,
    pub value: u32,
}

/// The mode that applies no filtering at all: [`crate::display::engine::refresh`]
/// restores the original ramps and returns early, so nothing stored under it
/// ever reaches the screen.
const PASSTHROUGH_MODE: &str = "pause";
/// Where an edit made in [`PASSTHROUGH_MODE`] is redirected to.
const FALLBACK_MODE: &str = "custom";

/// Colour-temperature bounds (Kelvin), narrow and wide.
const KELVIN_RANGE: (u32, u32) = (1000, 6500);
const KELVIN_RANGE_WIDE: (u32, u32) = (1000, 10_000);
/// Brightness bounds (percent). The narrow floor avoids a fully black screen.
const BRIGHTNESS_RANGE: (u32, u32) = (10, 100);
const BRIGHTNESS_RANGE_WIDE: (u32, u32) = (0, 100);

/// Clamp `value` into the active range for `axis`.
fn clamp_value(settings: &AppSettings, axis: DisplayAxis, value: u32) -> u32 {
    let (min, max) = match axis {
        DisplayAxis::Kelvin => {
            if settings.display.wide_range {
                KELVIN_RANGE_WIDE
            } else {
                KELVIN_RANGE
            }
        }
        DisplayAxis::Brightness => {
            if settings.display.brightness_wide_range {
                BRIGHTNESS_RANGE_WIDE
            } else {
                BRIGHTNESS_RANGE
            }
        }
    };
    value.clamp(min, max)
}

/// Write `value` into the `axis`/`phase` slot of a preset.
fn set_axis(preset: &mut ModePreset, axis: DisplayAxis, phase: DisplayPhase, value: u32) {
    match (axis, phase) {
        (DisplayAxis::Kelvin, DisplayPhase::Day) => preset.kelvin_day = value,
        (DisplayAxis::Kelvin, DisplayPhase::Night) => preset.kelvin_night = value,
        (DisplayAxis::Brightness, DisplayPhase::Day) => preset.brightness_day = value,
        (DisplayAxis::Brightness, DisplayPhase::Night) => preset.brightness_night = value,
    }
}

/// The mode an edit lands on, redirecting out of the passthrough mode.
///
/// Dragging a slider while in `pause` is a request *for* filtering. Writing the
/// value into the `pause` preset would persist something the engine never
/// applies — the live preview dims correctly, then the screen snaps back to
/// undimmed the moment the drag ends.
fn resolve_edit_mode(settings: &mut AppSettings) -> String {
    let active = settings.display.mode.clone();
    if active != PASSTHROUGH_MODE {
        return active;
    }
    // Seed `custom` from what is currently ON SCREEN so only the edited axis
    // moves; inheriting custom's stored values would jump the other axis.
    let seed = settings
        .display
        .modes
        .get(&active)
        .copied()
        .unwrap_or_default();
    settings
        .display
        .modes
        .insert(FALLBACK_MODE.to_string(), seed);
    settings.display.mode = FALLBACK_MODE.to_string();
    FALLBACK_MODE.to_string()
}

/// Apply one edit to the settings tree in place. Pure over `AppSettings`, so
/// the whole rule set is unit-testable without a running app.
///
/// Returns the mode the edit landed on.
pub(crate) fn apply_edit_to(settings: &mut AppSettings, edit: &DisplayEdit) -> String {
    let value = clamp_value(settings, edit.axis, edit.value);
    let mode = resolve_edit_mode(settings);

    match edit.monitor_id.as_ref() {
        // A specific monitor: its override, which is mode-independent.
        Some(id) => {
            let existing = settings.display.monitor_overrides.get(id).copied();
            let mut preset = existing.map_or_else(
                // No override means this monitor currently inherits the active
                // mode. Seed the first override from that exact preset so the
                // named edit cannot replace the other three endpoints with a
                // neutral default.
                || {
                    settings
                        .display
                        .modes
                        .get(&mode)
                        .copied()
                        .unwrap_or_default()
                },
                |ov| ModePreset {
                    kelvin_day: ov.kelvin_day,
                    kelvin_night: ov.kelvin_night,
                    brightness_day: ov.brightness_day,
                    brightness_night: ov.brightness_night,
                },
            );
            set_axis(&mut preset, edit.axis, edit.phase, value);
            settings.display.monitor_overrides.insert(
                id.clone(),
                MonitorOverride {
                    kelvin_day: preset.kelvin_day,
                    kelvin_night: preset.kelvin_night,
                    brightness_day: preset.brightness_day,
                    brightness_night: preset.brightness_night,
                },
            );
        }
        // Every monitor: the active mode's preset.
        None => {
            let mut preset = settings
                .display
                .modes
                .get(&mode)
                .copied()
                .unwrap_or_default();
            set_axis(&mut preset, edit.axis, edit.phase, value);
            settings.display.modes.insert(mode.clone(), preset);
        }
    }
    mode
}

/// Persist one edit atomically and re-apply the engine.
///
/// The read → modify → write happens inside the settings write lock, against
/// the tree on disk, so two surfaces editing at once serialize instead of
/// overwriting each other. Broadcasts `settings:changed` so every window
/// converges on the result, AND returns the resulting snapshot so the calling
/// surface can adopt it synchronously instead of waiting for that broadcast
/// (see [`crate::settings::commands::mutate_settings`]).
pub(crate) fn commit_edit(
    app: &AppHandle,
    edit: &DisplayEdit,
) -> Result<crate::settings::commands::SettingsSnapshot, String> {
    crate::settings::commands::mutate_settings(app, |settings| {
        apply_edit_to(settings, edit);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(mode: &str) -> AppSettings {
        let mut s = AppSettings::default();
        s.display.mode = mode.to_string();
        s
    }

    fn edit(axis: DisplayAxis, phase: DisplayPhase, value: u32) -> DisplayEdit {
        DisplayEdit {
            axis,
            phase,
            monitor_id: None,
            value,
        }
    }

    #[test]
    fn writes_the_named_axis_and_leaves_the_other_alone() {
        let mut s = settings_with("office");
        let before = s.display.modes["office"];
        apply_edit_to(
            &mut s,
            &edit(DisplayAxis::Brightness, DisplayPhase::Night, 55),
        );
        let after = s.display.modes["office"];
        assert_eq!(after.brightness_night, 55);
        // The whole point of intent-over-state: nothing else moves.
        assert_eq!(after.brightness_day, before.brightness_day);
        assert_eq!(after.kelvin_day, before.kelvin_day);
        assert_eq!(after.kelvin_night, before.kelvin_night);
    }

    #[test]
    fn an_edit_in_pause_is_redirected_into_custom() {
        let mut s = settings_with("pause");
        let mode = apply_edit_to(
            &mut s,
            &edit(DisplayAxis::Brightness, DisplayPhase::Night, 40),
        );
        assert_eq!(mode, "custom");
        assert_eq!(s.display.mode, "custom");
        assert_eq!(s.display.modes["custom"].brightness_night, 40);
        // Seeded from what was on screen (pause = 6500 K), not custom's 5500.
        assert_eq!(s.display.modes["custom"].kelvin_night, 6500);
        // `pause` itself must stay pristine so resuming it still means "off".
        assert_eq!(s.display.modes["pause"].brightness_night, 100);
    }

    #[test]
    fn values_are_clamped_to_the_active_range() {
        let mut s = settings_with("office");
        apply_edit_to(
            &mut s,
            &edit(DisplayAxis::Brightness, DisplayPhase::Day, 999),
        );
        assert_eq!(s.display.modes["office"].brightness_day, 100);
        apply_edit_to(&mut s, &edit(DisplayAxis::Brightness, DisplayPhase::Day, 0));
        // Narrow range floors at 10 % so the screen can't go fully black.
        assert_eq!(s.display.modes["office"].brightness_day, 10);
        apply_edit_to(
            &mut s,
            &edit(DisplayAxis::Kelvin, DisplayPhase::Day, 99_999),
        );
        assert_eq!(s.display.modes["office"].kelvin_day, 6500);
    }

    #[test]
    fn wide_range_widens_the_clamp() {
        let mut s = settings_with("office");
        s.display.brightness_wide_range = true;
        s.display.wide_range = true;
        apply_edit_to(&mut s, &edit(DisplayAxis::Brightness, DisplayPhase::Day, 0));
        assert_eq!(s.display.modes["office"].brightness_day, 0);
        apply_edit_to(&mut s, &edit(DisplayAxis::Kelvin, DisplayPhase::Day, 9000));
        assert_eq!(s.display.modes["office"].kelvin_day, 9000);
        apply_edit_to(&mut s, &edit(DisplayAxis::Kelvin, DisplayPhase::Day, 0));
        assert_eq!(s.display.modes["office"].kelvin_day, 1000);
    }

    #[test]
    fn a_monitor_edit_writes_the_override_not_the_mode_preset() {
        let mut s = settings_with("office");
        let before = s.display.modes["office"];
        let mut e = edit(DisplayAxis::Kelvin, DisplayPhase::Night, 3000);
        e.monitor_id = Some("\\\\.\\DISPLAY2".to_string());
        apply_edit_to(&mut s, &e);
        assert_eq!(
            s.display.monitor_overrides["\\\\.\\DISPLAY2"].kelvin_night,
            3000
        );
        let override_ = s.display.monitor_overrides["\\\\.\\DISPLAY2"];
        assert_eq!(override_.kelvin_day, before.kelvin_day);
        assert_eq!(override_.brightness_day, before.brightness_day);
        assert_eq!(override_.brightness_night, before.brightness_night);
        assert_eq!(s.display.modes["office"], before);
    }

    #[test]
    fn a_stale_caller_cannot_clobber_fields_it_did_not_touch() {
        // The regression this whole module exists for. A surface holding an
        // OLD copy of the tree used to save its whole `display` section and
        // overwrite everything another window had just written. Intent-based
        // edits make that impossible: only the named axis moves, whatever the
        // caller believes the rest of the tree looks like.
        let mut s = settings_with("office");
        apply_edit_to(
            &mut s,
            &edit(DisplayAxis::Kelvin, DisplayPhase::Night, 4200),
        );
        apply_edit_to(
            &mut s,
            &edit(DisplayAxis::Brightness, DisplayPhase::Night, 57),
        );
        let after = s.display.modes["office"];
        assert_eq!(after.kelvin_night, 4200, "the earlier edit must survive");
        assert_eq!(after.brightness_night, 57);
    }
}
