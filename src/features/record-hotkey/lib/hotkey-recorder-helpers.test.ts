import { describe, expect, it } from "bun:test";
import {
	findConflict,
	formatCombo,
	isHintText,
	resolveDisplayText,
} from "./hotkey-recorder-helpers";

describe("formatCombo", () => {
	it("joins tokens with spaced plus signs", () => {
		expect(formatCombo("Ctrl+Shift+K")).toBe("Ctrl + Shift + K");
	});

	it("drops empty and whitespace-only segments", () => {
		expect(formatCombo("")).toBe("");
		expect(formatCombo("Ctrl+")).toBe("Ctrl");
		expect(formatCombo("Ctrl+ ")).toBe("Ctrl");
	});

	it("maps display tokens", () => {
		expect(formatCombo("Alt+ArrowUp")).toBe("Alt + ↑");
	});
});

describe("resolveDisplayText / isHintText", () => {
	it("shows the current combo when idle", () => {
		expect(resolveDisplayText(false, [], "Ctrl+K", "press", "unset")).toBe(
			"Ctrl + K",
		);
		expect(isHintText(false, [], "Ctrl+K")).toBe(false);
	});

	it("shows the empty label when idle and unbound", () => {
		expect(resolveDisplayText(false, [], "", "press", "unset")).toBe("unset");
		expect(isHintText(false, [], "")).toBe(true);
	});

	it("shows live keys while recording", () => {
		expect(
			resolveDisplayText(true, ["Ctrl", "Shift"], "Ctrl+K", "press", "unset"),
		).toBe("Ctrl + Shift");
		expect(isHintText(true, ["Ctrl"], "")).toBe(false);
	});

	it("shows the press hint while recording with nothing held", () => {
		expect(resolveDisplayText(true, [], "Ctrl+K", "press", "unset")).toBe(
			"press",
		);
		expect(isHintText(true, [], "Ctrl+K")).toBe(true);
	});
});

describe("findConflict", () => {
	const forbidden = [
		{ combo: "Ctrl+Shift+V", label: "Paste special" },
		{ combo: "Alt+F4", label: "Quit" },
	];

	it("returns the first colliding entry", () => {
		expect(findConflict("shift+ctrl+v", forbidden)?.label).toBe(
			"Paste special",
		);
		expect(findConflict("Alt+F4", forbidden)?.label).toBe("Quit");
	});

	it("returns null for distinct, subset, or absent combos", () => {
		expect(findConflict("Ctrl+K", forbidden)).toBeNull();
		expect(findConflict("Ctrl+V", forbidden)).toBeNull();
		expect(findConflict("Ctrl+V", undefined)).toBeNull();
		expect(findConflict("Ctrl+V", [])).toBeNull();
	});
});
