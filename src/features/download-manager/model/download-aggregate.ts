/** Aggregate view over the active downloads — a status-bar chip renders "N
 *  downloads, X%" from this without subscribing to every entry. */

import { isTerminalPhase, type DownloadState } from "./download-store";

export interface DownloadEntry {
	id: string;
	percent: number | null;
}

export interface DownloadAggregate {
	averagePercent: number | null;
	count: number;
	primary: DownloadEntry;
}

/** Collect the non-paused, non-terminal downloads as aggregate entries.
 *  `percent` is the store's integer 0–100 progress (`null` while the first
 *  progress event hasn't landed yet). */
export function collectDownloadEntries(
	downloads: Record<string, DownloadState>,
): DownloadEntry[] {
	const entries: DownloadEntry[] = [];
	for (const key in downloads) {
		if (!Object.hasOwn(downloads, key)) {
			continue;
		}
		const entry = downloads[key];
		if (
			entry === undefined ||
			entry.phase === "paused" ||
			isTerminalPhase(entry.phase)
		) {
			continue;
		}
		entries.push({ id: entry.id, percent: entry.progress });
	}
	return entries;
}

export function aggregateDownloadEntries(
	entries: readonly DownloadEntry[],
): DownloadAggregate | null {
	const primary = pickPrimary(entries);
	if (primary === null) {
		return null;
	}
	return {
		count: entries.length,
		averagePercent: averageKnownPercent(entries),
		primary,
	};
}

function pickPrimary(entries: readonly DownloadEntry[]): DownloadEntry | null {
	let best = entries[0] ?? null;
	for (let i = 1; i < entries.length; i += 1) {
		const candidate = entries[i];
		if (candidate === undefined) {
			continue;
		}
		if ((candidate.percent ?? -1) > (best?.percent ?? -1)) {
			best = candidate;
		}
	}
	return best;
}

function averageKnownPercent(entries: readonly DownloadEntry[]): number | null {
	const numericPercents = entries
		.map((entry) => entry.percent)
		.filter((percent): percent is number => typeof percent === "number");
	if (numericPercents.length === 0) {
		return null;
	}
	return Math.round(
		numericPercents.reduce((a, b) => a + b, 0) / numericPercents.length,
	);
}
