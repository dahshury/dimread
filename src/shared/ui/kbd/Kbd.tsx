import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

// Decorative separator between keys — a visual symbol, not translatable copy.
const PLUS_GLYPH = "＋";

export interface KbdProps {
	children: ReactNode;
	className?: string | undefined;
	/** Lift the cap one step further — for "the key that matters" in a combo. */
	emphasized?: boolean;
}

/**
 * Flat neutral keycap, ported from WinSTT's shortcuts legend: a plain
 * surface fill + a single hairline ring — no 3D bevel, no white rings — so it
 * reads as a calm grayscale chip. The emphasized variant lifts a touch via a
 * brighter surface + border. Surface-aware: resolves against the local
 * `useSurface()` substrate so caps stay legible at any nesting depth.
 */
export function Kbd({ children, className, emphasized = false }: KbdProps) {
	const level = useSurface();
	return (
		<kbd
			className={cn(
				"inline-flex h-6 min-w-[1.6rem] items-center justify-center rounded-[6px] px-1.5 font-mono text-[11px] leading-none tracking-tight ring-1",
				emphasized
					? cn(
							surfaceBg(Math.min(level + 2, 8)),
							"text-foreground ring-divider-strong",
						)
					: cn(
							surfaceBg(Math.min(level + 1, 8)),
							"text-foreground-secondary ring-divider",
						),
				className,
			)}
		>
			{children}
		</kbd>
	);
}

export interface KbdComboProps {
	className?: string | undefined;
	/** Index of the key to render emphasized (defaults to none). */
	emphasizedIndex?: number;
	/** Display labels, one per key, in press order (e.g. ["Ctrl", "Shift", "K"]). */
	keys: readonly string[];
}

/**
 * A key-combo chip row: keycaps joined by muted "＋" separators, matching
 * WinSTT's hotkey legend. Purely presentational — pass display-ready labels.
 */
export function KbdCombo({ className, emphasizedIndex, keys }: KbdComboProps) {
	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			{keys.map((key, index) => (
				<span className="inline-flex items-center gap-1" key={key}>
					{index > 0 ? (
						<span aria-hidden className="text-[9px] text-foreground-dim">
							{PLUS_GLYPH}
						</span>
					) : null}
					<Kbd emphasized={index === emphasizedIndex}>{key}</Kbd>
				</span>
			))}
		</span>
	);
}
