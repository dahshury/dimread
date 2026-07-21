import { describe, expect, test } from "bun:test";
import {
	clampHeight,
	clampTransparency,
	HEIGHT_MAX,
	HEIGHT_MIN,
	TRANSPARENCY_MAX,
	TRANSPARENCY_MIN,
} from "./read-values";

describe("clampTransparency", () => {
	test("passes in-range values through, rounding to an integer", () => {
		expect(clampTransparency(50)).toBe(50);
		expect(clampTransparency(66.4)).toBe(66);
	});

	test("clamps to 0..=100", () => {
		expect(clampTransparency(-10)).toBe(TRANSPARENCY_MIN);
		expect(clampTransparency(250)).toBe(TRANSPARENCY_MAX);
	});

	test("falls back to the default on a non-finite value", () => {
		expect(clampTransparency(Number.NaN)).toBe(50);
	});
});

describe("clampHeight", () => {
	test("passes in-range values through, rounding to an integer", () => {
		expect(clampHeight(300)).toBe(300);
		expect(clampHeight(301.7)).toBe(302);
	});

	test("clamps to 20..=4000", () => {
		expect(clampHeight(0)).toBe(HEIGHT_MIN);
		expect(clampHeight(9000)).toBe(HEIGHT_MAX);
	});

	test("falls back to the default on a non-finite value", () => {
		expect(clampHeight(Number.POSITIVE_INFINITY)).toBe(300);
	});
});
