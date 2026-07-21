/**
 * Pairwise conflict detection between two accelerator strings (e.g.
 * `"Ctrl+Shift+V"`). Ported from WinSTT's hotkey-conflict module, trimmed to
 * the pairwise classifier (the starter has no multi-binding resolver).
 *
 * Two bindings collide whenever one's key set is equal to, a subset of, or a
 * superset of the other's — pressing the larger combo satisfies both, so the
 * smaller one fires "by accident". They are DISJOINT (safe) only when each
 * has at least one token the other lacks.
 *
 * Order- and case-insensitive: tokens are normalized via trim+lowercase, and
 * whitespace-only tokens are dropped, so hand-edited settings that drift on
 * casing or spacing still compare correctly.
 */

export type HotkeyRelation = "disjoint" | "equal" | "subset" | "superset";

function toTokenSet(combo: string): Set<string> {
	const out = new Set<string>();
	for (const part of combo.split("+")) {
		const token = part.trim().toLowerCase();
		if (token !== "") {
			out.add(token);
		}
	}
	return out;
}

function allIn(needle: Set<string>, haystack: Set<string>): boolean {
	for (const t of needle) {
		if (!haystack.has(t)) {
			return false;
		}
	}
	return true;
}

/**
 * Classify the relationship from `a`'s perspective. Empty inputs always
 * resolve to `"disjoint"` — an empty combo registers no listener, so it
 * cannot collide.
 */
export function compareHotkeys(a: string, b: string): HotkeyRelation {
	const sa = toTokenSet(a);
	const sb = toTokenSet(b);
	if (sa.size === 0 || sb.size === 0) {
		return "disjoint";
	}
	if (sa.size === sb.size) {
		return allIn(sa, sb) ? "equal" : "disjoint";
	}
	if (sa.size < sb.size) {
		return allIn(sa, sb) ? "subset" : "disjoint";
	}
	return allIn(sb, sa) ? "superset" : "disjoint";
}

/** True when the relation is anything other than "disjoint". */
export function isHotkeyConflict(rel: HotkeyRelation): boolean {
	return rel !== "disjoint";
}
