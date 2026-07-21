import { Button as BaseButton } from "@base-ui/react/button";
import {
	AlertCircleIcon,
	CheckmarkCircle02Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	CARD_BASE,
	CARD_SELECTED,
	CARD_UNAVAILABLE,
	RECESSED_SHELF_CLASSES,
} from "./card-constants";

/** One spec chip on the card's detail line (e.g. "1.2 GB", "MIT", "v3"). */
export interface ItemCardChip {
	icon?: IconSvgElement | undefined;
	key: string;
	label: string;
	/** Optional longer explanation shown as a tooltip. */
	tooltip?: string | undefined;
}

export interface ItemCardFavorite {
	/** Accessible label for the star, computed by the caller (i18n),
	 *  e.g. "Add Task Forge to favorites". */
	label: string;
	isFavorited: boolean;
	onToggle: () => void;
}

export interface ItemCardProps {
	/** Right-aligned action cluster beside the favourite star (e.g. a download
	 *  button, expand chevron, delete). Clicks never bubble to the body. */
	actions?: ReactNode;
	/** Muted status badges pinned at the end of the spec-chip line. */
	badges?: ReactNode;
	/** Merged last over the card classes (e.g. to override width/margins). */
	className?: string | undefined;
	/** Spec chips row — the single detail line under the title. */
	chips?: readonly ItemCardChip[] | undefined;
	/** Two-line clamped description; the card reserves its height even when
	 *  absent so every card in a grid shares the same footprint. */
	description?: ReactNode;
	errorMessage?: string | null | undefined;
	favorite?: ItemCardFavorite | undefined;
	/** Leading identity glyph/logo before the title. */
	icon?: ReactNode;
	/** Body-click select handler. When set (and not unavailable) the whole card
	 *  is clickable; slot controls `stopPropagation` and stay independent. */
	onSelect?: (() => void) | undefined;
	selected?: boolean;
	/** aria-label for the body-click button. Defaults to the title. */
	selectLabel?: string | undefined;
	/** Recessed bottom shelf for card-specific controls (download actions,
	 *  variant pills, …). */
	shelf?: ReactNode;
	title: string;
	unavailable?: boolean;
	/** Badge label when unavailable (e.g. "Broken"). Required if `unavailable`
	 *  can be true — the component ships no user-facing strings of its own. */
	unavailableLabel?: string | undefined;
}

/** The small error chip shown beside an unavailable item's title. */
function UnavailableBadge({
	errorMessage,
	label,
}: {
	errorMessage?: string | null | undefined;
	label: string;
}) {
	const badge = (
		<span className="inline-flex shrink-0 items-center gap-1 rounded bg-error/15 px-1.5 py-0.5 font-medium text-[10px] text-error">
			<HugeiconsIcon className="size-3" icon={AlertCircleIcon} />
			{label}
		</span>
	);
	return errorMessage ? (
		<Tooltip content={errorMessage} side="top">
			{badge}
		</Tooltip>
	) : (
		badge
	);
}

/** Star toggle in the shared muted-amber favourites vocabulary. */
function FavoriteToggle({ favorite }: { favorite: ItemCardFavorite }) {
	return (
		<Tooltip content={favorite.label} side="top">
			<BaseButton
				aria-label={favorite.label}
				aria-pressed={favorite.isFavorited}
				className={cn(
					"inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
					"motion-reduce:transition-none",
					favorite.isFavorited
						? "text-warning hover:bg-warning/15"
						: "text-foreground-muted opacity-55 hover:bg-foreground/[0.08] hover:text-foreground hover:opacity-100",
				)}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					favorite.onToggle();
				}}
				type="button"
			>
				<HugeiconsIcon
					className={cn("size-3.5", favorite.isFavorited && "fill-warning")}
					icon={StarIcon}
				/>
			</BaseButton>
		</Tooltip>
	);
}

function SpecChip({ chip }: { chip: ItemCardChip }) {
	const body = (
		<span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-xs border border-border bg-surface-2 px-1.5 font-medium font-mono text-[10px] text-foreground-secondary">
			{chip.icon ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="size-2.5 text-foreground-muted"
					icon={chip.icon}
				/>
			) : null}
			{chip.label}
		</span>
	);
	return chip.tooltip ? (
		<Tooltip content={chip.tooltip} side="top">
			{body}
		</Tooltip>
	) : (
		body
	);
}

/**
 * Universal item card — the generic descendant of WinSTT's universal model
 * card. A pure layout skeleton with a FIXED-height identity column so every
 * card in a grid reads as the same "medium" specimen regardless of how much
 * content it carries:
 *   1. title row (one line, truncated): selection check, icon, title
 *   2. one spec-chip detail line (never wraps into a second row)
 *   3. description clamped to two lines, height reserved even when shorter
 * plus a right-side actions/favourite cluster and an optional recessed shelf.
 * Callers feed picker-specific content via slots; the chrome stays identical.
 */
export function ItemCard({
	actions,
	badges,
	chips,
	className,
	description,
	errorMessage,
	favorite,
	icon,
	onSelect,
	selectLabel,
	selected = false,
	shelf,
	title,
	unavailable = false,
	unavailableLabel,
}: ItemCardProps) {
	const bodyClickable = !unavailable && onSelect !== undefined;
	const cardClass = cn(
		CARD_BASE,
		selected && CARD_SELECTED,
		unavailable && CARD_UNAVAILABLE,
		bodyClickable && "cursor-pointer",
		className,
	);

	const body = (
		<>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex min-w-0 items-center gap-1.5">
						{selected ? (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-accent"
								icon={CheckmarkCircle02Icon}
							/>
						) : null}
						{icon}
						<span className="min-w-0 truncate font-semibold text-body text-foreground leading-tight">
							{title}
						</span>
						{unavailable && unavailableLabel ? (
							<UnavailableBadge
								errorMessage={errorMessage}
								label={unavailableLabel}
							/>
						) : null}
					</div>
					{unavailable ? (
						errorMessage ? (
							<span className="truncate text-[11px] text-foreground-dim leading-tight">
								{errorMessage}
							</span>
						) : null
					) : (
						<>
							{/* Detail line: spec chips (allowed to shrink/clip) plus any
							    status badges pinned to its end. Kept to ONE line
							    (`overflow-hidden`) and a fixed height so a busy card is the
							    exact same height as a sparse one. */}
							<div className="flex min-h-[20px] min-w-0 items-center gap-x-2 overflow-hidden">
								<div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
									{chips?.map((chip) => (
										<SpecChip chip={chip} key={chip.key} />
									))}
								</div>
								{badges ? (
									<div className="flex shrink-0 items-center gap-1">
										{badges}
									</div>
								) : null}
							</div>
							{/* Description reserves two lines of height unconditionally, so
							    the card's footprint doesn't change with the copy length. */}
							<p className="line-clamp-2 min-h-[30px] text-[11px] text-foreground-muted leading-snug">
								{description}
							</p>
						</>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					{actions}
					{favorite && !unavailable ? (
						<FavoriteToggle favorite={favorite} />
					) : null}
				</div>
			</div>
			{!unavailable && shelf ? (
				<div className={RECESSED_SHELF_CLASSES}>{shelf}</div>
			) : null}
		</>
	);

	if (bodyClickable) {
		return (
			<div className={cardClass}>
				{/* A full-bleed button keeps the body selectable while slot controls
				    (favorite/actions/shelf) stay independently interactive above it. */}
				<button
					aria-label={selectLabel ?? title}
					aria-pressed={selected}
					className="absolute inset-0 rounded-lg border-0 bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
					onClick={onSelect}
					type="button"
				/>
				<div className="pointer-events-none relative z-raised flex flex-col gap-2.5 [&_[role=button]]:pointer-events-auto [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto">
					{body}
				</div>
			</div>
		);
	}
	return <div className={cardClass}>{body}</div>;
}
