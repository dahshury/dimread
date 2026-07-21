import { beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { getSettingsStoreState } from "@/entities/setting";
import { AutoDarkPanel } from "./AutoDarkPanel";

function renderSection() {
	return render(
		<IntlProvider>
			<AutoDarkPanel />
		</IntlProvider>,
	);
}

describe("AutoDarkPanel", () => {
	beforeEach(() => {
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
		getSettingsStoreState().resetSettings();
	});

	test("renders the system theme select and the taskbar toggle", () => {
		renderSection();
		expect(screen.getByRole("button", { name: "System theme" })).toBeDefined();
		expect(
			screen.getByRole("switch", { name: "Transparent taskbar" }),
		).toBeDefined();
	});

	test("offers no control over DimRead's own appearance, which is always dark", () => {
		renderSection();
		expect(screen.queryByRole("button", { name: "App theme" })).toBeNull();
	});

	test("hides the time settings until the system theme follows the day/night schedule", () => {
		renderSection();
		expect(screen.queryByText("System sunrise")).toBeNull();
	});

	test("reveals the system's own sunrise/sunset when the system theme is auto", () => {
		getSettingsStoreState().updateAutoDarkSettings({ systemTheme: "auto" });
		renderSection();
		expect(screen.getByText("System sunrise")).toBeDefined();
		expect(screen.getByText("System sunset")).toBeDefined();
	});
});
