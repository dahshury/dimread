/**
 * Pure keyboard-capture helpers for the DOM-based recorder. The starter emits
 * TAURI accelerator tokens directly ("Ctrl+Shift+Space", "Alt+ArrowUp") —
 * unlike WinSTT, whose native uiohook listener emits side-specific key names
 * that a Rust chokepoint later translates.
 */

/** Canonical modifier ordering inside an emitted combo. */
const MODIFIER_ORDER = new Map<string, number>([
	["Ctrl", 0],
	["Shift", 1],
	["Alt", 2],
	["Super", 3],
]);

const CODE_TO_TOKEN: Record<string, string> = {
	ControlLeft: "Ctrl",
	ControlRight: "Ctrl",
	AltLeft: "Alt",
	AltRight: "Alt",
	ShiftLeft: "Shift",
	ShiftRight: "Shift",
	MetaLeft: "Super",
	MetaRight: "Super",
	Space: "Space",
	Tab: "Tab",
	Enter: "Enter",
	NumpadEnter: "Enter",
	Escape: "Escape",
	Backspace: "Backspace",
	Delete: "Delete",
	Insert: "Insert",
	Home: "Home",
	End: "End",
	PageUp: "PageUp",
	PageDown: "PageDown",
	ArrowLeft: "ArrowLeft",
	ArrowRight: "ArrowRight",
	ArrowUp: "ArrowUp",
	ArrowDown: "ArrowDown",
};

/**
 * Map a KeyboardEvent's physical `code` to a Tauri accelerator token, or null
 * for keys the recorder ignores (media keys, IME, …). Layout-independent by
 * design: `code` identifies the physical key, matching how the global
 * shortcut fires later.
 */
export function keyNameFromEvent(
	event: Pick<KeyboardEvent, "code">,
): string | null {
	const mapped = CODE_TO_TOKEN[event.code];
	if (mapped) {
		return mapped;
	}
	if (/^Key[A-Z]$/.test(event.code)) {
		return event.code.slice(3);
	}
	if (/^Digit[0-9]$/.test(event.code)) {
		return event.code.slice(5);
	}
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) {
		return event.code;
	}
	if (/^Numpad[0-9]$/.test(event.code)) {
		return event.code;
	}
	return null;
}

export function isModifierToken(token: string): boolean {
	return MODIFIER_ORDER.has(token);
}

/** Dedupe + canonical order: modifiers first (fixed order), then main keys. */
export function sortKeys(keys: readonly string[]): string[] {
	return Array.from(new Set(keys)).sort((a, b) => {
		const aRank = MODIFIER_ORDER.get(a);
		const bRank = MODIFIER_ORDER.get(b);
		if (aRank !== undefined || bRank !== undefined) {
			return (aRank ?? 100) - (bRank ?? 100);
		}
		return a.localeCompare(b);
	});
}

/** DOM modifier names (for `getModifierState`) → accelerator tokens. */
const MODIFIER_STATES: readonly (readonly [string, string])[] = [
	["Control", "Ctrl"],
	["Shift", "Shift"],
	["Alt", "Alt"],
	["Meta", "Super"],
];

/**
 * The modifiers the OS reports as held RIGHT NOW, straight from the event's
 * modifier bitmask. This is the authoritative held-modifier source: tracking
 * keydown/keyup pairs breaks on Windows whenever a keyup is swallowed (the
 * Alt+Shift layout switch, Win-key menu handling), while the bitmask on the
 * next event is always current.
 */
export function heldModifiersFromEvent(
	event: Pick<KeyboardEvent, "getModifierState">,
): string[] {
	const held: string[] = [];
	for (const [state, token] of MODIFIER_STATES) {
		if (event.getModifierState(state)) {
			held.push(token);
		}
	}
	return held;
}

/**
 * Build the accelerator for a completed chord: the held modifiers (canonical
 * order) plus exactly ONE main key. A missing/modifier main key yields null —
 * the plugin can't register modifier-only shortcuts, and a chord with one main
 * key is the only shape the accelerator parser accepts.
 */
export function comboFromChord(
	modifiers: readonly string[],
	mainKey: string,
): string | null {
	if (mainKey.length === 0 || isModifierToken(mainKey)) {
		return null;
	}
	return [...sortKeys(modifiers.filter(isModifierToken)), mainKey].join("+");
}
