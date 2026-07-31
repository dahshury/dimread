import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { SettingSection } from "./SettingSection";

describe("SettingSection", () => {
	test("always groups direct children in the standard divided card", () => {
		render(
			<SettingSection title="Application">
				<div>First setting</div>
				<div>Second setting</div>
			</SettingSection>,
		);

		const first = screen.getByText("First setting");
		const group = first.parentElement;

		expect(group).toBe(screen.getByText("Second setting").parentElement);
		expect(group?.className).toContain("rounded-xl");
		expect(group?.className).toContain("ring-1");
		expect(group?.className).toContain("divide-y");
		expect(
			screen.getByRole("heading", { name: "Application" }).className,
		).toContain("uppercase");
	});
});
