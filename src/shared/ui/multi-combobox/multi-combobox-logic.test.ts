import { describe, expect, test } from "bun:test";
import {
	COLLAPSED_SELECTION_THRESHOLD,
	mergeSelectAll,
	summarizeSelection,
	toggleSelection,
} from "./multi-combobox-logic";

const countLabel = (count: number) => `${count} selected`;

describe("summarizeSelection", () => {
	test("empty selection shows the placeholder", () => {
		expect(summarizeSelection([], countLabel, "Pick some")).toBe("Pick some");
	});

	test("small selections list the labels", () => {
		expect(summarizeSelection(["A"], countLabel, "Pick some")).toBe("A");
		expect(summarizeSelection(["A", "B"], countLabel, "Pick some")).toBe(
			"A, B",
		);
	});

	test("collapses into a count at the threshold", () => {
		const labels = Array.from(
			{ length: COLLAPSED_SELECTION_THRESHOLD },
			(_, index) => `L${index}`,
		);
		expect(summarizeSelection(labels, countLabel, "Pick some")).toBe(
			`${COLLAPSED_SELECTION_THRESHOLD} selected`,
		);
	});
});

describe("mergeSelectAll", () => {
	test("appends missing visible ids after the existing selection", () => {
		expect(mergeSelectAll(["b"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
	});

	test("keeps ids that the current filter hides", () => {
		expect(mergeSelectAll(["hidden"], ["a"])).toEqual(["hidden", "a"]);
	});

	test("is a no-op when everything visible is already selected", () => {
		expect(mergeSelectAll(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
	});

	test("dedupes repeated visible ids", () => {
		expect(mergeSelectAll([], ["a", "a", "b"])).toEqual(["a", "b"]);
	});
});

describe("toggleSelection", () => {
	test("adds an unselected id at the end", () => {
		expect(toggleSelection(["a"], "b")).toEqual(["a", "b"]);
	});

	test("removes a selected id preserving order", () => {
		expect(toggleSelection(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});
});
