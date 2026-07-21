/**
 * Focus Read shade geometry (FEATURE-PARITY F8.1). Pure mappings shared by the
 * `focus-overlay` renderer: turn the backend's PHYSICAL cursor position (from
 * `focus:cursor`) into the overlay window's CSS-pixel band edges, and turn the
 * `#rrggbb` + transparency % settings into the shade fill colour.
 *
 * The `focus-overlay` window is positioned at the virtual-screen origin
 * (physical px) and spans every monitor, so `windowTopPhysical` is that origin's
 * Y and `dpr` its scale factor.
 */

import { clampTransparency } from "./read-values";

/** The clear band's top/bottom edges in the overlay window's CSS px. */
export interface ReadBand {
	bandTop: number;
	bandBottom: number;
}

/**
 * Map a physical cursor Y to the clear band's CSS-px edges, centred on the
 * cursor with the configured band height. Works with negative virtual-screen
 * origins (a monitor left of the primary).
 */
export function computeBand(
	cursorYPhysical: number,
	windowTopPhysical: number,
	dpr: number,
	bandHeightCss: number,
): ReadBand {
	const scale = dpr > 0 ? dpr : 1;
	const localCss = (cursorYPhysical - windowTopPhysical) / scale;
	const half = Math.max(0, bandHeightCss) / 2;
	return { bandTop: localCss - half, bandBottom: localCss + half };
}

/** An 8-bit RGB triple. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Parse a `#rrggbb` (or `rrggbb`) colour; `null` for anything else. */
export function hexToRgb(hex: string): Rgb | null {
	const [, digits] = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? [];
	if (digits === undefined) {
		return null;
	}
	const int = Number.parseInt(digits, 16);
	return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

/**
 * The shade fill: the configured colour at an alpha of `transparency%`
 * (higher % = a stronger dim of everything outside the clear band). Invalid
 * colours fall back to black.
 */
export function shadeColor(hex: string, transparencyPercent: number): string {
	const { r, g, b } = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
	const alpha = clampTransparency(transparencyPercent) / 100;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
