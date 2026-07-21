import { Tooltip } from "@base-ui/react/tooltip";
import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MultiCombobox } from "./MultiCombobox";

const options = [
	{ id: "en", label: "English", badge: "EN" },
	{ id: "fr", label: "French", badge: "FR" },
	{ id: "de", label: "German", badge: "DE" },
	{ id: "es", label: "Spanish", badge: "ES" },
];

function renderCombobox(
	value: readonly string[] = ["en"],
	onChange = mock((_value: string[]) => undefined),
) {
	render(
		<Tooltip.Provider closeDelay={0} delay={0}>
			<MultiCombobox
				ariaLabel="Languages"
				clearAllLabel="Clear"
				emptyLabel="No matches"
				onChange={onChange}
				options={options}
				placeholder="Select languages"
				removeLabel={(item) => `Remove ${item}`}
				selectAllLabel="Select all"
				selectedCountLabel={(count) => `${count} selected`}
				selectedHeading="Selected"
				value={value}
			/>
		</Tooltip.Provider>,
	);
	return onChange;
}

async function openPopup() {
	// Two triggers share the accessible name (input + chevron); either opens.
	fireEvent.click(screen.getAllByRole("button", { name: "Languages" })[0]!);
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

describe("MultiCombobox", () => {
	test("renders the selection as checked checkboxes", async () => {
		renderCombobox(["en", "fr"]);
		await openPopup();
		expect(
			screen
				.getByRole("checkbox", { name: "English" })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("checkbox", { name: "German" })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	test("toggling an option reports the new selection", async () => {
		const onChange = renderCombobox(["en"]);
		await openPopup();
		fireEvent.click(screen.getByRole("checkbox", { name: "German" }));
		expect(onChange).toHaveBeenCalledWith(["en", "de"]);
	});

	test("removing a chip deselects the item", async () => {
		const onChange = renderCombobox(["en", "fr"]);
		await openPopup();
		fireEvent.click(screen.getByRole("button", { name: "Remove English" }));
		expect(onChange).toHaveBeenCalledWith(["fr"]);
	});

	test("select-all selects every visible option", async () => {
		const onChange = renderCombobox(["fr"]);
		await openPopup();
		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(onChange).toHaveBeenCalledWith(["fr", "en", "de", "es"]);
	});

	test("clear empties the selection", async () => {
		const onChange = renderCombobox(["en", "fr"]);
		await openPopup();
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	test("clear is disabled when nothing is selected", async () => {
		renderCombobox([]);
		await openPopup();
		const clear = screen.getByRole("button", { name: "Clear" });
		expect(clear.hasAttribute("disabled")).toBe(true);
	});
});
