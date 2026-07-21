import { Tooltip } from "@base-ui/react/tooltip";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ItemCard } from "./ItemCard";

function withTooltips(children: ReactNode) {
	return (
		<Tooltip.Provider closeDelay={0} delay={0}>
			{children}
		</Tooltip.Provider>
	);
}

describe("ItemCard", () => {
	test("renders title, chips, and description", () => {
		render(
			withTooltips(
				<ItemCard
					chips={[
						{ key: "size", label: "1.2 GB" },
						{ key: "license", label: "MIT" },
					]}
					description="A compact demo entry."
					title="Aurora Kit"
				/>,
			),
		);
		expect(screen.getByText("Aurora Kit")).toBeTruthy();
		expect(screen.getByText("1.2 GB")).toBeTruthy();
		expect(screen.getByText("MIT")).toBeTruthy();
		expect(screen.getByText("A compact demo entry.")).toBeTruthy();
	});

	test("body click selects; the select button reflects selection state", () => {
		const onSelect = mock(() => undefined);
		render(withTooltips(<ItemCard onSelect={onSelect} title="Aurora Kit" />));
		const button = screen.getByRole("button", { name: "Aurora Kit" });
		expect(button.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(button);
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	test("favorite toggle fires without triggering body selection", () => {
		const onSelect = mock(() => undefined);
		const onToggle = mock(() => undefined);
		render(
			withTooltips(
				<ItemCard
					favorite={{
						isFavorited: false,
						label: "Add Aurora Kit to favorites",
						onToggle,
					}}
					onSelect={onSelect}
					title="Aurora Kit"
				/>,
			),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Add Aurora Kit to favorites" }),
		);
		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("unavailable cards drop the select button and show the error line", () => {
		const onSelect = mock(() => undefined);
		render(
			withTooltips(
				<ItemCard
					errorMessage="Missing runtime"
					onSelect={onSelect}
					title="Broken Kit"
					unavailable
					unavailableLabel="Broken"
				/>,
			),
		);
		expect(screen.queryByRole("button", { name: "Broken Kit" })).toBeNull();
		expect(screen.getByText("Broken")).toBeTruthy();
		expect(screen.getByText("Missing runtime")).toBeTruthy();
	});
});
