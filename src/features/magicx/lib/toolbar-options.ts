/**
 * Pure bounds + validation for the Magic Window options (F9.3). Kept out of the
 * section component so the clamp / colour-validation logic is unit-tested.
 */

/** Toolbar alignment on the target window. */
export const TOOLBAR_ALIGNMENTS = ["center", "left", "right"] as const;
export type ToolbarAlignment = (typeof TOOLBAR_ALIGNMENTS)[number];

/** Horizontal offset range (logical px) for the aligned toolbar. */
export const TOOLBAR_OFFSET_MIN = -200;
export const TOOLBAR_OFFSET_MAX = 200;
export const TOOLBAR_OFFSET_STEP = 4;

/** Hover-delay range (ms). CareUEyes recommends 0.3–0.5 s. */
export const TOOLBAR_DELAY_MIN = 0;
export const TOOLBAR_DELAY_MAX = 2000;
export const TOOLBAR_DELAY_STEP = 50;

/** Default toolbar accent colour (mirrors the Rust `MagicxSettings` default). */
export const DEFAULT_TOOLBAR_COLOR = "#14b8a6";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Clamp a horizontal offset into the adjustable range. */
export function clampOffset(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(
		TOOLBAR_OFFSET_MAX,
		Math.max(TOOLBAR_OFFSET_MIN, Math.round(value)),
	);
}

/** Clamp a hover delay (ms) into the adjustable range. */
export function clampDelay(value: number): number {
	if (!Number.isFinite(value)) {
		return TOOLBAR_DELAY_MIN;
	}
	return Math.min(
		TOOLBAR_DELAY_MAX,
		Math.max(TOOLBAR_DELAY_MIN, Math.round(value)),
	);
}

/** Whether `value` is a `#rrggbb` colour the native colour input accepts. */
export function isValidHexColor(value: string): boolean {
	return HEX_COLOR.test(value);
}

/** Coerce an arbitrary stored colour to a safe `#rrggbb` value for the input. */
export function safeToolbarColor(value: string): string {
	return isValidHexColor(value) ? value : DEFAULT_TOOLBAR_COLOR;
}
