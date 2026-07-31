import type { SettingsSnapshot } from "@/bindings";
import { isLocale, useLocaleStore } from "@/shared/i18n";
import { overlayPendingEdits } from "./pending-edits";
import { useSettingsHydrationStore } from "./settings-hydration-store";
import { getSettingsStoreState, normalizeSettings } from "./settings-store";

/**
 * Adopt an authoritative backend snapshot into the local store — refusing to
 * move BACKWARDS, and refusing to wipe unsaved local edits.
 *
 * Every path that hands the renderer a whole settings tree goes through here:
 * the boot hydration, the `settings:changed` broadcast, a save's echo, and the
 * snapshot `display_set_value` returns. They are all racing each other and
 * racing local optimistic edits, so two guards apply:
 *
 *  - **Revision guard.** A snapshot older than what the store already adopted
 *    is dropped (e.g. the boot snapshot resolving after an edit already
 *    advanced the revision — the "snaps back on first mount" bug).
 *  - **Pending-edit overlay.** A snapshot can be NEWER by revision yet still
 *    predate a local optimistic edit that hasn't been saved (debounced saves
 *    leave a window of hundreds of ms). Wholesale adoption would wipe the
 *    edit — and the debounced save would then persist the wiped value, making
 *    the loss durable (the "recorded hotkey vanishes from the picker" bug).
 *    Sections marked pending in the edit ledger keep their local value; the
 *    snapshot fills in everything else.
 *
 * Returns whether the snapshot was applied, so callers can tell "hydrated"
 * from "superseded".
 */
export function adoptSettingsSnapshot(snapshot: SettingsSnapshot): boolean {
	const { revision, setRevision } = useSettingsHydrationStore.getState();
	if (snapshot.revision < revision) {
		return false;
	}
	const store = getSettingsStoreState();
	const incoming = normalizeSettings(snapshot.settings);
	overlayPendingEdits(incoming, store.settings);
	store.setSettings(incoming);
	// The persisted settings tree and the per-window locale store intentionally
	// coexist: the latter drives use-intl immediately. Whole-tree adoption
	// (import, reset, or another window's save) must update both just like the
	// locale picker does, otherwise the UI language and persisted value diverge.
	if (isLocale(incoming.appearance.locale)) {
		useLocaleStore.getState().setLocale(incoming.appearance.locale);
	}
	setRevision(snapshot.revision);
	return true;
}
