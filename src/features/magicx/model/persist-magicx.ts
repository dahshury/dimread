import type {
	HotkeysSettings,
	MagicxSettings,
	PartialSettings,
} from "@/bindings";
import {
	enqueueSettingsSave,
	markSectionsEdited,
	getSettingsStoreState,
} from "@/entities/setting";

/**
 * MagicX settings persistence (the Magic Window section owns the `magicx`
 * section and the `magicDark` / `magicGray` hotkey fields).
 *
 * Each edit lands in the local zustand store immediately (optimistic UI — the
 * Magic Toolbar window reads `magicx.toolbarColor` from the same synced store)
 * and is then persisted through the shared, serialized save coordinator
 * (`entities/setting`), which posts through the revision-checked `settings_save`
 * command; the backend broadcasts `settings:changed`, re-syncing every window
 * (and hot-swaps the global hotkeys when the `hotkeys` section changes, so a
 * MagicX combo is armed the moment it is recorded).
 *
 * The coordinator serializes with the Options-tab and Display savers (they share
 * one chain + one edit counter), so a MagicX edit racing an Options edit can
 * neither conflict on the same revision nor clobber the other via a stale
 * whole-tree echo.
 */

type Section = "hotkeys" | "magicx";

/** Build the section patch from the CURRENT store (read at execution time so
 *  rapid edits coalesce). */
function buildSectionPatch(section: Section): PartialSettings {
	const { settings } = getSettingsStoreState();
	return section === "magicx"
		? { magicx: settings.magicx }
		: { hotkeys: settings.hotkeys };
}

/** Apply a `magicx` patch to the local store and persist it. Resolves once the
 *  backend write has landed. */
export function patchMagicxSettings(
	patch: Partial<MagicxSettings>,
): Promise<void> {
	// The store's updater is typed against the Zod (`toolbarAlign` enum) shape
	// while patches carry the tauri-specta (`string`) shape; the two are
	// structurally interchangeable for a whole-section merge (same bridge the
	// settings window's patcher uses).
	(
		getSettingsStoreState().updateMagicxSettings as (
			p: Partial<MagicxSettings>,
		) => void
	)(patch);
	markSectionsEdited("magicx");
	return enqueueSettingsSave(() => buildSectionPatch("magicx"));
}

/** Apply a `hotkeys` patch (MagicX dark/gray rows) to the local store and
 *  persist it. */
export function patchMagicxHotkeys(
	patch: Partial<HotkeysSettings>,
): Promise<void> {
	getSettingsStoreState().updateHotkeysSettings(patch);
	markSectionsEdited("hotkeys");
	return enqueueSettingsSave(() => buildSectionPatch("hotkeys"));
}
