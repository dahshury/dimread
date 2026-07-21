import { Tooltip } from "@base-ui/react/tooltip";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ItemPicker } from "./ItemPicker";
import type { ItemPickerItem, ItemPickerLabels } from "./item-picker-types";

const labels: ItemPickerLabels = {
	clearSearch: "Clear search",
	empty: "No matching items",
	favoritesGroup: "Favorites",
	list: "Items",
	search: "Search items",
	searchPlaceholder: "Search…",
	toggleFavorite: "Favorite",
};

const items: ItemPickerItem[] = [
	{ id: "alpha", title: "Alpha Kit", group: "tools", badges: ["v2"] },
	{ id: "beta", title: "Beta Bench", group: "tools" },
	{ id: "gamma", title: "Gamma Glow", group: "themes" },
];

const groups = [
	{ id: "tools", label: "Tools" },
	{ id: "themes", label: "Themes" },
];

function withTooltips(children: ReactNode) {
	return (
		<Tooltip.Provider closeDelay={0} delay={0}>
			{children}
		</Tooltip.Provider>
	);
}

describe("ItemPicker", () => {
	test("renders grouped rows with the selected checkmark state", () => {
		render(
			withTooltips(
				<ItemPicker
					groups={groups}
					items={items}
					labels={labels}
					virtualized={false}
					onValueChange={() => undefined}
					value="beta"
				/>,
			),
		);
		expect(screen.getByText("Alpha Kit")).toBeTruthy();
		expect(screen.getByText("Tools")).toBeTruthy();
		const selected = screen.getByText("Beta Bench").closest('[role="option"]');
		expect(selected?.getAttribute("aria-selected")).toBe("true");
	});

	test("clicking a row reports the selection (controlled)", () => {
		const onValueChange = mock((_id: string) => undefined);
		render(
			withTooltips(
				<ItemPicker
					groups={groups}
					items={items}
					labels={labels}
					virtualized={false}
					onValueChange={onValueChange}
					value="beta"
				/>,
			),
		);
		fireEvent.click(screen.getByText("Gamma Glow"));
		expect(onValueChange).toHaveBeenCalledWith("gamma");
	});

	test("search filters the list and shows the empty state on no match", () => {
		render(
			withTooltips(
				<ItemPicker
					groups={groups}
					items={items}
					labels={labels}
					virtualized={false}
				/>,
			),
		);
		const input = screen.getByRole("combobox", { name: "Search items" });
		fireEvent.change(input, { target: { value: "glow" } });
		expect(screen.queryByText("Alpha Kit")).toBeNull();
		expect(screen.getByText("Gamma Glow")).toBeTruthy();
		fireEvent.change(input, { target: { value: "zzzz" } });
		expect(screen.getByText("No matching items")).toBeTruthy();
	});

	test("arrow keys + Enter select from the search input (combobox pattern)", () => {
		const onValueChange = mock((_id: string) => undefined);
		render(
			withTooltips(
				<ItemPicker
					groups={groups}
					items={items}
					labels={labels}
					virtualized={false}
					onValueChange={onValueChange}
				/>,
			),
		);
		const input = screen.getByRole("combobox", { name: "Search items" });
		// First ArrowDown lands on the first item row (Alpha), second on Beta.
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onValueChange).toHaveBeenCalledWith("beta");
	});

	test("starring an item pins it into the Favorites group (uncontrolled)", () => {
		render(
			withTooltips(
				<ItemPicker
					groups={groups}
					items={items}
					labels={labels}
					virtualized={false}
				/>,
			),
		);
		expect(screen.queryByText("Favorites")).toBeNull();
		fireEvent.click(screen.getAllByRole("button", { name: "Favorite" })[2]!);
		expect(screen.getByText("Favorites")).toBeTruthy();
		// Gamma now renders twice: pinned + home group.
		expect(screen.getAllByText("Gamma Glow")).toHaveLength(2);
	});

	test("controlled favorites report through onFavoritesChange", () => {
		const onFavoritesChange = mock((_ids: string[]) => undefined);
		render(
			withTooltips(
				<ItemPicker
					favorites={["alpha"]}
					groups={groups}
					items={items}
					labels={labels}
					virtualized={false}
					onFavoritesChange={onFavoritesChange}
				/>,
			),
		);
		// Alpha is pinned; its pinned-copy star unfavorites it.
		fireEvent.click(screen.getAllByRole("button", { name: "Favorite" })[0]!);
		expect(onFavoritesChange).toHaveBeenCalledWith([]);
	});

	test("showFavorites=false renders no stars", () => {
		render(
			withTooltips(
				<ItemPicker
					groups={groups}
					items={items}
					labels={labels}
					virtualized={false}
					showFavorites={false}
				/>,
			),
		);
		expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
	});

	test("virtualized mode mounts the search field and listbox shell", () => {
		render(
			withTooltips(
				<ItemPicker groups={groups} items={items} labels={labels} />,
			),
		);
		expect(screen.getByRole("combobox", { name: "Search items" })).toBeTruthy();
		expect(screen.getByRole("listbox", { name: "Items" })).toBeTruthy();
	});
});
