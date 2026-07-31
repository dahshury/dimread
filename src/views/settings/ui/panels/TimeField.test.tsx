import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { TimeField } from "./TimeField";

describe("TimeField", () => {
	test("renders an hour and a minute stepper", () => {
		const { container } = render(
			<TimeField
				ariaHourLabel="Sunrise hours"
				ariaMinuteLabel="Sunrise minutes"
				onChange={() => undefined}
				value="07:30"
			/>,
		);
		const inputs = container.querySelectorAll('input[inputmode="numeric"]');
		expect(inputs.length).toBe(2);
	});

	test("exposes distinctly labelled hour/minute control groups", () => {
		const { getByRole } = render(
			<TimeField
				ariaHourLabel="Sunrise hours"
				ariaMinuteLabel="Sunrise minutes"
				onChange={() => undefined}
				value="07:30"
			/>,
		);
		expect(getByRole("group", { name: "Sunrise hours" })).toBeDefined();
		expect(getByRole("group", { name: "Sunrise minutes" })).toBeDefined();
	});
});
