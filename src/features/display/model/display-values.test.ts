import { describe, expect, test } from "bun:test";
import type { DisplaySettings } from "@/bindings";
import {
	ALL_MONITORS,
	BRIGHTNESS_RANGE,
	buildBrightnessPatch,
	buildKelvinPatch,
	buildMonitorEnabledPatch,
	clampBrightness,
	clampKelvin,
	countEnabledMonitors,
	defaultBrightnessFor,
	defaultKelvinFor,
	isAllMonitors,
	isMonitorEnabled,
	KELVIN_RANGE_DEFAULT,
	KELVIN_RANGE_WIDE,
	kelvinRange,
	previewMonitorId,
	readTargetPreset,
	readTargetValues,
} from "./display-values";

const MON = "\\\\.\\DISPLAY2";
const OTHER_MON = "\\\\.\\DISPLAY1";
/** An id left in settings for a display that is no longer enumerated. */
const UNPLUGGED_MON = "\\\\.\\DISPLAY9";

function makeDisplay(
	overrides: Partial<DisplaySettings> = {},
): DisplaySettings {
	return {
		mode: "office",
		wideRange: false,
		brightnessWideRange: false,
		disableOnFullscreen: true,
		smoothTransition: true,
		syncMonitors: true,
		monitorOverrides: {},
		excludedMonitors: [],
		modes: {
			office: {
				kelvinDay: 5500,
				kelvinNight: 5000,
				brightnessDay: 85,
				brightnessNight: 80,
			},
		},
		...overrides,
	};
}

describe("kelvinRange / clampKelvin", () => {
	test("default range is 1000–6500 K", () => {
		expect(kelvinRange(false)).toEqual(KELVIN_RANGE_DEFAULT);
	});

	test("wide range is 0–10000 K", () => {
		expect(kelvinRange(true)).toEqual(KELVIN_RANGE_WIDE);
	});

	test("clamps into the default range", () => {
		expect(clampKelvin(9000, false)).toBe(6500);
		expect(clampKelvin(500, false)).toBe(1000);
		expect(clampKelvin(5500, false)).toBe(5500);
	});

	test("clamps into the wide range", () => {
		expect(clampKelvin(9000, true)).toBe(9000);
		expect(clampKelvin(20_000, true)).toBe(10_000);
	});

	test("non-finite input degrades to the range floor", () => {
		expect(clampKelvin(Number.NaN, false)).toBe(1000);
	});
});

describe("clampBrightness", () => {
	test("clamps into the 10–100 % range", () => {
		expect(clampBrightness(150)).toBe(BRIGHTNESS_RANGE.max);
		expect(clampBrightness(0)).toBe(BRIGHTNESS_RANGE.min);
		expect(clampBrightness(72)).toBe(72);
	});
});

describe("monitor selection helpers", () => {
	test("isAllMonitors recognises the sentinel", () => {
		expect(isAllMonitors(ALL_MONITORS)).toBe(true);
		expect(isAllMonitors(MON)).toBe(false);
	});

	test("previewMonitorId maps the sentinel to null", () => {
		expect(previewMonitorId(ALL_MONITORS)).toBeNull();
		expect(previewMonitorId(MON)).toBe(MON);
	});
});

describe("readTargetValues", () => {
	test("reads the active mode preset for the day phase (all monitors)", () => {
		const display = makeDisplay();
		expect(readTargetValues(display, "office", ALL_MONITORS, "day")).toEqual({
			kelvin: 5500,
			brightness: 85,
		});
	});

	test("reads the active mode preset for the night phase", () => {
		const display = makeDisplay();
		expect(readTargetValues(display, "office", ALL_MONITORS, "night")).toEqual({
			kelvin: 5000,
			brightness: 80,
		});
	});

	test("falls back to the seeded default for an unknown mode", () => {
		const display = makeDisplay({ modes: {} });
		// pause default = 6500 K / 100 %
		expect(readTargetValues(display, "pause", ALL_MONITORS, "day")).toEqual({
			kelvin: 6500,
			brightness: 100,
		});
	});

	test("reads the monitor override when a specific monitor is selected", () => {
		const display = makeDisplay({
			monitorOverrides: {
				[MON]: {
					kelvinDay: 4200,
					kelvinNight: 3600,
					brightnessDay: 70,
					brightnessNight: 60,
				},
			},
		});
		expect(readTargetValues(display, "office", MON, "day")).toEqual({
			kelvin: 4200,
			brightness: 70,
		});
	});

	test("uses a neutral fallback for a monitor with no override", () => {
		const display = makeDisplay();
		expect(readTargetPreset(display, "office", MON)).toEqual({
			kelvinDay: 5500,
			kelvinNight: 5500,
			brightnessDay: 90,
			brightnessNight: 90,
		});
	});
});

describe("buildKelvinPatch", () => {
	test("updates the active mode's day Kelvin, preserving other fields", () => {
		const display = makeDisplay();
		const patch = buildKelvinPatch(
			display,
			"office",
			ALL_MONITORS,
			"day",
			4800,
		);
		expect(patch.modes?.["office"]).toEqual({
			kelvinDay: 4800,
			kelvinNight: 5000,
			brightnessDay: 85,
			brightnessNight: 80,
		});
	});

	test("updates only the night Kelvin for the night phase", () => {
		const display = makeDisplay();
		const patch = buildKelvinPatch(
			display,
			"office",
			ALL_MONITORS,
			"night",
			3200,
		);
		expect(patch.modes?.["office"]?.kelvinNight).toBe(3200);
		expect(patch.modes?.["office"]?.kelvinDay).toBe(5500);
	});

	test("preserves sibling modes in the record", () => {
		const display = makeDisplay({
			modes: {
				office: {
					kelvinDay: 5500,
					kelvinNight: 5000,
					brightnessDay: 85,
					brightnessNight: 80,
				},
				game: {
					kelvinDay: 6500,
					kelvinNight: 6000,
					brightnessDay: 90,
					brightnessNight: 90,
				},
			},
		});
		const patch = buildKelvinPatch(
			display,
			"office",
			ALL_MONITORS,
			"day",
			4800,
		);
		expect(patch.modes?.["game"]).toEqual({
			kelvinDay: 6500,
			kelvinNight: 6000,
			brightnessDay: 90,
			brightnessNight: 90,
		});
	});

	test("writes a monitor override when a monitor is selected", () => {
		const display = makeDisplay();
		const patch = buildKelvinPatch(display, "office", MON, "day", 4200);
		expect(patch.monitorOverrides?.[MON]).toEqual({
			kelvinDay: 4200,
			kelvinNight: 5500,
			brightnessDay: 90,
			brightnessNight: 90,
		});
		expect(patch.modes).toBeUndefined();
	});
});

describe("buildBrightnessPatch", () => {
	test("updates the active mode's day brightness", () => {
		const display = makeDisplay();
		const patch = buildBrightnessPatch(
			display,
			"office",
			ALL_MONITORS,
			"day",
			60,
		);
		expect(patch.modes?.["office"]?.brightnessDay).toBe(60);
		expect(patch.modes?.["office"]?.kelvinDay).toBe(5500);
	});

	test("updates a monitor override's night brightness", () => {
		const display = makeDisplay();
		const patch = buildBrightnessPatch(display, "office", MON, "night", 45);
		expect(patch.monitorOverrides?.[MON]?.brightnessNight).toBe(45);
	});
});

describe("defaultKelvinFor", () => {
	test("returns the seeded default for the mode/phase (all monitors)", () => {
		expect(defaultKelvinFor("health", ALL_MONITORS, "day")).toBe(5000);
		expect(defaultKelvinFor("health", ALL_MONITORS, "night")).toBe(3700);
	});

	test("returns the neutral default for a specific monitor", () => {
		expect(defaultKelvinFor("health", MON, "day")).toBe(5500);
	});
});

describe("defaultBrightnessFor", () => {
	test("returns the seeded default for the mode/phase (all monitors)", () => {
		expect(defaultBrightnessFor("health", ALL_MONITORS, "day")).toBe(90);
		expect(defaultBrightnessFor("health", ALL_MONITORS, "night")).toBe(80);
	});

	test("returns the neutral default for a specific monitor", () => {
		expect(defaultBrightnessFor("health", MON, "night")).toBe(90);
	});
});

describe("monitor participation", () => {
	test("a monitor with no exclusion entry participates", () => {
		expect(isMonitorEnabled(makeDisplay(), MON)).toBe(true);
	});

	test("a listed monitor is opted out", () => {
		const display = makeDisplay({ excludedMonitors: [MON] });
		expect(isMonitorEnabled(display, MON)).toBe(false);
		expect(isMonitorEnabled(display, OTHER_MON)).toBe(true);
	});

	test("opting out appends the id", () => {
		const patch = buildMonitorEnabledPatch(makeDisplay(), MON, false);
		expect(patch.excludedMonitors).toEqual([MON]);
	});

	test("opting back in removes the id, leaving other exclusions alone", () => {
		const display = makeDisplay({
			excludedMonitors: [OTHER_MON, MON],
		});
		const patch = buildMonitorEnabledPatch(display, MON, true);
		expect(patch.excludedMonitors).toEqual([OTHER_MON]);
	});

	test("opting out twice does not duplicate the id", () => {
		const display = makeDisplay({ excludedMonitors: [MON] });
		const patch = buildMonitorEnabledPatch(display, MON, false);
		expect(patch.excludedMonitors).toEqual([MON]);
	});

	test("counts only the participating monitors of the given roster", () => {
		const display = makeDisplay({ excludedMonitors: [MON, UNPLUGGED_MON] });
		// The id of an unplugged display stays in settings but is not counted:
		// the roster passed in is the enumerated hardware.
		expect(countEnabledMonitors(display, [OTHER_MON, MON])).toBe(1);
	});
});
