import type { HotkeysSettings } from "@/bindings";

/**
 * The seven DISPLAY hotkey actions (in the order they render in Options →
 * Hotkeys). Each id is used verbatim as three things that must stay in lockstep:
 *   1. the `settings.hotkeys.<id>` field key (camelCase),
 *   2. the backend `hotkey_register` / dispatch id, and
 *   3. the i18n label key `hotkeys.<id>Label`.
 * The Rust side owns the effects (`hotkeys::actions::handle_action`).
 */
export const DISPLAY_HOTKEY_ACTIONS = [
	"brightnessUp",
	"brightnessDown",
	"tempUp",
	"tempDown",
	"toggleFilter",
	"toggleReading",
	"toggleEditing",
] as const;

/** One display hotkey action id (also the `settings.hotkeys` field name). */
export type DisplayHotkeyActionId = (typeof DISPLAY_HOTKEY_ACTIONS)[number];

/** The i18n key (in the `hotkeys` namespace) for an action's row label. */
export function hotkeyActionLabelKey(
	id: DisplayHotkeyActionId,
): `${DisplayHotkeyActionId}Label` {
	return `${id}Label` as const;
}

/** Read one action's current accelerator from a hotkeys settings section. */
export function hotkeyActionAccelerator(
	hotkeys: HotkeysSettings,
	id: DisplayHotkeyActionId,
): string {
	return hotkeys[id];
}
