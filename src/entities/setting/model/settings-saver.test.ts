import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	commands,
	type AppSettings,
	type PartialSettings,
	type SettingsSnapshot,
} from "@/bindings";
import { adoptSettingsSnapshot } from "./adopt-settings-snapshot";
import {
	markSectionsEdited,
	pendingSectionKeys,
	clearPendingEdits,
} from "./pending-edits";
import {
	flushPendingSettings,
	patchSettingsSection,
	resetSettingsPatcherForTests,
} from "./settings-patcher";
import {
	enqueueSettingsSave,
	resetSettingsSaverForTests,
} from "./settings-saver";
import { useSettingsHydrationStore } from "./settings-hydration-store";
import {
	getSettingsStoreState,
	normalizeSettings,
	useSettingsStore,
} from "./settings-store";

const originalSave = commands.settingsSave;
const originalLoad = commands.settingsLoadSnapshot;
const originalConsoleError = console.error;

function snapshot(
	revision: number,
	general: Partial<AppSettings["general"]> = {},
): SettingsSnapshot {
	const settings = normalizeSettings({});
	return {
		revision,
		settings: {
			...settings,
			general: { ...settings.general, ...general },
		} as AppSettings,
	};
}

function currentGeneralPatch(): PartialSettings {
	return { general: getSettingsStoreState().settings.general };
}

describe("settings save coordinator", () => {
	beforeEach(() => {
		console.error = () => undefined;
		useSettingsStore.getState().resetSettings();
		useSettingsHydrationStore.setState({
			error: null,
			revision: 0,
			status: "idle",
		});
		clearPendingEdits();
		resetSettingsPatcherForTests();
		resetSettingsSaverForTests();
	});

	afterEach(() => {
		commands.settingsSave = originalSave;
		commands.settingsLoadSnapshot = originalLoad;
		console.error = originalConsoleError;
		resetSettingsPatcherForTests();
	});

	test("rebases an exact local field after a same-section conflict", async () => {
		adoptSettingsSnapshot(snapshot(1));
		getSettingsStoreState().updateGeneralSettings({ autostart: true });
		markSectionsEdited("general");
		const remote = snapshot(2, { minimizeToTray: false });
		let attempts = 0;
		const retryPatches: PartialSettings[] = [];
		commands.settingsLoadSnapshot = async () => remote;
		commands.settingsSave = async (patch, revision) => {
			attempts += 1;
			if (attempts === 1) {
				expect(revision).toBe(1);
				return {
					status: "error",
					error: "settings revision conflict: expected 1, current 2",
				};
			}
			expect(revision).toBe(2);
			retryPatches.push(patch);
			return {
				status: "ok",
				data: {
					revision: 3,
					settings: {
						...remote.settings,
						general: patch.general!,
					},
				},
			};
		};

		await enqueueSettingsSave(currentGeneralPatch);

		expect(attempts).toBe(2);
		expect(retryPatches[0]?.general?.autostart).toBe(true);
		expect(retryPatches[0]?.general?.minimizeToTray).toBe(false);
		expect(getSettingsStoreState().settings.general).toEqual({
			autostart: true,
			anonymousReports: false,
			minimizeToTray: false,
		});
	});

	test("a late save response cannot lower the adopted revision", async () => {
		adoptSettingsSnapshot(snapshot(4));
		getSettingsStoreState().updateGeneralSettings({ autostart: true });
		markSectionsEdited("general");
		commands.settingsSave = async () => {
			// A newer broadcast arrives before the command's older response.
			adoptSettingsSnapshot(
				snapshot(6, { autostart: true, minimizeToTray: false }),
			);
			return {
				status: "ok",
				data: snapshot(5, { autostart: true, minimizeToTray: true }),
			};
		};

		await enqueueSettingsSave(currentGeneralPatch);

		expect(useSettingsHydrationStore.getState().revision).toBe(6);
		expect(getSettingsStoreState().settings.general.minimizeToTray).toBe(false);
	});

	test("rejects a terminal failure while keeping pending edits retryable", async () => {
		adoptSettingsSnapshot(snapshot(1));
		getSettingsStoreState().updateGeneralSettings({ autostart: true });
		markSectionsEdited("general");
		commands.settingsSave = async () => ({
			status: "error",
			error: "disk full",
		});

		await expect(enqueueSettingsSave(currentGeneralPatch)).rejects.toThrow(
			"disk full",
		);
		expect(pendingSectionKeys()).toContain("general");

		commands.settingsSave = async (patch) => ({
			status: "ok",
			data: {
				revision: 2,
				settings: {
					...snapshot(1).settings,
					general: patch.general!,
				},
			},
		});
		await expect(
			enqueueSettingsSave(currentGeneralPatch),
		).resolves.toBeUndefined();
		expect(pendingSectionKeys()).not.toContain("general");
	});

	test("a failed debounced flush retains its dirty section for retry", async () => {
		adoptSettingsSnapshot(snapshot(1));
		let attempts = 0;
		commands.settingsSave = async (patch) => {
			attempts += 1;
			if (attempts === 1) {
				return { status: "error", error: "permission denied" };
			}
			return {
				status: "ok",
				data: {
					revision: 2,
					settings: {
						...snapshot(1).settings,
						general: patch.general!,
					},
				},
			};
		};
		patchSettingsSection("general", { anonymousReports: true });

		await expect(flushPendingSettings()).rejects.toThrow("permission denied");
		expect(attempts).toBe(1);
		await expect(flushPendingSettings()).resolves.toBeUndefined();
		expect(attempts).toBe(2);
		expect(getSettingsStoreState().settings.general.anonymousReports).toBe(
			true,
		);
	});
});
