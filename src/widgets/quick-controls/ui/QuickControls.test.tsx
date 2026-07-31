import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { QuickControls } from "./QuickControls";

function renderPanel() {
	return render(
		<IntlProvider>
			<QuickControls />
		</IntlProvider>,
	);
}

/** Render with the engine reporting a live day→night ramp at `factor`. */
async function renderDuringTransition(factor: number) {
	mockIPC(
		(command) => {
			if (command === "display_current") {
				return {
					brightness: 73,
					factor,
					grayscaleApplied: false,
					kelvin: 4300,
					mode: "office",
					phase: "transition",
				};
			}
			if (command === "display_list_monitors") {
				return [];
			}
			return undefined;
		},
		{ shouldMockEvents: true },
	);
	const rendered = renderPanel();
	// Let `display_current` resolve and React render the transition state.
	await act(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);
	return rendered;
}

describe("QuickControls", () => {
	beforeEach(() => {
		// Non-native (browser-preview) state: the monitor/state effects stay inert
		// so the panel renders the persisted-defaults snapshot deterministically.
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
	});

	afterEach(() => {
		clearMocks();
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

	test("does not start an endpoint preview when opened during a transition", async () => {
		const commands: string[] = [];
		mockIPC(
			(command) => {
				commands.push(command);
				if (command === "display_current") {
					return {
						brightness: 73,
						factor: 0.6,
						grayscaleApplied: false,
						kelvin: 4300,
						mode: "office",
						phase: "transition",
					};
				}
				if (command === "display_list_monitors") {
					return [];
				}
				return undefined;
			},
			{ shouldMockEvents: true },
		);
		const { unmount } = renderPanel();

		// Let display_current resolve, React render the transition state, and any
		// erroneously requested rAF-throttled preview flush.
		await act(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				}),
		);

		expect(commands).toContain("display_current");
		expect(commands).not.toContain("display_preview");
		unmount();
	});

	test("mid-ramp the sliders target the endpoint that dominates the screen", async () => {
		// Regression: `transition` used to be read as "day" whatever the ramp was
		// doing. Late in the evening ramp that pointed every slider, and the tray
		// flyout, at the endpoint with almost no weight — a brightness control
		// that moved while the screen did not, until the ramp ended and it
		// "started working again" on its own.
		const { unmount } = await renderDuringTransition(0.2);

		const night = screen.getByRole("button", {
			name: "Night",
		}) as HTMLButtonElement;
		const day = screen.getByRole("button", {
			name: "Day",
		}) as HTMLButtonElement;
		expect(night.getAttribute("aria-pressed")).toBe("true");
		expect(day.getAttribute("aria-pressed")).toBe("false");
		// Neither endpoint is "current" mid-ramp, so the choice is the user's.
		expect(night.disabled).toBe(false);
		expect(day.disabled).toBe(false);
		expect(screen.getByText(/Fading between day and night/)).toBeDefined();
		unmount();
	});

	test("mid-ramp near the day end it targets the day endpoint", async () => {
		const { unmount } = await renderDuringTransition(0.8);
		expect(
			screen.getByRole("button", { name: "Day" }).getAttribute("aria-pressed"),
		).toBe("true");
		unmount();
	});
});
