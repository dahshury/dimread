import { emit } from "@tauri-apps/api/event";
import {
	hasNativeRuntime,
	NATIVE_EVENTS,
	onCast,
	type Unsubscribe,
} from "@/shared/api";
import type { EditPhase } from "./display-values";

/**
 * Cross-surface sync for an IN-FLIGHT slider drag.
 *
 * The Display tab and the tray flyout host the same sliders and must never look
 * disconnected: dragging in one moves the other in real time. They cannot learn
 * it through the usual channel, because a drag is deliberately NOT persisted per
 * frame (see `useDisplaySliders`) — `settings:changed` stays silent until the
 * pointer is released.
 *
 * The engine's `display:state` broadcast is not a substitute either. It reports
 * the applied OUTPUT — day/night interpolated, per-monitor resolved — so it
 * cannot tell a surface what the edited PRESET should read.
 *
 * So the edit itself is broadcast, together with the target it lands on. A
 * surface mirrors a remote drag only when it is showing that exact target
 * (same mode, same phase, same monitor), and otherwise keeps rendering its own
 * stored value — the tray edits the live phase across all monitors, while the
 * Display tab may be showing the OFF phase or a single monitor, and those
 * sliders genuinely mean different things.
 */

/** The live values a surface is dragging. A `null` axis is not part of the
 *  drag — the receiving surface keeps rendering its own stored value for it. */
export interface DisplayEditValue {
	brightness: number | null;
	kelvin: number | null;
}

/** What a surface announces while (and just after) a drag. */
export interface DisplayEditBroadcast {
	/** The mode whose preset the edit lands on. */
	mode: string;
	/** Target monitor, or `null` for every monitor (the mode preset). */
	monitorId: string | null;
	/** The sending surface's id, so a sender ignores its own echo. */
	origin: string;
	/** Which day/night phase the edit lands on. */
	phase: EditPhase;
	/** The live pair, or `null` when the drag ended. */
	value: DisplayEditValue | null;
}

let originCounter = 0;

/**
 * A fresh per-surface id. Random-prefixed on purpose: a plain counter would
 * hand the Display tab and the tray flyout the SAME id (each window starts its
 * own module state at zero), and each would then dismiss the other's broadcast
 * as its own echo.
 */
export function createEditOrigin(): string {
	originCounter += 1;
	return `${Math.random().toString(36).slice(2, 10)}-${originCounter}`;
}

/** Announce this surface's drag state to every other window. */
export function broadcastDisplayEdit(payload: DisplayEditBroadcast): void {
	if (!hasNativeRuntime()) {
		return;
	}
	emit(NATIVE_EVENTS.DISPLAY_EDIT, payload).catch((error: unknown) => {
		console.warn("display edit broadcast failed", error);
	});
}

/** Subscribe to other surfaces' drags. */
export function subscribeDisplayEdit(
	handler: (payload: DisplayEditBroadcast) => void,
): Unsubscribe {
	return onCast<DisplayEditBroadcast>(NATIVE_EVENTS.DISPLAY_EDIT, handler);
}

/** Whether a broadcast edits exactly what this surface is showing. */
export function editTargetsSurface(
	payload: DisplayEditBroadcast,
	surface: { mode: string; monitorId: string | null; phase: EditPhase },
): boolean {
	return (
		payload.mode === surface.mode &&
		payload.phase === surface.phase &&
		payload.monitorId === surface.monitorId
	);
}
