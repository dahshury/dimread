import { cn } from "@/shared/lib/cn";
import { ringArcs, sharePercents } from "./chart-math";

export interface StatRingSlice {
	/** Wedge color — any CSS color. Falls back to the default token cycle. */
	color?: string | undefined;
	/** Stable key AND legend identity. */
	key: string;
	label: string;
	value: number;
}

export interface StatRingProps {
	/** Accessible name for the chart. */
	ariaLabel: string;
	/** Muted caption under the center value. */
	centerLabel: string;
	/** Big value in the donut hole (e.g. the total). */
	centerValue: string;
	className?: string | undefined;
	/** Formats each slice's value in the legend. */
	formatValue?: (value: number) => string;
	/** Hide the value/percent legend below the ring. */
	showLegend?: boolean;
	slices: readonly StatRingSlice[];
}

const SIZE = 132;
const CENTER = SIZE / 2;
const RADIUS = 46;
const STROKE = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// A hair of track shows between wedges so adjacent same-hue fades stay
// distinguishable; a lone full-ring slice skips it (handled in ringArcs).
const GAP = 2;

/** Default wedge palette — theme tokens only, cycled by slice index. */
const TOKEN_CYCLE = [
	"var(--color-accent)",
	"var(--color-teal)",
	"var(--color-orange)",
	"var(--color-success)",
	"var(--color-warning)",
	"var(--color-foreground-dim)",
] as const;

// Module-scope default: an arrow function as a destructured-prop default bails
// the component out of React Compiler memoization (it can't be reordered).
const defaultFormatValue = (value: number): string => value.toLocaleString();

function sliceColor(slice: StatRingSlice, index: number): string {
	return (
		slice.color ?? TOKEN_CYCLE[index % TOKEN_CYCLE.length] ?? TOKEN_CYCLE[0]
	);
}

/**
 * A donut/stat-ring breakdown, ported from WinSTT's CostPie: one wedge per
 * slice sized to its exact share (rounded percentages only label the legend,
 * never the geometry), the headline total in the hole, and a value/percent
 * legend below. Bespoke SVG on the design tokens. Renders nothing when the
 * total is zero, so the caller can hide the surrounding card.
 */
export function StatRing({
	ariaLabel,
	centerLabel,
	centerValue,
	className,
	formatValue = defaultFormatValue,
	showLegend = true,
	slices,
}: StatRingProps) {
	const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
	if (total <= 0 || slices.length === 0) {
		return null;
	}
	const arcs = ringArcs(
		slices.map((s) => s.value),
		CIRCUMFERENCE,
		GAP,
	);
	const percents = sharePercents(slices.map((s) => s.value));

	return (
		<div className={cn("flex flex-col items-center gap-3", className)}>
			<svg
				aria-label={ariaLabel}
				height={SIZE}
				role="img"
				viewBox={`0 0 ${SIZE} ${SIZE}`}
				width={SIZE}
			>
				{/* Track ring under the wedges keeps the donut whole at tiny shares. */}
				<circle
					cx={CENTER}
					cy={CENTER}
					fill="none"
					r={RADIUS}
					stroke="var(--color-surface-5)"
					strokeWidth={STROKE}
				/>
				<g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
					{slices.map((slice, index) => {
						const arc = arcs[index];
						if (!arc) {
							return null;
						}
						return (
							<circle
								cx={CENTER}
								cy={CENTER}
								fill="none"
								key={slice.key}
								r={RADIUS}
								stroke={sliceColor(slice, index)}
								strokeDasharray={`${arc.dash} ${CIRCUMFERENCE - arc.dash}`}
								strokeDashoffset={arc.offset}
								strokeWidth={STROKE}
							>
								<title>{`${slice.label} · ${formatValue(slice.value)} (${percents[index] ?? 0}%)`}</title>
							</circle>
						);
					})}
				</g>
				<text
					className="font-mono font-semibold tabular-nums"
					style={{ fill: "var(--color-foreground)", fontSize: "16px" }}
					textAnchor="middle"
					x={CENTER}
					y={CENTER - 1}
				>
					{centerValue}
				</text>
				<text
					className="font-mono uppercase tracking-wide"
					style={{
						fill: "var(--color-foreground-muted)",
						fontSize: "var(--text-body-sm)",
					}}
					textAnchor="middle"
					x={CENTER}
					y={CENTER + 12}
				>
					{centerLabel}
				</text>
			</svg>
			{showLegend ? (
				<ul className="flex w-full flex-col gap-1.5">
					{slices.map((slice, index) => (
						<li
							className="flex items-center gap-2 text-xs-tight"
							key={slice.key}
						>
							<span
								aria-hidden
								className="size-2.5 shrink-0 rounded-[3px]"
								style={{ backgroundColor: sliceColor(slice, index) }}
							/>
							<span className="min-w-0 flex-1 truncate text-foreground-secondary">
								{slice.label}
							</span>
							<span className="shrink-0 font-mono text-foreground tabular-nums">
								{formatValue(slice.value)}
							</span>
							<span className="w-9 shrink-0 text-end font-mono text-2xs text-foreground-muted tabular-nums">
								{`${percents[index] ?? 0}%`}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
