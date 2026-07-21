import { describe, expect, test } from "bun:test";
import { findToggledFavorite } from "./favorite-diff";

describe("findToggledFavorite", () => {
	test("detects an added favorite", () => {
		expect(findToggledFavorite(["a"], ["a", "b"])).toBe("b");
	});

	test("detects a removed favorite", () => {
		expect(findToggledFavorite(["a", "b"], ["a"])).toBe("b");
	});

	test("returns undefined when nothing changed", () => {
		expect(findToggledFavorite(["a", "b"], ["b", "a"])).toBeUndefined();
		expect(findToggledFavorite([], [])).toBeUndefined();
	});

	test("prefers the addition when both directions differ", () => {
		// Not a real gesture, but the contract stays deterministic.
		expect(findToggledFavorite(["a"], ["b"])).toBe("b");
	});
});
