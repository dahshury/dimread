import { describe, expect, test } from "bun:test";
import { cycleMode, findMode, type ModeSwitchMode } from "./mode-switch-option";

type Demo = "focus" | "casual" | "away";

const modes: ModeSwitchMode<Demo>[] = [
	{ value: "focus", label: "Focus" },
	{ value: "casual", label: "Casual" },
	{ value: "away", label: "Away" },
];

describe("cycleMode", () => {
	test("steps forward through the mode order", () => {
		expect(cycleMode(modes, "focus")).toBe("casual");
		expect(cycleMode(modes, "casual")).toBe("away");
	});

	test("wraps from the last mode back to the first", () => {
		expect(cycleMode(modes, "away")).toBe("focus");
	});

	test("steps backward with delta -1, wrapping at the front", () => {
		expect(cycleMode(modes, "casual", -1)).toBe("focus");
		expect(cycleMode(modes, "focus", -1)).toBe("away");
	});

	test("skips disabled modes", () => {
		const withDisabled: ModeSwitchMode<Demo>[] = [
			{ value: "focus", label: "Focus" },
			{ value: "casual", label: "Casual", disabled: true },
			{ value: "away", label: "Away" },
		];
		expect(cycleMode(withDisabled, "focus")).toBe("away");
		expect(cycleMode(withDisabled, "away", -1)).toBe("focus");
	});

	test("returns current when no other mode is enabled", () => {
		const lonely: ModeSwitchMode<Demo>[] = [
			{ value: "focus", label: "Focus" },
			{ value: "casual", label: "Casual", disabled: true },
		];
		expect(cycleMode(lonely, "focus")).toBe("focus");
	});

	test("returns current for an empty mode list", () => {
		expect(cycleMode([] as ModeSwitchMode<Demo>[], "focus")).toBe("focus");
	});

	test("lands on the first enabled mode when current is unknown", () => {
		expect(cycleMode(modes, "missing" as Demo)).toBe("focus");
	});
});

describe("findMode", () => {
	test("returns the matching mode entry", () => {
		expect(findMode(modes, "casual")?.label).toBe("Casual");
	});

	test("returns undefined for an unknown value", () => {
		expect(findMode(modes, "missing" as Demo)).toBeUndefined();
	});
});
