//! System-timezone → approximate location, the offline backing for
//! "time based on location".
//!
//! ## Why the timezone and not a geolocation API
//!
//! Sun times need a latitude/longitude. Asking the user to type coordinates is
//! what made the old panel useless — a fresh install sat at 0°, 0° (the Gulf of
//! Guinea), so "time based on location" produced a 06:00/18:00 equatorial day
//! for everybody. The three ways to get real coordinates are:
//!
//! 1. A platform geolocation service — needs a permission prompt, is disabled by
//!    default on most Windows installs, and returns nothing on a desktop with no
//!    radios.
//! 2. An IP lookup — needs the network, and sends the user's address to a third
//!    party. DimRead's sun math is deliberately offline (see [`super::suncalc`]).
//! 3. The system timezone. Always set, needs no permission, no network, and no
//!    prompt.
//!
//! (3) wins. A timezone's reference locality is by construction the place its
//! civil clock is set for, and sunrise shifts only ~4 minutes per degree of
//! longitude — so "Europe/Berlin" gives sun times good to a few minutes for
//! anyone in Germany. That is well inside the accuracy a screen-tint schedule
//! needs, and the same table backs the manual timezone picker for anyone whose
//! machine reports the wrong zone (or who wants a different one).
//!
//! The table itself is generated — see `tools/timezones/generate-timezones.py`.

use chrono::{DateTime, NaiveDate, Offset, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

use super::timezones_data::{ALIASES, ZONES};

/// One IANA zone's reference locality.
pub struct TimeZoneLocation {
    /// IANA zone id, e.g. `"Europe/Berlin"`.
    pub id: &'static str,
    /// ISO 3166-1 alpha-2 country code, e.g. `"DE"`. The renderer turns this
    /// into a localized country name with `Intl.DisplayNames`, so no country
    /// name table is duplicated here.
    pub country: &'static str,
    pub latitude: f64,
    pub longitude: f64,
}

/// A selectable timezone, as sent to the picker.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimeZoneOption {
    pub id: String,
    pub country: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// Local civil-time components for a UTC instant in one IANA timezone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ZonedTime {
    pub date: NaiveDate,
    pub minutes: f64,
    pub utc_offset_minutes: i32,
}

/// Every zone DimRead can resolve to coordinates, sorted by id.
pub fn options() -> Vec<TimeZoneOption> {
    ZONES
        .iter()
        .map(|zone| TimeZoneOption {
            id: zone.id.to_string(),
            country: zone.country.to_string(),
            latitude: zone.latitude,
            longitude: zone.longitude,
        })
        .collect()
}

/// Coordinates for an IANA zone id, resolving deprecated ids through
/// [`ALIASES`] first. `None` when the id is not one the tzdb gives a locality
/// for (`Etc/GMT+5`, `UTC`, a typo in a hand-edited settings file).
pub fn lookup(id: &str) -> Option<&'static TimeZoneLocation> {
    canonical(id).and_then(|id| {
        ZONES
            .binary_search_by(|zone| zone.id.cmp(id))
            .ok()
            .map(|index| &ZONES[index])
    })
}

/// Resolve a possibly-deprecated zone id to the canonical one `zone.tab` lists.
/// Ids already canonical pass through; unknown ids resolve to themselves and
/// simply miss in [`lookup`].
fn canonical(id: &str) -> Option<&str> {
    match ALIASES.binary_search_by(|(alias, _)| (*alias).cmp(id)) {
        Ok(index) => Some(ALIASES[index].1),
        Err(_) => Some(id),
    }
}

/// Convert an absolute instant to the civil date, time, and UTC offset in an
/// IANA timezone. The bundled tzdb applies the zone's historical and future
/// daylight-saving transitions; the host timezone is not consulted.
pub(crate) fn time_at(id: &str, instant: DateTime<Utc>) -> Option<ZonedTime> {
    let timezone = canonical(id)?.parse::<Tz>().ok()?;
    let local = instant.with_timezone(&timezone);
    Some(ZonedTime {
        date: local.date_naive(),
        minutes: f64::from(local.hour()) * 60.0
            + f64::from(local.minute())
            + f64::from(local.second()) / 60.0
            + f64::from(local.nanosecond()) / 60_000_000_000.0,
        utc_offset_minutes: local.offset().fix().local_minus_utc() / 60,
    })
}

/// Find the first UTC-offset transition after `instant`, bounded by `within`.
///
/// `chrono-tz` exposes offset lookup rather than a public transition iterator,
/// so the bounded horizon is sampled hourly and the first changed interval is
/// binary-searched to the transition second. Runtime horizons never exceed the
/// scheduler's next wall-clock deadline (at most the next local midnight), and
/// tzdb offset transitions are separated by far more than one hour.
pub(crate) fn next_offset_change(
    id: &str,
    instant: DateTime<Utc>,
    within: Duration,
) -> Option<Duration> {
    let timezone = canonical(id)?.parse::<Tz>().ok()?;
    let horizon = instant + chrono::Duration::from_std(within).ok()?;
    let initial_offset = offset_seconds(timezone, instant);
    let mut lower = instant;

    while lower < horizon {
        let upper = (lower + chrono::Duration::hours(1)).min(horizon);
        if offset_seconds(timezone, upper) != initial_offset {
            let mut lower_second = lower.timestamp();
            let mut upper_second = upper.timestamp();
            while upper_second - lower_second > 1 {
                let midpoint = lower_second + (upper_second - lower_second) / 2;
                let midpoint = DateTime::from_timestamp(midpoint, 0)?;
                if offset_seconds(timezone, midpoint) == initial_offset {
                    lower_second = midpoint.timestamp();
                } else {
                    upper_second = midpoint.timestamp();
                }
            }

            let transition = DateTime::from_timestamp(upper_second, 0)?;
            return (transition - instant).to_std().ok();
        }
        lower = upper;
    }

    None
}

fn offset_seconds(timezone: Tz, instant: DateTime<Utc>) -> i32 {
    instant
        .with_timezone(&timezone)
        .offset()
        .fix()
        .local_minus_utc()
}

/// The IANA zone id this machine is configured for, whatever the platform calls
/// it internally (Windows registry key → CLDR mapping, `/etc/localtime` on
/// Unix, `CFTimeZone` on macOS).
///
/// `None` when the platform cannot report one — never a guess, because a wrong
/// location is worse than a visibly unset one: the panel can say "couldn't
/// detect, pick a timezone", whereas silently defaulting to some zone would
/// leave the user staring at sun times that are simply wrong.
pub fn system_id() -> Option<String> {
    match iana_time_zone::get_timezone() {
        Ok(id) => Some(id),
        Err(err) => {
            log::warn!("[timezones] could not read the system timezone: {err}");
            None
        }
    }
}

/// The system zone, resolved against the table. `None` when detection failed OR
/// when the reported zone has no locality (see [`lookup`]).
pub fn detect() -> Option<&'static TimeZoneLocation> {
    lookup(&system_id()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn the_generated_table_covers_the_world() {
        assert!(
            ZONES.len() > 300,
            "only {} zones — did the generator run against a truncated zone.tab?",
            ZONES.len()
        );
    }

    #[test]
    fn the_table_is_sorted_so_lookup_can_binary_search() {
        for pair in ZONES.windows(2) {
            assert!(
                pair[0].id < pair[1].id,
                "{} is not before {}",
                pair[0].id,
                pair[1].id
            );
        }
    }

    #[test]
    fn coordinates_are_plausible() {
        for zone in &ZONES {
            assert!(
                (-90.0..=90.0).contains(&zone.latitude),
                "{} has latitude {}",
                zone.id,
                zone.latitude
            );
            assert!(
                (-180.0..=180.0).contains(&zone.longitude),
                "{} has longitude {}",
                zone.id,
                zone.longitude
            );
            assert_eq!(zone.country.len(), 2, "{} has a bad country code", zone.id);
        }
    }

    #[test]
    fn lookup_finds_known_zones_and_rejects_unknown_ones() {
        let berlin = lookup("Europe/Berlin").expect("Europe/Berlin is in the tzdb");
        assert!((berlin.latitude - 52.5).abs() < 1.0);
        assert!((berlin.longitude - 13.4).abs() < 1.0);
        assert_eq!(berlin.country, "DE");

        // The southern hemisphere has to come out negative, or every sun time
        // below the equator is inverted by six months.
        let sydney = lookup("Australia/Sydney").expect("Australia/Sydney is in the tzdb");
        assert!(
            sydney.latitude < 0.0,
            "Sydney should be south of the equator"
        );
        assert!(sydney.longitude > 0.0, "Sydney should be east of Greenwich");

        // Western longitudes likewise.
        let ny = lookup("America/New_York").expect("America/New_York is in the tzdb");
        assert!(ny.longitude < 0.0, "New York should be west of Greenwich");

        assert!(lookup("Etc/GMT+5").is_none());
        assert!(lookup("Not/AZone").is_none());
    }

    #[test]
    fn the_alias_table_is_sorted_and_every_entry_resolves() {
        for pair in ALIASES.windows(2) {
            assert!(
                pair[0].0 < pair[1].0,
                "{} is not before {}",
                pair[0].0,
                pair[1].0
            );
        }
        for (alias, target) in &ALIASES {
            assert!(
                lookup(target).is_some(),
                "alias {alias} points at {target}, which has no locality"
            );
        }
    }

    #[test]
    fn deprecated_ids_platforms_still_report_are_resolvable() {
        // The Windows→IANA (CLDR) mapping hands back tzdb "backward" links —
        // an Indian machine reports `Asia/Calcutta`, which modern `zone.tab`
        // does not list at all. Without alias resolution those users would fall
        // back to 0°, 0°, which is the exact bug this module exists to fix.
        let kolkata = lookup("Asia/Kolkata").expect("canonical id resolves");
        let calcutta = lookup("Asia/Calcutta").expect("deprecated id resolves");
        assert_eq!(calcutta.id, kolkata.id);

        for id in ["Asia/Saigon", "America/Buenos_Aires", "Europe/Kiev"] {
            assert!(lookup(id).is_some(), "{id} should resolve to a locality");
        }
    }

    #[test]
    fn sydney_time_uses_its_local_date_and_summer_offset() {
        let instant = Utc
            .with_ymd_and_hms(2024, 1, 15, 13, 30, 0)
            .single()
            .unwrap();
        let local = time_at("Australia/Sydney", instant).unwrap();

        assert_eq!(local.date, NaiveDate::from_ymd_opt(2024, 1, 16).unwrap());
        assert_eq!(local.minutes, 30.0);
        assert_eq!(local.utc_offset_minutes, 11 * 60);
    }

    #[test]
    fn sydney_time_applies_dst_for_the_instant() {
        let summer = Utc
            .with_ymd_and_hms(2024, 1, 15, 13, 30, 0)
            .single()
            .unwrap();
        let winter = Utc
            .with_ymd_and_hms(2024, 7, 15, 14, 30, 0)
            .single()
            .unwrap();

        assert_eq!(
            time_at("Australia/Sydney", summer)
                .unwrap()
                .utc_offset_minutes,
            11 * 60
        );
        assert_eq!(
            time_at("Australia/Sydney", winter)
                .unwrap()
                .utc_offset_minutes,
            10 * 60
        );
    }

    #[test]
    fn sydney_next_offset_change_finds_the_spring_dst_transition() {
        let instant = Utc
            .with_ymd_and_hms(2024, 10, 5, 15, 30, 0)
            .single()
            .unwrap();

        assert_eq!(
            next_offset_change(
                "Australia/Sydney",
                instant,
                Duration::from_secs(4 * 60 * 60)
            ),
            Some(Duration::from_secs(30 * 60))
        );
    }
}
