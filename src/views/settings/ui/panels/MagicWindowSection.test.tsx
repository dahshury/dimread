import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { getSettingsStoreState, useSettingsStore } from "@/entities/setting";
import { DEFAULT_TOOLBAR_COLOR } from "@/features/magicx";
import { MagicWindowSection } from "./MagicWindowSection";

function renderSection() {
	return render(
		<IntlProvider>
			<MagicWindowSection />
		</IntlProvider>,
	);
}

function setBrowserPreview(): void {
	(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
		undefined;
}

function settings() {
	return useSettingsStore.getState().settings.magicx;
}

function clickStepperIncrement(input: HTMLElement): void {
	fireEvent.keyDown(input, { key: "ArrowUp" });
}

describe("MagicWindowSection", () => {
	beforeEach(() => {
		getSettingsStoreState().resetSettings();
		setBrowserPreview();
	});

	test("persists every toggle, scalar, colour, and alignment control", () => {
		getSettingsStoreState().updateMagicxSettings({
			enabled: true,
			toolbarEnabled: true,
		});
		const { unmount } = renderSection();

		fireEvent.click(screen.getByRole("switch", { name: "Enable MagicX" }));
		expect(settings().enabled).toBe(false);
		fireEvent.click(screen.getByRole("switch", { name: "Enable MagicX" }));
		expect(settings().enabled).toBe(true);

		fireEvent.click(screen.getByRole("switch", { name: "Show Magic Toolbar" }));
		expect(settings().toolbarEnabled).toBe(false);
		fireEvent.click(screen.getByRole("switch", { name: "Show Magic Toolbar" }));
		expect(settings().toolbarEnabled).toBe(true);

		const color = screen.getByLabelText("Toolbar colour");
		fireEvent.change(color, { target: { value: "#abcdef" } });
		expect(settings().toolbarColor).toBe("#abcdef");
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(settings().toolbarColor).toBe(DEFAULT_TOOLBAR_COLOR);

		fireEvent.click(screen.getByRole("button", { name: "Left" }));
		expect(settings().toolbarAlign).toBe("left");

		clickStepperIncrement(screen.getByRole("textbox"));
		expect(settings().toolbarDelayMs).toBe(450);

		// The offset is intentionally trailing-debounced. Leaving this tab must
		// flush the pending final value instead of cancelling it.
		fireEvent.keyDown(screen.getByRole("slider", { name: "Offset" }), {
			key: "ArrowRight",
		});
		expect(settings().toolbarOffset).toBe(0);
		unmount();
		expect(settings().toolbarOffset).toBe(4);
	});

	test("truly disables every toolbar option until both parent toggles are on", () => {
		const { unmount } = renderSection();

		const toolbarToggle = screen.getByRole("switch", {
			name: "Show Magic Toolbar",
		}) as HTMLElement & { disabled?: boolean };
		const color = screen.getByLabelText("Toolbar colour") as HTMLInputElement;
		const reset = screen.getByRole("button", {
			name: "Reset",
		}) as HTMLButtonElement;
		const left = screen.getByRole("button", {
			name: "Left",
		}) as HTMLButtonElement;
		const offset = screen.getByRole("slider", { name: "Offset" });
		const delay = screen.getByRole("textbox") as HTMLInputElement;

		expect(toolbarToggle.getAttribute("aria-disabled")).toBe("true");
		expect(color.disabled).toBe(true);
		expect(reset.disabled).toBe(true);
		expect(left.disabled).toBe(true);
		expect(delay.disabled).toBe(true);

		// Native-disabled alignment buttons reject both pointer and keyboard input.
		fireEvent.click(left);
		fireEvent.keyDown(left, { key: "ArrowRight" });
		fireEvent.keyDown(offset, { key: "ArrowRight" });
		expect(settings().toolbarAlign).toBe("center");
		expect(settings().toolbarOffset).toBe(0);

		fireEvent.click(screen.getByRole("switch", { name: "Enable MagicX" }));
		expect(settings().enabled).toBe(true);
		expect(
			screen
				.getByRole("switch", { name: "Show Magic Toolbar" })
				.getAttribute("aria-disabled"),
		).not.toBe("true");
		// Turning the master on is insufficient while the toolbar itself is off.
		fireEvent.click(screen.getByRole("switch", { name: "Show Magic Toolbar" }));
		expect(settings().toolbarEnabled).toBe(false);
		expect(
			(screen.getByRole("button", { name: "Left" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.click(screen.getByRole("switch", { name: "Show Magic Toolbar" }));
		expect(settings().toolbarEnabled).toBe(true);
		expect(
			(screen.getByRole("button", { name: "Left" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		expect(
			(screen.getByLabelText("Toolbar colour") as HTMLInputElement).disabled,
		).toBe(false);
		expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(
			false,
		);
		unmount();
	});
});
