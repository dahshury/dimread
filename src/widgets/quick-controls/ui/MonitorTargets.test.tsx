import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { MonitorInfo } from "@/bindings";
import { ALL_MONITORS } from "@/features/display";
import { MonitorTargets } from "./MonitorTargets";

const PRIMARY = "\\\\.\\DISPLAY1";
const SECOND = "\\\\.\\DISPLAY2";

const MONITORS: MonitorInfo[] = [
	{ id: PRIMARY, index: 0, friendlyName: "Dell U2720Q", isPrimary: true },
	{
		id: SECOND,
		index: 1,
		friendlyName: "Generic PnP Monitor",
		isPrimary: false,
	},
];

function renderTargets(
	props: Partial<Parameters<typeof MonitorTargets>[0]> = {},
) {
	return render(
		<IntlProvider>
			<MonitorTargets
				excluded={[]}
				monitors={MONITORS}
				onSelect={() => undefined}
				onSetEnabled={() => undefined}
				onUseModeValues={() => undefined}
				overridden={[]}
				selection={ALL_MONITORS}
				{...props}
			/>
		</IntlProvider>,
	);
}

describe("MonitorTargets", () => {
	test("lists an All option plus one radio per monitor, named by hardware", () => {
		renderTargets();
		expect(screen.getByRole("radio", { name: /All monitors/ })).toBeDefined();
		expect(screen.getByRole("radio", { name: /Dell U2720Q/ })).toBeDefined();
		expect(
			screen.getByRole("radio", { name: /Generic PnP Monitor/ }),
		).toBeDefined();
	});

	test("marks the primary display and shows each device id", () => {
		renderTargets();
		expect(screen.getByText("Primary")).toBeDefined();
		expect(screen.getByText(PRIMARY)).toBeDefined();
		expect(screen.getByText(SECOND)).toBeDefined();
	});

	test("selecting a monitor reports its id", () => {
		const onSelect = mock((_next: string) => undefined);
		renderTargets({ onSelect });
		fireEvent.click(screen.getByRole("radio", { name: /Generic PnP Monitor/ }));
		expect(onSelect).toHaveBeenCalledWith(SECOND);
	});

	test("the targeted monitor is the checked radio", () => {
		renderTargets({ selection: SECOND });
		expect(
			screen
				.getByRole("radio", { name: /Generic PnP Monitor/ })
				.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			screen
				.getByRole("radio", { name: /All monitors/ })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	test("switching a monitor off reports the opt-out", () => {
		const onSetEnabled = mock((_id: string, _enabled: boolean) => undefined);
		renderTargets({ onSetEnabled });
		fireEvent.click(
			screen.getByRole("switch", { name: /Generic PnP Monitor/ }),
		);
		expect(onSetEnabled).toHaveBeenCalledWith(SECOND, false);
	});

	test("an opted-out monitor cannot be targeted", () => {
		renderTargets({ excluded: [SECOND] });
		const radio = screen.getByRole("radio", { name: /Generic PnP Monitor/ });
		expect((radio as HTMLButtonElement).disabled).toBe(true);
	});

	test("the last participating monitor may not be switched off", () => {
		// DISPLAY2 is already out, so DISPLAY1 is the only one left filtering —
		// turning it off too would be `pause` wearing a roster's clothes. Assert
		// the behaviour, not an attribute: Base UI's Switch.Root is a <span>, which
		// carries `data-disabled` rather than the native `disabled` property.
		const onSetEnabled = mock((_id: string, _enabled: boolean) => undefined);
		renderTargets({ excluded: [SECOND], onSetEnabled });
		fireEvent.click(screen.getByRole("switch", { name: /Dell U2720Q/ }));
		expect(onSetEnabled).not.toHaveBeenCalled();
	});

	test("a single enabled display cannot be opted out", () => {
		const onSetEnabled = mock((_id: string, _enabled: boolean) => undefined);
		renderTargets({
			monitors: [MONITORS[0] as MonitorInfo],
			onSetEnabled,
		});
		expect(screen.queryByRole("radio")).toBeNull();
		fireEvent.click(screen.getByRole("switch", { name: /Dell U2720Q/ }));
		expect(onSetEnabled).not.toHaveBeenCalled();
		// Still answers "which display does DimRead see, and under what id".
		expect(screen.getByText("Dell U2720Q")).toBeDefined();
		expect(screen.getByText(PRIMARY)).toBeDefined();
	});

	test("a sole excluded display remains re-enableable", () => {
		const onSetEnabled = mock((_id: string, _enabled: boolean) => undefined);
		renderTargets({
			excluded: [PRIMARY],
			monitors: [MONITORS[0] as MonitorInfo],
			onSetEnabled,
		});

		fireEvent.click(screen.getByRole("switch", { name: /Dell U2720Q/ }));

		expect(onSetEnabled).toHaveBeenCalledWith(PRIMARY, true);
	});

	test("an overridden monitor can be returned to the active mode", () => {
		const onUseModeValues = mock((_id: string) => undefined);
		renderTargets({ overridden: [SECOND], onUseModeValues });

		fireEvent.click(
			screen.getByRole("button", {
				name: /Use mode values for Generic PnP Monitor/,
			}),
		);

		expect(onUseModeValues).toHaveBeenCalledWith(SECOND);
	});

	test("reports an empty roster instead of rendering an empty group", () => {
		renderTargets({ monitors: [] });
		expect(screen.getByText("No monitors detected.")).toBeDefined();
		expect(screen.queryByRole("radiogroup")).toBeNull();
	});
});
