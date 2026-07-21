import { describe, expect, it } from "bun:test";
import {
	clampDelay,
	clampOffset,
	DEFAULT_TOOLBAR_COLOR,
	isValidHexColor,
	safeToolbarColor,
} from "./toolbar-options";
import {
	cleared,
	INITIAL_TOOLBAR_STATE,
	isEffectActive,
	onHide,
	onShow,
	toggleDark,
	toggleGray,
} from "./toolbar-state";

describe("toolbar-state", () => {
	it("shows with the target effect flags", () => {
		expect(onShow(true, false)).toEqual({
			visible: true,
			dark: true,
			gray: false,
		});
	});

	it("hides but keeps the last flags for the fade-out", () => {
		const shown = onShow(true, true);
		// `visible` flips to false; the dark/gray flags stay for the exit frame.
		expect(onHide(shown)).toEqual({ visible: false, dark: true, gray: true });
	});

	it("toggles each effect independently and optimistically", () => {
		let state = INITIAL_TOOLBAR_STATE;
		state = onShow(false, false);
		state = toggleDark(state);
		expect(state).toEqual({ visible: true, dark: true, gray: false });
		state = toggleGray(state);
		expect(state).toEqual({ visible: true, dark: true, gray: true });
		state = toggleDark(state);
		expect(state).toEqual({ visible: true, dark: false, gray: true });
	});

	it("clear keeps the toolbar visible but drops both effects", () => {
		const state = cleared(onShow(true, true));
		expect(state).toEqual({ visible: true, dark: false, gray: false });
	});

	it("reports whether any effect is active (Close visibility)", () => {
		expect(isEffectActive(onShow(false, false))).toBe(false);
		expect(isEffectActive(onShow(true, false))).toBe(true);
		expect(isEffectActive(onShow(false, true))).toBe(true);
	});
});

describe("toolbar-options", () => {
	it("clamps the offset into range and rounds", () => {
		expect(clampOffset(9999)).toBe(200);
		expect(clampOffset(-9999)).toBe(-200);
		expect(clampOffset(12.6)).toBe(13);
		expect(clampOffset(Number.NaN)).toBe(0);
	});

	it("clamps the delay into range", () => {
		expect(clampDelay(-100)).toBe(0);
		expect(clampDelay(5000)).toBe(2000);
		expect(clampDelay(400)).toBe(400);
		expect(clampDelay(Number.NaN)).toBe(0);
	});

	it("validates and coerces hex colours", () => {
		expect(isValidHexColor("#14b8a6")).toBe(true);
		expect(isValidHexColor("#FFF")).toBe(false);
		expect(isValidHexColor("teal")).toBe(false);
		expect(safeToolbarColor("#000000")).toBe("#000000");
		expect(safeToolbarColor("nope")).toBe(DEFAULT_TOOLBAR_COLOR);
	});
});
