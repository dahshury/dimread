import type { AutoDarkSettings, PartialSettings } from "@/bindings";
import {
	enqueueSettingsSave,
	markSectionsEdited,
	getSettingsStoreState,
} from "@/entities/setting";

/**
 * Auto Dark settings persistence (FEATURE-PARITY F9.5-F9.6).
 *
 * The MagicX → Auto Dark section edits the `autoDark` section, which the shared
 * settings window never touches — so this slice owns its save path. Each edit
 * lands in the local zustand store immediately (optimistic UI) and is then
 * persisted through the shared, serialized save coordinator (`entities/setting`),
 * which posts through the revision-checked `settings_save`; the backend
 * broadcasts `settings:changed`, re-syncing every window and prompting the
 * `magicx::theme` scheduler to re-evaluate.
 */

/** Build the `autoDark` section patch from the CURRENT store (read at execution
 *  time so rapid edits coalesce). */
function buildPatch(): PartialSettings {
	const { settings } = getSettingsStoreState();
	return { autoDark: settings.autoDark };
}

/** Apply an `autoDark` patch to the local store and persist it. Resolves once
 *  the backend write has landed. */
export function patchAutoDarkSettings(
	patch: Partial<AutoDarkSettings>,
): Promise<void> {
	// The Zod store narrows `systemTheme` to an enum while patches carry
	// the tauri-specta `string` shape; the two are interchangeable for a
	// whole-section merge (same bridge the settings window's patcher uses).
	(
		getSettingsStoreState().updateAutoDarkSettings as (
			p: Partial<AutoDarkSettings>,
		) => void
	)(patch);
	markSectionsEdited("autoDark");
	return enqueueSettingsSave(buildPatch);
}
