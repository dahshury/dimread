import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import {
	Sortable,
	SortableContent,
	SortableItem,
	SortableItemHandle,
} from "@/shared/ui/data-grid/primitives/sortable";

/** Minimal shape the sortable machinery needs. */
export interface SortableListEntry {
	id: string;
}

export interface SortableListProps<T extends SortableListEntry> {
	className?: string | undefined;
	/** Freeze the list: handles hidden-disabled, rows stay put. */
	disabled?: boolean | undefined;
	/** Accessible name for each row's grab handle ("Reorder"). */
	handleLabel: string;
	items: readonly T[];
	/** Called after a drop / keyboard reorder with ids in new display order. */
	onReorder: (orderedIds: string[]) => void;
	/** Drag-in-progress signal (e.g. to fence hover effects elsewhere). */
	onSortingChange?: ((sorting: boolean) => void) | undefined;
	/** Renders one row's content (the handle chrome is supplied). */
	renderItem: (item: T) => ReactNode;
}

/**
 * A generic drag-to-reorder vertical list, ported from WinSTT's mic-priority
 * drag-sort pattern (`SortableOptionRows`): dnd-kit rows on lifted surface
 * cards with always-visible grab handles (hover-reveal made lists look
 * unsortable), pointer + keyboard sorting (space to grab, arrows to move,
 * space to drop — announced to screen readers), and the dnd-kit transform
 * transition animating rows into place.
 *
 * For drag-sortable rows inside a `Select` popup, use the Select's own
 * `sortable`/`onReorder` options instead — this component is the standalone
 * list-on-a-page variant.
 */
export function SortableList<T extends SortableListEntry>({
	className,
	disabled = false,
	handleLabel,
	items,
	onReorder,
	onSortingChange,
	renderItem,
}: SortableListProps<T>) {
	const rowBg = surfaceBg(Math.min(useSurface() + 1, 8));
	// Typed against the supertype: TS can't resolve Sortable's conditional
	// `GetItemValue<T>` for an unbound generic, and the dnd wiring only needs
	// `id` (same shape-erasure WinSTT's SortableOptionRows uses).
	const entries: SortableListEntry[] = [...items];
	return (
		<Sortable
			getItemValue={(entry: SortableListEntry) => entry.id}
			onDragCancel={() => onSortingChange?.(false)}
			onDragEnd={() => onSortingChange?.(false)}
			onDragStart={() => onSortingChange?.(true)}
			onValueChange={(next) => onReorder(next.map((entry) => entry.id))}
			orientation="vertical"
			value={entries}
		>
			<SortableContent
				className={cn("flex w-full flex-col gap-1.5", className)}
				role="list"
			>
				{items.map((item) => (
					<SortableItem
						className={cn(
							"flex items-center gap-2 rounded-lg px-2.5 py-2 ring-1 ring-divider",
							rowBg,
							"data-dragging:z-10 data-dragging:shadow-md data-dragging:ring-border-hover",
						)}
						disabled={disabled}
						key={item.id}
						role="listitem"
						value={item.id}
					>
						<SortableItemHandle
							aria-label={handleLabel}
							className="flex size-5 shrink-0 items-center justify-center rounded text-foreground-dim transition-colors hover:text-foreground data-dragging:text-foreground"
						>
							<HugeiconsIcon
								aria-hidden="true"
								icon={DragDropVerticalIcon}
								size={14}
							/>
						</SortableItemHandle>
						<div className="min-w-0 flex-1">{renderItem(item)}</div>
					</SortableItem>
				))}
			</SortableContent>
		</Sortable>
	);
}
