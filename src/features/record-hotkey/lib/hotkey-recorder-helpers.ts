import { formatKeyName } from "@/shared/lib/format-key-name";
import { compareHotkeys, isHotkeyConflict } from "./hotkey-conflict";

/**
 * One row in the `forbiddenCombos` prop. `combo` is the accelerator another
 * hotkey is currently bound to; `label` is that hotkey's human-readable name
 * (already i18n-resolved by the caller) so the inline error identifies WHICH
 * binding is colliding, not just THAT one is.
 */
export interface ForbiddenCombo {
	combo: string;
	label: string;
}

export function formatCombo(combo: string): string {
	// Drop empty/whitespace-only segments so a partial or malformed accelerator
	// ("", "Ctrl+", "Ctrl+ ") renders cleanly ("", "Ctrl") instead of leaking a
	// dangling " + " or formatting an empty token.
	return combo
		.split("+")
		.filter((token) => token.trim().length > 0)
		.map(formatKeyName)
		.join(" + ");
}

/**
 * Resolve the text shown in the hotkey display box. Pure for testability.
 * `emptyLabel` renders when the binding is unset (the starter allows "" =
 * unbound, unlike WinSTT where every binding always has a value).
 */
export function resolveDisplayText(
	recording: boolean,
	liveKeys: string[],
	currentKey: string,
	pressKeysLabel: string,
	emptyLabel: string,
): string {
	if (!recording) {
		const formatted = formatCombo(currentKey);
		return formatted.length > 0 ? formatted : emptyLabel;
	}
	if (liveKeys.length > 0) {
		return liveKeys.map(formatKeyName).join(" + ");
	}
	return pressKeysLabel;
}

/** True when the resolved display text is a hint, not a recorded combo. */
export function isHintText(
	recording: boolean,
	liveKeys: string[],
	currentKey: string,
): boolean {
	if (recording) {
		return liveKeys.length === 0;
	}
	return formatCombo(currentKey).length === 0;
}

/**
 * Scan `forbiddenCombos` for the first conflict against `candidate`. Pure so
 * the wiring stays test-friendly and the component body stays small.
 */
export function findConflict(
	candidate: string,
	forbiddenCombos: readonly ForbiddenCombo[] | undefined,
): ForbiddenCombo | null {
	if (!forbiddenCombos) {
		return null;
	}
	for (const entry of forbiddenCombos) {
		if (isHotkeyConflict(compareHotkeys(candidate, entry.combo))) {
			return entry;
		}
	}
	return null;
}
