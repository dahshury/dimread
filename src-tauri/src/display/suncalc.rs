//! Sunrise / sunset computation — pure, deterministic, no network.
//!
//! A direct port of the NOAA Solar Calculator equations (the same math behind
//! <https://gml.noaa.gov/grad/solcalc/>). Given a latitude, longitude, calendar
//! date and the local UTC offset, [`sun_times`] returns the sunrise and sunset
//! **as local minutes-since-midnight** — ready to feed the day/night ramp in
//! [`super::scheduler`].
//!
//! Everything here is a pure function of its inputs: no clock, no timezone
//! database, no `AppHandle`. The caller (the scheduler) supplies the current
//! date and the DST-correct UTC offset from `chrono::Local`, which keeps this
//! module trivially unit-testable with published almanac values.
//!
//! Accuracy is ~1 minute against the NOAA calculator for mid-latitudes, which is
//! far finer than the day/night ramp needs. Polar edge cases (the sun never
//! rising or never setting) are reported explicitly rather than producing NaNs.

use chrono::{Datelike, NaiveDate};

/// Solar zenith angle (degrees) that defines "official" sunrise/sunset: 90° plus
/// ~50′ for atmospheric refraction and the sun's apparent radius.
const SUNRISE_ZENITH_DEG: f64 = 90.833;

/// The result of a sunrise/sunset computation for one location and date.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SunTimes {
    /// The sun rises and sets: both times are local minutes-since-midnight
    /// (`0.0..=1440.0`, e.g. `405.0` == 06:45 local).
    Rises {
        sunrise_minutes: f64,
        sunset_minutes: f64,
    },
    /// Polar day: the sun stays above the horizon for the whole date.
    AlwaysUp,
    /// Polar night: the sun stays below the horizon for the whole date.
    AlwaysDown,
}

/// Julian Day Number for 12:00 UT of `date` (the epoch NOAA's series expect).
///
/// Uses the standard integer Gregorian algorithm; `2000-01-01` → `2451545`
/// (J2000), so the Julian-century term below is zero at the epoch.
fn julian_day_noon(date: NaiveDate) -> f64 {
    let y = i64::from(date.year());
    let m = i64::from(date.month());
    let d = i64::from(date.day());
    let a = (14 - m) / 12;
    let yy = y + 4800 - a;
    let mm = m + 12 * a - 3;
    let jdn = d + (153 * mm + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
    jdn as f64
}

/// Compute sunrise/sunset for `latitude`/`longitude` (degrees, +N / +E) on
/// `date`, expressed in the local clock via `tz_offset_minutes` (minutes east of
/// UTC, e.g. `+60` for UTC+1 / BST, `-300` for EST).
///
/// The offset is applied verbatim, so passing the DST-correct offset for the day
/// yields DST-correct local times.
pub fn sun_times(
    latitude: f64,
    longitude: f64,
    date: NaiveDate,
    tz_offset_minutes: i32,
) -> SunTimes {
    // Julian century relative to J2000, centred on the date's noon.
    let t = (julian_day_noon(date) - 2451545.0) / 36525.0;

    // Sun geometric mean longitude and anomaly (degrees).
    let l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)).rem_euclid(360.0);
    let m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    let m_rad = m.to_radians();

    // Earth orbital eccentricity.
    let e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

    // Sun equation of centre → true longitude → apparent longitude.
    let c = m_rad.sin() * (1.914602 - t * (0.004817 + 0.000014 * t))
        + (2.0 * m_rad).sin() * (0.019993 - 0.000101 * t)
        + (3.0 * m_rad).sin() * 0.000289;
    let true_long = l0 + c;
    let omega = 125.04 - 1934.136 * t;
    let lambda = true_long - 0.00569 - 0.00478 * omega.to_radians().sin();

    // Obliquity of the ecliptic (corrected) and the sun's declination.
    let eps0 = 23.0 + (26.0 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60.0) / 60.0;
    let eps = eps0 + 0.00256 * omega.to_radians().cos();
    let eps_rad = eps.to_radians();
    let decl_rad = (eps_rad.sin() * lambda.to_radians().sin()).asin();

    // Equation of time (minutes) — the sundial-vs-clock discrepancy.
    let var_y = (eps_rad / 2.0).tan().powi(2);
    let l0_rad = l0.to_radians();
    let eot_minutes = 4.0
        * (var_y * (2.0 * l0_rad).sin() - 2.0 * e * m_rad.sin()
            + 4.0 * e * var_y * m_rad.sin() * (2.0 * l0_rad).cos()
            - 0.5 * var_y * var_y * (4.0 * l0_rad).sin()
            - 1.25 * e * e * (2.0 * m_rad).sin())
        .to_degrees();

    // Hour angle from solar noon to sunrise/sunset (degrees). Out-of-domain
    // cosine ⇒ the horizon is never crossed (polar day/night).
    let lat_rad = latitude.to_radians();
    let cos_hour_angle = SUNRISE_ZENITH_DEG.to_radians().cos() / (lat_rad.cos() * decl_rad.cos())
        - lat_rad.tan() * decl_rad.tan();
    if cos_hour_angle < -1.0 {
        return SunTimes::AlwaysUp;
    }
    if cos_hour_angle > 1.0 {
        return SunTimes::AlwaysDown;
    }
    let hour_angle_deg = cos_hour_angle.acos().to_degrees();

    // Solar noon and the symmetric sunrise/sunset, in local clock minutes
    // (4 minutes per degree of longitude / hour angle).
    let solar_noon = 720.0 - 4.0 * longitude - eot_minutes + f64::from(tz_offset_minutes);
    SunTimes::Rises {
        sunrise_minutes: solar_noon - 4.0 * hour_angle_deg,
        sunset_minutes: solar_noon + 4.0 * hour_angle_deg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("valid test date")
    }

    fn rises(result: SunTimes) -> (f64, f64) {
        match result {
            SunTimes::Rises {
                sunrise_minutes,
                sunset_minutes,
            } => (sunrise_minutes, sunset_minutes),
            other => panic!("expected the sun to rise, got {other:?}"),
        }
    }

    /// London, summer solstice. Published local times (BST, UTC+1) are sunrise
    /// 04:43 (283 min) and sunset 21:21 (1281 min).
    #[test]
    fn london_summer_solstice() {
        let (sunrise, sunset) = rises(sun_times(51.5074, -0.1278, date(2024, 6, 21), 60));
        assert!(
            (sunrise - 283.0).abs() < 8.0,
            "sunrise {sunrise} min, expected ~283 (04:43 BST)"
        );
        assert!(
            (sunset - 1281.0).abs() < 8.0,
            "sunset {sunset} min, expected ~1281 (21:21 BST)"
        );
    }

    /// The equator on the March equinox: day is almost exactly 12 h, so sunrise
    /// sits near 06:00 and sunset near 18:00 (shifted only by the equation of
    /// time + refraction), symmetric about solar noon.
    #[test]
    fn equator_equinox_is_near_twelve_hours() {
        let (sunrise, sunset) = rises(sun_times(0.0, 0.0, date(2024, 3, 20), 0));
        assert!(
            (sunrise - 360.0).abs() < 12.0,
            "sunrise {sunrise} min, expected ~360 (06:00)"
        );
        assert!(
            (sunset - 1080.0).abs() < 12.0,
            "sunset {sunset} min, expected ~1080 (18:00)"
        );
        // Refraction makes the day marginally longer than 12 h.
        let day_length = sunset - sunrise;
        assert!(
            day_length > 720.0 && day_length < 740.0,
            "day length {day_length} min, expected slightly over 720"
        );
    }

    /// A location east of the timezone meridian sees earlier clock times than
    /// one to its west, on the same date and latitude.
    #[test]
    fn eastward_longitude_advances_the_clock() {
        let west = rises(sun_times(40.0, -10.0, date(2024, 3, 20), 0));
        let east = rises(sun_times(40.0, 10.0, date(2024, 3, 20), 0));
        assert!(
            east.0 < west.0,
            "eastern sunrise {} should precede western {}",
            east.0,
            west.0
        );
        // 20° of longitude ≈ 80 minutes of clock offset.
        assert!((west.0 - east.0 - 80.0).abs() < 2.0);
    }

    /// High Arctic in midsummer: the midnight sun never sets.
    #[test]
    fn arctic_midsummer_is_polar_day() {
        assert_eq!(
            sun_times(78.0, 15.0, date(2024, 6, 21), 60),
            SunTimes::AlwaysUp
        );
    }

    /// High Arctic in midwinter: polar night, the sun never rises.
    #[test]
    fn arctic_midwinter_is_polar_night() {
        assert_eq!(
            sun_times(78.0, 15.0, date(2024, 12, 21), 60),
            SunTimes::AlwaysDown
        );
    }

    /// The timezone offset shifts the reported clock time one-for-one.
    #[test]
    fn tz_offset_shifts_times_linearly() {
        let (r0, s0) = rises(sun_times(48.0, 2.0, date(2024, 9, 1), 60));
        let (r1, s1) = rises(sun_times(48.0, 2.0, date(2024, 9, 1), 120));
        assert!((r1 - r0 - 60.0).abs() < 1e-6);
        assert!((s1 - s0 - 60.0).abs() < 1e-6);
    }

    #[test]
    fn j2000_epoch_julian_day_is_exact() {
        assert_eq!(julian_day_noon(date(2000, 1, 1)), 2451545.0);
    }
}
