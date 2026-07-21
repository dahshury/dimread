import { describe, expect, test } from "bun:test";
import {
	type BlurViewport,
	computeBlurLayout,
	shadeColorRgba,
} from "./blur-geometry";

const VIEWPORT_1X: BlurViewport = { width: 1920, height: 1080, dpr: 1 };

/** One 1920×1080 monitor whose taskbar (40 px, bottom) is left clear. */
const WORK_AREA_1 = { left: 0, top: 0, right: 1920, bottom: 1040 };

/** A full anchor sample (window-local physical px). */
function anchor(over: Partial<Parameters<typeof computeBlurLayout>[0]> = {}) {
	return {
		x: 100,
		y: 200,
		width: 400,
		height: 300,
		monitorLeft: 0,
		monitorTop: 0,
		monitorRight: 1920,
		monitorBottom: 1040,
		monitors: [WORK_AREA_1],
		...over,
	};
}

describe("computeBlurLayout", () => {
	test("whole-virtual-screen shade covers each monitor region, hole at the window", () => {
		const regions = computeBlurLayout(anchor(), VIEWPORT_1X, false);
		expect(regions).toHaveLength(1);
		// The region is the monitor's WORK AREA (1040), not the raw 1080 viewport:
		// that is what leaves the taskbar undimmed.
		expect(regions[0]?.container).toEqual({
			left: 0,
			top: 0,
			width: 1920,
			height: 1040,
		});
		expect(regions[0]?.cutout).toEqual({
			left: 100,
			top: 200,
			width: 400,
			height: 300,
		});
	});

	test("includeTaskbar extends each region to the full monitor rect", () => {
		// Backend resolves rcMonitor instead of rcWork, so the shade reaches 1080.
		const regions = computeBlurLayout(
			anchor({ monitors: [{ left: 0, top: 0, right: 1920, bottom: 1080 }] }),
			VIEWPORT_1X,
			false,
		);
		expect(regions[0]?.container.height).toBe(1080);
	});

	test("shades every monitor and keeps each taskbar clear on a dual setup", () => {
		// Two side-by-side displays, each with its own bottom taskbar. Both work
		// areas must be shaded — the bug this covers dimmed the whole viewport,
		// swallowing both taskbars.
		const regions = computeBlurLayout(
			anchor({
				monitors: [
					WORK_AREA_1,
					{ left: 1920, top: 0, right: 3840, bottom: 1030 },
				],
			}),
			{ width: 3840, height: 1080, dpr: 1 },
			false,
		);
		expect(regions).toHaveLength(2);
		expect(regions[0]?.container).toEqual({
			left: 0,
			top: 0,
			width: 1920,
			height: 1040,
		});
		expect(regions[1]?.container).toEqual({
			left: 1920,
			top: 0,
			width: 1920,
			height: 1030,
		});
	});

	test("a region the window never touches stays fully shaded", () => {
		// The window sits on monitor 1, so monitor 2's hole collapses on the axis
		// that separates them (zero AREA ⇒ nothing revealed, and its spotlight
		// box-shadow fills that whole region).
		const regions = computeBlurLayout(
			anchor({
				monitors: [
					WORK_AREA_1,
					{ left: 1920, top: 0, right: 3840, bottom: 1040 },
				],
			}),
			{ width: 3840, height: 1080, dpr: 1 },
			false,
		);
		const cutout = regions[1]?.cutout;
		expect(cutout?.width).toBe(0);
		expect((cutout?.width ?? 0) * (cutout?.height ?? 0)).toBe(0);
	});

	test("a window straddling two monitors is revealed by both regions", () => {
		// 800 px wide window centred on the seam at x=1920: 400 px each side.
		const regions = computeBlurLayout(
			anchor({
				x: 1520,
				y: 100,
				width: 800,
				height: 400,
				monitors: [
					WORK_AREA_1,
					{ left: 1920, top: 0, right: 3840, bottom: 1040 },
				],
			}),
			{ width: 3840, height: 1080, dpr: 1 },
			false,
		);
		// Left region: hole runs from x=1520 to its right edge (1920).
		expect(regions[0]?.cutout).toEqual({
			left: 1520,
			top: 100,
			width: 400,
			height: 400,
		});
		// Right region: hole starts at its left edge and runs 400 px in.
		expect(regions[1]?.cutout).toEqual({
			left: 0,
			top: 100,
			width: 400,
			height: 400,
		});
	});

	test("leaves the gap between non-contiguous monitors untinted", () => {
		// Displays separated by a 40 px virtual gap produce two regions, never one
		// spanning rect — so nothing paints over the gap.
		const regions = computeBlurLayout(
			anchor({
				monitors: [
					WORK_AREA_1,
					{ left: 1960, top: 0, right: 3880, bottom: 1040 },
				],
			}),
			{ width: 3880, height: 1080, dpr: 1 },
			false,
		);
		expect(regions).toHaveLength(2);
		expect(
			(regions[0]?.container.left ?? 0) + (regions[0]?.container.width ?? 0),
		).toBe(1920);
		expect(regions[1]?.container.left).toBe(1960);
	});

	test("falls back to the whole viewport when monitor enumeration is empty", () => {
		const regions = computeBlurLayout(
			anchor({ monitors: [] }),
			VIEWPORT_1X,
			false,
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]?.container).toEqual({
			left: 0,
			top: 0,
			width: 1920,
			height: 1080,
		});
	});

	test("drops degenerate zero-area monitor regions", () => {
		const regions = computeBlurLayout(
			anchor({
				monitors: [WORK_AREA_1, { left: 500, top: 0, right: 500, bottom: 0 }],
			}),
			VIEWPORT_1X,
			false,
		);
		expect(regions).toHaveLength(1);
	});

	test("only-current-monitor clips the shade to the monitor bounds", () => {
		const regions = computeBlurLayout(
			anchor({
				monitorLeft: 0,
				monitorTop: 0,
				monitorRight: 1920,
				monitorBottom: 1040,
			}),
			VIEWPORT_1X,
			true,
		);
		// Monitor work area (taskbar excluded ⇒ 1040 tall, not 1080).
		expect(regions).toHaveLength(1);
		expect(regions[0]?.container).toEqual({
			left: 0,
			top: 0,
			width: 1920,
			height: 1040,
		});
		expect(regions[0]?.cutout).toEqual({
			left: 100,
			top: 200,
			width: 400,
			height: 300,
		});
	});

	test("only-current-monitor ignores the other monitors' regions", () => {
		const regions = computeBlurLayout(
			anchor({
				monitors: [
					WORK_AREA_1,
					{ left: 1920, top: 0, right: 3840, bottom: 1040 },
				],
			}),
			{ width: 3840, height: 1080, dpr: 1 },
			true,
		);
		expect(regions).toHaveLength(1);
		expect(regions[0]?.container.left).toBe(0);
	});

	test("cutout is relative to a non-origin monitor container", () => {
		// A right-hand monitor whose local origin is at x=1920, with a window on it.
		const regions = computeBlurLayout(
			anchor({
				x: 2020,
				y: 100,
				width: 500,
				height: 400,
				monitorLeft: 1920,
				monitorTop: 0,
				monitorRight: 3840,
				monitorBottom: 1080,
			}),
			{ width: 3840, height: 1080, dpr: 1 },
			true,
		);
		expect(regions[0]?.container).toEqual({
			left: 1920,
			top: 0,
			width: 1920,
			height: 1080,
		});
		// 2020 - 1920 = 100 local to the container.
		expect(regions[0]?.cutout).toEqual({
			left: 100,
			top: 100,
			width: 500,
			height: 400,
		});
	});

	test("divides physical px by the device-pixel-ratio", () => {
		const regions = computeBlurLayout(
			anchor({
				x: 200,
				y: 400,
				width: 800,
				height: 600,
				monitors: [{ left: 0, top: 0, right: 1920, bottom: 1080 }],
			}),
			{ width: 960, height: 540, dpr: 2 },
			false,
		);
		expect(regions[0]?.container).toEqual({
			left: 0,
			top: 0,
			width: 960,
			height: 540,
		});
		expect(regions[0]?.cutout).toEqual({
			left: 100,
			top: 200,
			width: 400,
			height: 300,
		});
	});

	test("clamps a window that spills past the monitor container", () => {
		// A maximized window slightly larger than the work area must not push the
		// clear hole outside the shade (which would leak the box-shadow edge).
		const regions = computeBlurLayout(
			anchor({
				x: -8,
				y: -8,
				width: 1936,
				height: 1056,
				monitorLeft: 0,
				monitorTop: 0,
				monitorRight: 1920,
				monitorBottom: 1040,
			}),
			VIEWPORT_1X,
			true,
		);
		expect(regions[0]?.cutout).toEqual({
			left: 0,
			top: 0,
			width: 1920,
			height: 1040,
		});
	});

	test("a fully off-container window yields a zero-area cutout", () => {
		const regions = computeBlurLayout(
			anchor({ x: 5000, y: 5000, width: 400, height: 300 }),
			VIEWPORT_1X,
			false,
		);
		expect(regions[0]?.cutout.width).toBe(0);
		expect(regions[0]?.cutout.height).toBe(0);
	});
});

describe("shadeColorRgba", () => {
	test("black at 50% transparency", () => {
		expect(shadeColorRgba("#000000", 50)).toBe("rgba(0, 0, 0, 0.5)");
	});

	test("parses a #rrggbb colour and full opacity", () => {
		expect(shadeColorRgba("#1a2b3c", 100)).toBe("rgba(26, 43, 60, 1)");
	});

	test("expands #rgb shorthand", () => {
		expect(shadeColorRgba("#abc", 0)).toBe("rgba(170, 187, 204, 0)");
	});

	test("clamps out-of-range transparency and defaults a bad colour to black", () => {
		expect(shadeColorRgba("#000000", 150)).toBe("rgba(0, 0, 0, 1)");
		expect(shadeColorRgba("not-a-color", 40)).toBe("rgba(0, 0, 0, 0.4)");
	});
});
