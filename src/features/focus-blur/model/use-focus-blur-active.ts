import { useEffect, useState } from "react";
import { commands, events } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

/**
 * Whether Focus Blur is currently running, for the panel's Enable switch. Seeds
 * from `focus_active_state` on mount and follows the `focus:state` broadcast, so
 * the switch reflects a toggle made here, by the hotkey, or by the boot
 * auto-start — the single source of truth for the running effect.
 */
export function useFocusBlurActive(): boolean {
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
				setActive(event.payload.blur);
			},
			async (isDisposed) => {
				const state = await commands.focusActiveState();
				if (!(isDisposed() || eventReceived)) {
					setActive(state.blur);
				}
			},
		);
	}, []);

	return active;
}
