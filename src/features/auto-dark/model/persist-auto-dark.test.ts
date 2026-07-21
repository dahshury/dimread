import { beforeEach, describe, expect, test } from "bun:test";
import { getSettingsStoreState } from "@/entities/setting";
import { patchAutoDarkSettings } from "./persist-auto-dark";

describe("patchAutoDarkSettings", () => {
	beforeEach(() => {
		// Non-native (browser-preview) state: the shared save coordinator no-ops
		// its backend post, so the local store is the only sink to assert against.
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
		getSettingsStoreState().resetSettings();
	});

	test("applies the patch optimistically to the store", async () => {
		expect(getSettingsStoreState().settings.autoDark.systemTheme).toBe(
			"disable",
		);
		await patchAutoDarkSettings({ systemTheme: "dark" });
		expect(getSettingsStoreState().settings.autoDark.systemTheme).toBe("dark");
	});

	test("merges only the provided fields, leaving the rest at their defaults", async () => {
		await patchAutoDarkSettings({
			systemTheme: "auto",
			taskbarTransparent: true,
		});
		const { autoDark } = getSettingsStoreState().settings;
		expect(autoDark.systemTheme).toBe("auto");
		expect(autoDark.taskbarTransparent).toBe(true);
		// Untouched fields keep their defaults.
		expect(autoDark.systemSunrise).toBe("07:00");
		expect(autoDark.systemSunset).toBe("19:00");
	});
});
