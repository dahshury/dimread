import { commands, type PartialSettings } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";
import { adoptSettingsSnapshot } from "./adopt-settings-snapshot";
import {
	currentEditSeq,
	type SettingsSectionKey,
	settleSections,
} from "./pending-edits";
import { useSettingsHydrationStore } from "./settings-hydration-store";

/**
 * Shared, serialized settings-save coordinator.
 *
 * Several slices persist DIFFERENT sections of the SAME settings tree through
 * the revision-checked `settings_save` pipeline — the Display slice
 * (`features/display`) posts `display` / `dayNight`, the Options tab
 * (`views/main`) posts every other section. Routing every save through ONE
 * promise chain closes the races a per-slice saver cannot:
 *
 *  1. **Lost update.** `settings_save` echoes the whole backend tree. That
 *     echo (like every authoritative snapshot) is adopted through
 *     {@link adoptSettingsSnapshot}, which overlays sections still marked
 *     pending in the edit ledger (`pending-edits`) — so an echo can never
 *     revert an optimistic edit that landed after the save was built.
 *  2. **Stale-revision conflict between two savers.** Serializing through one
 *     chain means the second save only runs after the first committed and
 *     advanced the revision. A conflict can still arrive from ANOTHER window's
 *     save racing this one; that case re-reads the authoritative snapshot and
 *     retries once (the build closure re-reads the store, so the retry posts
 *     the freshest values against the fresh revision).
 *
 * `build` is invoked at EXECUTION time (after earlier saves commit) so it reads
 * the freshest store values and the freshest revision — rapid edits coalesce.
 */

let saveChain: Promise<void> = Promise.resolve();

/** The section keys a built patch actually carries (non-null entries). */
function sectionsInPatch(patch: PartialSettings): SettingsSectionKey[] {
	return (Object.keys(patch) as SettingsSectionKey[]).filter(
		(key) => patch[key] != null,
	);
}

async function runSave(build: () => PartialSettings): Promise<void> {
	if (!hasNativeRuntime()) {
		// Browser preview: the localStorage-backed store is the only sink.
		return;
	}
	const maxAttempts = 2;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const patch = build();
		// Everything the patch carries as of NOW is covered by this save; edits
		// racing in after this stamp stay pending (and overlay-protected).
		const buildSeq = currentEditSeq();
		const { revision } = useSettingsHydrationStore.getState();
		const result = await commands.settingsSave(patch, revision);
		if (result.status === "ok") {
			// Advance the revision FIRST so the echo passes the adoption guard,
			// settle the saved sections, then adopt the echo — the overlay keeps
			// any section that was re-edited mid-save.
			useSettingsHydrationStore.getState().setRevision(result.data.revision);
			settleSections(sectionsInPatch(patch), buildSeq);
			adoptSettingsSnapshot(result.data);
			return;
		}
		const conflict = result.error.includes("revision conflict");
		if (!conflict || attempt === maxAttempts) {
			console.error(`[settings] save failed: ${result.error}`);
			return;
		}
		// Another window advanced the revision under us. Re-read the
		// authoritative tree (adoption overlays our pending sections), then
		// rebuild + repost against the fresh revision.
		try {
			adoptSettingsSnapshot(await commands.settingsLoadSnapshot());
		} catch (error) {
			console.error("[settings] snapshot re-read failed:", error);
			return;
		}
	}
}

/**
 * Queue a settings save behind all prior saves. The build closure runs at
 * execution time; mark edited sections via `markSectionsEdited` at edit time
 * so they stay overlay-protected until this save lands. Resolves once the
 * backend write lands.
 */
export function enqueueSettingsSave(
	build: () => PartialSettings,
): Promise<void> {
	saveChain = saveChain
		.then(() => runSave(build))
		.catch((error) => {
			console.error("[settings] save error:", error);
		});
	return saveChain;
}
