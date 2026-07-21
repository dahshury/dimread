import { useEffect } from "react";
import { commands, events } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";
import { adoptSettingsSnapshot } from "./adopt-settings-snapshot";
import { useSettingsHydrationStore } from "./settings-hydration-store";

/**
 * Window-root settings bootstrap: hydrate the local store from the backend
 * snapshot (backend wins over the localStorage cache) and keep it in sync via
 * the `settings:changed` broadcast so every window converges on one tree.
 *
 * Both paths go through {@link adoptSettingsSnapshot}, which drops a snapshot
 * older than what the store already holds. That guard is what makes the window
 * safe to interact with WHILE the boot snapshot is still in flight: an edit
 * committed in that gap advances the revision, so the arriving snapshot is
 * recognised as stale instead of reverting it.
 *
 * Mount ONCE per window (RootLayout does).
 */
export function useSettingsSync(): void {
	const setStatus = useSettingsHydrationStore((s) => s.setStatus);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			// Browser preview: the localStorage cache is all we have.
			setStatus("unavailable");
			return;
		}
		let disposed = false;
		setStatus("loading");
		commands
			.settingsLoadSnapshot()
			.then((snapshot) => {
				if (disposed) {
					return;
				}
				// Superseded by an edit made during boot is still "hydrated".
				adoptSettingsSnapshot(snapshot);
				setStatus("ready");
			})
			.catch((error: unknown) => {
				if (!disposed) {
					setStatus(
						"error",
						error instanceof Error ? error.message : String(error),
					);
				}
			});
		const unsubscribe = subscribeNativeEvent(
			events.settingsChanged,
			(event) => {
				adoptSettingsSnapshot(event.payload);
			},
		);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [setStatus]);
}
