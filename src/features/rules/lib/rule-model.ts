import type { OpenWindow, Rule } from "@/bindings";

/**
 * Pure rule-model logic for the custom-rules feature (FEATURE-PARITY F4): the
 * match kinds, an in-progress "draft" shape for the add/edit dialog, and the
 * immutable list transforms the UI persists. No React, no IPC — unit-tested in
 * isolation and mirrored by the Rust matcher in `src-tauri/src/rules/mod.rs`.
 */

/** How a rule is matched against the foreground window. */
export const MATCH_KINDS = ["process", "class", "title"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/** Narrow an arbitrary persisted string to a known {@link MatchKind}. */
export function isMatchKind(value: string): value is MatchKind {
	return (MATCH_KINDS as readonly string[]).includes(value);
}

/** Coerce a possibly-unknown persisted match kind to a safe default. */
export function toMatchKind(value: string): MatchKind {
	return isMatchKind(value) ? value : "process";
}

/** An in-progress rule as edited in the add/edit dialog (no id yet). */
export interface RuleDraft {
	matchKind: MatchKind;
	pattern: string;
	mode: string;
}

/** A fresh draft: match a process, no pattern yet, "pause" (disable filtering
 *  for this app — the canonical CareUEyes rule, e.g. a colour-critical editor). */
export const DEFAULT_DRAFT: RuleDraft = {
	matchKind: "process",
	pattern: "",
	mode: "pause",
};

/** A stable id for a new rule (UUID where available, else a time+random fallback). */
function createRuleId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Trim the pattern; leave kind/mode as-is. */
export function normalizeDraft(draft: RuleDraft): RuleDraft {
	return {
		matchKind: draft.matchKind,
		pattern: draft.pattern.trim(),
		mode: draft.mode,
	};
}

/** A draft is submittable once it has a known kind and a non-blank pattern. */
export function isDraftValid(draft: RuleDraft): boolean {
	return isMatchKind(draft.matchKind) && draft.pattern.trim().length > 0;
}

/** Materialize a persisted {@link Rule} from a draft + id. */
export function draftToRule(draft: RuleDraft, id: string): Rule {
	const normalized = normalizeDraft(draft);
	return {
		id,
		matchKind: normalized.matchKind,
		pattern: normalized.pattern,
		mode: normalized.mode,
	};
}

/** Seed a dialog draft from an existing rule (for the edit flow). */
export function ruleToDraft(rule: Rule): RuleDraft {
	return {
		matchKind: toMatchKind(rule.matchKind),
		pattern: rule.pattern,
		mode: rule.mode,
	};
}

/** Append a new rule built from `draft`. */
export function addRule(
	items: readonly Rule[],
	draft: RuleDraft,
	id: string = createRuleId(),
): Rule[] {
	return [...items, draftToRule(draft, id)];
}

/** Replace the fields present in `patch` on the rule with `id` (immutably). */
export function updateRule(
	items: readonly Rule[],
	id: string,
	patch: Partial<RuleDraft>,
): Rule[] {
	return items.map((rule) => {
		if (rule.id !== id) {
			return rule;
		}
		return {
			id: rule.id,
			matchKind: patch.matchKind ?? toMatchKind(rule.matchKind),
			pattern:
				patch.pattern === undefined ? rule.pattern : patch.pattern.trim(),
			mode: patch.mode ?? rule.mode,
		};
	});
}

/** Drop the rule with `id`. */
export function removeRule(items: readonly Rule[], id: string): Rule[] {
	return items.filter((rule) => rule.id !== id);
}

/** The pattern a picked window contributes for a given match kind — the
 *  replacement for CareUEyes' drag "Finder Tool" (capture a window's identity). */
export function patternForWindow(win: OpenWindow, kind: MatchKind): string {
	switch (kind) {
		case "process":
			return win.process;
		case "class":
			return win.className;
		case "title":
			return win.title;
	}
}
