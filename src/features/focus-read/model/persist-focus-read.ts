import type { FocusReadSettings, PartialSettings } from "@/bindings";
import {
	enqueueSettingsSave,
	markSectionsEdited,
	getSettingsStoreState,
} from "@/entities/setting";

/**
 * Focus Read settings persistence.
 *
 * The Focus Read panel edits the `focusRead` section (transparency / colour /
 * band height); its toggle hotkey is bound on the Hotkeys tab, which owns the
 * whole `hotkeys` section. Each edit lands in the local zustand store
 * immediately (optimistic UI) and is then persisted through the shared,
 * serialized save coordinator (`entities/setting`)
 * — the SAME chain the Display and Options savers use, so writes to the same
 * tree can never race the same revision or clobber each other via a stale
 * whole-tree echo. The build closures read the CURRENT store at execution time,
 * so rapid edits coalesce.
 */

/** Apply a `focusRead` patch to the local store and persist it. Resolves once
 *  the backend write has landed. */
export function patchFocusReadSettings(
	patch: Partial<FocusReadSettings>,
): Promise<void> {
	getSettingsStoreState().updateFocusReadSettings(patch);
	markSectionsEdited("focusRead");
	return enqueueSettingsSave(
		(): PartialSettings => ({
			focusRead: getSettingsStoreState().settings.focusRead,
		}),
	);
}
