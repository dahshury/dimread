import type { AppSettingsOutput } from "@/shared/config/settings-schema";

/**
 * Per-section optimistic-edit ledger.
 *
 * An edit lands in the local store instantly but reaches the backend later
 * (debounce + queued save). In that window, ANY authoritative whole-tree
 * snapshot — a save's echo, the `settings:changed` broadcast from another
 * window or from a hotkey action — predates the edit and would silently wipe
 * it on adoption; the debounced save then persists the wiped (stale) value,
 * making the loss durable. This ledger records which sections hold unsaved
 * edits so snapshot adoption ({@link adoptSettingsSnapshot}) can overlay them,
 * and the save coordinator can settle them once they are durably written.
 *
 * Sequence numbers make settling precise: a section is settled only when the
 * completed save was built AFTER the section's latest edit — an edit that
 * raced in mid-save stays pending and keeps its overlay protection.
 */

export type SettingsSectionKey = keyof AppSettingsOutput;

let editSeq = 0;
const pending = new Map<SettingsSectionKey, number>();

/** Record an optimistic edit to the given sections. Call at EDIT time (right
 *  after mutating the store), not at flush time — the protection window is
 *  edit → durable write, and marking late leaves the debounce gap exposed. */
export function markSectionsEdited(
	...sections: readonly SettingsSectionKey[]
): number {
	editSeq += 1;
	for (const section of sections) {
		pending.set(section, editSeq);
	}
	return editSeq;
}

/** The sequence stamp of the newest edit (0 = none yet). A save captures this
 *  right after building its patch, then settles against it on success. */
export function currentEditSeq(): number {
	return editSeq;
}

/** Sections with optimistic edits not yet confirmed durably saved. */
export function pendingSectionKeys(): SettingsSectionKey[] {
	return Array.from(pending.keys());
}

/** Settle sections a completed save covered: each is cleared only if its
 *  latest edit predates the save's build (`upToSeq`) — newer racing edits
 *  stay pending. */
export function settleSections(
	sections: readonly SettingsSectionKey[],
	upToSeq: number,
): void {
	for (const section of sections) {
		const markedAt = pending.get(section);
		if (markedAt !== undefined && markedAt <= upToSeq) {
			pending.delete(section);
		}
	}
}

/** Test-only: reset the ledger between cases. */
export function resetPendingEditsForTests(): void {
	pending.clear();
	editSeq = 0;
}
