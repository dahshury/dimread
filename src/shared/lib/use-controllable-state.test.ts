import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useControllableState } from "./use-controllable-state";

describe("useControllableState", () => {
	test("uncontrolled: owns state seeded from defaultValue and reports changes", () => {
		const onChange = mock((_next: string) => undefined);
		const { result } = renderHook(() =>
			useControllableState<string>(undefined, "a", onChange),
		);
		expect(result.current[0]).toBe("a");
		act(() => result.current[1]("b"));
		expect(result.current[0]).toBe("b");
		expect(onChange).toHaveBeenCalledWith("b");
	});

	test("controlled: renders the prop value and never mutates it locally", () => {
		const onChange = mock((_next: string) => undefined);
		const { result, rerender } = renderHook(
			({ value }: { value: string }) =>
				useControllableState<string>(value, "seed", onChange),
			{ initialProps: { value: "x" } },
		);
		expect(result.current[0]).toBe("x");
		act(() => result.current[1]("y"));
		// Still "x" — the owner did not accept the change yet.
		expect(result.current[0]).toBe("x");
		expect(onChange).toHaveBeenCalledWith("y");
		rerender({ value: "y" });
		expect(result.current[0]).toBe("y");
	});

	test("works without an onChange listener", () => {
		const { result } = renderHook(() =>
			useControllableState<number>(undefined, 1),
		);
		act(() => result.current[1](2));
		expect(result.current[0]).toBe(2);
	});
});
