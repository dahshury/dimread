import type { DisplayOutput, DisplaySettings, ModePreset } from "@/bindings";
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
export const KELVIN_RANGE_WIDE = { min: 1000, max: 10_000 } as const;
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

/**
 * Ramp position at which the day endpoint takes over from the night one as the
 * endpoint a manual edit should land on. Mirrors `scheduler::dominant_endpoint`
 * in `src-tauri/src/display/scheduler.rs` — the hotkey steppers apply the same
 * rule, and the two surfaces must not disagree about which value they edit.
 */
const DOMINANT_ENDPOINT_SPLIT = 0.5;

/**
 * The day/night endpoint a slider edit should land on for the engine's live
 * output.
 *
 * Mid-ramp there is no "current value" to edit — the engine applies
 * `lerp(night, day, factor)` — so an edit has to pick an endpoint, and the
 * choice is load-bearing rather than cosmetic. Editing the endpoint that is
 * fading OUT weights the edit by whatever is left of it: at `factor = 0.05` a
 * full-range brightness drag moves the screen by five percentage points, which
 * reads as a slider stuck well above its own minimum. An hour later the ramp
 * ends, the endpoint applies 1:1, and the same slider works — the "it fixed
 * itself" report this rule exists to prevent.
 *
 * Picking the DOMINANT endpoint bounds that weight at >= 0.5, so a drag always
 * has at least half the authority over what is on screen.
 */
export function editPhaseFor(state: DisplayOutput | null): EditPhase {
	if (!state) {
		return "day";
	}
	if (state.phase === "transition") {
		return state.factor >= DOMINANT_ENDPOINT_SPLIT ? "day" : "night";
	}
	return state.phase === "night" ? "night" : "day";
}

/** True while the schedule is ramping between the two endpoints, so the applied
 *  output is a blend rather than either stored profile. */
export function isRampingPhase(state: DisplayOutput | null): boolean {
	return state?.phase === "transition";
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

/**
 * Read a monitor's stored override, inheriting the active mode until the first
 * override is written.
 *
 * The engine has the same fallback: switching to per-monitor control must be a
 * no-op until the user actually moves a slider. Seeding from the active mode
 * here also means that first edit changes only its named endpoint instead of
 * silently replacing the other three endpoints with a neutral preset.
 */
function readMonitorOverride(
	display: DisplaySettings,
	mode: string,
	monitorId: string,
): ModePreset {
	return display.monitorOverrides[monitorId] ?? readModePreset(display, mode);
}

/** The preset the current selection edits (mode preset or monitor override). */
export function readTargetPreset(
	display: DisplaySettings,
	mode: string,
	selection: MonitorSelection,
): ModePreset {
	return isAllMonitors(selection)
		? readModePreset(display, mode)
		: readMonitorOverride(display, mode, selection);
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
		readMonitorOverride(display, mode, selection),
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
		readMonitorOverride(display, mode, selection),
		phase,
		brightness,
	);
	return {
		monitorOverrides: { ...display.monitorOverrides, [selection]: next },
	};
}

/**
 * True when a monitor participates in filtering at all.
 *
 * Separate axis from {@link readTargetPreset}: that answers "which values does
 * this display get", this answers "does it get any". A monitor with no entry in
 * `excludedMonitors` participates, so the default (empty list) filters
 * everything — the behaviour before per-monitor opt-out existed.
 */
export function isMonitorEnabled(
	display: DisplaySettings,
	monitorId: string,
): boolean {
	return !display.excludedMonitors.includes(monitorId);
}

/** How many of `monitorIds` currently participate in filtering. */
export function countEnabledMonitors(
	display: DisplaySettings,
	monitorIds: readonly string[],
): number {
	return monitorIds.filter((id) => isMonitorEnabled(display, id)).length;
}

/** Build the `display` patch that opts `monitorId` in or out of filtering. */
export function buildMonitorEnabledPatch(
	display: DisplaySettings,
	monitorId: string,
	enabled: boolean,
): Partial<DisplaySettings> {
	const without = display.excludedMonitors.filter((id) => id !== monitorId);
	return {
		excludedMonitors: enabled ? without : [...without, monitorId],
	};
}

/**
 * Build the patch that removes a monitor override, returning it to the active
 * mode's values. Other monitors' overrides are preserved verbatim.
 */
export function buildMonitorInheritPatch(
	display: DisplaySettings,
	monitorId: string,
): Partial<DisplaySettings> {
	const monitorOverrides = { ...display.monitorOverrides };
	delete monitorOverrides[monitorId];
	return { monitorOverrides };
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

/** The default brightness the reset button restores for the selection/phase. */
export function defaultBrightnessFor(
	mode: string,
	selection: MonitorSelection,
	phase: EditPhase,
): number {
	const preset = isAllMonitors(selection)
		? (DEFAULT_MODES[mode] ?? FALLBACK_PRESET)
		: FALLBACK_PRESET;
	return phase === "night" ? preset.brightnessNight : preset.brightnessDay;
}
