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
//! - `use_location == true` ⇒ today's sunrise/sunset via [`super::suncalc`]
//!   (pure NOAA math, no network) for the coordinates [`super::location`]
//!   resolves — the system timezone's locality, a zone the user picked, or the
//!   stored `latitude`/`longitude` — using the DST-correct local offset for the
//!   current date.
//! - otherwise the manual `sunrise`/`sunset` `"HH:MM"` strings.
//!   Manual daytime is the circular interval from sunrise to sunset, so a
//!   sunrise later than sunset wraps across midnight. Equal boundaries define
//!   a zero-length daytime interval and therefore remain full night.
//!
//! Times are recomputed on every evaluation, so DST shifts and date changes are
//! always reflected (nothing is cached across midnight). A selected or detected
//! IANA timezone supplies its own civil date and DST-correct offset; manual
//! coordinates fall back to the host clock because they do not identify a zone.
//!
//! ## Runtime deadline worker
//!
//! [`day_factor`]/[`current_phase`] are pure reads of the current clock, but the
//! *applied* gamma ramp only follows the clock if something re-applies it as
//! time passes. [`init`] captures the [`AppHandle`] the scheduler needs to read
//! settings and spawns a wakeable deadline worker. It sleeps until the next
//! schedule boundary (or the next 1% transition step), and is interrupted by
//! settings saves, cross-platform Tauri lifecycle/focus events, plus native
//! clock/resume notifications where available. Call it **once** from the setup
//! hook, right after
//! `display::engine::init` — e.g. `display::scheduler::init(&app_handle);`.
//! Until then the two accessors fall back to full day, so an un-wired build is
//! inert rather than wrong.

use std::sync::OnceLock;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use chrono::{DateTime, Local, Offset, Timelike, Utc};
use tauri::{AppHandle, Listener};

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

/// Coalescing wake channel for settings and native clock notifications.
static WAKE_TX: OnceLock<SyncSender<()>> = OnceLock::new();

/// Match the old visual granularity without waking at a fixed cadence: during a
/// ramp the next deadline is one percentage point of the configured transition.
const FACTOR_STEP: f64 = 0.01;

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

/// The endpoint a MANUAL edit (slider, tray flyout, hotkey stepper) should land
/// on right now. Never [`Phase::Transition`] — that is not a stored endpoint.
///
/// Mid-ramp the engine applies `lerp(night, day, factor)`, so an edit to the
/// endpoint that is fading OUT barely reaches the screen: at `factor == 0.05` a
/// full-range brightness drag moves the applied output by 5 %, which the user
/// experiences as a slider that stops working and then "fixes itself" an hour
/// later when the ramp ends. Manual edits therefore land on the endpoint that
/// DOMINATES the current output, so a drag always has at least half the
/// authority over what is on screen.
pub fn current_edit_phase() -> Phase {
    dominant_endpoint(day_factor())
}

/// Pure core of [`current_edit_phase`]: which endpoint a ramp factor is closest
/// to. Ties go to day, matching [`ramp_factor`]'s inclusive daytime interval.
fn dominant_endpoint(factor: f32) -> Phase {
    if factor >= 0.5 {
        Phase::Day
    } else {
        Phase::Night
    }
}

/// Capture the app handle and start the day/night worker. Idempotent — a second
/// call is a no-op and never starts a second thread.
pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let (wake_tx, wake_rx) = mpsc::sync_channel(1);
    let _ = WAKE_TX.set(wake_tx);
    let _ = app.listen_any("settings:changed", |_event| request_wake());

    if let Err(err) = std::thread::Builder::new()
        .name("daynight-scheduler".into())
        .spawn(move || scheduler_loop(wake_rx))
    {
        log::warn!("[scheduler] failed to start day/night worker: {err}");
    }

    #[cfg(windows)]
    if let Err(err) = std::thread::Builder::new()
        .name("system-clock-events".into())
        .spawn(windows_notification_loop)
    {
        log::warn!("[scheduler] failed to start native clock listener: {err}");
    }
}

/// Coalesce any number of simultaneous settings/native notifications into one
/// refresh. A full channel means the worker is already guaranteed to wake.
fn request_wake() {
    if let Some(tx) = WAKE_TX.get() {
        let _ = tx.try_send(());
    }
}

/// Reconcile the schedule after the cross-platform application event loop
/// reports a resume or a window regains focus. This complements platform-native
/// clock notifications and keeps non-Windows builds event-driven too.
pub(crate) fn notify_app_activity() {
    request_wake();
}

/// Re-apply the display output at exact schedule deadlines. Settings changes,
/// suspend/resume, and wall-clock adjustments interrupt the wait immediately.
fn scheduler_loop(wake_rx: Receiver<()>) {
    // Apply once now that settings are reachable: the boot-time `engine::init`
    // ran before this handle existed and saw the full-day fallback.
    super::engine::refresh();
    loop {
        let deadline = next_refresh_delay();
        let _ = wake_rx.recv_timeout(deadline);
        super::engine::refresh();
    }
}

/// Delay until the next boundary that can materially change the output.
fn next_refresh_delay() -> Duration {
    let Some(app) = APP.get() else {
        return Duration::from_secs(24 * 60 * 60);
    };
    let settings = crate::settings::store::read_settings(app);
    let instant = Utc::now();
    let clock = clock_at(&settings.day_night, instant);
    let delay = next_schedule_delay(
        &settings.day_night,
        clock.date,
        clock.minutes,
        clock.utc_offset_minutes,
    );
    cap_at_timezone_transition(&settings.day_night, instant, delay)
}

fn cap_at_timezone_transition(
    day_night: &DayNightSettings,
    instant: DateTime<Utc>,
    delay: Duration,
) -> Duration {
    if !day_night.use_location {
        return delay;
    }

    let location = super::location::resolve(day_night);
    let Some(timezone) = location.timezone.as_deref() else {
        return delay;
    };
    super::timezones::next_offset_change(timezone, instant, delay)
        .map_or(delay, |transition| delay.min(transition))
}

fn next_schedule_delay(
    day_night: &DayNightSettings,
    date: chrono::NaiveDate,
    now_minutes: f64,
    tz_offset_minutes: i32,
) -> Duration {
    if !day_night.enabled {
        return until_next_local_midnight(now_minutes);
    }

    let (sunrise, sunset) = match schedule_times(day_night, date, tz_offset_minutes) {
        ScheduleTimes::Rises { sunrise, sunset } => (sunrise, sunset),
        // Polar day/night: nothing changes until the date does.
        ScheduleTimes::AlwaysUp | ScheduleTimes::AlwaysDown => {
            return until_next_local_midnight(now_minutes);
        }
    };
    if circular_day_length(sunrise, sunset) <= f64::EPSILON {
        return until_next_local_midnight(now_minutes);
    }

    let window = f64::from(day_night.transition_minutes).max(1.0);
    let morning_end = sunrise + window;
    let evening_start = sunset - window;
    let in_ramp = is_in_transition_window(now_minutes, sunrise, sunset, window);

    let mut delay_minutes = 1440.0 - now_minutes;
    for boundary in [sunrise, morning_end, evening_start, sunset] {
        let delta = (boundary - now_minutes).rem_euclid(1440.0);
        if delta > f64::EPSILON {
            delay_minutes = delay_minutes.min(delta);
        }
    }
    if in_ramp {
        delay_minutes = delay_minutes.min(window * FACTOR_STEP);
    }
    duration_from_minutes(delay_minutes)
}

fn until_next_local_midnight(now_minutes: f64) -> Duration {
    duration_from_minutes((1440.0 - now_minutes).max(1.0 / 60.0))
}

fn duration_from_minutes(minutes: f64) -> Duration {
    Duration::from_secs_f64((minutes * 60.0).max(0.05))
}

/// A hidden top-level window receives the broadcasts Windows already provides
/// for wall-clock/DST changes, resume, and Explorer recreation. It never polls.
#[cfg(windows)]
fn windows_notification_loop() {
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, MSG, RegisterClassW, TranslateMessage,
        WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
    };
    use windows::core::w;

    // SAFETY: the class and invisible window live for this process; the message
    // loop owns the thread and all pointers supplied here are static strings.
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else {
            log::warn!("[scheduler] GetModuleHandleW failed for clock listener");
            return;
        };
        let class_name = w!("DimReadSystemClockListener");
        let class = WNDCLASSW {
            lpfnWndProc: Some(system_notification_wnd_proc),
            hInstance: module.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            log::warn!("[scheduler] RegisterClassW failed for clock listener");
            return;
        }
        let Ok(_window) = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(module.into()),
            None,
        ) else {
            log::warn!("[scheduler] CreateWindowExW failed for clock listener");
            return;
        };
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

#[cfg(windows)]
unsafe extern "system" fn system_notification_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMECRITICAL, PBT_APMRESUMESTANDBY,
        PBT_APMRESUMESUSPEND, RegisterWindowMessageW, WM_DISPLAYCHANGE, WM_POWERBROADCAST,
        WM_TIMECHANGE,
    };
    use windows::core::w;

    let resumed = message == WM_POWERBROADCAST
        && matches!(
            wparam.0 as u32,
            PBT_APMRESUMEAUTOMATIC
                | PBT_APMRESUMECRITICAL
                | PBT_APMRESUMESTANDBY
                | PBT_APMRESUMESUSPEND
        );
    if message == WM_DISPLAYCHANGE {
        super::engine::notify_topology_change();
    } else if message == WM_TIMECHANGE || resumed {
        request_wake();
        crate::magicx::theme::notify_system_change();
    // SAFETY: registering this process-wide message is idempotent and the
    // string is static. Explorer broadcasts it after recreating the taskbar.
    } else if message == unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) } {
        crate::magicx::theme::notify_system_change();
    }

    // SAFETY: messages not consumed above retain default window semantics.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// Read the live day/night settings + clock and resolve the current factor.
fn evaluate() -> (f32, Phase) {
    let Some(app) = APP.get() else {
        return (1.0, Phase::Day);
    };
    let settings = crate::settings::store::read_settings(app);
    let clock = clock_at(&settings.day_night, Utc::now());
    schedule_factor(
        &settings.day_night,
        clock.date,
        clock.minutes,
        clock.utc_offset_minutes,
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScheduleClock {
    pub date: chrono::NaiveDate,
    pub minutes: f64,
    pub utc_offset_minutes: i32,
}

/// Resolve an instant to the civil clock that owns this schedule. Location
/// modes use the resolved IANA zone; modes without a resolvable zone use the
/// host clock as their explicit fallback.
pub(crate) fn clock_at(day_night: &DayNightSettings, instant: DateTime<Utc>) -> ScheduleClock {
    if day_night.use_location {
        let location = super::location::resolve(day_night);
        if let Some(timezone) = location.timezone.as_deref()
            && let Some(local) = super::timezones::time_at(timezone, instant)
        {
            return ScheduleClock {
                date: local.date,
                minutes: local.minutes,
                utc_offset_minutes: local.utc_offset_minutes,
            };
        }
    }

    let local = instant.with_timezone(&Local);
    ScheduleClock {
        date: local.date_naive(),
        minutes: f64::from(local.hour()) * 60.0
            + f64::from(local.minute())
            + f64::from(local.second()) / 60.0
            + f64::from(local.nanosecond()) / 60_000_000_000.0,
        utc_offset_minutes: local.offset().fix().local_minus_utc() / 60,
    }
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

    let (sunrise, sunset) = match schedule_times(day_night, date, tz_offset_minutes) {
        ScheduleTimes::Rises { sunrise, sunset } => (sunrise, sunset),
        ScheduleTimes::AlwaysUp => return (1.0, Phase::Day),
        ScheduleTimes::AlwaysDown => return (0.0, Phase::Night),
    };

    let factor = ramp_factor(
        now_minutes,
        sunrise,
        sunset,
        f64::from(day_night.transition_minutes),
    );
    (factor, phase_of(factor))
}

/// Today's schedule boundaries in local minutes-of-day.
pub(crate) enum ScheduleTimes {
    Rises { sunrise: f64, sunset: f64 },
    AlwaysUp,
    AlwaysDown,
}

/// Today's day/night boundaries for the LIVE settings, resolved the same way the
/// colour filter resolves them.
///
/// Shared with Auto Dark (`crate::magicx::theme`) so that "follow the day & night
/// schedule" means literally the same sun times — including a resolved location's
/// astronomy — rather than a second HH:MM pair that can silently disagree.
///
/// `day_night.enabled` is deliberately NOT consulted: that flag says whether the
/// COLOUR filter ramps, and a user who parks the filter on one profile still
/// expects their system theme to turn over at dusk. `None` before [`init`] has
/// captured the handle, i.e. when no settings are reachable yet.
pub(crate) fn current_schedule_times() -> Option<ScheduleTimes> {
    let app = APP.get()?;
    let settings = crate::settings::store::read_settings(app);
    let clock = clock_at(&settings.day_night, Utc::now());
    Some(schedule_times(
        &settings.day_night,
        clock.date,
        clock.utc_offset_minutes,
    ))
}

/// The sunrise/sunset pair a settings snapshot implies: real astronomy for the
/// RESOLVED location when `use_location` is set (see [`super::location`] — the
/// coordinates may come from the system timezone, a chosen one, or the stored
/// pair), otherwise the manual "HH:MM" strings.
pub(crate) fn schedule_times(
    day_night: &DayNightSettings,
    date: chrono::NaiveDate,
    tz_offset_minutes: i32,
) -> ScheduleTimes {
    if !day_night.use_location {
        return ScheduleTimes::Rises {
            sunrise: parse_hhmm(&day_night.sunrise),
            sunset: parse_hhmm(&day_night.sunset),
        };
    }
    let location = super::location::resolve(day_night);
    match super::suncalc::sun_times(
        location.latitude,
        location.longitude,
        date,
        tz_offset_minutes,
    ) {
        super::suncalc::SunTimes::Rises {
            sunrise_minutes,
            sunset_minutes,
        } => ScheduleTimes::Rises {
            sunrise: sunrise_minutes,
            sunset: sunset_minutes,
        },
        super::suncalc::SunTimes::AlwaysUp => ScheduleTimes::AlwaysUp,
        super::suncalc::SunTimes::AlwaysDown => ScheduleTimes::AlwaysDown,
    }
}

/// CareUEyes-style ramp over the circular daytime interval from sunrise to
/// sunset. A later sunrise wraps through midnight; equal boundaries are an
/// empty daytime interval and return full night. `min(..)` keeps overlapping
/// morning/evening ramps in `0.0..=1.0`.
fn ramp_factor(now_minutes: f64, sunrise: f64, sunset: f64, transition: f64) -> f32 {
    let day_length = circular_day_length(sunrise, sunset);
    if day_length <= f64::EPSILON {
        return 0.0;
    }

    let elapsed = (now_minutes - sunrise).rem_euclid(1440.0);
    if elapsed >= day_length {
        return 0.0;
    }

    // A zero/negative window becomes a hard step (clamped to a 1-minute ramp).
    let window = transition.max(1.0);
    let morning = (elapsed / window).clamp(0.0, 1.0);
    let evening = ((day_length - elapsed) / window).clamp(0.0, 1.0);
    morning.min(evening) as f32
}

fn circular_day_length(sunrise: f64, sunset: f64) -> f64 {
    (sunset - sunrise).rem_euclid(1440.0)
}

fn is_in_transition_window(now_minutes: f64, sunrise: f64, sunset: f64, window: f64) -> bool {
    let day_length = circular_day_length(sunrise, sunset);
    let elapsed = (now_minutes - sunrise).rem_euclid(1440.0);
    day_length > f64::EPSILON
        && elapsed < day_length
        && (elapsed < window || day_length - elapsed <= window)
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
    use chrono::{NaiveDate, TimeZone, Utc};

    /// Manual-mode 07:00→19:00, 60-minute transition, used across the ramp tests.
    fn manual() -> DayNightSettings {
        DayNightSettings {
            enabled: true,
            use_location: false,
            location_source: "manual".to_string(),
            timezone: String::new(),
            latitude: 0.0,
            longitude: 0.0,
            sunrise: "07:00".to_string(),
            sunset: "19:00".to_string(),
            transition_minutes: 60,
        }
    }

    /// A location-mode snapshot pinned to explicit COORDINATES, so the sun-time
    /// assertions below test the astronomy rather than whatever timezone the
    /// machine running the suite happens to be set to.
    fn at(latitude: f64, longitude: f64) -> DayNightSettings {
        DayNightSettings {
            use_location: true,
            location_source: "manual".to_string(),
            latitude,
            longitude,
            ..manual()
        }
    }

    fn in_timezone(timezone: &str) -> DayNightSettings {
        DayNightSettings {
            use_location: true,
            location_source: "timezone".to_string(),
            timezone: timezone.to_string(),
            ..manual()
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
    fn overnight_ramp_wraps_daytime_across_midnight() {
        let sunrise = 20.0 * 60.0;
        let sunset = 6.0 * 60.0;

        assert_eq!(ramp_factor(12.0 * 60.0, sunrise, sunset, 60.0), 0.0);
        assert_eq!(ramp_factor(0.0, sunrise, sunset, 60.0), 1.0);
        assert!((ramp_factor(20.5 * 60.0, sunrise, sunset, 60.0) - 0.5).abs() < 1e-6);
        assert!((ramp_factor(5.5 * 60.0, sunrise, sunset, 60.0) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn equal_boundaries_define_an_all_night_schedule() {
        for now in [0.0, 7.0 * 60.0, 12.0 * 60.0, 23.0 * 60.0] {
            assert_eq!(ramp_factor(now, 7.0 * 60.0, 7.0 * 60.0, 60.0), 0.0);
        }
    }

    #[test]
    fn phase_thresholds() {
        assert_eq!(phase_of(1.0), Phase::Day);
        assert_eq!(phase_of(0.0), Phase::Night);
        assert_eq!(phase_of(0.5), Phase::Transition);
    }

    #[test]
    fn a_manual_edit_lands_on_the_endpoint_that_dominates_the_output() {
        // Never `Transition`: it is not a stored endpoint, and editing the
        // fading one is the "slider does nothing mid-ramp" bug.
        assert_eq!(dominant_endpoint(1.0), Phase::Day);
        assert_eq!(dominant_endpoint(0.75), Phase::Day);
        assert_eq!(dominant_endpoint(0.5), Phase::Day);
        assert_eq!(dominant_endpoint(0.49), Phase::Night);
        assert_eq!(dominant_endpoint(0.05), Phase::Night);
        assert_eq!(dominant_endpoint(0.0), Phase::Night);
    }

    #[test]
    fn every_edit_keeps_at_least_half_the_authority_over_the_screen() {
        // The property the split exists for: writing an endpoint moves the
        // applied output by `weight * delta`, and that weight is never small.
        for step in 0..=100 {
            let factor = step as f32 / 100.0;
            let weight = match dominant_endpoint(factor) {
                Phase::Day => factor,
                Phase::Night => 1.0 - factor,
                Phase::Transition => unreachable!("not an endpoint"),
            };
            assert!(weight >= 0.5, "factor {factor} left weight {weight}");
        }
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
    fn manual_mode_supports_an_overnight_day_window() {
        let mut settings = manual();
        settings.sunrise = "20:00".to_string();
        settings.sunset = "06:00".to_string();

        assert_eq!(
            schedule_factor(&settings, date(), 0.0, 0),
            (1.0, Phase::Day)
        );
        assert_eq!(
            schedule_factor(&settings, date(), 12.0 * 60.0, 0),
            (0.0, Phase::Night)
        );
    }

    #[test]
    fn manual_mode_with_equal_boundaries_is_always_night() {
        let mut settings = manual();
        settings.sunrise = "07:00".to_string();
        settings.sunset = "07:00".to_string();

        assert_eq!(
            schedule_factor(&settings, date(), 12.0 * 60.0, 0),
            (0.0, Phase::Night)
        );
    }

    #[test]
    fn deadline_sleeps_to_the_next_structural_boundary() {
        let settings = manual();
        assert_eq!(
            next_schedule_delay(&settings, date(), 360.0, 0),
            Duration::from_secs(60 * 60)
        );
        assert_eq!(
            next_schedule_delay(&settings, date(), 720.0, 0),
            Duration::from_secs(6 * 60 * 60)
        );
    }

    #[test]
    fn deadline_advances_an_active_ramp_one_percent_at_a_time() {
        let settings = manual();
        assert_eq!(
            next_schedule_delay(&settings, date(), 450.0, 0),
            Duration::from_secs(36)
        );
        assert_eq!(
            next_schedule_delay(&settings, date(), 1110.0, 0),
            Duration::from_secs(36)
        );
    }

    #[test]
    fn overnight_deadline_advances_both_transition_ramps() {
        let mut settings = manual();
        settings.sunrise = "20:00".to_string();
        settings.sunset = "06:00".to_string();

        assert_eq!(
            next_schedule_delay(&settings, date(), 20.5 * 60.0, 0),
            Duration::from_secs(36)
        );
        assert_eq!(
            next_schedule_delay(&settings, date(), 5.5 * 60.0, 0),
            Duration::from_secs(36)
        );
    }

    #[test]
    fn disabled_schedule_only_wakes_for_the_next_date() {
        let mut settings = manual();
        settings.enabled = false;
        assert_eq!(
            next_schedule_delay(&settings, date(), 720.0, 0),
            Duration::from_secs(12 * 60 * 60)
        );
    }

    #[test]
    fn location_mode_tracks_computed_sun_times() {
        let settings = at(51.5074, -0.1278);
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
    fn selected_sydney_timezone_uses_its_date_and_offset_not_the_host_clock() {
        let settings = in_timezone("Australia/Sydney");
        let instant = Utc
            .with_ymd_and_hms(2024, 1, 15, 13, 30, 0)
            .single()
            .unwrap();

        let clock = clock_at(&settings, instant);

        assert_eq!(clock.date, NaiveDate::from_ymd_opt(2024, 1, 16).unwrap());
        assert_eq!(clock.minutes, 30.0);
        assert_eq!(clock.utc_offset_minutes, 11 * 60);
        assert_eq!(
            schedule_factor(
                &settings,
                clock.date,
                clock.minutes,
                clock.utc_offset_minutes,
            ),
            (0.0, Phase::Night)
        );
    }

    #[test]
    fn selected_sydney_timezone_wakes_at_its_dst_transition() {
        let settings = in_timezone("Australia/Sydney");
        let instant = Utc
            .with_ymd_and_hms(2024, 10, 5, 15, 30, 0)
            .single()
            .unwrap();

        assert_eq!(
            cap_at_timezone_transition(&settings, instant, Duration::from_secs(4 * 60 * 60)),
            Duration::from_secs(30 * 60)
        );
    }

    #[test]
    fn location_mode_polar_day_and_night() {
        let settings = at(78.0, 15.0);
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
        let loc = at(51.5074, -0.1278);
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
