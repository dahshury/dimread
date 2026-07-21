import { useEffect, useReducer } from "react";
import { events } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";
import {
	INITIAL_OVERLAY_STATE,
	type OverlayState,
	overlayReducer,
} from "../lib/notification-core";

/**
 * Overlay-window state: subscribe to `overlay:notify` / `overlay:dismiss`
 * and run the renderer-side expiry clock.
 *
 * Timing contract with the Rust side (`src-tauri/src/overlay`): the renderer
 * starts its exit animation at `durationMs` (this hook's timer, or the
 * dismiss event); Rust hides the OS window at `durationMs + exit grace`, so
 * the retract always finishes compositing before the hide.
 */
export function useOverlayNotifications(): OverlayState {
	const [state, dispatch] = useReducer(overlayReducer, INITIAL_OVERLAY_STATE);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			// Browser preview: nothing emits overlay events; stay hidden.
			return;
		}
		const unsubscribeNotify = subscribeNativeEvent(
			events.overlayNotify,
			(event) => {
				dispatch({ type: "notify", notification: event.payload });
			},
		);
		const unsubscribeDismiss = subscribeNativeEvent(events.overlayDismiss, () =>
			dispatch({ type: "dismiss" }),
		);
		return () => {
			unsubscribeNotify();
			unsubscribeDismiss();
		};
	}, []);

	// One expiry timer per shown notification; the generation guard makes a
	// stale timeout a no-op after a replacement notify.
	useEffect(() => {
		if (!(state.visible && state.notification)) {
			return;
		}
		const generation = state.generation;
		const timer = setTimeout(() => {
			dispatch({ type: "expired", generation });
		}, state.notification.durationMs);
		return () => clearTimeout(timer);
	}, [state.visible, state.generation, state.notification]);

	return state;
}
