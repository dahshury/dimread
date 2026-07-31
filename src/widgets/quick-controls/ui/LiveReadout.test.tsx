import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { LiveReadout } from "./LiveReadout";

describe("LiveReadout", () => {
	test("formats the engine's Kelvin/brightness output", () => {
		render(
			<IntlProvider>
				<LiveReadout
					state={{
						kelvin: 5500,
						brightness: 85,
						mode: "office",
						phase: "day",
						factor: 1,
						grayscaleApplied: false,
					}}
				/>
			</IntlProvider>,
		);
		expect(screen.getByText("5500K · 85%")).toBeDefined();
	});

	test("renders nothing before the first state arrives", () => {
		const { container } = render(
			<IntlProvider>
				<LiveReadout state={null} />
			</IntlProvider>,
		);
		expect(container.textContent).toBe("");
	});
});
