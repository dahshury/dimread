import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PANEL_RECT,
	dropdownStateClass,
	normalizePanelRect,
	panelOrigin,
} from "./panel-math";

describe("panelOrigin", () => {
	test("panel hugging the bottom (footer trigger) animates from its bottom edge", () => {
		// 1080-tall backdrop, panel ends 8px above the bottom.
		const rect = { x: 100, y: 652, width: 360, height: 420 };
		expect(panelOrigin(rect, 1080)).toBe("bottom-right");
	});

	test("panel hugging the top (trigger near the top) animates from its top edge", () => {
		const rect = { x: 100, y: 40, width: 360, height: 420 };
		expect(panelOrigin(rect, 1080)).toBe("top-right");
	});

	test("centered panel defaults to bottom origin (footer chips dominate)", () => {
		const rect = { x: 0, y: 330, width: 360, height: 420 };
		expect(panelOrigin(rect, 1080)).toBe("bottom-right");
	});
});

describe("normalizePanelRect", () => {
	test("passes a sane rect through unchanged", () => {
		const rect = { x: 12, y: 34, width: 360, height: 420 };
		expect(normalizePanelRect(rect)).toEqual(rect);
	});

	test("heals non-finite coordinates to the default footprint", () => {
		const rect = normalizePanelRect({
			x: Number.NaN,
			y: Number.POSITIVE_INFINITY,
			width: Number.NaN,
			height: -0,
		});
		expect(rect.x).toBe(DEFAULT_PANEL_RECT.x);
		expect(rect.y).toBe(DEFAULT_PANEL_RECT.y);
		expect(rect.width).toBe(DEFAULT_PANEL_RECT.width);
		// -0 is finite; heights floor at 1 so the panel can never invert.
		expect(rect.height).toBe(1);
	});

	test("floors degenerate sizes at 1px", () => {
		const rect = normalizePanelRect({ x: 0, y: 0, width: -5, height: 0 });
		expect(rect.width).toBe(1);
		expect(rect.height).toBe(1);
	});
});

describe("dropdownStateClass", () => {
	test("maps phases onto the t-dropdown contract", () => {
		expect(dropdownStateClass("hidden")).toBe("");
		expect(dropdownStateClass("pre-open")).toBe("");
		expect(dropdownStateClass("open")).toBe("is-open");
		expect(dropdownStateClass("closing")).toBe("is-closing");
	});
});
