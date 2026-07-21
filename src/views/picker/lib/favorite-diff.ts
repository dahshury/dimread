/**
 * The picker-selection store's favorites API is per-id (`toggleFavorite`),
 * while the generic ItemPicker reports whole-array favorites changes. Exactly
 * one id differs per star gesture — recover it by set difference (either
 * direction), so the view can translate array → toggle without new store API.
 */
export function findToggledFavorite(
	previous: readonly string[],
	next: readonly string[],
): string | undefined {
	const previousSet = new Set(previous);
	const nextSet = new Set(next);
	for (const id of nextSet) {
		if (!previousSet.has(id)) {
			return id;
		}
	}
	for (const id of previousSet) {
		if (!nextSet.has(id)) {
			return id;
		}
	}
	return undefined;
}
