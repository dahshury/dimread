import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MonitorInfo } from "@/bindings";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { ALL_MONITORS } from "@/features/display";
import { MonitorStrip } from "./MonitorStrip";

const MONITORS: MonitorInfo[] = [
	{ id: "\\\\.\\DISPLAY1", index: 0, friendlyName: "Primary", isPrimary: true },
	{ id: "\\\\.\\DISPLAY2", index: 1, friendlyName: "Second", isPrimary: false },
];

function renderStrip(
	selection = ALL_MONITORS,
	onSelect = (_next: string) => undefined,
) {
	return render(
		<IntlProvider>
			<MonitorStrip
				monitors={MONITORS}
				onSelect={onSelect}
				selection={selection}
			/>
		</IntlProvider>,
	);
}

describe("MonitorStrip", () => {
	test("renders an All chip and one chip per monitor", () => {
		renderStrip();
		expect(screen.getByRole("button", { name: "All monitors" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Monitor 1" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Monitor 2" })).toBeDefined();
	});

	test("selecting a monitor chip reports its id", () => {
		const onSelect = mock((_next: string) => undefined);
		renderStrip(ALL_MONITORS, onSelect);
		fireEvent.click(screen.getByRole("button", { name: "Monitor 2" }));
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(
			(onSelect as unknown as { mock: { calls: unknown[][] } }).mock
				.calls[0]?.[0],
		).toBe("\\\\.\\DISPLAY2");
	});
});
