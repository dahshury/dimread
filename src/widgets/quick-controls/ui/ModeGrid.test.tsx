import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { ModeGrid } from "./ModeGrid";

function renderGrid(
	activeMode = "office",
	onSelect: (mode: string) => undefined = () => undefined,
	grayscaleApplied?: boolean,
) {
	return render(
		<IntlProvider>
			<ModeGrid
				activeMode={activeMode}
				grayscaleApplied={grayscaleApplied}
				onSelect={onSelect}
			/>
		</IntlProvider>,
	);
}

describe("ModeGrid", () => {
	test("renders all eight preset modes", () => {
		renderGrid();
		for (const name of [
			"Pause",
			"Health",
			"Game",
			"Movie",
			"Office",
			"Editing",
			"Reading",
			"Custom",
		]) {
			expect(screen.getByRole("button", { name })).toBeDefined();
		}
	});

	test("marks the active mode as pressed", () => {
		renderGrid("office");
		expect(
			screen
				.getByRole("button", { name: "Office" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			screen.getByRole("button", { name: "Game" }).getAttribute("aria-pressed"),
		).toBe("false");
	});

	test("shows the active mode's description", () => {
		renderGrid("office");
		expect(
			screen.getByText("Comfortable warmth for long hours of office work."),
		).toBeDefined();
	});

	test("reports the degraded Reading effect instead of claiming grayscale", () => {
		renderGrid("reading", undefined, false);
		expect(
			screen.getByText(
				"Reading temperature and brightness are active, but full-screen grayscale is unavailable on this display backend.",
			),
		).toBeDefined();
	});

	test("invokes onSelect with the chosen mode id", () => {
		const onSelect = mock((_mode: string) => undefined);
		renderGrid("office", onSelect);
		fireEvent.click(screen.getByRole("button", { name: "Health" }));
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(
			(onSelect as unknown as { mock: { calls: unknown[][] } }).mock
				.calls[0]?.[0],
		).toBe("health");
	});
});
