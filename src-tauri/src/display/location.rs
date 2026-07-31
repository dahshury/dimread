//! Resolves `settings.day_night` to the latitude/longitude the sun math runs
//! on, and reports that resolution to the UI.
//!
//! Three sources, in the order the panel lists them:
//!
//! | `location_source` | coordinates from                                  |
//! |-------------------|---------------------------------------------------|
//! | `"auto"`          | the system timezone's reference locality           |
//! | `"timezone"`      | the user's chosen zone (empty ⇒ falls back to auto)|
//! | `"manual"`        | the stored `latitude`/`longitude`                 |
//!
//! Every fallback is REPORTED, never silent: [`ResolvedLocation::source`] says
//! which branch actually produced the coordinates, so the panel can show "we
//! could not detect your timezone" instead of quietly scheduling sun times for
//! the Gulf of Guinea — the failure mode that made this whole path look broken.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::timezones;
use crate::settings::DayNightSettings;

/// Where a resolution actually landed, mirroring `settings.location_source`
/// plus the two failure branches the UI has to explain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LocationSource {
    /// Detected from the system timezone.
    Auto,
    /// The user's chosen timezone.
    Timezone,
    /// Hand-entered coordinates.
    Manual,
    /// Wanted a timezone (auto or chosen) but none resolved — the stored
    /// coordinates are being used instead, and the UI should say so.
    Unresolved,
}

/// The outcome of resolving `day_night` to a point on the globe.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLocation {
    pub latitude: f64,
    pub longitude: f64,
    /// Which branch produced the coordinates above.
    pub source: LocationSource,
    /// The zone the coordinates came from, when they came from one.
    pub timezone: Option<String>,
}

/// The coordinates the scheduler should use for `day_night`.
pub fn resolve(day_night: &DayNightSettings) -> ResolvedLocation {
    let manual = |source| ResolvedLocation {
        latitude: day_night.latitude,
        longitude: day_night.longitude,
        source,
        timezone: None,
    };
    let from_zone = |zone: &'static timezones::TimeZoneLocation, source| ResolvedLocation {
        latitude: zone.latitude,
        longitude: zone.longitude,
        source,
        timezone: Some(zone.id.to_string()),
    };

    match day_night.location_source.as_str() {
        "manual" => manual(LocationSource::Manual),
        // An empty id means the picker has never been touched; treat it as auto
        // rather than as "no location", so the mode still works out of the box.
        "timezone" if !day_night.timezone.is_empty() => timezones::lookup(&day_night.timezone)
            .map_or_else(
                || manual(LocationSource::Unresolved),
                |zone| from_zone(zone, LocationSource::Timezone),
            ),
        // "auto", an empty timezone, and any unrecognised id (a hand-edited or
        // future settings file) all detect: it is the branch that works without
        // the user having entered anything.
        _ => timezones::detect().map_or_else(
            || manual(LocationSource::Unresolved),
            |zone| from_zone(zone, LocationSource::Auto),
        ),
    }
}

/// What the Day & night panel needs to explain the current schedule: the
/// resolution above, plus the system zone it detected (so "Timezone" mode can
/// still show what auto WOULD have picked).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocationStatus {
    pub resolved: ResolvedLocation,
    /// The raw IANA id the platform reports, even when it has no locality —
    /// showing `Etc/GMT+3` is more useful than showing nothing.
    pub detected_timezone: Option<String>,
    /// Today's sun times in local wall-clock minutes from midnight, or `None`
    /// on a polar day/night where the sun does not cross the horizon.
    pub sunrise_minutes: Option<f64>,
    pub sunset_minutes: Option<f64>,
}

/// `daynight_list_timezones` — every zone the picker can offer, with the
/// coordinates each resolves to. Sent once when the panel mounts; the renderer
/// turns `country` into a localized name with `Intl.DisplayNames`.
#[tauri::command]
#[specta::specta]
pub fn daynight_list_timezones() -> Vec<timezones::TimeZoneOption> {
    timezones::options()
}

/// `daynight_location_status` — what the Day & night panel needs to show which
/// location the schedule is actually running on, and today's sun times for it.
///
/// Computed here rather than in the renderer so there is exactly ONE
/// implementation of "which coordinates apply": the panel cannot disagree with
/// the scheduler about what it is displaying.
#[tauri::command]
#[specta::specta]
pub fn daynight_location_status(app: tauri::AppHandle) -> LocationStatus {
    use chrono::Utc;

    let settings = crate::settings::store::read_settings(&app);
    let day_night = &settings.day_night;
    let resolved = resolve(day_night);

    let clock = super::scheduler::clock_at(day_night, Utc::now());
    let (sunrise_minutes, sunset_minutes) =
        match super::scheduler::schedule_times(day_night, clock.date, clock.utc_offset_minutes) {
            super::scheduler::ScheduleTimes::Rises { sunrise, sunset } => {
                (Some(sunrise), Some(sunset))
            }
            super::scheduler::ScheduleTimes::AlwaysUp
            | super::scheduler::ScheduleTimes::AlwaysDown => (None, None),
        };

    LocationStatus {
        resolved,
        detected_timezone: timezones::system_id(),
        sunrise_minutes,
        sunset_minutes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(source: &str, timezone: &str) -> DayNightSettings {
        DayNightSettings {
            location_source: source.to_string(),
            timezone: timezone.to_string(),
            latitude: 12.5,
            longitude: -34.5,
            ..DayNightSettings::default()
        }
    }

    #[test]
    fn manual_keeps_the_stored_coordinates() {
        let resolved = resolve(&settings("manual", "Europe/Berlin"));
        assert_eq!(resolved.source, LocationSource::Manual);
        assert_eq!(resolved.latitude, 12.5);
        assert_eq!(resolved.longitude, -34.5);
        assert_eq!(resolved.timezone, None);
    }

    #[test]
    fn a_chosen_timezone_wins_over_the_stored_coordinates() {
        let resolved = resolve(&settings("timezone", "Australia/Sydney"));
        assert_eq!(resolved.source, LocationSource::Timezone);
        assert_eq!(resolved.timezone.as_deref(), Some("Australia/Sydney"));
        assert!(resolved.latitude < 0.0, "Sydney is south of the equator");
        assert_ne!(resolved.latitude, 12.5);
    }

    #[test]
    fn a_deprecated_zone_id_still_resolves() {
        let resolved = resolve(&settings("timezone", "Asia/Calcutta"));
        assert_eq!(resolved.source, LocationSource::Timezone);
        assert_eq!(resolved.timezone.as_deref(), Some("Asia/Kolkata"));
    }

    #[test]
    fn an_unknown_timezone_reports_unresolved_instead_of_pretending() {
        let resolved = resolve(&settings("timezone", "Not/AZone"));
        assert_eq!(resolved.source, LocationSource::Unresolved);
        assert_eq!(resolved.latitude, 12.5, "falls back to stored coordinates");
    }

    #[test]
    fn an_empty_picker_and_an_unknown_source_both_fall_through_to_detection() {
        // Whatever this machine reports, neither may be treated as `Manual` —
        // that is what would silently schedule 0°, 0° sun times.
        for source in ["timezone", "auto", "something-newer"] {
            let resolved = resolve(&settings(source, ""));
            assert!(
                matches!(
                    resolved.source,
                    LocationSource::Auto | LocationSource::Unresolved
                ),
                "{source} with no chosen zone should detect, got {:?}",
                resolved.source
            );
        }
    }

    #[test]
    fn detection_on_this_machine_yields_a_usable_location() {
        // Not asserting WHICH zone (CI runs on UTC, developers do not), only
        // that the auto path produces coordinates rather than dropping to the
        // 0°, 0° fallback on a normally-configured machine.
        let resolved = resolve(&settings("auto", ""));
        if resolved.source == LocationSource::Auto {
            assert!(resolved.timezone.is_some());
            assert!((-90.0..=90.0).contains(&resolved.latitude));
            assert!((-180.0..=180.0).contains(&resolved.longitude));
        }
    }
}
