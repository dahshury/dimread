// Pure geometry helpers shared by the bespoke SVG charts (ported from
// WinSTT's hand-rolled history-dashboard charts — no charting library).

export interface ChartFrame {
	height: number;
	/** Vertical headroom inside the frame so strokes never clip. */
	pad: number;
	width: number;
}

/** X pitch between consecutive points across the frame width. */
function stepX(frame: ChartFrame, count: number): number {
	return count <= 1 ? 0 : frame.width / (count - 1);
}

/** Map one value into frame-local y (0 = top). Scales 0..max like WinSTT's
 *  Sparkline so a quiet series still reads. A flat all-zero series sits on
 *  the baseline. */
export function valueToY(
	value: number,
	max: number,
	frame: ChartFrame,
): number {
	const usable = frame.height - frame.pad * 2;
	if (max <= 0) {
		return frame.height - frame.pad;
	}
	const clamped = Math.max(0, value);
	return frame.height - frame.pad - (clamped / max) * usable;
}

/** SVG `points` string for a polyline through the series. */
export function polylinePoints(
	values: readonly number[],
	frame: ChartFrame,
): string {
	const max = Math.max(...values, 0);
	const pitch = stepX(frame, values.length);
	return values
		.map((value, i) => {
			const x = (i * pitch).toFixed(2);
			const y = valueToY(value, max, frame).toFixed(2);
			return `${x},${y}`;
		})
		.join(" ");
}

/** SVG `points` for the closed area polygon under the series line. */
export function areaPoints(
	values: readonly number[],
	frame: ChartFrame,
): string {
	if (values.length === 0) {
		return "";
	}
	const line = polylinePoints(values, frame);
	const baseline = frame.height - frame.pad;
	return `0,${baseline} ${line} ${frame.width},${baseline}`;
}

/** Per-point y position as a percentage of frame height (hover dot anchors). */
export function pointYPercents(
	values: readonly number[],
	frame: ChartFrame,
): number[] {
	const max = Math.max(...values, 0);
	return values.map(
		(value) => (valueToY(value, max, frame) / frame.height) * 100,
	);
}

export interface RingArc {
	/** Visible dash length along the circumference. */
	dash: number;
	/** Negative offset rotating the wedge to its start position. */
	offset: number;
}

/**
 * Donut wedge geometry (from WinSTT's CostPie): each wedge sized to its
 * exact share of the circumference, with a hair of gap between wedges so
 * adjacent same-hue slices stay distinguishable. A lone full-ring slice
 * skips the gap (no seam on a single wedge).
 */
export function ringArcs(
	values: readonly number[],
	circumference: number,
	gap: number,
): RingArc[] {
	const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
	if (total <= 0) {
		return values.map(() => ({ dash: 0, offset: 0 }));
	}
	const effectiveGap = values.length === 1 ? 0 : gap;
	return values.map((value, index) => {
		const fraction = Math.max(0, value) / total;
		const before =
			values.slice(0, index).reduce((sum, v) => sum + Math.max(0, v), 0) /
			total;
		return {
			dash: Math.max(0, fraction * circumference - effectiveGap),
			offset: -before * circumference,
		};
	});
}

/** Integer percent of total for legends (display only, never geometry). */
export function sharePercents(values: readonly number[]): number[] {
	const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
	if (total <= 0) {
		return values.map(() => 0);
	}
	return values.map((value) => Math.round((Math.max(0, value) / total) * 100));
}

/**
 * Rank-based fade (from WinSTT's UsageBars): the leading entry is the
 * strongest, each row below it steps darker so the list reads as a gradient.
 * Mixing the base color toward black keeps every fill dark enough for light
 * text while preserving the hue.
 */
export function rankFadeColor(index: number, baseColor: string): string {
	const strength = Math.max(40, 70 - index * 7);
	return `color-mix(in oklch, ${baseColor} ${strength}%, black)`;
}
