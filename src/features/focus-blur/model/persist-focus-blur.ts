import type { FocusBlurSettings, PartialSettings } from "@/bindings";
import {
	enqueueSettingsSave,
	markSectionsEdited,
	getSettingsStoreState,
} from "@/entities/setting";

/**
 * Focus Blur settings persistence (FEATURE-PARITY F8.2).
 *
 * The Focus panel edits the `focusBlur` section, which the shared settings
 * window never touches — so this slice owns its save path. Each edit lands in
 * the local zustand store immediately (optimistic UI) and is then persisted
 * through the shared, serialized save coordinator (`entities/setting`), which
 * posts through the revision-checked `settings_save` command; the backend
 * broadcasts `settings:changed`, re-syncing every window (including the
 * `focus-overlay` renderer, so the live shade picks up a colour/transparency
 * change). The coordinator shares one chain + edit counter with the Display and
 * Options savers, so concurrent edits can't conflict on a revision.
 */
export function patchFocusBlurSettings(
	patch: Partial<FocusBlurSettings>,
): Promise<void> {
	getSettingsStoreState().updateFocusBlurSettings(patch);
	markSectionsEdited("focusBlur");
	return enqueueSettingsSave(
		(): PartialSettings => ({
			focusBlur: getSettingsStoreState().settings.focusBlur,
		}),
	);
}
