import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	areaPoints,
	type ChartFrame,
	pointYPercents,
	polylinePoints,
} from "./chart-math";

export interface LineChartPoint {
	/** Category/time label — shown in the hover tooltip. */
	label: string;
	value: number;
}

export interface LineChartProps {
	/** Fill the area under the line with a soft wash. */
	area?: boolean;
	/** Accessible name for the chart region. */
	ariaLabel: string;
	/** Sizes the chart box; defaults to `h-24 w-full`. */
	className?: string | undefined;
	/** Stroke color — any CSS color, defaults to the accent token. */
	color?: string;
	data: readonly LineChartPoint[];
	/** Formats the value line inside the hover tooltip. */
	formatValue?: (value: number) => string;
}

// Normalized drawing frame; the SVG stretches to the styled box
// (`preserveAspectRatio="none"`), with `vectorEffect` keeping the stroke crisp.
const FRAME: ChartFrame = { width: 100, height: 40, pad: 2 };

// Module-scope default: an arrow function as a destructured-prop default bails
// the component out of React Compiler memoization (it can't be reordered).
const defaultFormatValue = (value: number): string => value.toLocaleString();

/**
 * A bespoke line/area chart, grown from WinSTT's history Sparkline: a single
 * polyline scaled to the series' own max, theme-token colored, with the
 * dashboard's hover-tooltip pattern — an invisible full-height hit column per
 * point (wrapped in the shared `Tooltip`) that reveals a marker dot on the
 * line while the tooltip names the point. Renders nothing with fewer than two
 * points.
 */
export function LineChart({
	area = false,
	ariaLabel,
	className,
	color = "var(--color-accent)",
	data,
	formatValue = defaultFormatValue,
}: LineChartProps) {
	if (data.length < 2) {
		return null;
	}
	const values = data.map((point) => point.value);
	const yPercents = pointYPercents(values, FRAME);

	return (
		<div
			aria-label={ariaLabel}
			className={cn("relative h-24 w-full", className)}
			role="img"
		>
			<svg
				aria-hidden="true"
				className="absolute inset-0 h-full w-full"
				preserveAspectRatio="none"
				viewBox={`0 0 ${FRAME.width} ${FRAME.height}`}
			>
				{area ? (
					<polygon
						fill={color}
						opacity={0.14}
						points={areaPoints(values, FRAME)}
					/>
				) : null}
				<polyline
					fill="none"
					points={polylinePoints(values, FRAME)}
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={1.5}
					style={{ stroke: color, vectorEffect: "non-scaling-stroke" }}
				/>
			</svg>
			{/* Hover hit columns — one per point, centered on the point's x so the
			    revealed marker dot sits exactly on the line. Labels double as React
			    keys, so they should be unique within one chart. */}
			<div className="absolute inset-0">
				{data.map((point, index) => (
					<Tooltip
						content={`${point.label} · ${formatValue(point.value)}`}
						key={point.label}
					>
						<div
							className="group -translate-x-1/2 absolute top-0 h-full"
							style={{
								left: `${(index / (data.length - 1)) * 100}%`,
								width: `${100 / (data.length - 1)}%`,
							}}
						>
							<span
								aria-hidden="true"
								className="-translate-x-1/2 -translate-y-1/2 absolute left-1/2 size-1.5 rounded-full opacity-0 transition-opacity duration-100 group-hover:opacity-100"
								style={{
									backgroundColor: color,
									top: `${yPercents[index] ?? 0}%`,
								}}
							/>
						</div>
					</Tooltip>
				))}
			</div>
		</div>
	);
}
