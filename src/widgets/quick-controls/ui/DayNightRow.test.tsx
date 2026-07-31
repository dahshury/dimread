import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DayNightRow } from "./DayNightRow";

function renderRow(overrides: Partial<Parameters<typeof DayNightRow>[0]> = {}) {
	const props = {
		canChoosePhase: false,
		enabled: true,
		onPhaseChange: () => undefined,
		onToggleEnabled: () => undefined,
		phase: "day" as const,
		ramping: false,
		...overrides,
	};
	return render(
		<IntlProvider>
			<DayNightRow {...props} />
		</IntlProvider>,
	);
}

describe("DayNightRow", () => {
	test("renders the auto day/night switch and disables manual phase selection while enabled", () => {
		renderRow();
		expect(screen.getByText("Auto day/night")).toBeDefined();
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

	test("no longer offers the schedule gear — that moved to settings", () => {
		renderRow();
		expect(
			screen.queryByRole("button", { name: "Day & night settings" }),
		).toBeNull();
	});

	test("choosing a phase reports it upward", () => {
		const onPhaseChange = mock((_phase: string) => undefined);
		renderRow({ canChoosePhase: true, enabled: false, onPhaseChange });
		fireEvent.click(screen.getByRole("button", { name: "Night" }));
		expect(onPhaseChange).toHaveBeenCalledTimes(1);
		expect(
			(onPhaseChange as unknown as { mock: { calls: unknown[][] } }).mock
				.calls[0]?.[0],
		).toBe("night");
	});

	test("mid-ramp the endpoint choice comes back, with an explanation", () => {
		// Regression: with auto on, a ramp used to present a locked "Day" while
		// the sliders edited an endpoint that barely reached the screen — read as
		// a brightness slider with a floor it does not have.
		const onPhaseChange = mock((_phase: string) => undefined);
		renderRow({ canChoosePhase: true, onPhaseChange, ramping: true });
		expect(
			(screen.getByRole("button", { name: "Night" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		expect(screen.getByText(/Fading between day and night/)).toBeDefined();
	});

	test("a settled auto phase stays the clock's to choose", () => {
		renderRow({ ramping: false });
		expect(screen.queryByText(/Fading between day and night/)).toBeNull();
	});

	test("toggling the switch reports the inverted enabled state", () => {
		const onToggleEnabled = mock((_enabled: boolean) => undefined);
		renderRow({ onToggleEnabled });
		fireEvent.click(screen.getByRole("switch", { name: "Auto day/night" }));
		expect(onToggleEnabled).toHaveBeenCalledTimes(1);
		expect(
			(onToggleEnabled as unknown as { mock: { calls: unknown[][] } }).mock
				.calls[0]?.[0],
		).toBe(false);
	});
});
