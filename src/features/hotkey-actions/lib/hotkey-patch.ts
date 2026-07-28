import type { HotkeysSettings } from "@/bindings";

/**
 * A single hotkey-field patch (one accelerator per press). Keyed by the action
 * id, which is exactly the `settings.hotkeys` field name — so the patch is a
 * one-field `Partial<HotkeysSettings>` the store's section patcher merges in.
 */
export type HotkeyPatch = Partial<HotkeysSettings>;

/** Every hotkey binding id = every `settings.hotkeys` field. */
export type HotkeyId = keyof HotkeysSettings;

/** Build the settings patch that BINDS `id` to `combo` (trimmed). */
export function buildHotkeyPatch(id: HotkeyId, combo: string): HotkeyPatch {
	return { [id]: combo.trim() } as HotkeyPatch;
}

/** Build the settings patch that CLEARS `id` (unbinds it, `"" `). */
export function clearHotkeyPatch(id: HotkeyId): HotkeyPatch {
	return { [id]: "" } as HotkeyPatch;
}

/** Split an accelerator string into its tokens (trimmed, empties dropped). */
export function splitCombo(combo: string): string[] {
	return combo
		.split("+")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

/** Canonical accelerator string: tokens trimmed, empties dropped, `+`-joined. */
export function normalizeCombo(combo: string): string {
	return splitCombo(combo).join("+");
}

/** Exhaustive id roster — `Record<HotkeyId, …>` makes adding
 *  a `HotkeysSettings` field without listing it here a compile error, so the
 *  conflict set below can never silently miss a binding again. */
const HOTKEY_ID_ROSTER: Record<HotkeyId, true> = {
	toggleMain: true,
	brightnessUp: true,
	brightnessDown: true,
	tempUp: true,
	tempDown: true,
	toggleFilter: true,
	toggleReading: true,
	toggleEditing: true,
	focusRead: true,
	focusBlur: true,
	magicDark: true,
	magicGray: true,
};

export const ALL_HOTKEY_IDS = Object.keys(HOTKEY_ID_ROSTER) as HotkeyId[];

/**
 * Every hotkey row in the order the Hotkeys tab lists them: the seven display
 * actions, the window toggle, then the Focus Read/Blur and MagicX bindings.
 *
 * ONE tab owns every binding — the Focus and MagicX tabs used to carry their own
 * recorder rows, which split the roster across three places and made conflicts
 * hard to see. Those tabs now keep only their effect options.
 *
 * `satisfies` types the ids; a unit test keeps this list a permutation of
 * `ALL_HOTKEY_IDS`, so a new `HotkeysSettings` field can't stay unreachable.
 */
export const HOTKEY_ROW_ORDER = [
	"brightnessUp",
	"brightnessDown",
	"tempUp",
	"tempDown",
	"toggleFilter",
	"toggleReading",
	"toggleEditing",
	"toggleMain",
	"focusRead",
	"focusBlur",
	"magicDark",
	"magicGray",
] as const satisfies readonly HotkeyId[];

/** One other binding a recorder must not collide with. */
export interface OtherCombo {
	id: HotkeyId;
	combo: string;
}

/**
 * Every currently-bound hotkey EXCEPT `exceptId`, as `{ id, combo }` rows — the
 * conflict set a recorder checks against so one accelerator can't drive two
 * actions. Covers the WHOLE hotkeys section (display actions, `toggleMain`,
 * Focus Read/Blur, MagicX): the backend rejects only exact cross-id
 * duplicates, so the subset/superset screening is only as good as this roster.
 * Empty (unbound) fields are skipped.
 */
export function collectOtherCombos(
	hotkeys: HotkeysSettings,
	exceptId: HotkeyId,
): OtherCombo[] {
	const out: OtherCombo[] = [];
	for (const id of ALL_HOTKEY_IDS) {
		if (id === exceptId) {
			continue;
		}
		const combo = hotkeys[id];
		if (combo.trim().length > 0) {
			out.push({ id, combo });
		}
	}
	return out;
}
