import {
	aggregateDownloadEntries,
	collectDownloadEntries,
	type DownloadAggregate,
} from "./download-aggregate";
import { useDownloadStore } from "./download-store";

/**
 * Aggregate view over the in-flight downloads for at-a-glance chrome (the
 * footer chip): `null` while nothing is streaming, otherwise a count +
 * average-percent summary. Subscribes to the whole download map — cheap, the
 * map only ticks while bytes are actually flowing.
 */
export function useDownloadAggregate(): DownloadAggregate | null {
	const downloads = useDownloadStore((s) => s.downloads);
	return aggregateDownloadEntries(collectDownloadEntries(downloads));
}
