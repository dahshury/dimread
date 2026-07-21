import { cn } from "@/shared/lib/cn";

/**
 * Shared item-card chrome, lifted from WinSTT's universal model card so every
 * catalog-style card in the app reads as the same solid, elevated *specimen*:
 * a real surface step with a tinted depth shadow. Hover deepens the shadow
 * without moving the card; press settles it with a subtle scale
 * (transform/opacity only, ease-out ≤150ms, motion-reduce guarded).
 */
export const CARD_BASE = cn(
	// `group` enables hover-reveal of `group-hover:` descendants (e.g. a delete
	// button in the actions slot).
	"group relative flex flex-col gap-2.5 overflow-hidden rounded-lg px-3.5 py-3 outline-none",
	"border border-border bg-surface-3 shadow-surface-2",
	"[content-visibility:auto] [contain-intrinsic-size:0_136px]",
	"transition-[transform,border-color,background-color,box-shadow] duration-150 ease-out",
	"hover:border-border-hover hover:bg-surface-4 hover:shadow-surface-3",
	"active:scale-[0.99]",
	"motion-reduce:transition-none motion-reduce:active:scale-100",
);

/** Active selection: the fill warms to an accent tint and gains a ring; hover
 *  keeps the accent rather than falling back to the neutral surface-4. */
export const CARD_SELECTED = cn(
	"border-accent/55 bg-accent/[0.09] shadow-surface-3 ring-1 ring-accent/25",
	"hover:border-accent/70 hover:bg-accent/[0.12]",
);

/** Desaturates a broken/unavailable card and parks the hover surface change (a
 *  non-selectable card shouldn't feel tactile). */
export const CARD_UNAVAILABLE = cn(
	"cursor-not-allowed opacity-55",
	"hover:border-border hover:bg-surface-3 hover:shadow-surface-2",
);

/** The recessed action shelf: a subtly-darkened ledge that bleeds to the
 *  card's bottom + side edges (negative margins MUST match the card's own
 *  px-3.5/py-3), split from the identity block by a full-bleed hairline. */
export const RECESSED_SHELF_CLASSES =
	"-mx-3.5 -mb-3 border-divider border-t bg-foreground/[0.02] px-3.5 pt-2.5 pb-3";
