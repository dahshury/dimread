import { describe, expect, test } from "bun:test";
import { computeBand, hexToRgb, shadeColor } from "./read-geometry";

describe("computeBand", () => {
	test("centres the band on the cursor at dpr 1", () => {
		// Window origin at y=0, cursor at 500 physical, 300px band → 350..650.
		expect(computeBand(500, 0, 1, 300)).toEqual({
			bandTop: 350,
			bandBottom: 650,
		});
	});

	test("divides physical coords by the device pixel ratio", () => {
		// At dpr 2 the same physical cursor maps to half the CSS position.
		expect(computeBand(600, 0, 2, 200)).toEqual({
			bandTop: 200, // 600/2 - 100
			bandBottom: 400, // 600/2 + 100
		});
	});

	test("subtracts a non-zero window origin (multi-monitor)", () => {
		// A monitor left of the primary has a negative virtual origin.
		expect(computeBand(-400, -1000, 1, 100)).toEqual({
			bandTop: 550, // (-400 - -1000) - 50
			bandBottom: 650,
		});
	});

	test("treats a zero/negative dpr as 1 and clamps negative heights to 0", () => {
		expect(computeBand(100, 0, 0, 0)).toEqual({
			bandTop: 100,
			bandBottom: 100,
		});
		expect(computeBand(100, 0, -3, -50)).toEqual({
			bandTop: 100,
			bandBottom: 100,
		});
	});
});

describe("hexToRgb", () => {
	test("parses #rrggbb", () => {
		expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
		expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
		expect(hexToRgb("#14b8a6")).toEqual({ r: 20, g: 184, b: 166 });
	});

	test("accepts a bare hex and is case-insensitive with surrounding space", () => {
		expect(hexToRgb("  FF8800 ")).toEqual({ r: 255, g: 136, b: 0 });
	});

	test("rejects malformed colours", () => {
		expect(hexToRgb("#fff")).toBeNull();
		expect(hexToRgb("red")).toBeNull();
		expect(hexToRgb("#gggggg")).toBeNull();
	});
});

describe("shadeColor", () => {
	test("maps transparency% to the fill alpha", () => {
		expect(shadeColor("#000000", 50)).toBe("rgba(0, 0, 0, 0.5)");
		expect(shadeColor("#14b8a6", 100)).toBe("rgba(20, 184, 166, 1)");
		expect(shadeColor("#ffffff", 0)).toBe("rgba(255, 255, 255, 0)");
	});

	test("clamps out-of-range transparency and falls back to black on bad colour", () => {
		expect(shadeColor("#000000", 250)).toBe("rgba(0, 0, 0, 1)");
		expect(shadeColor("nope", 60)).toBe("rgba(0, 0, 0, 0.6)");
	});
});
