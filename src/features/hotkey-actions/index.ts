export {
	type DisplayHotkeyActionId,
	DISPLAY_HOTKEY_ACTIONS,
	hotkeyActionAccelerator,
	hotkeyActionLabelKey,
} from "./model/hotkey-actions";
export {
	ALL_HOTKEY_IDS,
	buildHotkeyPatch,
	clearHotkeyPatch,
	collectOtherCombos,
	type HotkeyId,
	type HotkeyPatch,
	normalizeCombo,
	type OtherCombo,
	splitCombo,
} from "./lib/hotkey-patch";
export { useHotkeyLabels } from "./model/use-hotkey-labels";
