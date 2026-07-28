import type { MagicxSettings, PartialSettings } from "@/bindings";
import {
	enqueueSettingsSave,
	markSectionsEdited,
	getSettingsStoreState,
} from "@/entities/setting";

/**
 * MagicX settings persistence (the Magic Window section owns the `magicx`
 * section; its `magicDark` / `magicGray` accelerators are bound on the Hotkeys
 * tab, which owns the whole `hotkeys` section).
 *
 * Each edit lands in the local zustand store immediately (optimistic UI — the
 * Magic Toolbar window reads `magicx.toolbarColor` from the same synced store)
 * and is then persisted through the shared, serialized save coordinator
 * (`entities/setting`), which posts through the revision-checked `settings_save`
 * command; the backend broadcasts `settings:changed`, re-syncing every window.
 *
 * The coordinator serializes with the Options-tab and Display savers (they share
 * one chain + one edit counter), so a MagicX edit racing an Options edit can
 * neither conflict on the same revision nor clobber the other via a stale
 * whole-tree echo.
 */

/** Build the `magicx` patch from the CURRENT store (read at execution time so
 *  rapid edits coalesce). */
function buildSectionPatch(): PartialSettings {
	return { magicx: getSettingsStoreState().settings.magicx };
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
	return enqueueSettingsSave(buildSectionPatch);
}
