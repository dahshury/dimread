import { beforeEach, describe, expect, test } from "bun:test";
import type { SettingsSnapshot } from "@/bindings";
import { useLocaleStore } from "@/shared/i18n";
import { adoptSettingsSnapshot } from "./adopt-settings-snapshot";
import {
	markSectionsEdited,
	clearPendingEdits,
	settleSections,
} from "./pending-edits";
import { useSettingsHydrationStore } from "./settings-hydration-store";
import {
	getSettingsStoreState,
	normalizeSettings,
	useSettingsStore,
} from "./settings-store";

/** A snapshot at `revision` whose brightness marks which tree it is. */
function snapshotWith(
	revision: number,
	brightnessDay: number,
): SettingsSnapshot {
	const settings = normalizeSettings({});
	return {
		revision,
		settings: {
			...settings,
			display: {
				...settings.display,
				modes: {
					...settings.display.modes,
					custom: {
						brightnessDay,
						brightnessNight: brightnessDay,
						kelvinDay: 5500,
						kelvinNight: 5500,
					},
				},
			},
		},
	} as SettingsSnapshot;
}

function currentBrightness(): number {
	return (
		getSettingsStoreState().settings.display.modes["custom"]?.brightnessDay ??
		Number.NaN
	);
}

describe("adoptSettingsSnapshot", () => {
	beforeEach(() => {
		useSettingsStore.getState().resetSettings();
		useSettingsHydrationStore.setState({ revision: 0 });
		useLocaleStore.setState({ locale: "en" });
		clearPendingEdits();
	});

	test("adopts a snapshot at the same revision (first hydration)", () => {
		expect(adoptSettingsSnapshot(snapshotWith(0, 42))).toBe(true);
		expect(currentBrightness()).toBe(42);
		expect(useSettingsHydrationStore.getState().revision).toBe(0);
	});

	test("adopts a newer snapshot", () => {
		adoptSettingsSnapshot(snapshotWith(1, 42));
		expect(adoptSettingsSnapshot(snapshotWith(2, 77))).toBe(true);
		expect(currentBrightness()).toBe(77);
		expect(useSettingsHydrationStore.getState().revision).toBe(2);
	});

	test("keeps the live locale store in sync with an adopted snapshot", () => {
		useLocaleStore.setState({ locale: "synthetic" as never });
		adoptSettingsSnapshot(snapshotWith(1, 42));
		expect(useLocaleStore.getState().locale).toBe("en");
	});

	test("drops a stale snapshot instead of reverting a newer edit", () => {
		// The regression: a slider commit advances the revision while the boot
		// `settings_load_snapshot()` is still in flight. When that older snapshot
		// finally resolves it must NOT put the pre-edit value back — that is the
		// slider visibly snapping back on first mount.
		adoptSettingsSnapshot(snapshotWith(3, 77));
		expect(adoptSettingsSnapshot(snapshotWith(1, 42))).toBe(false);
		expect(currentBrightness()).toBe(77);
		expect(useSettingsHydrationStore.getState().revision).toBe(3);
	});

	test("re-adopting the same revision is idempotent", () => {
		// A commit adopts its own snapshot, then the `settings:changed` echo for
		// that same write arrives at the same revision. Identical data, no snap.
		adoptSettingsSnapshot(snapshotWith(5, 60));
		expect(adoptSettingsSnapshot(snapshotWith(5, 60))).toBe(true);
		expect(currentBrightness()).toBe(60);
	});

	test("a newer snapshot cannot wipe a pending optimistic edit", () => {
		// The regression: a hotkey is recorded (optimistic store edit, debounced
		// save still pending) and a broadcast from another save arrives at a NEWER
		// revision but with the PRE-edit hotkeys section. Wholesale adoption wiped
		// the combo — and the debounced save then persisted the wiped value.
		getSettingsStoreState().updateHotkeysSettings({
			brightnessUp: "Shift+Alt+S",
		});
		markSectionsEdited("hotkeys");
		expect(adoptSettingsSnapshot(snapshotWith(2, 42))).toBe(true);
		// The unrelated section adopted; the pending section kept the local edit.
		expect(currentBrightness()).toBe(42);
		expect(getSettingsStoreState().settings.hotkeys.brightnessUp).toBe(
			"Shift+Alt+S",
		);
	});

	test("rebases disjoint fields in the same pending section", () => {
		getSettingsStoreState().updateHotkeysSettings({ brightnessUp: "F6" });
		markSectionsEdited("hotkeys");
		const remote = snapshotWith(2, 42);
		remote.settings.hotkeys.brightnessDown = "F7";
		remote.settings.hotkeys.brightnessUp = "";

		expect(adoptSettingsSnapshot(remote)).toBe(true);
		const { hotkeys } = getSettingsStoreState().settings;
		expect(hotkeys.brightnessUp).toBe("F6");
		expect(hotkeys.brightnessDown).toBe("F7");
	});

	test("tracks a nested leaf without protecting its whole object", () => {
		const current = getSettingsStoreState().settings.display;
		getSettingsStoreState().updateDisplaySettings({
			modes: {
				...current.modes,
				custom: {
					...current.modes["custom"]!,
					brightnessDay: 33,
				},
			},
		});
		markSectionsEdited("display");
		const remote = snapshotWith(2, 90);
		remote.settings.display.modes["custom"]!.kelvinDay = 6200;

		expect(adoptSettingsSnapshot(remote)).toBe(true);
		const custom = getSettingsStoreState().settings.display.modes["custom"]!;
		expect(custom.brightnessDay).toBe(33);
		expect(custom.kelvinDay).toBe(6200);
	});

	test("a settled section adopts snapshots normally again", () => {
		getSettingsStoreState().updateHotkeysSettings({
			brightnessUp: "Shift+Alt+S",
		});
		const seq = markSectionsEdited("hotkeys");
		settleSections(["hotkeys"], seq);
		const snapshot = snapshotWith(2, 42);
		snapshot.settings.hotkeys = {
			...snapshot.settings.hotkeys,
			brightnessUp: "",
		};
		adoptSettingsSnapshot(snapshot);
		expect(getSettingsStoreState().settings.hotkeys.brightnessUp).toBe("");
	});

	test("an edit newer than a partial settle stays pending", () => {
		getSettingsStoreState().updateHotkeysSettings({ brightnessUp: "F5" });
		const first = markSectionsEdited("hotkeys");
		// A second edit races in AFTER the save was built…
		getSettingsStoreState().updateHotkeysSettings({ brightnessUp: "F6" });
		markSectionsEdited("hotkeys");
		// …so settling against the first build must NOT clear the section.
		settleSections(["hotkeys"], first);
		expect(adoptSettingsSnapshot(snapshotWith(2, 42))).toBe(true);
		expect(getSettingsStoreState().settings.hotkeys.brightnessUp).toBe("F6");
	});
});
