import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { DayNightPanel } from "./DayNightPanel";

function renderPanel() {
	return render(
		<IntlProvider>
			<DayNightPanel />
		</IntlProvider>,
	);
}

describe("DayNightPanel", () => {
	beforeEach(() => {
		// Non-native (browser-preview) state: `patchDayNightSettings` writes only to
		// the local store, so the panel round-trips its own edits deterministically.
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
		useSettingsStore.getState().updateDayNightSettings({
			enabled: true,
			useLocation: false,
			latitude: 40,
			longitude: -74,
			sunrise: "06:47",
			sunset: "17:40",
			transitionMinutes: 60,
		});
	});

	test("renders the custom sun-time inputs when not location-based", () => {
		renderPanel();
		expect(screen.getByText("Sunrise")).toBeDefined();
		expect(screen.getByText("Sunset")).toBeDefined();
	});

	test("switching to location swaps in latitude/longitude", () => {
		renderPanel();
		fireEvent.click(
			screen.getByRole("button", { name: "Time based on location" }),
		);
		expect(screen.getByText("Latitude")).toBeDefined();
		expect(screen.getByText("Longitude")).toBeDefined();
	});

	test("edits persist straight to the dayNight section (no Save step)", () => {
		renderPanel();
		fireEvent.click(
			screen.getByRole("button", { name: "Time based on location" }),
		);
		expect(useSettingsStore.getState().settings.dayNight.useLocation).toBe(
			true,
		);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});
});
