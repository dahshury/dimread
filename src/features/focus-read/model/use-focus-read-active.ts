import { useEffect, useState } from "react";
import { commands, events } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

/**
 * Whether Focus Read is currently active, for the panel's Preview toggle. Seeds
 * from `focus_active_state` on mount and follows the `focus:state` broadcast, so
 * the button reflects a preview started here, by the hotkey, or by ESC-to-quit.
 */
export function useFocusReadActive(): boolean {
	const [active, setActive] = useState(false);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let eventReceived = false;
		return subscribeNativeEvent(
			events.focusState,
			(event) => {
				eventReceived = true;
				setActive(event.payload.read);
			},
			async (isDisposed) => {
				const state = await commands.focusActiveState();
				if (!(isDisposed() || eventReceived)) {
					setActive(state.read);
				}
			},
		);
	}, []);

	return active;
}
