import type { PickerAnchorEvent } from "@/bindings";

/**
 * Duration of the panel's close FADE. Keep in sync with
 * `--dropdown-close-dur` in `src/app/styles/globals.css`; the Rust side hides
 * the OS window a beat LATER (260ms grace in `windows/placement.rs`) so the
 * fully-faded transparent frame is composited before the hide.
 */
export const PICKER_CLOSE_MS = 120;

/** Window-local rect (CSS px) of the visible panel inside the full-workarea
 *  transparent backdrop. Mirrors the Rust-side default footprint so the warm
 *  (hidden) mount lays out at a plausible size before the first anchor. */
export interface PanelRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

export const DEFAULT_PANEL_RECT: PanelRect = {
	x: 0,
	y: 0,
	width: 360,
	height: 420,
};

/** `pre-open` = positioned but not yet revealed: the panel holds its
 *  pre-animation state until the compositor has painted a frame at the new
 *  anchor (double-rAF), so the open animation is never swallowed by
 *  WebView2's show-resume lag. */
export type PanelPhase = "hidden" | "pre-open" | "open" | "closing";

/** Scale/slide origin for the `t-dropdown` recipe. Rust places the panel
 *  above OR below its trigger; the trigger itself isn't reported, so infer
 *  the shared edge from which screen edge the panel hugs: a panel pinned
 *  toward the bottom of the backdrop opened ABOVE a bottom trigger (origin
 *  on its bottom edge), and vice versa. */
export type PanelOrigin = "bottom-right" | "top-right";

export function panelOrigin(
	rect: PanelRect,
	viewportHeight: number,
): PanelOrigin {
	const topGap = rect.y;
	const bottomGap = viewportHeight - (rect.y + rect.height);
	return topGap < bottomGap ? "top-right" : "bottom-right";
}

function finiteOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

/** Harden an anchor payload into a usable rect (a hostile/malformed event
 *  must never produce a NaN-positioned panel). */
export function normalizePanelRect(payload: PickerAnchorEvent): PanelRect {
	return {
		x: finiteOr(payload.x, DEFAULT_PANEL_RECT.x),
		y: finiteOr(payload.y, DEFAULT_PANEL_RECT.y),
		width: Math.max(1, finiteOr(payload.width, DEFAULT_PANEL_RECT.width)),
		height: Math.max(1, finiteOr(payload.height, DEFAULT_PANEL_RECT.height)),
	};
}

/** CSS state class for the `t-dropdown` transition recipe. */
export function dropdownStateClass(phase: PanelPhase): string {
	if (phase === "closing") {
		return "is-closing";
	}
	if (phase === "open") {
		return "is-open";
	}
	return "";
}
