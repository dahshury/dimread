import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { getSettingsStoreState, useSettingsStore } from "@/entities/setting";
import { WindowEffectsPanel } from "./WindowEffectsPanel";

function renderPanel() {
	return render(
		<IntlProvider>
			<WindowEffectsPanel />
		</IntlProvider>,
	);
}

function clickStepperIncrement(input: HTMLElement): void {
	fireEvent.keyDown(input, { key: "ArrowUp" });
}

describe("WindowEffectsPanel", () => {
	beforeEach(() => {
		getSettingsStoreState().resetSettings();
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
	});

	test("writes every Focus Read and Focus Blur option to its owning section", () => {
		const { unmount } = renderPanel();
		const readTransparency = screen.getByRole("slider", {
			name: "Focus Read transparency",
		});
		const blurTransparency = screen.getByRole("slider", {
			name: "Focus Blur transparency",
		});

		fireEvent.keyDown(readTransparency, { key: "ArrowRight" });
		fireEvent.change(screen.getByLabelText("Shade colour"), {
			target: { value: "#123456" },
		});
		clickStepperIncrement(screen.getAllByRole("textbox")[0]!);

		fireEvent.click(screen.getByRole("switch", { name: "Enable Focus Blur" }));
		fireEvent.click(screen.getByRole("switch", { name: "Include taskbar" }));
		fireEvent.click(
			screen.getByRole("switch", { name: "Only current monitor" }),
		);
		fireEvent.click(
			screen.getByRole("switch", { name: "Transition animation" }),
		);
		fireEvent.keyDown(blurTransparency, { key: "ArrowRight" });
		fireEvent.change(screen.getByLabelText("Background colour"), {
			target: { value: "#654321" },
		});

		const { focusRead, focusBlur } = useSettingsStore.getState().settings;
		expect(focusRead).toEqual({
			transparency: 51,
			color: "#123456",
			height: 310,
		});
		expect(focusBlur).toEqual({
			enabled: true,
			includeTaskbar: true,
			onlyCurrentMonitor: true,
			animate: false,
			transparency: 51,
			color: "#654321",
		});
		unmount();
	});
});
