import { useEffect } from "react";
import { commands, events } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";
import { useDownloadStore } from "../model/download-store";

/**
 * Projects backend-owned download snapshots into renderer state.
 *
 * Per-download state has exactly one authority: the `download:update` event.
 * The subscription is installed before hydration; the store's monotonic merge
 * makes a late `download_list` response unable to roll an entry's bar
 * backwards past a newer live event.
 */
export function useDownloadListener(): void {
	const applySnapshot = useDownloadStore((state) => state.applySnapshot);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		const unsubscribe = subscribeNativeEvent(events.downloadUpdate, (event) => {
			applySnapshot(event.payload);
		});
		void commands
			.downloadList()
			.then((snapshots) => {
				if (!disposed && Array.isArray(snapshots)) {
					for (const snapshot of snapshots) {
						applySnapshot(snapshot);
					}
				}
			})
			.catch((error) => {
				console.error("download list hydration failed", error);
			});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [applySnapshot]);
}
