import { describe, expect, it } from "bun:test";
import type { HotkeysSettings } from "@/bindings";
import {
	DISPLAY_HOTKEY_ACTIONS,
	hotkeyActionAccelerator,
	hotkeyActionLabelKey,
} from "./hotkey-actions";

describe("DISPLAY_HOTKEY_ACTIONS", () => {
	it("lists the seven display actions in render order", () => {
		expect(DISPLAY_HOTKEY_ACTIONS).toEqual([
			"brightnessUp",
			"brightnessDown",
			"tempUp",
			"tempDown",
			"toggleFilter",
			"toggleReading",
			"toggleEditing",
		]);
	});

	it("has no duplicate ids", () => {
		expect(new Set(DISPLAY_HOTKEY_ACTIONS).size).toBe(
			DISPLAY_HOTKEY_ACTIONS.length,
		);
	});
});

describe("hotkeyActionLabelKey", () => {
	it("derives the `<id>Label` i18n key", () => {
		expect(hotkeyActionLabelKey("brightnessUp")).toBe("brightnessUpLabel");
		expect(hotkeyActionLabelKey("toggleEditing")).toBe("toggleEditingLabel");
	});
});

describe("hotkeyActionAccelerator", () => {
	it("reads an action's current binding by id", () => {
		const hotkeys = {
			toggleMain: "",
			brightnessUp: "F2",
			brightnessDown: "",
			tempUp: "",
			tempDown: "",
			toggleFilter: "Ctrl+Alt+P",
			toggleReading: "",
			toggleEditing: "",
			focusRead: "",
			focusBlur: "",
			magicDark: "",
			magicGray: "",
		} satisfies HotkeysSettings;
		expect(hotkeyActionAccelerator(hotkeys, "brightnessUp")).toBe("F2");
		expect(hotkeyActionAccelerator(hotkeys, "toggleFilter")).toBe("Ctrl+Alt+P");
	});
});
