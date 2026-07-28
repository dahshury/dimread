import { describe, expect, it } from "bun:test";
import type { HotkeysSettings } from "@/bindings";
import {
	ALL_HOTKEY_IDS,
	buildHotkeyPatch,
	clearHotkeyPatch,
	collectOtherCombos,
	HOTKEY_ROW_ORDER,
	normalizeCombo,
	splitCombo,
} from "./hotkey-patch";

function hotkeys(overrides: Partial<HotkeysSettings> = {}): HotkeysSettings {
	return {
		toggleMain: "",
		brightnessUp: "",
		brightnessDown: "",
		tempUp: "",
		tempDown: "",
		toggleFilter: "",
		toggleReading: "",
		toggleEditing: "",
		focusRead: "",
		focusBlur: "",
		magicDark: "",
		magicGray: "",
		...overrides,
	};
}

describe("HOTKEY_ROW_ORDER", () => {
	it("lists every binding exactly once", () => {
		// The Hotkeys tab is the ONLY place a combo can be bound, so a hotkeys
		// field missing from this list would be unreachable in the UI.
		expect([...HOTKEY_ROW_ORDER].sort()).toEqual([...ALL_HOTKEY_IDS].sort());
	});

	it("keeps the Focus and MagicX bindings on the tab", () => {
		expect(HOTKEY_ROW_ORDER).toContain("focusRead");
		expect(HOTKEY_ROW_ORDER).toContain("focusBlur");
		expect(HOTKEY_ROW_ORDER).toContain("magicDark");
		expect(HOTKEY_ROW_ORDER).toContain("magicGray");
	});
});

describe("buildHotkeyPatch", () => {
	it("produces a one-field patch keyed by the action id", () => {
		expect(buildHotkeyPatch("brightnessUp", "F2")).toEqual({
			brightnessUp: "F2",
		});
	});

	it("trims the recorded combo", () => {
		expect(buildHotkeyPatch("tempDown", "  Ctrl+Alt+Down  ")).toEqual({
			tempDown: "Ctrl+Alt+Down",
		});
	});
});

describe("clearHotkeyPatch", () => {
	it("unbinds the action with an empty string", () => {
		expect(clearHotkeyPatch("toggleReading")).toEqual({ toggleReading: "" });
	});
});

describe("splitCombo / normalizeCombo", () => {
	it("splits into trimmed, non-empty tokens", () => {
		expect(splitCombo("Ctrl + Shift + K")).toEqual(["Ctrl", "Shift", "K"]);
	});

	it("drops dangling and empty segments", () => {
		expect(splitCombo("Ctrl+")).toEqual(["Ctrl"]);
		expect(splitCombo("  +  ")).toEqual([]);
	});

	it("re-joins into a canonical accelerator", () => {
		expect(normalizeCombo("Ctrl + Shift + K")).toBe("Ctrl+Shift+K");
		expect(normalizeCombo("Alt+ ")).toBe("Alt");
	});
});

describe("collectOtherCombos", () => {
	it("returns every bound hotkey except the excluded one", () => {
		const settings = hotkeys({
			toggleMain: "Ctrl+Shift+Space",
			brightnessUp: "F2",
			brightnessDown: "F3",
		});
		const others = collectOtherCombos(settings, "brightnessUp");
		expect(others).toEqual([
			{ id: "toggleMain", combo: "Ctrl+Shift+Space" },
			{ id: "brightnessDown", combo: "F3" },
		]);
	});

	it("skips unbound (empty/whitespace) fields", () => {
		const settings = hotkeys({ brightnessUp: "F2", tempUp: "   " });
		expect(collectOtherCombos(settings, "toggleMain")).toEqual([
			{ id: "brightnessUp", combo: "F2" },
		]);
	});

	it("excludes toggleMain itself when it is the subject", () => {
		const settings = hotkeys({ toggleMain: "Ctrl+M", tempUp: "F5" });
		expect(collectOtherCombos(settings, "toggleMain")).toEqual([
			{ id: "tempUp", combo: "F5" },
		]);
	});

	it("covers the Focus and MagicX bindings too", () => {
		// Regression: these four were missing from the roster, so a combo bound
		// on the Focus/MagicX tabs sailed through the frontend check and bounced
		// off the backend with a raw duplicate error.
		const settings = hotkeys({
			focusRead: "Shift+Alt+S",
			focusBlur: "F7",
			magicDark: "Ctrl+D",
			magicGray: "Ctrl+G",
		});
		expect(collectOtherCombos(settings, "brightnessUp")).toEqual([
			{ id: "focusRead", combo: "Shift+Alt+S" },
			{ id: "focusBlur", combo: "F7" },
			{ id: "magicDark", combo: "Ctrl+D" },
			{ id: "magicGray", combo: "Ctrl+G" },
		]);
	});
});
