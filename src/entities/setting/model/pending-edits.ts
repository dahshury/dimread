import type { AppSettingsOutput } from "@/shared/config/settings-schema";

/**
 * Per-field optimistic-edit ledger.
 *
 * The backend accepts whole sections, but renderers edit individual fields. A
 * conflict retry therefore has to adopt the other renderer's section first and
 * replay only this renderer's still-pending fields over it. Protecting the
 * whole section would preserve the local field while silently reverting every
 * disjoint field the other renderer changed.
 *
 * Object changes are tracked down to their changed leaves. Arrays are atomic:
 * without a stable item-level operation, merging two independently edited
 * arrays would invent an ordering neither writer requested.
 */

export type SettingsSectionKey = keyof AppSettingsOutput;

type Path = readonly string[];

interface PendingPath {
	path: Path;
	sequence: number;
}

let editSeq = 0;
const pending = new Map<SettingsSectionKey, Map<string, PendingPath>>();
const preciselyRecorded = new Set<SettingsSectionKey>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owns(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

function collectChangedPaths(
	before: unknown,
	after: unknown,
	path: readonly string[],
	result: string[][],
): void {
	if (Object.is(before, after)) {
		return;
	}
	if (isRecord(before) && isRecord(after)) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		for (const key of keys) {
			const nextPath = [...path, key];
			if (!(owns(before, key) && owns(after, key))) {
				// A newly-added/deleted subtree is one exact operation. Recording
				// its leaves would lose deletion semantics or create partial objects.
				result.push(nextPath);
				continue;
			}
			collectChangedPaths(before[key], after[key], nextPath, result);
		}
		return;
	}
	result.push([...path]);
}

function pathKey(path: Path): string {
	return JSON.stringify(path);
}

function isPrefix(prefix: Path, path: Path): boolean {
	return (
		prefix.length <= path.length &&
		prefix.every((segment, index) => segment === path[index])
	);
}

function recordPath(
	entries: Map<string, PendingPath>,
	path: Path,
	sequence: number,
): void {
	for (const [key, entry] of entries) {
		if (isPrefix(entry.path, path)) {
			entries.set(key, { ...entry, sequence });
			return;
		}
		if (isPrefix(path, entry.path)) {
			entries.delete(key);
		}
	}
	entries.set(pathKey(path), { path, sequence });
}

/** Record the exact fields changed by one store update. */
export function markSectionChanges<K extends SettingsSectionKey>(
	section: K,
	before: AppSettingsOutput[K],
	after: AppSettingsOutput[K],
): number {
	// Existing feature writers call `markSectionsEdited(section)` immediately
	// after the store updater. Remember that this updater already handled the
	// edit, including the important no-op case where there is nothing to mark.
	preciselyRecorded.add(section);
	const paths: string[][] = [];
	collectChangedPaths(before, after, [], paths);
	if (paths.length === 0) {
		return editSeq;
	}
	editSeq += 1;
	const entries = pending.get(section) ?? new Map<string, PendingPath>();
	for (const path of paths) {
		recordPath(entries, path, editSeq);
	}
	pending.set(section, entries);
	return editSeq;
}

/**
 * Compatibility marker for writers that already call this after a store
 * updater. Store updaters record precise paths themselves; if a caller changed
 * state through another route, an empty path safely falls back to protecting
 * the whole section.
 */
export function markSectionsEdited(
	...sections: readonly SettingsSectionKey[]
): number {
	const untracked = sections.filter((section) => {
		if (preciselyRecorded.delete(section)) {
			return false;
		}
		return !pending.get(section)?.size;
	});
	if (untracked.length === 0) {
		return editSeq;
	}
	editSeq += 1;
	for (const section of untracked) {
		const entries = new Map<string, PendingPath>();
		entries.set(pathKey([]), { path: [], sequence: editSeq });
		pending.set(section, entries);
	}
	return editSeq;
}

/** The sequence stamp of the newest edit (0 = none yet). */
export function currentEditSeq(): number {
	return editSeq;
}

/** Sections with optimistic edits not yet confirmed durably saved. */
export function pendingSectionKeys(): SettingsSectionKey[] {
	return Array.from(pending.keys());
}

/**
 * Overlay only locally changed paths onto an authoritative snapshot. This is
 * the rebase step that preserves both sides of disjoint same-section edits.
 */
export function overlayPendingEdits(
	target: AppSettingsOutput,
	source: AppSettingsOutput,
): void {
	const targetRoot = target as unknown as Record<string, unknown>;
	const sourceRoot = source as unknown as Record<string, unknown>;
	for (const [section, entries] of pending) {
		for (const { path } of entries.values()) {
			if (path.length === 0) {
				targetRoot[section] = sourceRoot[section];
				continue;
			}
			overlayPath(targetRoot[section], sourceRoot[section], path);
		}
	}
}

function overlayPath(target: unknown, source: unknown, path: Path): void {
	if (!(isRecord(target) && isRecord(source))) {
		return;
	}
	let targetParent = target;
	let sourceParent = source;
	for (const segment of path.slice(0, -1)) {
		const sourceChild = sourceParent[segment];
		if (!isRecord(sourceChild)) {
			return;
		}
		if (!isRecord(targetParent[segment])) {
			targetParent[segment] = {};
		}
		targetParent = targetParent[segment] as Record<string, unknown>;
		sourceParent = sourceChild;
	}
	const leaf = path.at(-1);
	if (leaf === undefined) {
		return;
	}
	if (owns(sourceParent, leaf)) {
		targetParent[leaf] = sourceParent[leaf];
	} else {
		delete targetParent[leaf];
	}
}

/** Settle paths covered by a completed save, retaining edits made later. */
export function settleSections(
	sections: readonly SettingsSectionKey[],
	upToSeq: number,
): void {
	for (const section of sections) {
		const entries = pending.get(section);
		if (!entries) {
			continue;
		}
		for (const [key, entry] of entries) {
			if (entry.sequence <= upToSeq) {
				entries.delete(key);
			}
		}
		if (entries.size === 0) {
			pending.delete(section);
		}
	}
}

/** Discard the local optimistic-edit ledger. */
export function clearPendingEdits(): void {
	pending.clear();
	preciselyRecorded.clear();
	editSeq = 0;
}
