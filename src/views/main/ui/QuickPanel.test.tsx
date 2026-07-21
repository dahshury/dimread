import { beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { QuickPanel } from "./QuickPanel";

function renderPanel() {
	return render(
		<IntlProvider>
			<QuickPanel />
		</IntlProvider>,
	);
}

describe("QuickPanel", () => {
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
	});

	test("shows the default mode's values and mode grid", () => {
		renderPanel();
		// Persisted default mode is Pause → 6500 K / 100 %.
		expect(screen.getByText("6500K")).toBeDefined();
		expect(screen.getByText("100%")).toBeDefined();
		expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Custom" })).toBeDefined();
	});

	test("keeps configuration out of the main window", () => {
		renderPanel();
		// Hotkeys, rules and the day/night schedule all belong to settings now.
		expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Day & night settings" }),
		).toBeNull();
		expect(screen.queryByText("Latitude")).toBeNull();
	});
});
