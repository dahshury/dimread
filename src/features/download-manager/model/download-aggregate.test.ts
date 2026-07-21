import { describe, expect, test } from "bun:test";
import type { DownloadPhase } from "@/bindings";
import {
	aggregateDownloadEntries,
	collectDownloadEntries,
} from "./download-aggregate";
import type { DownloadState } from "./download-store";

function entry(
	id: string,
	phase: DownloadPhase,
	progress: number | null,
	totalBytes = 1000,
): DownloadState {
	return {
		id,
		url: `https://example.invalid/${id}`,
		fileName: `${id}.bin`,
		phase,
		progress,
		downloadedBytes:
			progress === null ? 0 : Math.round((progress / 100) * totalBytes),
		totalBytes,
		speedBps: null,
		etaSeconds: null,
		error: null,
	};
}

describe("collectDownloadEntries", () => {
	test("skips paused and terminal downloads", () => {
		const entries = collectDownloadEntries({
			a: entry("a", "downloading", 50),
			b: entry("b", "paused", 40),
			c: entry("c", "completed", 100),
			d: entry("d", "failed", 20),
			e: entry("e", "queued", 0),
		});
		expect(entries.map((e) => e.id).toSorted()).toEqual(["a", "e"]);
	});

	test("passes the store's 0–100 percent through (null = indeterminate)", () => {
		const entries = collectDownloadEntries({
			a: entry("a", "downloading", 44),
			b: entry("b", "downloading", null),
		});
		expect(entries.find((e) => e.id === "a")?.percent).toBe(44);
		expect(entries.find((e) => e.id === "b")?.percent).toBeNull();
	});
});

describe("aggregateDownloadEntries", () => {
	test("returns null when nothing is in flight", () => {
		expect(aggregateDownloadEntries([])).toBeNull();
	});

	test("averages known percents and picks the furthest as primary", () => {
		const aggregate = aggregateDownloadEntries([
			{ id: "a", percent: 20 },
			{ id: "b", percent: 80 },
			{ id: "c", percent: null },
		]);
		expect(aggregate).not.toBeNull();
		expect(aggregate?.count).toBe(3);
		expect(aggregate?.averagePercent).toBe(50);
		expect(aggregate?.primary.id).toBe("b");
	});
});
