import { PreviewCard } from "@base-ui/react/preview-card";
import { HugeiconsIcon } from "@hugeicons/react";
import { cloneElement, type ReactElement } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { SurfaceProvider, surfaceClasses } from "@/shared/lib/surface";
import { Badge } from "@/shared/ui/badge";
import type { ItemPickerItem } from "./item-picker-types";

/**
 * Level 7 — the same fixed surface the app-wide tooltip pins to. Transient
 * topmost chrome reads consistently regardless of the substrate it floats
 * over, and the level-7 shadow recipe supplies the hairline outline.
 */
const POPUP_LEVEL = 7;

/**
 * Open only after a deliberate hover — the card must NOT flash on every mouse
 * pass over the list. ~0.45s reads as "the user paused here on purpose".
 */
const DEFAULT_OPEN_DELAY = 450;
/** Short close grace so the pointer can travel from row into the card. */
const CLOSE_DELAY = 120;

/** The spec card's static body: identity, badges, description, facts grid. */
export function ItemSpecCard({ item }: { item: ItemPickerItem }) {
	return (
		<div className="flex flex-col gap-2.5 p-3.5">
			<div className="flex min-w-0 items-center gap-2">
				{item.icon ? (
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground-secondary ring-1 ring-divider">
						<HugeiconsIcon aria-hidden="true" icon={item.icon} size={15} />
					</span>
				) : null}
				<div className="flex min-w-0 flex-col">
					<span className="truncate font-semibold text-body text-foreground leading-tight">
						{item.title}
					</span>
					{item.subtitle ? (
						<span className="truncate text-[11px] text-foreground-muted leading-snug">
							{item.subtitle}
						</span>
					) : null}
				</div>
			</div>
			{item.badges && item.badges.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1">
					{item.badges.map((badge) => (
						<Badge className="font-mono" key={badge} variant="outline">
							{badge}
						</Badge>
					))}
				</div>
			) : null}
			{item.description ? (
				<p className="text-[11px] text-foreground-secondary leading-relaxed">
					{item.description}
				</p>
			) : null}
			{item.meta && item.meta.length > 0 ? (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-divider border-t pt-2.5">
					{item.meta.map((fact) => (
						<div className="contents" key={fact.key}>
							<dt className="text-[11px] text-foreground-muted leading-snug">
								{fact.label}
							</dt>
							<dd className="m-0 truncate text-right text-[11px] text-foreground-secondary leading-snug">
								{fact.value}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</div>
	);
}

export interface ItemSpecHoverCardProps {
	align?: "start" | "center" | "end";
	/**
	 * The anchor. MUST be a single DOM element (not a bare component) so Base
	 * UI can merge the hover handlers + ref onto it — mirrors the shared
	 * Tooltip's `cloneElement` contract.
	 */
	children: ReactElement;
	/** Open delay in ms. */
	delay?: number;
	/** The item to preview. `null`/`undefined` renders the anchor inert. */
	item: ItemPickerItem | null | undefined;
	side?: "top" | "bottom" | "left" | "right";
	sideOffset?: number;
}

/**
 * Hover spec card (ported from WinSTT's model-selector hover card, item-shape
 * genericized): wraps a row/chip so that pausing over it reveals a rich side
 * preview panel. Built on Base UI's PreviewCard — opens on hover only, never
 * on click or keyboard focus, so keyboard traversal stays quiet. The popup is
 * interactive (the pointer can move into it to read the full description).
 */
export function ItemSpecHoverCard({
	align = "start",
	children,
	delay = DEFAULT_OPEN_DELAY,
	item,
	side = "right",
	sideOffset = 10,
}: ItemSpecHoverCardProps) {
	if (!item) {
		return children;
	}
	return (
		<PreviewCard.Root>
			<PreviewCard.Trigger
				closeDelay={CLOSE_DELAY}
				delay={delay}
				render={cloneElement(children, {
					suppressHydrationWarning: true,
				} as Record<string, unknown>)}
			/>
			<PreviewCard.Portal>
				<SurfaceProvider value={POPUP_LEVEL}>
					<PreviewCard.Positioner
						align={align}
						collisionPadding={12}
						side={side}
						sideOffset={sideOffset}
						style={{ zIndex: Z_INDEX.tooltip }}
					>
						<PreviewCard.Popup
							className={`w-[280px] max-w-[92vw] origin-(--transform-origin) overflow-hidden rounded-xl ${surfaceClasses(POPUP_LEVEL)} font-sans transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[instant]:transition-none`}
						>
							<ItemSpecCard item={item} />
						</PreviewCard.Popup>
					</PreviewCard.Positioner>
				</SurfaceProvider>
			</PreviewCard.Portal>
		</PreviewCard.Root>
	);
}
