import { describe, expect, it } from "bun:test";
import type { OpenWindow, Rule } from "@/bindings";
import {
	addRule,
	DEFAULT_DRAFT,
	draftToRule,
	isDraftValid,
	isMatchKind,
	normalizeDraft,
	patternForWindow,
	removeRule,
	type RuleDraft,
	ruleToDraft,
	toMatchKind,
	updateRule,
} from "./rule-model";

function rule(partial: Partial<Rule> & { id: string }): Rule {
	return {
		matchKind: "process",
		pattern: "photoshop.exe",
		mode: "pause",
		...partial,
	};
}

const win: OpenWindow = {
	id: "12345",
	process: "photoshop.exe",
	title: "Untitled-1 @ 100% (RGB/8)",
	className: "Photoshop",
};

describe("match-kind guards", () => {
	it("recognises the three known kinds and rejects others", () => {
		expect(isMatchKind("process")).toBe(true);
		expect(isMatchKind("class")).toBe(true);
		expect(isMatchKind("title")).toBe(true);
		expect(isMatchKind("bogus")).toBe(false);
	});

	it("coerces unknown persisted kinds to process", () => {
		expect(toMatchKind("title")).toBe("title");
		expect(toMatchKind("legacy")).toBe("process");
	});
});

describe("draft validity + normalization", () => {
	it("requires a non-blank pattern", () => {
		expect(isDraftValid(DEFAULT_DRAFT)).toBe(false);
		expect(isDraftValid({ ...DEFAULT_DRAFT, pattern: "  " })).toBe(false);
		expect(isDraftValid({ ...DEFAULT_DRAFT, pattern: "code.exe" })).toBe(true);
	});

	it("trims the pattern when normalizing/materializing", () => {
		const draft: RuleDraft = {
			matchKind: "title",
			pattern: "  Visual Studio  ",
			mode: "office",
		};
		expect(normalizeDraft(draft).pattern).toBe("Visual Studio");
		expect(draftToRule(draft, "id-1")).toEqual({
			id: "id-1",
			matchKind: "title",
			pattern: "Visual Studio",
			mode: "office",
		});
	});

	it("round-trips a rule through a draft", () => {
		const seeded = ruleToDraft(
			rule({ id: "r", matchKind: "legacy", pattern: "x", mode: "game" }),
		);
		expect(seeded).toEqual({
			matchKind: "process",
			pattern: "x",
			mode: "game",
		});
	});
});

describe("list transforms", () => {
	it("adds a rule with the supplied id", () => {
		const next = addRule([], { ...DEFAULT_DRAFT, pattern: "code.exe" }, "id-1");
		expect(next).toEqual([
			{ id: "id-1", matchKind: "process", pattern: "code.exe", mode: "pause" },
		]);
	});

	it("updates only the targeted rule's supplied fields", () => {
		const items = [
			rule({ id: "a", mode: "pause" }),
			rule({ id: "b", mode: "pause" }),
		];
		const next = updateRule(items, "b", { mode: "editing" });
		expect(next[0]?.mode).toBe("pause");
		expect(next[1]?.mode).toBe("editing");
		expect(next[1]?.pattern).toBe("photoshop.exe");
	});

	it("trims an updated pattern and coerces an unknown existing kind", () => {
		const items = [rule({ id: "a", matchKind: "legacy" })];
		const next = updateRule(items, "a", { pattern: "  chrome.exe " });
		expect(next[0]).toEqual({
			id: "a",
			matchKind: "process",
			pattern: "chrome.exe",
			mode: "pause",
		});
	});

	it("removes the targeted rule", () => {
		const items = [rule({ id: "a" }), rule({ id: "b" })];
		expect(removeRule(items, "a")).toEqual([rule({ id: "b" })]);
	});

	it("does not mutate the input array", () => {
		const items = [rule({ id: "a" })];
		addRule(items, DEFAULT_DRAFT, "z");
		updateRule(items, "a", { mode: "game" });
		removeRule(items, "a");
		expect(items).toEqual([rule({ id: "a" })]);
	});
});

describe("patternForWindow", () => {
	it("maps each match kind to the window field it captures", () => {
		expect(patternForWindow(win, "process")).toBe("photoshop.exe");
		expect(patternForWindow(win, "class")).toBe("Photoshop");
		expect(patternForWindow(win, "title")).toBe("Untitled-1 @ 100% (RGB/8)");
	});
});
