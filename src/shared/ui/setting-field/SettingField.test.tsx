import { describe, expect, mock, test } from "bun:test";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { act, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { SettingField } from "./SettingField";

function renderField(ui: React.ReactElement) {
	return render(
		<TooltipPrimitive.Provider closeDelay={0} delay={0}>
			<IntlProvider>{ui}</IntlProvider>
		</TooltipPrimitive.Provider>,
	);
}

const RESET = "Reset to default";

describe("SettingField", () => {
	test("renders no reset button when onReset is omitted", () => {
		renderField(<SettingField label="Speed" />);
		expect(screen.queryByRole("button", { name: RESET })).toBeNull();
	});

	test("renders a reset button when onReset is provided", () => {
		renderField(<SettingField label="Speed" onReset={() => undefined} />);
		expect(screen.getByRole("button", { name: RESET })).toBeDefined();
	});

	test("reset button is disabled while value equals defaultValue", () => {
		renderField(
			<SettingField
				defaultValue="a"
				label="Speed"
				onReset={() => undefined}
				value="a"
			/>,
		);
		expect(
			screen.getByRole("button", { name: RESET }).hasAttribute("disabled"),
		).toBe(true);
	});

	test("reset button is enabled when value differs from defaultValue", () => {
		renderField(
			<SettingField
				defaultValue="a"
				label="Speed"
				onReset={() => undefined}
				value="b"
			/>,
		);
		expect(
			screen.getByRole("button", { name: RESET }).hasAttribute("disabled"),
		).toBe(false);
	});

	test("explicit isDefault overrides value/defaultValue comparison", () => {
		renderField(
			<SettingField
				defaultValue="a"
				isDefault
				label="Speed"
				onReset={() => undefined}
				value="b"
			/>,
		);
		expect(
			screen.getByRole("button", { name: RESET }).hasAttribute("disabled"),
		).toBe(true);
	});

	test("hideReset suppresses the reset button even with onReset", () => {
		renderField(
			<SettingField hideReset label="Speed" onReset={() => undefined} />,
		);
		expect(screen.queryByRole("button", { name: RESET })).toBeNull();
	});

	test("clicking reset opens the confirm dialog (does not fire onReset directly)", async () => {
		const onReset = mock(() => undefined);
		renderField(
			<SettingField
				defaultValue="a"
				label="Speed"
				onReset={onReset}
				value="b"
			/>,
		);
		await act(async () => {
			screen.getByRole("button", { name: RESET }).click();
		});
		// The reset is gated behind a ConfirmDialog — the click opens it, the
		// actual onReset fires on confirm.
		expect(onReset).toHaveBeenCalledTimes(0);
		expect(screen.getByRole("button", { name: "Reset" })).toBeDefined();
	});

	test("confirming the dialog fires onReset", async () => {
		const onReset = mock(() => undefined);
		renderField(
			<SettingField
				defaultValue="a"
				label="Speed"
				onReset={onReset}
				value="b"
			/>,
		);
		await act(async () => {
			screen.getByRole("button", { name: RESET }).click();
		});
		await act(async () => {
			screen.getByRole("button", { name: "Reset" }).click();
		});
		expect(onReset).toHaveBeenCalledTimes(1);
	});

	test("renders no error message by default", () => {
		renderField(<SettingField label="Speed" />);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("renders the inline error message when error is set", () => {
		renderField(<SettingField error="Bad value" label="Speed" />);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Bad value");
	});

	test("disabled + disabledReason anchor a tooltip wrapper on the control", () => {
		renderField(
			<SettingField
				disabled
				disabledReason="Parent setting"
				label="Child setting"
			>
				<button data-testid="control" type="button">
					{"Control"}
				</button>
			</SettingField>,
		);
		const control = screen.getByTestId("control");
		// The disabled control is fenced behind a pointer-events-none wrapper so
		// the disabled-reason tooltip target can still receive hover.
		expect(control.parentElement?.className).toContain("pointer-events-none");
	});
});
