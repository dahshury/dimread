import { useEffect, useState } from "react";
import { commands, type DisplayOutput, events } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

/**
 * The engine's live output (Kelvin / brightness% / mode / phase). Seeds from
 * `display_current` on mount and stays fresh via the `display:state` broadcast,
 * so the panel's readout and the day/night phase never poll. `null` until the
 * first value arrives (or forever in a non-native browser preview).
 */
export function useDisplayState(): DisplayOutput | null {
	const [state, setState] = useState<DisplayOutput | null>(null);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		void commands
			.displayCurrent()
			.then((output) => {
				if (!disposed) {
					setState(output);
				}
			})
			.catch(() => undefined);
		const unsubscribe = subscribeNativeEvent(events.displayState, (event) => {
			setState(event.payload);
		});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, []);

	return state;
}
