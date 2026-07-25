import { commands, type DisplayPhase } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";

/**
 * Live display-preview driver. During a slider drag (or while previewing the
 * off-phase's values) the panel streams raw Kelvin/brightness to the engine
 * via `display_preview` WITHOUT persisting; on release it persists and calls
 * {@link endDisplayPreview}, which reverts the engine to its settings-driven
 * output.
 *
 * Preview calls are coalesced to one per animation frame so a fast drag never
 * floods the IPC channel — only the most recent value in a frame is sent.
 */

interface PreviewValue {
	brightness: number | null;
	kelvin: number | null;
	monitorId: string | null;
	phase: DisplayPhase | null;
}

let frame: number | null = null;
let pending: PreviewValue | null = null;

function flush(): void {
	frame = null;
	if (!pending) {
		return;
	}
	const value = pending;
	pending = null;
	void commands
		.displayPreview(
			value.kelvin,
			value.brightness,
			value.monitorId,
			value.phase,
		)
		.catch(() => undefined);
}

/** Queue a live preview of `kelvin`/`brightness` on one monitor (or all when
 *  `monitorId` is `null`), throttled to one call per frame. A `null` axis is
 *  left at each monitor's currently APPLIED value — a drag streams only the
 *  axis it moves, so the other axis can never snap to a stored value that
 *  diverges from what is on screen (day/night interpolation, overrides). */
export function previewDisplay(
	kelvin: number | null,
	brightness: number | null,
	monitorId: string | null,
	phase: DisplayPhase | null,
): void {
	if (!hasNativeRuntime()) {
		return;
	}
	pending = { kelvin, brightness, monitorId, phase };
	if (frame !== null) {
		return;
	}
	frame = requestAnimationFrame(flush);
}

/** End any live preview and revert the engine to its settings-driven output
 *  (also forces a fresh `refresh()`, so it doubles as "re-apply settings"). */
export function endDisplayPreview(): void {
	if (!hasNativeRuntime()) {
		return;
	}
	if (frame !== null) {
		cancelAnimationFrame(frame);
		frame = null;
	}
	pending = null;
	void commands.displayPreviewEnd().catch(() => undefined);
}
