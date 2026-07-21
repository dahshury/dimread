/**
 * "HH:MM" clock-string helpers for the day/night sunrise/sunset inputs. The
 * `dayNight` settings store sunrise/sunset as zero-padded 24-hour strings; the
 * dialog edits them through two hour/minute steppers, so these convert between
 * the two representations and clamp out-of-range or malformed input.
 */

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

/** Parse an "HH:MM" string into clamped hour (0–23) and minute (0–59) parts. */
export function parseHm(value: string): { hours: number; minutes: number } {
	const [rawHours = "", rawMinutes = ""] = value.split(":");
	return {
		hours: clampInt(Number(rawHours), 0, 23),
		minutes: clampInt(Number(rawMinutes), 0, 59),
	};
}

/** Format clamped hour/minute parts back into a zero-padded "HH:MM" string. */
export function formatHm(hours: number, minutes: number): string {
	return `${pad2(clampInt(hours, 0, 23))}:${pad2(clampInt(minutes, 0, 59))}`;
}
