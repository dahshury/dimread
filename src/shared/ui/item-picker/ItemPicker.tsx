import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { cn } from "@/shared/lib/cn";
import { useControllableState } from "@/shared/lib/use-controllable-state";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { ClearableTextField } from "@/shared/ui/text-field";
import { ItemPickerRow } from "./ItemPickerRow";
import { ItemSpecHoverCard } from "./ItemSpecCard";
import {
	buildItemPickerRows,
	firstItemRowIndex,
	type ItemPickerRowModel,
	itemRowIndexById,
	stepItemRow,
} from "./item-picker-logic";
import type {
	ItemPickerGroup,
	ItemPickerItem,
	ItemPickerLabels,
} from "./item-picker-types";

/** Spec-card placement overrides (see {@link ItemSpecHoverCard}). */
export interface ItemPickerSpecCardOptions {
	align?: "start" | "center" | "end";
	delay?: number;
	side?: "top" | "bottom" | "left" | "right";
}

export interface ItemPickerProps {
	/** Focus the search field on mount (and whenever it flips back to true —
	 *  e.g. a warm-mounted detached window becoming interactive). */
	autoFocusSearch?: boolean;
	className?: string | undefined;
	/** Uncontrolled initial favorites. Ignored when `favorites` is provided. */
	defaultFavorites?: readonly string[] | undefined;
	/** Uncontrolled initial selection. Ignored when `value` is provided. */
	defaultValue?: string | null | undefined;
	/** Controlled favorites (star toggles report through onFavoritesChange). */
	favorites?: readonly string[] | undefined;
	/** Group order + localized labels. Omit for a flat, header-less list. */
	groups?: readonly ItemPickerGroup[] | undefined;
	items: readonly ItemPickerItem[];
	labels: ItemPickerLabels;
	onFavoritesChange?: ((favorites: string[]) => void) | undefined;
	onValueChange?: ((id: string) => void) | undefined;
	/** Render star toggles + the pinned Favorites group. Default true. */
	showFavorites?: boolean;
	/** Hover spec card on rows: `true` for defaults, or placement options.
	 *  Omit/false for no preview panel. */
	specCard?: boolean | ItemPickerSpecCardOptions | undefined;
	/** Controlled selection. */
	value?: string | null | undefined;
	/** Windowed rendering via virtua (default). Turn off for small inline
	 *  lists — rows render eagerly with CSS-sticky group headers instead
	 *  (also the mode exercised by DOM tests, where virtua can't measure). */
	virtualized?: boolean;
}

const NO_FAVORITES: readonly string[] = [];

function rowKey(row: ItemPickerRowModel): string {
	return row.type === "header"
		? `header:${row.id}`
		: `item:${row.sectionId}:${row.item.id}`;
}

/**
 * Generic searchable item picker — the core UX of WinSTT's model picker with
 * the model domain stripped: a fuzzy search field over a virtualized, grouped
 * item list with pinned favorites, selected checkmark, full keyboard
 * traversal from the search input (combobox pattern), and an optional hover
 * spec card. Works inline (popover/dialog body) and as the detached picker
 * window's panel body. Selection and favorites each support controlled and
 * uncontrolled usage.
 */
export function ItemPicker({
	autoFocusSearch = false,
	className,
	defaultFavorites,
	defaultValue,
	favorites,
	groups,
	items,
	labels,
	onFavoritesChange,
	onValueChange,
	showFavorites = true,
	specCard,
	value,
	virtualized = true,
}: ItemPickerProps): ReactNode {
	const listId = useId();
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useControllableState<string | null>(
		value,
		defaultValue ?? null,
		onValueChange === undefined
			? undefined
			: (next) => {
					if (next !== null) {
						onValueChange(next);
					}
				},
	);
	const [favoriteIds, setFavoriteIds] = useControllableState<readonly string[]>(
		favorites,
		defaultFavorites ?? NO_FAVORITES,
		(next) => onFavoritesChange?.([...next]),
	);
	const [activeIndex, setActiveIndex] = useState<number | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const virtualizerRef = useRef<VirtualizerHandle>(null);
	// Section id whose header floats pinned at the top (the in-list header
	// unmounts under virtualization, so it is re-rendered as an overlay).
	const [stickySectionId, setStickySectionId] = useState<string | null>(null);

	const rows = buildItemPickerRows(items, {
		favorites: favoriteIds,
		favoritesLabel: labels.favoritesGroup,
		groups,
		query,
		showFavoritesGroup: showFavorites,
	});
	const stickyHeader =
		stickySectionId === null
			? undefined
			: rows.find((row) => row.type === "header" && row.id === stickySectionId);

	useEffect(() => {
		if (autoFocusSearch) {
			inputRef.current?.focus();
		}
	}, [autoFocusSearch]);

	const activeRow = activeIndex === null ? undefined : rows[activeIndex];
	const activeRowId =
		activeRow?.type === "item" ? `${listId}-${rowKey(activeRow)}` : undefined;

	const scrollRowIntoView = (index: number) => {
		const handle = virtualizerRef.current;
		if (handle) {
			handle.scrollToIndex(index, { align: "nearest" });
			return;
		}
		// Eager (non-virtualized) mode: plain DOM scroll.
		const row = rows[index];
		if (row?.type === "item") {
			document
				.getElementById(`${listId}-${rowKey(row)}`)
				?.scrollIntoView({ block: "nearest" });
		}
	};

	const moveActive = (delta: 1 | -1) => {
		const start =
			activeIndex ??
			(selectedId === null ? null : itemRowIndexById(rows, selectedId));
		const next = stepItemRow(rows, start, delta);
		if (next !== null) {
			setActiveIndex(next);
			scrollRowIntoView(next);
		}
	};

	const jumpActive = (position: "first" | "last") => {
		const next =
			position === "first"
				? firstItemRowIndex(rows)
				: stepItemRow(rows, null, -1);
		if (next !== null) {
			setActiveIndex(next);
			scrollRowIntoView(next);
		}
	};

	const handleSelect = (id: string) => {
		setSelectedId(id);
	};

	const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveActive(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			moveActive(-1);
		} else if (event.key === "Home" && query.length === 0) {
			event.preventDefault();
			jumpActive("first");
		} else if (event.key === "End" && query.length === 0) {
			event.preventDefault();
			jumpActive("last");
		} else if (event.key === "Enter" && activeRow?.type === "item") {
			event.preventDefault();
			handleSelect(activeRow.item.id);
		}
	};

	const handleQueryChange = (next: string) => {
		setQuery(next);
		// A new result set invalidates the highlight; restart at the top so
		// Enter always picks the best (first) match.
		setActiveIndex(null);
		setStickySectionId(null);
		virtualizerRef.current?.scrollTo(0);
	};

	const handleVirtualScroll = (offset: number) => {
		const handle = virtualizerRef.current;
		if (!handle || rows.length === 0) {
			return;
		}
		// The topmost visible row's section header floats pinned — but only once
		// scrolled PAST the header row itself (top row is an item), so a header
		// docked at the very top isn't duplicated by the overlay.
		const threshold = offset + 1;
		for (let index = 0; index < rows.length; index++) {
			if (handle.getItemOffset(index) + handle.getItemSize(index) > threshold) {
				const top = rows[index];
				setStickySectionId(top && top.type === "item" ? top.sectionId : null);
				return;
			}
		}
		setStickySectionId(null);
	};

	const specCardOptions =
		specCard === true ? {} : specCard === false ? undefined : specCard;

	const renderRow = (row: ItemPickerRowModel, index: number) => {
		if (row.type === "header") {
			return (
				<div
					className={cn(
						"picker-group-header-surface mx-1.5 mt-1 mb-0.5 rounded-xs px-2.5 py-1 font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]",
						// Eager mode keeps real CSS-sticky headers; virtualized mode
						// re-renders the active one as the floating overlay instead
						// (a virtualized header unmounts while its group scrolls).
						!virtualized && "sticky top-0 z-raised",
					)}
					key={rowKey(row)}
					role="presentation"
				>
					{row.label}
				</div>
			);
		}
		const rowNode = (
			<ItemPickerRow
				active={index === activeIndex}
				favorite={row.favorite}
				favoriteLabel={labels.toggleFavorite}
				id={`${listId}-${rowKey(row)}`}
				item={row.item}
				onHover={() => setActiveIndex(index)}
				onSelect={handleSelect}
				onToggleFavorite={
					showFavorites
						? (id) =>
								setFavoriteIds(
									favoriteIds.includes(id)
										? favoriteIds.filter((candidate) => candidate !== id)
										: [...favoriteIds, id],
								)
						: undefined
				}
				selected={row.item.id === selectedId}
			/>
		);
		return specCardOptions === undefined ? (
			<div key={rowKey(row)} role="presentation">
				{rowNode}
			</div>
		) : (
			<ItemSpecHoverCard item={row.item} key={rowKey(row)} {...specCardOptions}>
				<div role="presentation">{rowNode}</div>
			</ItemSpecHoverCard>
		);
	};

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			<div className="shrink-0 border-divider border-b p-2">
				<ClearableTextField
					aria-activedescendant={activeRowId}
					aria-controls={listId}
					aria-expanded={true}
					aria-label={labels.search}
					clearLabel={labels.clearSearch}
					leadingIcon={
						<HugeiconsIcon aria-hidden="true" icon={Search01Icon} size={15} />
					}
					onKeyDown={handleSearchKeyDown}
					onValueChange={handleQueryChange}
					placeholder={labels.searchPlaceholder}
					ref={inputRef}
					role="combobox"
					type="text"
					value={query}
				/>
			</div>
			<div className="relative min-h-0 flex-1">
				{virtualized && stickyHeader && stickyHeader.type === "header" ? (
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-1.5 z-raised"
					>
						<div className="picker-group-header-surface mx-1.5 rounded-xs px-2.5 py-1 font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]">
							{stickyHeader.label}
						</div>
					</div>
				) : null}
				{rows.length === 0 ? (
					<p className="px-4 py-6 text-center text-body-sm text-foreground-muted">
						{labels.empty}
					</p>
				) : (
					<ScrollArea
						className="h-full min-h-0"
						verticalOnly
						viewportClassName="overscroll-contain py-1.5"
						viewportRef={viewportRef}
					>
						<div aria-label={labels.list} id={listId} role="listbox">
							{virtualized ? (
								<Virtualizer
									data={rows}
									onScroll={handleVirtualScroll}
									ref={virtualizerRef}
									scrollRef={viewportRef}
								>
									{renderRow}
								</Virtualizer>
							) : (
								rows.map(renderRow)
							)}
						</div>
					</ScrollArea>
				)}
			</div>
		</div>
	);
}
