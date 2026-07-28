import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { getSettingsStoreState, useSettingsStore } from "@/entities/setting";
import { SchedulePanel } from "./SchedulePanel";

function renderPanel() {
	return render(
		<IntlProvider>
			<SchedulePanel />
		</IntlProvider>,
	);
}

const segment = (name: string) => screen.getByRole("button", { name });
const dayNight = () => useSettingsStore.getState().settings.dayNight;
const autoDark = () => useSettingsStore.getState().settings.autoDark;

describe("SchedulePanel", () => {
	beforeEach(() => {
		getSettingsStoreState().resetSettings();
		// Non-native (browser-preview) state: `patchDayNightSettings` writes only to
		// the local store, so the panel round-trips its own edits deterministically.
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
		useSettingsStore.getState().updateDayNightSettings({
			enabled: true,
			useLocation: false,
			locationSource: "auto",
			timezone: "",
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

	test("automatic asks for nothing — no coordinates, no timezone picker", () => {
		// The whole point of the mode: a fresh install gets real sun times without
		// the user knowing their own latitude.
		renderPanel();
		fireEvent.click(segment("Automatic"));
		expect(screen.queryByText("Latitude")).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByText("Location")).toBeNull();
		expect(dayNight()).toMatchObject({
			locationSource: "auto",
			useLocation: true,
		});
	});

	test("manual offers timezone and coordinates as two ways of one source", () => {
		renderPanel();
		fireEvent.click(segment("Manual"));
		// One extra choice appears, not two more top-level sources.
		expect(screen.getByText("Location")).toBeDefined();
		expect(segment("Timezone")).toBeDefined();
		expect(segment("Coordinates")).toBeDefined();
		// Timezone is the way that needs no outside knowledge, so it leads.
		expect(
			screen.getByRole("combobox", { name: "Your timezone" }),
		).toBeDefined();
		expect(screen.queryByText("Latitude")).toBeNull();
		expect(dayNight()).toMatchObject({
			locationSource: "timezone",
			useLocation: true,
		});
	});

	test("the coordinates method swaps in latitude/longitude", () => {
		renderPanel();
		fireEvent.click(segment("Manual"));
		fireEvent.click(segment("Coordinates"));
		expect(screen.getByText("Latitude")).toBeDefined();
		expect(screen.getByText("Longitude")).toBeDefined();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(dayNight().locationSource).toBe("manual");
	});

	test("the chosen manual method survives a trip through the other sources", () => {
		renderPanel();
		fireEvent.click(segment("Manual"));
		fireEvent.click(segment("Coordinates"));
		fireEvent.click(segment("Automatic"));
		fireEvent.click(segment("Manual"));
		// Back on coordinates, not reset to the timezone picker.
		expect(screen.getByText("Latitude")).toBeDefined();
		expect(dayNight().locationSource).toBe("manual");
	});

	test("returning to custom times clears useLocation without losing the source", () => {
		renderPanel();
		fireEvent.click(segment("Manual"));
		fireEvent.click(segment("Custom time"));
		expect(screen.getByText("Sunrise")).toBeDefined();
		expect(dayNight().useLocation).toBe(false);
		// Remembered, so flipping back to location-based times returns to the way
		// the user had already set up.
		expect(dayNight().locationSource).toBe("timezone");
	});

	test("edits persist straight to the dayNight section (no Save step)", () => {
		renderPanel();
		fireEvent.click(segment("Automatic"));
		expect(dayNight().useLocation).toBe(true);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	// ── The Windows-theme section (was its own "Auto dark" tab) ───────────────

	test("renders the system theme select and the taskbar toggle", () => {
		renderPanel();
		expect(screen.getByRole("button", { name: "System theme" })).toBeDefined();
		expect(
			screen.getByRole("switch", { name: "Transparent taskbar" }),
		).toBeDefined();
	});

	test("offers no control over DimRead's own appearance, which is always dark", () => {
		renderPanel();
		expect(screen.queryByRole("button", { name: "App theme" })).toBeNull();
	});

	test("hides the theme schedule's controls until the theme is scheduled", () => {
		renderPanel();
		expect(
			screen.queryByRole("switch", { name: "Follow the day & night schedule" }),
		).toBeNull();
		expect(screen.queryByText("System sunrise")).toBeNull();
	});

	test("a scheduled theme follows the day & night times, with no second pair to set", () => {
		// The point of the merge: one answer to "when is it night?" by default.
		getSettingsStoreState().updateAutoDarkSettings({ systemTheme: "auto" });
		renderPanel();
		expect(autoDark().useDayNightSchedule).toBe(true);
		expect(
			screen.getByRole("switch", { name: "Follow the day & night schedule" }),
		).toBeDefined();
		expect(screen.queryByText("System sunrise")).toBeNull();
	});

	test("opting out reveals the system's own sunrise/sunset as the fallback", () => {
		getSettingsStoreState().updateAutoDarkSettings({
			systemTheme: "auto",
			useDayNightSchedule: false,
		});
		renderPanel();
		expect(screen.getByText("System sunrise")).toBeDefined();
		expect(screen.getByText("System sunset")).toBeDefined();
	});
});
