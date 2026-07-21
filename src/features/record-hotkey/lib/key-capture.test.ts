import { describe, expect, it } from "bun:test";
import {
	comboFromChord,
	heldModifiersFromEvent,
	isModifierToken,
	keyNameFromEvent,
	sortKeys,
} from "./key-capture";

describe("keyNameFromEvent", () => {
	it("collapses side-specific modifiers into Tauri tokens", () => {
		expect(keyNameFromEvent({ code: "ControlLeft" })).toBe("Ctrl");
		expect(keyNameFromEvent({ code: "ControlRight" })).toBe("Ctrl");
		expect(keyNameFromEvent({ code: "MetaLeft" })).toBe("Super");
		expect(keyNameFromEvent({ code: "ShiftRight" })).toBe("Shift");
	});

	it("maps letters, digits, F-keys and named keys", () => {
		expect(keyNameFromEvent({ code: "KeyK" })).toBe("K");
		expect(keyNameFromEvent({ code: "Digit7" })).toBe("7");
		expect(keyNameFromEvent({ code: "F12" })).toBe("F12");
		expect(keyNameFromEvent({ code: "F24" })).toBe("F24");
		expect(keyNameFromEvent({ code: "Space" })).toBe("Space");
		expect(keyNameFromEvent({ code: "ArrowUp" })).toBe("ArrowUp");
		expect(keyNameFromEvent({ code: "Numpad3" })).toBe("Numpad3");
	});

	it("ignores keys outside the accelerator vocabulary", () => {
		expect(keyNameFromEvent({ code: "AudioVolumeUp" })).toBeNull();
		expect(keyNameFromEvent({ code: "F25" })).toBeNull();
		expect(keyNameFromEvent({ code: "" })).toBeNull();
	});
});

describe("sortKeys", () => {
	it("dedupes and orders modifiers before main keys", () => {
		expect(sortKeys(["K", "Ctrl", "Shift", "Ctrl"])).toEqual([
			"Ctrl",
			"Shift",
			"K",
		]);
		expect(sortKeys(["Super", "Alt"])).toEqual(["Alt", "Super"]);
	});
});

describe("comboFromChord", () => {
	it("joins held modifiers (canonical order) with the main key", () => {
		expect(comboFromChord(["Shift", "Ctrl"], "K")).toBe("Ctrl+Shift+K");
		expect(comboFromChord(["Alt", "Shift"], "S")).toBe("Shift+Alt+S");
		expect(comboFromChord([], "F5")).toBe("F5");
	});

	it("drops non-modifier noise from the modifier set", () => {
		expect(comboFromChord(["Ctrl", "K"], "S")).toBe("Ctrl+S");
	});

	it("rejects a missing or modifier main key", () => {
		expect(comboFromChord(["Ctrl"], "")).toBeNull();
		expect(comboFromChord(["Ctrl"], "Shift")).toBeNull();
	});
});

describe("heldModifiersFromEvent", () => {
	const eventWith = (down: readonly string[]) => ({
		getModifierState: (state: string) => down.includes(state),
	});

	it("reads the held modifiers from the event bitmask", () => {
		expect(heldModifiersFromEvent(eventWith(["Alt", "Shift"]))).toEqual([
			"Shift",
			"Alt",
		]);
		expect(heldModifiersFromEvent(eventWith(["Control", "Meta"]))).toEqual([
			"Ctrl",
			"Super",
		]);
		expect(heldModifiersFromEvent(eventWith([]))).toEqual([]);
	});
});

describe("isModifierToken", () => {
	it("recognizes the four modifier tokens", () => {
		for (const token of ["Ctrl", "Shift", "Alt", "Super"]) {
			expect(isModifierToken(token)).toBe(true);
		}
		expect(isModifierToken("K")).toBe(false);
	});
});
