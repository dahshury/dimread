/**
 * Pure selection/summary helpers behind {@link MultiCombobox}, split out so the
 * chips-summary and select-all semantics are directly testable.
 */

/** At/above this many selections the chips collapse into one count chip. */
export const COLLAPSED_SELECTION_THRESHOLD = 3;

/** The closed trigger's display text: placeholder, short label list, or count. */
export function summarizeSelection(
	labels: readonly string[],
	selectedCountLabel: (count: number) => string,
	placeholder: string,
): string {
	if (labels.length === 0) {
		return placeholder;
	}
	if (labels.length < COLLAPSED_SELECTION_THRESHOLD) {
		return labels.join(", ");
	}
	return selectedCountLabel(labels.length);
}

/**
 * Select-all over the currently VISIBLE (filtered) options: appends the
 * visible ids missing from the selection while preserving the existing
 * selection order (ids filtered away stay selected — select-all is additive).
 */
export function mergeSelectAll<T extends string>(
	value: readonly T[],
	visibleIds: readonly T[],
): T[] {
	const selected = new Set(value);
	const merged = [...value];
	for (const id of visibleIds) {
		if (!selected.has(id)) {
			merged.push(id);
			selected.add(id);
		}
	}
	return merged;
}

/** Toggle one id in/out of the selection, preserving selection order. */
export function toggleSelection<T extends string>(
	value: readonly T[],
	id: T,
): T[] {
	return value.includes(id)
		? value.filter((candidate) => candidate !== id)
		: [...value, id];
}
