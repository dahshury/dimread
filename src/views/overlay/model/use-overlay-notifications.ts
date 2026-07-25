import { useEffect, useReducer } from "react";
import { commands, events } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEventPair } from "@/shared/api";
import {
	INITIAL_OVERLAY_STATE,
	type OverlayState,
	overlayReducer,
} from "../lib/notification-core";

/**
 * Overlay-window state: subscribe to `overlay:notify` / `overlay:dismiss`
 * using a listener-first, cached-snapshot handshake. Rust owns the semantic
 * duration deadline; the renderer owns the real exit-animation callback.
 */
export function useOverlayNotifications(): OverlayState {
	const [state, dispatch] = useReducer(overlayReducer, INITIAL_OVERLAY_STATE);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			// Browser preview: nothing emits overlay events; stay hidden.
			return;
		}
		return subscribeNativeEventPair(
			events.overlayNotify,
			(event) => {
				dispatch({ type: "notify", notification: event.payload });
			},
			events.overlayDismiss,
			(event) => {
				dispatch({ type: "dismiss", sequence: event.payload.sequence });
			},
			async (isDisposed) => {
				const snapshot = await commands.overlaySnapshot();
				if (isDisposed()) {
					return;
				}
				if (snapshot.notification) {
					dispatch({ type: "notify", notification: snapshot.notification });
				} else if (snapshot.sequence > 0) {
					dispatch({ type: "dismiss", sequence: snapshot.sequence });
				}
			},
		);
	}, []);

	return state;
}
