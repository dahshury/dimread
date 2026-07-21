import { describe, expect, test } from "bun:test";
import {
	createEditOrigin,
	type DisplayEditBroadcast,
	editTargetsSurface,
} from "./display-edit-channel";

const MON = "\\\\.\\DISPLAY2";

function broadcast(
	overrides: Partial<DisplayEditBroadcast> = {},
): DisplayEditBroadcast {
	return {
		mode: "office",
		monitorId: null,
		origin: "sender-1",
		phase: "day",
		value: { brightness: 60, kelvin: 4200 },
		...overrides,
	};
}

const SURFACE = { mode: "office", monitorId: null, phase: "day" } as const;

describe("editTargetsSurface", () => {
	test("mirrors a drag on the same mode/phase/monitor", () => {
		expect(editTargetsSurface(broadcast(), SURFACE)).toBe(true);
	});

	test("ignores a drag on the other phase", () => {
		// The tray edits the live phase; the Display tab may be showing the OFF
		// phase, where the same slider means a different stored value.
		expect(editTargetsSurface(broadcast({ phase: "night" }), SURFACE)).toBe(
			false,
		);
	});

	test("ignores a drag on a different monitor", () => {
		expect(editTargetsSurface(broadcast({ monitorId: MON }), SURFACE)).toBe(
			false,
		);
	});

	test("ignores a drag on a different mode", () => {
		expect(editTargetsSurface(broadcast({ mode: "reading" }), SURFACE)).toBe(
			false,
		);
	});

	test("mirrors the end-of-drag signal for a matching target", () => {
		expect(editTargetsSurface(broadcast({ value: null }), SURFACE)).toBe(true);
	});
});

describe("createEditOrigin", () => {
	test("is unique per surface", () => {
		// A plain counter would hand two windows the same id (each starts its own
		// module state at zero) and each would dismiss the other as its own echo.
		const ids = new Set(Array.from({ length: 50 }, () => createEditOrigin()));
		expect(ids.size).toBe(50);
	});
});
