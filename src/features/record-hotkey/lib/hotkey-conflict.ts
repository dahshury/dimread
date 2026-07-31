/**
 * Pairwise conflict detection between two accelerator strings (e.g.
 * `"Ctrl+Shift+V"`). Ported from WinSTT's hotkey-conflict module, trimmed to
 * the pairwise classifier (the starter has no multi-binding resolver).
 *
 * The classifier retains subset/superset information for diagnostics, but the
 * native global-shortcut backend matches complete accelerators. Only equal
 * normalized chords conflict; `Ctrl+V` and `Ctrl+Shift+V` are distinct live
 * registrations and must both remain configurable.
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

/** True only when both normalized accelerators are the same chord. */
export function isHotkeyConflict(rel: HotkeyRelation): boolean {
	return rel === "equal";
}
