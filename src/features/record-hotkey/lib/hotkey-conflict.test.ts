import { describe, expect, it } from "bun:test";
import { compareHotkeys, isHotkeyConflict } from "./hotkey-conflict";

describe("compareHotkeys", () => {
	it("classifies equal sets regardless of order and case", () => {
		expect(compareHotkeys("Ctrl+Shift+V", "shift+ctrl+v")).toBe("equal");
	});

	it("classifies subset / superset", () => {
		expect(compareHotkeys("Ctrl+V", "Ctrl+Shift+V")).toBe("subset");
		expect(compareHotkeys("Ctrl+Shift+V", "Ctrl+V")).toBe("superset");
	});

	it("classifies disjoint combos", () => {
		expect(compareHotkeys("Ctrl+A", "Alt+B")).toBe("disjoint");
		expect(compareHotkeys("Ctrl+A", "Ctrl+B")).toBe("disjoint");
	});

	it("treats empty combos as disjoint", () => {
		expect(compareHotkeys("", "Ctrl+A")).toBe("disjoint");
		expect(compareHotkeys("  ", "")).toBe("disjoint");
	});

	it("survives hostile token whitespace", () => {
		expect(compareHotkeys("Ctrl + Shift + V", "ctrl+shift+v")).toBe("equal");
	});
});

describe("isHotkeyConflict", () => {
	it("flags every non-disjoint relation", () => {
		expect(isHotkeyConflict("equal")).toBe(true);
		expect(isHotkeyConflict("subset")).toBe(true);
		expect(isHotkeyConflict("superset")).toBe(true);
		expect(isHotkeyConflict("disjoint")).toBe(false);
	});
});
