import { beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { QuickControls } from "./QuickControls";

function renderPanel() {
	return render(
		<IntlProvider>
			<QuickControls />
		</IntlProvider>,
	);
}

describe("QuickControls", () => {
	beforeEach(() => {
		// Non-native (browser-preview) state: the monitor/state effects stay inert
		// so the panel renders the persisted-defaults snapshot deterministically.
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
	});

	test("renders the colour-temperature and brightness sliders", () => {
		renderPanel();
		expect(screen.getByText("Warm")).toBeDefined();
		expect(screen.getByText("Cool")).toBeDefined();
		expect(screen.getByText("Dimmer")).toBeDefined();
		expect(screen.getByText("Brighter")).toBeDefined();
		expect(screen.getAllByRole("slider").length).toBeGreaterThanOrEqual(2);
		expect(
			screen.getByRole("button", { name: "Reset colour temperature" }),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Reset brightness" }),
		).toBeDefined();
	});

	test("shows the default mode's values and mode grid", () => {
		renderPanel();
		// Persisted default mode is Pause → 6500 K / 100 %.
		expect(screen.getByText("6500K")).toBeDefined();
		expect(screen.getByText("100%")).toBeDefined();
		expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Custom" })).toBeDefined();
	});

	test("carries the auto day/night switch that used to live in the main window", () => {
		renderPanel();
		expect(
			screen.getByRole("switch", { name: "Auto day/night" }),
		).toBeDefined();
		expect(
			(screen.getByRole("button", { name: "Day" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: "Night" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	test("leaves the numeric schedule to the Day & Night panel", () => {
		renderPanel();
		// The block is the live controls only; anything with a number, a hotkey
		// or a rule stays in its own settings tab.
		expect(screen.queryByText("Latitude")).toBeNull();
		expect(screen.queryByText("Sunrise")).toBeNull();
	});
});
