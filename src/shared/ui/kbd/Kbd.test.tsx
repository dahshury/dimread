import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Kbd, KbdCombo } from "./Kbd";

describe("Kbd", () => {
	test("renders a semantic <kbd> element", () => {
		render(<Kbd>{"Esc"}</Kbd>);
		const cap = screen.getByText("Esc");
		expect(cap.tagName).toBe("KBD");
	});

	test("emphasized cap lifts to a stronger ring", () => {
		render(<Kbd emphasized>{"F5"}</Kbd>);
		expect(screen.getByText("F5").className).toContain("ring-divider-strong");
	});
});

describe("KbdCombo", () => {
	test("renders one cap per key with separators between", () => {
		const { container } = render(<KbdCombo keys={["Ctrl", "Shift", "K"]} />);
		expect(container.querySelectorAll("kbd").length).toBe(3);
		// Two joiners for three keys.
		expect(container.querySelectorAll("[aria-hidden]").length).toBe(2);
	});

	test("emphasizedIndex lifts exactly that cap", () => {
		render(<KbdCombo emphasizedIndex={0} keys={["Ctrl", "K"]} />);
		expect(screen.getByText("Ctrl").className).toContain("ring-divider-strong");
		expect(screen.getByText("K").className).not.toContain(
			"ring-divider-strong",
		);
	});
});
