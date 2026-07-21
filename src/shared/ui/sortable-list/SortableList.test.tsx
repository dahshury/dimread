import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { SortableList } from "./SortableList";

const ITEMS = [
	{ id: "a", label: "Alpha" },
	{ id: "b", label: "Beta" },
	{ id: "c", label: "Gamma" },
];

describe("SortableList", () => {
	test("renders every row's content in order", () => {
		render(
			<SortableList
				handleLabel="Reorder"
				items={ITEMS}
				onReorder={() => undefined}
				renderItem={(item) => <span>{item.label}</span>}
			/>,
		);
		const rows = screen.getAllByRole("listitem");
		expect(rows.length).toBe(3);
		expect(rows.map((row) => row.textContent)).toEqual([
			"Alpha",
			"Beta",
			"Gamma",
		]);
	});

	test("each row exposes a keyboard-focusable grab handle", () => {
		render(
			<SortableList
				handleLabel="Reorder"
				items={ITEMS}
				onReorder={() => undefined}
				renderItem={(item) => <span>{item.label}</span>}
			/>,
		);
		const handles = screen.getAllByRole("button", { name: "Reorder" });
		expect(handles.length).toBe(3);
		for (const handle of handles) {
			expect(handle.tagName).toBe("BUTTON");
			expect(handle.hasAttribute("disabled")).toBe(false);
			// dnd-kit wires its keyboard/pointer activator attributes here.
			expect(handle.getAttribute("aria-roledescription")).toBe("sortable");
		}
	});

	test("disabled list disables the handles", () => {
		render(
			<SortableList
				disabled
				handleLabel="Reorder"
				items={ITEMS}
				onReorder={() => undefined}
				renderItem={(item) => <span>{item.label}</span>}
			/>,
		);
		for (const handle of screen.getAllByRole("button", { name: "Reorder" })) {
			expect(handle.hasAttribute("disabled")).toBe(true);
		}
	});

	test("renderItem receives the full item", () => {
		const renderItem = mock((item: (typeof ITEMS)[number]) => (
			<span>{item.label}</span>
		));
		render(
			<SortableList
				handleLabel="Reorder"
				items={ITEMS}
				onReorder={() => undefined}
				renderItem={renderItem}
			/>,
		);
		expect(renderItem).toHaveBeenCalledTimes(3);
		expect(renderItem.mock.calls.map((call) => call[0]?.id)).toEqual([
			"a",
			"b",
			"c",
		]);
	});
});
