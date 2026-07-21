import type { DisplaySettings, ModePreset } from "@/bindings";
import { DEFAULT_MODES } from "@/shared/config/settings-schema";

/**
 * Pure value-mapping + patch-building logic for the Display tab.
 *
 * The Display panel drives colour-temperature / brightness through two axes:
 *
 *  - **which phase** the user is editing (`day` | `night`, chosen by the
 *    Day/Night segmented control), and
 *  - **which monitor** the edit targets — either every monitor (the active
 *    mode's preset, {@link ALL_MONITORS}) or one specific monitor (its
 *    per-monitor override).
 *
 * Every function here is pure so the mapping and the resulting settings patch
 * can be unit-tested without a running backend.
 */

/** Which day/night phase a slider edit lands on. */
export type EditPhase = "day" | "night";

/** Sentinel monitor selection meaning "apply to every monitor" (the active
 *  mode's preset), as opposed to a concrete GDI device-name id. */
export const ALL_MONITORS = "all";

/** A monitor-strip selection: {@link ALL_MONITORS} or a monitor id. */
export type MonitorSelection = string;

/** Default colour-temperature bounds (Kelvin). */
export const KELVIN_RANGE_DEFAULT = { min: 1000, max: 6500 } as const;
/** Widened colour-temperature bounds when `display.wideRange` is on. */
export const KELVIN_RANGE_WIDE = { min: 0, max: 10_000 } as const;
/** Slider granularity for colour temperature. */
export const KELVIN_STEP = 50;

/** Brightness percentage bounds (gamma dim floor at 10 % to avoid a black screen). */
export const BRIGHTNESS_RANGE = { min: 10, max: 100 } as const;
/** Widened brightness bounds when `display.brightnessWideRange` is on — down to
 *  0 % (fully black), per FEATURE-PARITY F2.2. */
export const BRIGHTNESS_RANGE_WIDE = { min: 0, max: 100 } as const;
/** Slider granularity for brightness (1 % precision, per parity F2.1). */
export const BRIGHTNESS_STEP = 1;

/** Neutral fallback preset for a monitor override with no stored value yet. */
const FALLBACK_PRESET: ModePreset = {
	kelvinDay: 5500,
	kelvinNight: 5500,
	brightnessDay: 90,
	brightnessNight: 90,
};

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.max(min, Math.min(max, value));
}

/** The active colour-temperature bounds for the current wide-range setting. */
export function kelvinRange(wideRange: boolean): { max: number; min: number } {
	return wideRange ? KELVIN_RANGE_WIDE : KELVIN_RANGE_DEFAULT;
}

/** Clamp a Kelvin value into the active range. */
export function clampKelvin(value: number, wideRange: boolean): number {
	const { min, max } = kelvinRange(wideRange);
	return clamp(value, min, max);
}

/** The active brightness bounds for the current wide-range setting. */
export function brightnessRange(wideRange: boolean): {
	max: number;
	min: number;
} {
	return wideRange ? BRIGHTNESS_RANGE_WIDE : BRIGHTNESS_RANGE;
}

/** Clamp a brightness percentage into the active range (`[10, 100]`, or
 *  `[0, 100]` when the brightness wide range is enabled). */
export function clampBrightness(value: number, wideRange = false): number {
	const { min, max } = brightnessRange(wideRange);
	return clamp(value, min, max);
}

/** True when the selection targets every monitor (the mode preset). */
export function isAllMonitors(selection: MonitorSelection): boolean {
	return selection === ALL_MONITORS;
}

/** The monitor id to hand `display_preview` (`null` = every monitor). */
export function previewMonitorId(selection: MonitorSelection): string | null {
	return isAllMonitors(selection) ? null : selection;
}

function withKelvin(
	preset: ModePreset,
	phase: EditPhase,
	value: number,
): ModePreset {
	return phase === "night"
		? { ...preset, kelvinNight: value }
		: { ...preset, kelvinDay: value };
}

function withBrightness(
	preset: ModePreset,
	phase: EditPhase,
	value: number,
): ModePreset {
	return phase === "night"
		? { ...preset, brightnessNight: value }
		: { ...preset, brightnessDay: value };
}

/** Read the active mode's stored preset, healing to the seeded default. */
function readModePreset(display: DisplaySettings, mode: string): ModePreset {
	return display.modes[mode] ?? DEFAULT_MODES[mode] ?? FALLBACK_PRESET;
}

/** Read a monitor's stored override, healing to a neutral default. */
function readMonitorOverride(
	display: DisplaySettings,
	monitorId: string,
): ModePreset {
	return display.monitorOverrides[monitorId] ?? FALLBACK_PRESET;
}

/** The preset the current selection edits (mode preset or monitor override). */
export function readTargetPreset(
	display: DisplaySettings,
	mode: string,
	selection: MonitorSelection,
): ModePreset {
	return isAllMonitors(selection)
		? readModePreset(display, mode)
		: readMonitorOverride(display, selection);
}

/** The Kelvin + brightness the sliders should show for the given selection/phase. */
export function readTargetValues(
	display: DisplaySettings,
	mode: string,
	selection: MonitorSelection,
	phase: EditPhase,
): { brightness: number; kelvin: number } {
	const preset = readTargetPreset(display, mode, selection);
	return phase === "night"
		? { kelvin: preset.kelvinNight, brightness: preset.brightnessNight }
		: { kelvin: preset.kelvinDay, brightness: preset.brightnessDay };
}

/** Build the `display` patch that writes `kelvin` to the selection/phase. */
export function buildKelvinPatch(
	display: DisplaySettings,
	mode: string,
	selection: MonitorSelection,
	phase: EditPhase,
	kelvin: number,
): Partial<DisplaySettings> {
	if (isAllMonitors(selection)) {
		const next = withKelvin(readModePreset(display, mode), phase, kelvin);
		return { modes: { ...display.modes, [mode]: next } };
	}
	const next = withKelvin(
		readMonitorOverride(display, selection),
		phase,
		kelvin,
	);
	return {
		monitorOverrides: { ...display.monitorOverrides, [selection]: next },
	};
}

/** Build the `display` patch that writes `brightness` to the selection/phase. */
export function buildBrightnessPatch(
	display: DisplaySettings,
	mode: string,
	selection: MonitorSelection,
	phase: EditPhase,
	brightness: number,
): Partial<DisplaySettings> {
	if (isAllMonitors(selection)) {
		const next = withBrightness(
			readModePreset(display, mode),
			phase,
			brightness,
		);
		return { modes: { ...display.modes, [mode]: next } };
	}
	const next = withBrightness(
		readMonitorOverride(display, selection),
		phase,
		brightness,
	);
	return {
		monitorOverrides: { ...display.monitorOverrides, [selection]: next },
	};
}

/** The default Kelvin the reset button restores for the selection/phase. */
export function defaultKelvinFor(
	mode: string,
	selection: MonitorSelection,
	phase: EditPhase,
): number {
	const preset = isAllMonitors(selection)
		? (DEFAULT_MODES[mode] ?? FALLBACK_PRESET)
		: FALLBACK_PRESET;
	return phase === "night" ? preset.kelvinNight : preset.kelvinDay;
}
