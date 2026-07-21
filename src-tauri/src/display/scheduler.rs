//! Day/night scheduler — the clock + astronomy that drives the display engine's
//! day↔night interpolation.
//!
//! The engine interpolates every mode between its `*_day` and `*_night` values
//! by [`day_factor`] (`0.0` = full night, `1.0` = full day) and labels the UI
//! badge with [`current_phase`]. This module owns how that factor tracks the
//! wall clock, reading `settings.day_night`.
//!
//! ## Ramp shape (CareUEyes parity — FEATURE-PARITY F3.4)
//!
//! CareUEyes anchors the transition asymmetrically (see its "Practical Example":
//! sunrise 06:26, sunset 17:54, 1 h transition):
//!
//! - The morning ramp **starts at sunrise** and climbs `0.0 → 1.0` over
//!   `transition_minutes` (night → day).
//! - The evening ramp **starts `transition_minutes` before sunset** and falls
//!   `1.0 → 0.0`, reaching full night exactly at sunset (day → night).
//! - Between the two ramps the factor plateaus at `1.0` (day); outside them it
//!   is `0.0` (night).
//!
//! This is implemented as `min(morning_ramp, evening_ramp)`, which also degrades
//! gracefully when the two ramps would overlap (very long transition / short
//! day).
//!
//! ## Sources
//!
//! - `enabled == false` ⇒ always `1.0` / [`Phase::Day`].
//! - `use_location == true` ⇒ today's sunrise/sunset from `latitude`/`longitude`
//!   via [`super::suncalc`] (pure NOAA math, no network), using the DST-correct
//!   local offset for the current date.
//! - otherwise the manual `sunrise`/`sunset` `"HH:MM"` strings.
//!
//! Times are recomputed from `chrono::Local` on every evaluation, so DST shifts
//! and date changes are always reflected (nothing is cached across midnight).
//!
//! ## Runtime ticker
//!
//! [`day_factor`]/[`current_phase`] are pure reads of the current clock, but the
//! *applied* gamma ramp only follows the clock if something re-applies it as
//! time passes. [`init`] captures the [`AppHandle`] the scheduler needs to read
//! settings and spawns a lightweight 30 s ticker that calls
//! [`super::engine::refresh`] whenever the computed factor drifts past 1 %, or
//! immediately after a system-wake / large clock jump (so the ramp is restored
//! after sleep). Call it **once** from the setup hook, right after
//! `display::engine::init` — e.g. `display::scheduler::init(&app_handle);`.
//! Until then the two accessors fall back to full day (identical to the old
//! stub), so an un-wired build is inert rather than wrong.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use chrono::{Local, Offset, Timelike};
use tauri::AppHandle;

use crate::settings::DayNightSettings;

/// Coarse day/night phase for the real-time UI badge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Day,
    Night,
    Transition,
}

impl Phase {
    /// Lowercase wire string for `DisplayOutput.phase` (`"day"` / `"night"` /
    /// `"transition"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Night => "night",
            Self::Transition => "transition",
        }
    }
}

/// `AppHandle` captured by [`init`], used to read the live settings tree from a
/// background context (the engine calls the accessors below with no handle).
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Ticker cadence: re-evaluate the schedule this often and re-apply when it has
/// meaningfully moved.
const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// Interpolation factor between night (`0.0`) and day (`1.0`) for *now*.
///
/// Reads `settings.day_night` via the captured [`AppHandle`]; before [`init`]
/// runs (or if it never does) it reports full day.
pub fn day_factor() -> f32 {
    evaluate().0
}

/// Coarse phase label for the UI badge, consistent with [`day_factor`].
pub fn current_phase() -> Phase {
    evaluate().1
}

/// Capture the app handle and start the day/night ticker. Idempotent — a second
/// call is a no-op and never starts a second thread.
pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    if let Err(err) = std::thread::Builder::new()
        .name("daynight-scheduler".into())
        .spawn(ticker_loop)
    {
        log::warn!("[scheduler] failed to start day/night ticker: {err}");
    }
}

/// The 30 s driver: re-apply the display output as the ramp advances with the
/// clock, and force a re-apply after a suspend/resume (the OS resets gamma on
/// wake) or any large clock jump.
fn ticker_loop() {
    // Apply once now that settings are reachable: the boot-time `engine::init`
    // ran before this handle existed and saw the full-day fallback.
    super::engine::refresh();
    let mut last_factor = day_factor();
    let mut last_wall = SystemTime::now();

    loop {
        std::thread::sleep(TICK_INTERVAL);

        let now_wall = SystemTime::now();
        // Elapsed wall time; `duration_since` errors on a backward jump, which
        // we also treat as "something moved the clock".
        let jumped = match now_wall.duration_since(last_wall) {
            Ok(elapsed) => elapsed > TICK_INTERVAL * 3,
            Err(_) => true,
        };
        last_wall = now_wall;

        let factor = day_factor();
        if jumped || (factor - last_factor).abs() > 0.01 {
            last_factor = factor;
            super::engine::refresh();
        }
    }
}

/// Read the live day/night settings + clock and resolve the current factor.
fn evaluate() -> (f32, Phase) {
    let Some(app) = APP.get() else {
        return (1.0, Phase::Day);
    };
    let settings = crate::settings::store::read_settings(app);
    let now = Local::now();
    let now_minutes =
        f64::from(now.hour()) * 60.0 + f64::from(now.minute()) + f64::from(now.second()) / 60.0;
    let tz_offset_minutes = now.offset().fix().local_minus_utc() / 60;
    schedule_factor(
        &settings.day_night,
        now.date_naive(),
        now_minutes,
        tz_offset_minutes,
    )
}

/// Pure resolver: `(factor, phase)` for a settings snapshot at a given local
/// date, minute-of-day and UTC offset. All runtime state (clock, settings,
/// astronomy) is passed in, so this is the fully unit-tested core.
fn schedule_factor(
    day_night: &DayNightSettings,
    date: chrono::NaiveDate,
    now_minutes: f64,
    tz_offset_minutes: i32,
) -> (f32, Phase) {
    if !day_night.enabled {
        return (1.0, Phase::Day);
    }

    let (sunrise, sunset) = if day_night.use_location {
        match super::suncalc::sun_times(
            day_night.latitude,
            day_night.longitude,
            date,
            tz_offset_minutes,
        ) {
            super::suncalc::SunTimes::Rises {
                sunrise_minutes,
                sunset_minutes,
            } => (sunrise_minutes, sunset_minutes),
            super::suncalc::SunTimes::AlwaysUp => return (1.0, Phase::Day),
            super::suncalc::SunTimes::AlwaysDown => return (0.0, Phase::Night),
        }
    } else {
        (
            parse_hhmm(&day_night.sunrise),
            parse_hhmm(&day_night.sunset),
        )
    };

    let factor = ramp_factor(
        now_minutes,
        sunrise,
        sunset,
        f64::from(day_night.transition_minutes),
    );
    (factor, phase_of(factor))
}

/// CareUEyes-style ramp: `0.0` before sunrise, up over `transition` after it,
/// `1.0` through the day, down over `transition` ending at sunset, `0.0` after.
/// All arguments are local minutes-of-day; `min(..)` keeps the result in
/// `0.0..=1.0` even when the two ramps overlap.
fn ramp_factor(now_minutes: f64, sunrise: f64, sunset: f64, transition: f64) -> f32 {
    // A zero/negative window becomes a hard step (clamped to a 1-minute ramp).
    let window = transition.max(1.0);
    let morning = ((now_minutes - sunrise) / window).clamp(0.0, 1.0);
    let evening = ((sunset - now_minutes) / window).clamp(0.0, 1.0);
    morning.min(evening) as f32
}

/// Classify a factor into the coarse UI phase.
fn phase_of(factor: f32) -> Phase {
    if factor >= 0.999 {
        Phase::Day
    } else if factor <= 0.001 {
        Phase::Night
    } else {
        Phase::Transition
    }
}

/// Parse an `"HH:MM"` string to local minutes-since-midnight, tolerating stray
/// whitespace and clamping to a valid time; unparseable input falls back to
/// midnight (`0.0`).
fn parse_hhmm(value: &str) -> f64 {
    let mut parts = value.splitn(2, ':');
    let hours = parts
        .next()
        .and_then(|p| p.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 23.0);
    let minutes = parts
        .next()
        .and_then(|p| p.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 59.0);
    hours * 60.0 + minutes
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// Manual-mode 07:00→19:00, 60-minute transition, used across the ramp tests.
    fn manual() -> DayNightSettings {
        DayNightSettings {
            enabled: true,
            use_location: false,
            latitude: 0.0,
            longitude: 0.0,
            sunrise: "07:00".to_string(),
            sunset: "19:00".to_string(),
            transition_minutes: 60,
        }
    }

    fn date() -> NaiveDate {
        NaiveDate::from_ymd_opt(2024, 3, 20).unwrap()
    }

    #[test]
    fn phase_wire_strings_are_stable() {
        assert_eq!(Phase::Day.as_str(), "day");
        assert_eq!(Phase::Night.as_str(), "night");
        assert_eq!(Phase::Transition.as_str(), "transition");
    }

    #[test]
    fn parse_hhmm_handles_valid_and_garbage() {
        assert_eq!(parse_hhmm("07:00"), 420.0);
        assert_eq!(parse_hhmm("19:30"), 1170.0);
        assert_eq!(parse_hhmm("  06:45 "), 405.0);
        assert_eq!(parse_hhmm("00:00"), 0.0);
        assert_eq!(parse_hhmm("garbage"), 0.0);
        assert_eq!(parse_hhmm(""), 0.0);
        // Out-of-range components clamp instead of exploding.
        assert_eq!(parse_hhmm("30:99"), 23.0 * 60.0 + 59.0);
    }

    #[test]
    fn ramp_is_full_day_at_noon() {
        // 12:00 sits on the daytime plateau.
        assert_eq!(ramp_factor(720.0, 420.0, 1140.0, 60.0), 1.0);
    }

    #[test]
    fn ramp_is_full_night_before_sunrise_and_after_sunset() {
        assert_eq!(ramp_factor(180.0, 420.0, 1140.0, 60.0), 0.0); // 03:00
        assert_eq!(ramp_factor(1380.0, 420.0, 1140.0, 60.0), 0.0); // 23:00
    }

    #[test]
    fn morning_ramp_starts_at_sunrise() {
        // Exactly at sunrise → still night; halfway through the window → 0.5;
        // one window later → full day.
        assert_eq!(ramp_factor(420.0, 420.0, 1140.0, 60.0), 0.0);
        assert!((ramp_factor(450.0, 420.0, 1140.0, 60.0) - 0.5).abs() < 1e-6);
        assert_eq!(ramp_factor(480.0, 420.0, 1140.0, 60.0), 1.0);
    }

    #[test]
    fn evening_ramp_ends_at_sunset() {
        // One window before sunset → still full day; halfway → 0.5; at sunset →
        // full night.
        assert_eq!(ramp_factor(1080.0, 420.0, 1140.0, 60.0), 1.0);
        assert!((ramp_factor(1110.0, 420.0, 1140.0, 60.0) - 0.5).abs() < 1e-6);
        assert_eq!(ramp_factor(1140.0, 420.0, 1140.0, 60.0), 0.0);
    }

    #[test]
    fn overlapping_ramps_stay_in_range() {
        // A transition wider than half the day would overshoot without the
        // `min`; here it must still land within [0, 1] and never exceed the
        // shorter ramp.
        let f = ramp_factor(720.0, 420.0, 1140.0, 600.0);
        assert!((0.0..=1.0).contains(&f));
    }

    #[test]
    fn phase_thresholds() {
        assert_eq!(phase_of(1.0), Phase::Day);
        assert_eq!(phase_of(0.0), Phase::Night);
        assert_eq!(phase_of(0.5), Phase::Transition);
    }

    #[test]
    fn disabled_is_always_full_day() {
        let mut settings = manual();
        settings.enabled = false;
        // Even at deep night, a disabled schedule reports full day.
        assert_eq!(
            schedule_factor(&settings, date(), 120.0, 0),
            (1.0, Phase::Day)
        );
    }

    #[test]
    fn manual_mode_midday_and_midnight() {
        let settings = manual();
        assert_eq!(
            schedule_factor(&settings, date(), 720.0, 0),
            (1.0, Phase::Day)
        );
        assert_eq!(
            schedule_factor(&settings, date(), 30.0, 0),
            (0.0, Phase::Night)
        );
    }

    #[test]
    fn manual_mode_inside_morning_and_evening_ramps() {
        let settings = manual();
        // 07:30 → half-way up the morning ramp.
        let (factor, phase) = schedule_factor(&settings, date(), 450.0, 0);
        assert!((factor - 0.5).abs() < 1e-6);
        assert_eq!(phase, Phase::Transition);
        // 18:30 → half-way down the evening ramp.
        let (factor, phase) = schedule_factor(&settings, date(), 1110.0, 0);
        assert!((factor - 0.5).abs() < 1e-6);
        assert_eq!(phase, Phase::Transition);
    }

    #[test]
    fn location_mode_tracks_computed_sun_times() {
        let mut settings = manual();
        settings.use_location = true;
        settings.latitude = 51.5074;
        settings.longitude = -0.1278;
        // London solstice: sunrise ~04:43, sunset ~21:21 (BST, +60). Local noon
        // is squarely daytime; local midnight is night.
        let noon = schedule_factor(
            &settings,
            NaiveDate::from_ymd_opt(2024, 6, 21).unwrap(),
            720.0,
            60,
        );
        assert_eq!(noon, (1.0, Phase::Day));
        let midnight = schedule_factor(
            &settings,
            NaiveDate::from_ymd_opt(2024, 6, 21).unwrap(),
            0.0,
            60,
        );
        assert_eq!(midnight, (0.0, Phase::Night));
    }

    #[test]
    fn location_mode_polar_day_and_night() {
        let mut settings = manual();
        settings.use_location = true;
        settings.latitude = 78.0;
        settings.longitude = 15.0;
        // Midnight sun → always day regardless of the clock.
        assert_eq!(
            schedule_factor(
                &settings,
                NaiveDate::from_ymd_opt(2024, 6, 21).unwrap(),
                30.0,
                60
            ),
            (1.0, Phase::Day)
        );
        // Polar night → always night, even at midday.
        assert_eq!(
            schedule_factor(
                &settings,
                NaiveDate::from_ymd_opt(2024, 12, 21).unwrap(),
                720.0,
                60
            ),
            (0.0, Phase::Night)
        );
    }

    #[test]
    fn manual_and_location_agree_at_matching_times() {
        // With manual times set to the computed London solstice sun times, the
        // two modes must classify midday and dusk identically.
        let london = NaiveDate::from_ymd_opt(2024, 6, 21).unwrap();
        let mut loc = manual();
        loc.use_location = true;
        loc.latitude = 51.5074;
        loc.longitude = -0.1278;
        let (loc_factor, loc_phase) = schedule_factor(&loc, london, 720.0, 60);
        let mut man = manual();
        man.sunrise = "04:43".to_string();
        man.sunset = "21:21".to_string();
        let (man_factor, man_phase) = schedule_factor(&man, london, 720.0, 60);
        assert_eq!(loc_phase, man_phase);
        assert!((loc_factor - man_factor).abs() < 1e-3);
    }

    #[test]
    fn day_factor_is_full_day_without_init() {
        // The frozen accessors must be safe (and neutral) before `init` runs.
        assert_eq!(day_factor(), 1.0);
        assert_eq!(current_phase(), Phase::Day);
    }
}
