import type { OverlayNotification } from "@/bindings";

/**
 * Pure state core for the overlay pill. Semantics (mirroring the Rust side in
 * `src-tauri/src/overlay`):
 *   - `notify` REPLACES the current notification (no queue — last wins) and
 *     restarts the visible window; byte-identical repeats while visible are
 *     idempotent because the backend re-emits the same event a few times to
 *     cover the first-show listener race.
 *   - `dismiss` starts the exit (visible → false) but KEEPS the notification
 *     so the retracting pill still renders its content.
 *   - `expired` only applies when its generation is still current — a newer
 *     notify invalidates a stale timer.
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
	| { type: "dismiss" }
	| { type: "expired"; generation: number };

export function sameNotification(
	a: OverlayNotification | null,
	b: OverlayNotification,
): boolean {
	return (
		a !== null &&
		(a.title ?? null) === (b.title ?? null) &&
		a.message === b.message &&
		a.tone === b.tone &&
		a.durationMs === b.durationMs
	);
}

export function overlayReducer(
	state: OverlayState,
	action: OverlayAction,
): OverlayState {
	switch (action.type) {
		case "notify":
			// Duplicate delivery of the CURRENT visible notification (backend
			// re-emit) — keep the state identity so the expiry timer isn't
			// restarted and the content doesn't re-render.
			if (
				state.visible &&
				sameNotification(state.notification, action.notification)
			) {
				return state;
			}
			return {
				generation: state.generation + 1,
				notification: action.notification,
				visible: true,
			};
		case "dismiss":
			if (!state.visible) {
				return state;
			}
			// Bump the generation so a pending expiry can't fire again later.
			return { ...state, generation: state.generation + 1, visible: false };
		case "expired":
			if (action.generation !== state.generation || !state.visible) {
				return state;
			}
			return { ...state, visible: false };
		default:
			return state;
	}
}
