import type { FocusAnchorEvent } from "@/bindings";

/** A rectangle in CSS px. */
export interface BlurRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The overlay window's CSS viewport, plus the device-pixel-ratio needed to map
 *  the backend's window-local PHYSICAL px into CSS px. */
export interface BlurViewport {
	/** Viewport width, CSS px (`window.innerWidth`). */
	width: number;
	/** Viewport height, CSS px (`window.innerHeight`). */
	height: number;
	/** `window.devicePixelRatio` (physical px per CSS px). */
	dpr: number;
}

/** One shaded region — a monitor's dimmable area — plus its clear cutout. */
export interface BlurRegion {
	/** The shaded rect, absolute in the overlay viewport (CSS px). Clips the
	 *  tint to one monitor's dimmable area (its work area when the taskbar is
	 *  excluded, its full rect when included). */
	container: BlurRect;
	/** The clear hole, RELATIVE to {@link BlurRegion.container} (CSS px), clamped
	 *  inside it so a maximized/off-monitor window can't leak the tint edge. A
	 *  region the active window doesn't touch gets a zero-area cutout and stays
	 *  fully shaded; a window straddling two monitors gets its own clamped slice
	 *  in each, so the union is the whole window. */
	cutout: BlurRect;
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}

/** Physical px → CSS px. A non-positive dpr is treated as 1 (identity). */
function toCss(physical: number, dpr: number): number {
	return dpr > 0 ? physical / dpr : physical;
}

/** The active-window rect in absolute viewport CSS px, clamped into `container`
 *  and expressed relative to it, so the clear hole never spills past the shade. */
function cutoutIn(
	container: BlurRect,
	abs: { left: number; top: number; right: number; bottom: number },
): BlurRect {
	const left = clamp(abs.left - container.left, 0, container.width);
	const top = clamp(abs.top - container.top, 0, container.height);
	const right = clamp(abs.right - container.left, 0, container.width);
	const bottom = clamp(abs.bottom - container.top, 0, container.height);
	return {
		left,
		top,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	};
}

/**
 * Compute the shaded regions and their clear cutouts from a `focus:anchor`.
 *
 * The anchor carries WINDOW-LOCAL physical px (the backend already subtracted the
 * virtual-screen origin), so we only divide by the device-pixel-ratio.
 *
 * `onlyCurrentMonitor` yields a single region clipped to the active window's
 * monitor. Otherwise the shade is the union of `anchor.monitors` — one region per
 * display, each ALREADY resolved by the backend to the work area (taskbar left
 * clear) or the full monitor rect. Shading that union rather than the raw
 * viewport is what makes `includeTaskbar` work across every monitor, and it also
 * leaves the gaps between non-contiguous displays untinted. An empty monitor list
 * (enumeration failed) falls back to the whole viewport so the tint never
 * silently disappears. Pure so the geometry is unit-tested without a DOM.
 */
export function computeBlurLayout(
	anchor: Pick<
		FocusAnchorEvent,
		| "x"
		| "y"
		| "width"
		| "height"
		| "monitorLeft"
		| "monitorTop"
		| "monitorRight"
		| "monitorBottom"
		| "monitors"
	>,
	viewport: BlurViewport,
	onlyCurrentMonitor: boolean,
): BlurRegion[] {
	const { dpr } = viewport;
	const fullViewport: BlurRect = {
		left: 0,
		top: 0,
		width: viewport.width,
		height: viewport.height,
	};

	let containers: BlurRect[];
	if (onlyCurrentMonitor) {
		containers = [
			{
				left: toCss(anchor.monitorLeft, dpr),
				top: toCss(anchor.monitorTop, dpr),
				width: toCss(anchor.monitorRight - anchor.monitorLeft, dpr),
				height: toCss(anchor.monitorBottom - anchor.monitorTop, dpr),
			},
		];
	} else if (anchor.monitors.length > 0) {
		containers = anchor.monitors.map((rect) => ({
			left: toCss(rect.left, dpr),
			top: toCss(rect.top, dpr),
			width: toCss(rect.right - rect.left, dpr),
			height: toCss(rect.bottom - rect.top, dpr),
		}));
	} else {
		containers = [fullViewport];
	}

	const absLeft = toCss(anchor.x, dpr);
	const absTop = toCss(anchor.y, dpr);
	const abs = {
		left: absLeft,
		top: absTop,
		right: absLeft + toCss(anchor.width, dpr),
		bottom: absTop + toCss(anchor.height, dpr),
	};

	// Single pass: skip degenerate regions and pair each survivor with its hole.
	const regions: BlurRegion[] = [];
	for (const container of containers) {
		if (container.width > 0 && container.height > 0) {
			regions.push({ container, cutout: cutoutIn(container, abs) });
		}
	}
	return regions;
}

/** Parse `#rrggbb` (or `#rgb`) into `[r, g, b]` (0–255), defaulting to black. */
function hexToRgb(hex: string): [number, number, number] {
	const raw = hex.trim().replace(/^#/, "");
	const full =
		raw.length === 3
			? raw
					.split("")
					.map((c) => c + c)
					.join("")
			: raw;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) {
		return [0, 0, 0];
	}
	return [
		Number.parseInt(full.slice(0, 2), 16),
		Number.parseInt(full.slice(2, 4), 16),
		Number.parseInt(full.slice(4, 6), 16),
	];
}

/**
 * Build the shade fill colour: the picked `#rrggbb` at `transparency`% opacity
 * (higher transparency = a stronger dim, matching CareUEyes' slider). The value
 * is clamped to 0–100 and returned as an `rgba()` string.
 */
export function shadeColorRgba(
	hex: string,
	transparencyPercent: number,
): string {
	const [r, g, b] = hexToRgb(hex);
	const alpha = clamp(transparencyPercent, 0, 100) / 100;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
