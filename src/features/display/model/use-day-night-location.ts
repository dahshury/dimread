import { useEffect, useState } from "react";
import { commands, type LocationStatus, type TimeZoneOption } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";
import { useSettingsStore } from "@/entities/setting";

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
	/** Null until the first snapshot lands (and in a non-native preview). */
	status: LocationStatus | null;
	/** Every zone the picker can offer. Empty until loaded. */
	timezones: TimeZoneOption[];
}

export function useDayNightLocation(): DayNightLocation {
	const dayNight = useSettingsStore((s) => s.settings.dayNight);
	const [status, setStatus] = useState<LocationStatus | null>(null);
	const [timezones, setTimezones] = useState<TimeZoneOption[]>([]);

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
				}
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
		};
	}, []);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		void commands
			.daynightLocationStatus()
			.then((next) => {
				if (!disposed) {
					setStatus(next);
				}
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
		};
	}, [dayNight]);

	return { status, timezones };
}
