import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModeSwitch, ModeSwitchPill } from "./ModeSwitch";
import type { ModeSwitchMode } from "./mode-switch-option";

type Demo = "focus" | "casual" | "away";

const modes: ModeSwitchMode<Demo>[] = [
	{ value: "focus", label: "Focus" },
	{ value: "casual", label: "Casual" },
	{ value: "away", label: "Away" },
];

// The segmented variant renders each label twice (visible + aria-hidden width
// ghost); resolve the underlying toggle button instead of matching text once.
function segmentFor(label: string): HTMLButtonElement | null {
	return screen.getAllByText(label)[0]?.closest("button") ?? null;
}

describe("ModeSwitch (segmented)", () => {
	test("renders one segment per mode and marks the selected one", () => {
		render(
			<ModeSwitch modes={modes} onChange={() => undefined} value="casual" />,
		);
		expect(segmentFor("Focus")).not.toBeNull();
		expect(segmentFor("Away")).not.toBeNull();
		expect(segmentFor("Casual")?.getAttribute("data-pressed")).not.toBeNull();
	});

	test("clicking a segment reports the new mode", () => {
		const onChange = mock((_next: Demo) => undefined);
		render(<ModeSwitch modes={modes} onChange={onChange} value="focus" />);
		fireEvent.click(segmentFor("Away") as HTMLButtonElement);
		expect(onChange).toHaveBeenCalledWith("away");
	});

	test("uncontrolled: defaultValue seeds the selection and clicks move it", () => {
		render(<ModeSwitch defaultValue="casual" modes={modes} />);
		expect(segmentFor("Casual")?.getAttribute("data-pressed")).not.toBeNull();
		fireEvent.click(segmentFor("Away") as HTMLButtonElement);
		expect(segmentFor("Away")?.getAttribute("data-pressed")).not.toBeNull();
	});
});

describe("ModeSwitchPill", () => {
	test("shows the current mode and cycles forward on click", () => {
		const onChange = mock((_next: Demo) => undefined);
		render(
			<ModeSwitchPill
				defaultValue="focus"
				describeMode={(label) => `Mode: ${label}`}
				modes={modes}
				onChange={onChange}
			/>,
		);
		const pill = screen.getByRole("button", { name: "Mode: Focus" });
		fireEvent.click(pill);
		expect(onChange).toHaveBeenCalledWith("casual");
		expect(screen.getByRole("button", { name: "Mode: Casual" })).toBeTruthy();
	});

	test("wraps from the last mode back to the first", () => {
		render(
			<ModeSwitchPill
				defaultValue="away"
				describeMode={(label) => label}
				modes={modes}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Away" }));
		expect(screen.getByRole("button", { name: "Focus" })).toBeTruthy();
	});

	test("arrow keys cycle in both directions", () => {
		render(
			<ModeSwitchPill
				defaultValue="casual"
				describeMode={(label) => label}
				modes={modes}
			/>,
		);
		const pill = screen.getByRole("button", { name: "Casual" });
		fireEvent.keyDown(pill, { key: "ArrowRight" });
		expect(screen.getByRole("button", { name: "Away" })).toBeTruthy();
		fireEvent.keyDown(screen.getByRole("button", { name: "Away" }), {
			key: "ArrowLeft",
		});
		expect(screen.getByRole("button", { name: "Casual" })).toBeTruthy();
	});

	test("controlled: the value prop wins over internal cycling", () => {
		const onChange = mock((_next: Demo) => undefined);
		render(
			<ModeSwitchPill
				describeMode={(label) => label}
				modes={modes}
				onChange={onChange}
				value="focus"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Focus" }));
		expect(onChange).toHaveBeenCalledWith("casual");
		// Still Focus — the owner did not commit the change.
		expect(screen.getByRole("button", { name: "Focus" })).toBeTruthy();
	});
});
