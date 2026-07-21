import { describe, expect, test } from "bun:test";
import {
	buildItemPickerRows,
	FAVORITES_SECTION_ID,
	firstItemRowIndex,
	type ItemPickerRowModel,
	itemRowIndexById,
	stepItemRow,
	UNGROUPED_SECTION_ID,
} from "./item-picker-logic";
import type { ItemPickerItem } from "./item-picker-types";

const items: ItemPickerItem[] = [
	{ id: "alpha", title: "Alpha Kit", group: "tools", badges: ["v2"] },
	{ id: "beta", title: "Beta Bench", group: "tools" },
	{ id: "gamma", title: "Gamma Glow", group: "themes" },
	{ id: "delta", title: "Delta Dock" }, // ungrouped
];

const groups = [
	{ id: "tools", label: "Tools" },
	{ id: "themes", label: "Themes" },
];

function build(
	overrides: Partial<Parameters<typeof buildItemPickerRows>[1]> = {},
) {
	return buildItemPickerRows(items, {
		favorites: [],
		favoritesLabel: "Favorites",
		groups,
		query: "",
		...overrides,
	});
}

function rowIds(rows: ItemPickerRowModel[]): string[] {
	return rows.map((row) =>
		row.type === "header" ? `H:${row.id}` : `I:${row.item.id}`,
	);
}

describe("buildItemPickerRows", () => {
	test("groups follow the configured order with ungrouped items first", () => {
		expect(rowIds(build())).toEqual([
			"I:delta",
			"H:tools",
			"I:alpha",
			"I:beta",
			"H:themes",
			"I:gamma",
		]);
	});

	test("pins visible favorites into a leading Favorites group, keeping the home copy", () => {
		const rows = build({ favorites: ["gamma"] });
		expect(rowIds(rows)).toEqual([
			`H:${FAVORITES_SECTION_ID}`,
			"I:gamma",
			"I:delta",
			"H:tools",
			"I:alpha",
			"I:beta",
			"H:themes",
			"I:gamma",
		]);
		const pinned = rows[1];
		expect(pinned?.type === "item" && pinned.favorite).toBe(true);
	});

	test("showFavoritesGroup=false suppresses the pinned group", () => {
		const rows = build({
			favorites: ["gamma"],
			showFavoritesGroup: false,
		});
		expect(rowIds(rows)[0]).toBe("I:delta");
	});

	test("fuzzy query filters items and drops empty group headers", () => {
		expect(rowIds(build({ query: "glow" }))).toEqual(["H:themes", "I:gamma"]);
	});

	test("matches against badges and group labels too", () => {
		expect(rowIds(build({ query: "v2" }))).toEqual(["H:tools", "I:alpha"]);
		expect(rowIds(build({ query: "themes" }))).toEqual(["H:themes", "I:gamma"]);
	});

	test("no groups configured renders a flat header-less list", () => {
		const rows = buildItemPickerRows(items, {
			favorites: [],
			favoritesLabel: "Favorites",
			query: "",
		});
		expect(rows.every((row) => row.type === "item")).toBe(true);
		expect(
			rows.every(
				(row) => row.type === "item" && row.sectionId === UNGROUPED_SECTION_ID,
			),
		).toBe(true);
	});

	test("no matches yields an empty row list", () => {
		expect(build({ query: "zzzzzz" })).toEqual([]);
	});
});

describe("keyboard traversal helpers", () => {
	const rows = build(); // [delta, H, alpha, beta, H, gamma]

	test("firstItemRowIndex finds the first item row", () => {
		expect(firstItemRowIndex(rows)).toBe(0);
		expect(firstItemRowIndex([])).toBeNull();
	});

	test("itemRowIndexById prefers the first (pinned) copy", () => {
		const withFavorite = build({ favorites: ["gamma"] });
		expect(itemRowIndexById(withFavorite, "gamma")).toBe(1);
		expect(itemRowIndexById(rows, "missing")).toBeNull();
	});

	test("stepItemRow skips headers in both directions", () => {
		// delta(0) -> alpha(2), skipping the tools header at 1
		expect(stepItemRow(rows, 0, 1)).toBe(2);
		// alpha(2) -> delta(0)
		expect(stepItemRow(rows, 2, -1)).toBe(0);
	});

	test("stepItemRow wraps around the ends", () => {
		// gamma (last, index 5) -> delta (0)
		expect(stepItemRow(rows, 5, 1)).toBe(0);
		// delta (0) -> gamma (5)
		expect(stepItemRow(rows, 0, -1)).toBe(5);
	});

	test("null current starts from the matching end", () => {
		expect(stepItemRow(rows, null, 1)).toBe(0);
		expect(stepItemRow(rows, null, -1)).toBe(5);
	});

	test("header-only lists yield null", () => {
		const headerOnly: ItemPickerRowModel[] = [
			{ type: "header", id: "x", label: "X", count: 0 },
		];
		expect(stepItemRow(headerOnly, null, 1)).toBeNull();
	});
});
