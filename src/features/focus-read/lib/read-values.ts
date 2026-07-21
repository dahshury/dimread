/**
 * Focus Read value bounds + clamps (FEATURE-PARITY F8.1), mirroring the Rust
 * `normalize_settings` clamps for the `focusRead` section so the UI can never
 * post a value the backend would silently trim. Pure + unit-tested.
 */

/** Shade opacity is a percentage. */
export const TRANSPARENCY_MIN = 0;
export const TRANSPARENCY_MAX = 100;
/** Clear-band height (px). Matches the Rust `focus_read.height` clamp (20..=4000). */
export const HEIGHT_MIN = 20;
export const HEIGHT_MAX = 4000;
/** Number-stepper increment for the band height. */
export const HEIGHT_STEP = 10;

/** Fallback shade opacity when a stored value is non-finite. */
const DEFAULT_TRANSPARENCY = 50;
/** Fallback band height when a stored value is non-finite. */
const DEFAULT_HEIGHT = 300;

function clampInt(
	value: number,
	min: number,
	max: number,
	fallback: number,
): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.round(Math.min(max, Math.max(min, value)));
}

/** Clamp a shade opacity into `0..=100`. */
export function clampTransparency(value: number): number {
	return clampInt(
		value,
		TRANSPARENCY_MIN,
		TRANSPARENCY_MAX,
		DEFAULT_TRANSPARENCY,
	);
}

/** Clamp a band height into `20..=4000` px. */
export function clampHeight(value: number): number {
	return clampInt(value, HEIGHT_MIN, HEIGHT_MAX, DEFAULT_HEIGHT);
}
