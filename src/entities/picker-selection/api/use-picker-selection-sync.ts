import { useEffect } from "react";
import { NATIVE_EVENTS, onCast } from "@/shared/api";
import {
	type PickerSelectionBroadcast,
	usePickerSelectionStore,
} from "../model/picker-selection-store";

/**
 * Subscribe this window to `picker:selected` broadcasts so its
 * picker-selection store converges with the window the user is clicking in.
 * Mount once per window that shows the selection (main's footer chip) or
 * edits it (the picker view).
 */
export function usePickerSelectionSync(): void {
	const applyRemote = usePickerSelectionStore((s) => s.applyRemote);
	useEffect(
		() =>
			onCast<PickerSelectionBroadcast>(
				NATIVE_EVENTS.PICKER_SELECTED,
				applyRemote,
			),
		[applyRemote],
	);
}
