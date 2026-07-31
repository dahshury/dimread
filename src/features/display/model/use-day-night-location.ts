import { useCallback, useEffect, useState } from "react";
import { commands, type LocationStatus, type TimeZoneOption } from "@/bindings";
import { flushPendingSettings, useSettingsStore } from "@/entities/setting";
import { hasNativeRuntime } from "@/shared/api";

/**
 * The day/night schedule's LOCATION, read from the engine rather than recomputed
 * here.
 *
 * `day_night` can arrive at coordinates three ways (the detected system
 * timezone, a chosen one, or a stored pair) and each has a failure branch. The
 * backend owns that resolution — see `src-tauri/src/display/location.rs` — so
 * the panel shows what the scheduler is ACTUALLY using instead of a second
 * implementation that can disagree with it. The same call returns today's sun
 * times, which is the only way a user can tell at a glance that the location is
 * right.
 *
 * Re-read whenever the `dayNight` settings section changes, because every field
 * in it can move the answer.
 */
export interface DayNightLocation {
	/** True when the latest location-status request failed. */
	locationLoadError: boolean;
	/** Re-run the location-status request after a failure. */
	retryLocation: () => void;
	/** Re-run the timezone-roster request after a failure. */
	retryTimezones: () => void;
	/** Null until the first snapshot lands (and in a non-native preview). */
	status: LocationStatus | null;
	/** Every zone the picker can offer. Empty until loaded. */
	timezones: TimeZoneOption[];
	/** True when the latest timezone-roster request failed. */
	timezonesLoadError: boolean;
}

export function useDayNightLocation(): DayNightLocation {
	const dayNight = useSettingsStore((s) => s.settings.dayNight);
	// Settings normalization may rebuild section objects when an unrelated
	// section changes. Depend on the actual schedule values so a Focus/Hotkey
	// edit cannot cancel an in-flight location request and silently replace it
	// with a second request.
	const locationSettingsKey = [
		dayNight.enabled,
		dayNight.useLocation,
		dayNight.locationSource,
		dayNight.timezone,
		dayNight.latitude,
		dayNight.longitude,
		dayNight.sunrise,
		dayNight.sunset,
		dayNight.transitionMinutes,
	].join("\u0000");
	const [status, setStatus] = useState<LocationStatus | null>(null);
	const [timezones, setTimezones] = useState<TimeZoneOption[]>([]);
	const [locationLoadError, setLocationLoadError] = useState(false);
	const [timezonesLoadError, setTimezonesLoadError] = useState(false);
	const [locationRequest, setLocationRequest] = useState(0);
	const [timezonesRequest, setTimezonesRequest] = useState(0);

	const retryLocation = useCallback(() => {
		setLocationLoadError(false);
		setLocationRequest((request) => request + 1);
	}, []);
	const retryTimezones = useCallback(() => {
		setTimezonesLoadError(false);
		setTimezonesRequest((request) => request + 1);
	}, []);

	// The roster is a build-time constant on the backend, so it is fetched once
	// rather than on every settings change.
	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		void commands
			.daynightListTimezones()
			.then((list) => {
				if (!disposed) {
					setTimezones(list);
					setTimezonesLoadError(false);
				}
			})
			.catch(() => {
				if (!disposed) {
					setTimezonesLoadError(true);
				}
			});
		return () => {
			disposed = true;
		};
	}, [timezonesRequest]);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		// Settings edits are optimistic and debounced. Querying the backend on the
		// same render would resolve the PRE-edit location and the authoritative
		// save echo would not retrigger this effect (its scalar key is identical).
		// Flush first so the readout always describes the schedule just selected.
		void flushPendingSettings()
			.then(() => commands.daynightLocationStatus())
			.then((next) => {
				if (!disposed) {
					setStatus(next);
					setLocationLoadError(false);
				}
			})
			.catch(() => {
				if (!disposed) {
					setLocationLoadError(true);
				}
			});
		return () => {
			disposed = true;
		};
	}, [locationSettingsKey, locationRequest]);

	return {
		locationLoadError,
		retryLocation,
		retryTimezones,
		status,
		timezones,
		timezonesLoadError,
	};
}
