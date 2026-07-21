import { cn } from "@/shared/lib/cn";
import { rankFadeColor, sharePercents } from "./chart-math";

export interface BarChartDatum {
	/** Stable key AND row identity. */
	key: string;
	label: string;
	value: number;
}

export interface BarChartProps {
	className?: string | undefined;
	/** Base bar color — any CSS color, defaults to the accent token. */
	color?: string;
	data: readonly BarChartDatum[];
	/** Text inside each pill — defaults to the row's share, e.g. "42%". */
	formatValue?: (value: number, pct: number) => string;
	/** Trailing text per row — defaults to the row label. */
	formatLabel?: (datum: BarChartDatum, pct: number) => string;
}

// The pill's minimum share of its track: keeps the in-pill text legible — and
// the pill visible — even at ~0%.
const MIN_BAR_PCT = 12;

// Default formatters live at module scope: React Compiler can't reorder arrow
// functions used as destructured-prop defaults, which bails the whole component
// out of automatic memoization.
const defaultFormatValue = (_value: number, pct: number): string => `${pct}%`;
const defaultFormatLabel = (datum: BarChartDatum): string => datum.label;

/**
 * A rank-bars breakdown, ported from WinSTT's UsageBars/CostBars: one row per
 * datum — a pill sized to its share of a full-width track (the value text
 * sits inside it) followed by the label. Rows step darker down the ranking
 * (rank fade) so the list reads as a gradient on one visual scale. Sort the
 * data before passing it in; renders nothing when empty.
 */
export function BarChart({
	className,
	color = "var(--color-accent)",
	data,
	formatValue = defaultFormatValue,
	formatLabel = defaultFormatLabel,
}: BarChartProps) {
	if (data.length === 0) {
		return null;
	}
	const percents = sharePercents(data.map((datum) => datum.value));

	return (
		<div className={cn("flex w-full flex-col gap-2", className)}>
			{data.map((datum, index) => {
				const pct = percents[index] ?? 0;
				return (
					<div className="flex items-center gap-3" key={datum.key}>
						<span className="relative h-6 w-[55%] shrink-0 overflow-hidden rounded-md bg-surface-elevated">
							<span
								className="absolute inset-y-0 start-0 flex items-center rounded-md px-2"
								style={{
									backgroundColor: rankFadeColor(index, color),
									width: `${Math.max(MIN_BAR_PCT, pct)}%`,
								}}
							>
								<span className="whitespace-nowrap font-medium font-mono text-2xs text-on-accent tabular-nums">
									{formatValue(datum.value, pct)}
								</span>
							</span>
						</span>
						<span className="min-w-0 flex-1 truncate text-foreground-secondary text-xs-tight">
							{formatLabel(datum, pct)}
						</span>
					</div>
				);
			})}
		</div>
	);
}
