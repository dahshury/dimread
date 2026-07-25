import type { OverlayNotification } from "@/bindings";

/**
 * Pure state core for the overlay pill. Semantics (mirroring the Rust side in
 * `src-tauri/src/overlay`):
 *   - `notify` REPLACES the current notification (no queue — last wins) and
 *     restarts the visible window; sequence numbers make delayed event and
 *     snapshot delivery safe in either order.
 *   - `dismiss` starts the exit (visible → false) but KEEPS the notification
 *     so the retracting pill still renders its content.
 */

export interface OverlayState {
	generation: number;
	notification: OverlayNotification | null;
	visible: boolean;
}

export const INITIAL_OVERLAY_STATE: OverlayState = {
	generation: 0,
	notification: null,
	visible: false,
};

export type OverlayAction =
	| { type: "notify"; notification: OverlayNotification }
	| { type: "dismiss"; sequence: number };

export function overlayReducer(
	state: OverlayState,
	action: OverlayAction,
): OverlayState {
	switch (action.type) {
		case "notify":
			if (action.notification.sequence <= state.generation) {
				return state;
			}
			return {
				generation: action.notification.sequence,
				notification: action.notification,
				visible: true,
			};
		case "dismiss":
			if (action.sequence <= state.generation) {
				return state;
			}
			return { ...state, generation: action.sequence, visible: false };
		default:
			return state;
	}
}
