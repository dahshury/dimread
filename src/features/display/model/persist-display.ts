import {
	commands,
	type DayNightSettings,
	type DisplayEdit,
	type DisplaySettings,
	type PartialSettings,
} from "@/bindings";
import {
	adoptSettingsSnapshot,
	enqueueSettingsSave,
	markSectionsEdited,
	getSettingsStoreState,
} from "@/entities/setting";
import { hasNativeRuntime } from "@/shared/api";

/**
 * Display / day-night settings persistence.
 *
 * The Display panel edits the `display` and `dayNight` sections, which the
 * shared settings window never touches — so this slice owns their save path.
 * Each edit lands in the local zustand store immediately (optimistic UI) and is
 * then persisted through the shared, serialized save coordinator
 * (`entities/setting`), which posts through the revision-checked `settings_save`
 * command; the backend broadcasts `settings:changed`, re-syncing every window.
 *
 * The coordinator serializes with the Options-tab saver too (they share one
 * chain + one edit counter), so two quick edits — or an edit here racing an
 * Options edit — can neither conflict on the same revision nor clobber each
 * other via a stale whole-tree echo. The returned promise resolves only after
 * the backend write lands, so the caller can safely trigger an engine refresh
 * (`display_preview_end`) knowing the persisted value is in place.
 */

/**
 * Persist ONE colour-temperature / brightness edit.
 *
 * Deliberately NOT a `patchDisplaySettings` call. That path serializes the
 * whole `display` section from this window's store, which means any window
 * whose copy has drifted overwrites every other window's work on its next save
 * — observed as a slider release landing and then being reverted a second later
 * by a stale surface. `display_set_value` takes the edit itself and performs
 * the read-modify-write in Rust under the settings write lock, so concurrent
 * editors serialize instead of clobbering. See `src-tauri/src/display/values.rs`.
 */
export async function commitDisplayValue(edit: DisplayEdit): Promise<boolean> {
	if (!hasNativeRuntime()) {
		return true;
	}
	try {
		const result = await commands.displaySetValue(edit);
		if (result.status === "error") {
			console.error(`[display] failed to persist edit: ${result.error}`);
			return false;
		}
		// Adopt the authoritative post-write snapshot HERE, before the caller drops
		// its local drag override. Relying on the `settings:changed` broadcast
		// instead loses the race every time: that event is delivered asynchronously,
		// so the store still holds the PRE-drag value at the moment the override is
		// released, and the slider visibly snaps back before jumping to the value
		// that was just committed.
		adoptSettingsSnapshot(result.data);
		return true;
	} catch (error) {
		console.error("[display] failed to persist edit", error);
		return false;
	}
}

type Section = "dayNight" | "display";

/** Build the section patch from the CURRENT store (read at execution time so
 *  rapid edits coalesce). */
function buildSectionPatch(section: Section): PartialSettings {
	const { settings } = getSettingsStoreState();
	return section === "display"
		? { display: settings.display }
		: { dayNight: settings.dayNight };
}

/** Apply a `display` patch to the local store and persist it. Resolves once the
 *  backend write has landed. */
export function patchDisplaySettings(
	patch: Partial<DisplaySettings>,
): Promise<void> {
	// The store's updater is typed against the Zod (`Record`) shape while patches
	// carry the tauri-specta (`Partial<Record>`) shape for the map fields; the two
	// are structurally interchangeable for a whole-section merge (same bridge the
	// settings window's patcher uses).
	(
		getSettingsStoreState().updateDisplaySettings as (
			p: Partial<DisplaySettings>,
		) => void
	)(patch);
	markSectionsEdited("display");
	return enqueueSettingsSave(() => buildSectionPatch("display"));
}

/** Apply a `dayNight` patch to the local store and persist it. */
export function patchDayNightSettings(
	patch: Partial<DayNightSettings>,
): Promise<void> {
	getSettingsStoreState().updateDayNightSettings(patch);
	markSectionsEdited("dayNight");
	return enqueueSettingsSave(() => buildSectionPatch("dayNight"));
}
