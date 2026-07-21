import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import type { ItemPickerGroup, ItemPickerItem } from "./item-picker-types";

/** Sentinel section id of the pinned favorites group. */
export const FAVORITES_SECTION_ID = "__favorites__";
/** Sentinel section id of the ungrouped leading section (no header). */
export const UNGROUPED_SECTION_ID = "__ungrouped__";

/** One flattened virtual row: a sticky group header or a pickable item. */
export type ItemPickerRowModel =
	| { count: number; id: string; label: string; type: "header" }
	| {
			favorite: boolean;
			item: ItemPickerItem;
			sectionId: string;
			type: "item";
	  };

export interface BuildItemPickerRowsOptions {
	favorites: readonly string[];
	/** Header label for the pinned favorites group. Favorites collect there
	 *  only when at least one favorited item is visible. */
	favoritesLabel: string;
	/** Group order + labels. Items whose `group` is not listed fall back to the
	 *  ungrouped leading section. Omit for a flat, header-less list. */
	groups?: readonly ItemPickerGroup[] | undefined;
	query: string;
	/** When false the favorites group is not pinned (stars may still render). */
	showFavoritesGroup?: boolean | undefined;
}

function matchesItem(
	item: ItemPickerItem,
	groupLabel: string | undefined,
	query: string,
): boolean {
	return matchesFuzzySearch(
		[item.title, item.subtitle ?? "", ...(item.badges ?? []), groupLabel ?? ""],
		query,
	);
}

function pushSection(
	rows: ItemPickerRowModel[],
	sectionId: string,
	label: string | null,
	items: readonly ItemPickerItem[],
	favorites: ReadonlySet<string>,
): void {
	if (items.length === 0) {
		return;
	}
	if (label !== null) {
		rows.push({
			type: "header",
			id: sectionId,
			label,
			count: items.length,
		});
	}
	for (const item of items) {
		rows.push({
			type: "item",
			item,
			sectionId,
			favorite: favorites.has(item.id),
		});
	}
}

/**
 * Flattens the catalog into the virtualized row list: a fuzzy-filtered,
 * grouped sequence of header + item rows with visible favorites collected
 * into a pinned Favorites group first (items stay in their home group too —
 * the WinSTT picker convention), then ungrouped items, then each configured
 * group in order.
 */
export function buildItemPickerRows(
	items: readonly ItemPickerItem[],
	{
		favorites,
		favoritesLabel,
		groups,
		query,
		showFavoritesGroup = true,
	}: BuildItemPickerRowsOptions,
): ItemPickerRowModel[] {
	const groupLabels = new Map<string, string>(
		(groups ?? []).map((group) => [group.id, group.label]),
	);
	const favoriteSet = new Set(favorites);
	const visible = items.filter((item) =>
		matchesItem(
			item,
			item.group === undefined ? undefined : groupLabels.get(item.group),
			query,
		),
	);
	const rows: ItemPickerRowModel[] = [];
	if (showFavoritesGroup) {
		pushSection(
			rows,
			FAVORITES_SECTION_ID,
			favoritesLabel,
			visible.filter((item) => favoriteSet.has(item.id)),
			favoriteSet,
		);
	}
	const ungrouped = visible.filter(
		(item) => item.group === undefined || !groupLabels.has(item.group),
	);
	// A flat catalog (no groups configured, nothing favorited yet) renders
	// header-less; once any header exists the ungrouped block keeps no header
	// of its own (it reads as the list's preamble).
	pushSection(rows, UNGROUPED_SECTION_ID, null, ungrouped, favoriteSet);
	for (const group of groups ?? []) {
		pushSection(
			rows,
			group.id,
			group.label,
			visible.filter((item) => item.group === group.id),
			favoriteSet,
		);
	}
	return rows;
}

/** Index of the first item row, or null when the list is empty/header-only. */
export function firstItemRowIndex(
	rows: readonly ItemPickerRowModel[],
): number | null {
	const index = rows.findIndex((row) => row.type === "item");
	return index === -1 ? null : index;
}

/** Index of the first item row matching `id` (favorites duplicate items, so
 *  the pinned copy wins), or null when not visible. */
export function itemRowIndexById(
	rows: readonly ItemPickerRowModel[],
	id: string,
): number | null {
	const index = rows.findIndex(
		(row) => row.type === "item" && row.item.id === id,
	);
	return index === -1 ? null : index;
}

/**
 * Arrow-key step: the next/previous ITEM row from `current`, skipping headers
 * and wrapping around. `null` current starts from the corresponding end.
 */
export function stepItemRow(
	rows: readonly ItemPickerRowModel[],
	current: number | null,
	delta: 1 | -1,
): number | null {
	if (rows.length === 0) {
		return null;
	}
	const start = current ?? (delta === 1 ? -1 : rows.length);
	for (let step = 1; step <= rows.length; step++) {
		const index = (start + delta * step + rows.length * step) % rows.length;
		if (rows[index]?.type === "item") {
			return index;
		}
	}
	return null;
}
