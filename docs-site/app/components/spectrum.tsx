const MIN_K = 1000;
const MAX_K = 6500;

/** Where a Kelvin value sits along the slider, as a percentage. */
function position(kelvin: number): number {
	return ((kelvin - MIN_K) / (MAX_K - MIN_K)) * 100;
}

/**
 * The stops of the ramp, in the app's own rendering rather than true
 * blackbody: DimRead draws its cool end blue, so the docs draw it blue too.
 */
const RAMP: { k: number; color: string }[] = [
	{ k: 1000, color: "oklch(62% 0.17 42)" },
	{ k: 2000, color: "oklch(72% 0.16 55)" },
	{ k: 3000, color: "oklch(82% 0.13 74)" },
	{ k: 4000, color: "oklch(90% 0.08 88)" },
	{ k: 5000, color: "oklch(95% 0.032 96)" },
	{ k: 5500, color: "oklch(95% 0.018 190)" },
	{ k: 6500, color: "oklch(86% 0.068 246)" },
];

const GRADIENT = `linear-gradient(90deg, ${RAMP.map(
	(stop) => `${stop.color} ${position(stop.k).toFixed(1)}%`,
).join(", ")})`;

const MARKS: { k: number; label: string; note: string }[] = [
	{ k: 1000, label: "1000 K", note: "the warm floor" },
	{ k: 3700, label: "3700 K", note: "Health, at night" },
	{ k: 5500, label: "5500 K", note: "Reading and Office" },
	{ k: 6500, label: "6500 K", note: "unfiltered" },
];

/**
 * The temperature slider, drawn large.
 *
 * This is the site's one piece of bespoke illustration, and it is a real
 * control rather than a decoration: the gradient is the range DimRead's
 * colour-temperature slider actually spans, and every labelled stop is a
 * value the app ships as a preset endpoint. Pure CSS, so it costs nothing
 * and stays sharp at any width.
 */
export function Spectrum() {
	return (
		<div className="not-prose w-full">
			<div
				className="relative h-14 w-full overflow-hidden rounded-xl border border-fd-border sm:h-16"
				style={{ background: GRADIENT }}
			>
				{MARKS.map((mark) => (
					<span
						aria-hidden="true"
						className="absolute top-0 bottom-0 w-px bg-black/25"
						key={mark.k}
						style={{
							insetInlineStart: `${position(mark.k)}%`,
							display:
								mark.k === MIN_K || mark.k === MAX_K ? "none" : undefined,
						}}
					/>
				))}
				<span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/15 to-transparent" />
			</div>

			{/* Below ~480px four two-line captions collide, so the notes drop and
			    only the Kelvin values remain — which are the part that carries
			    the meaning. */}
			<dl className="mt-3 flex justify-between gap-2 text-xs">
				{MARKS.map((mark) => (
					<div
						className="flex min-w-0 flex-col gap-0.5 first:items-start last:items-end"
						key={mark.k}
					>
						<dt className="font-medium text-fd-foreground tabular-nums">
							{mark.label}
						</dt>
						<dd className="hidden text-fd-muted-foreground sm:block">
							{mark.note}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
