import { useEffect } from "react";
import { commands, events, type SettingsSnapshot } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";
import { adoptSettingsSnapshot } from "./adopt-settings-snapshot";
import { useSettingsHydrationStore } from "./settings-hydration-store";

interface SettingsEvent {
	payload: SettingsSnapshot;
}

interface SettingsEventSource {
	listen: (handler: (event: SettingsEvent) => void) => Promise<() => void>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Install the live stream before loading a snapshot, closing the classic
 * load-then-listen gap where a save could land between those two operations
 * and never reach this renderer. Kept as a small injectable unit so the
 * ordering and recovery contract can be tested without a Tauri runtime.
 */
export function startSettingsSync(
	source: SettingsEventSource = events.settingsChanged,
	loadSnapshot: () => Promise<SettingsSnapshot> = () =>
		commands.settingsLoadSnapshot(),
): () => void {
	let disposed = false;
	let hasAuthoritativeSnapshot = false;
	let unlisten: (() => void) | null = null;
	const { setStatus } = useSettingsHydrationStore.getState();
	setStatus("loading");

	const handleSnapshot = (snapshot: SettingsSnapshot): boolean => {
		if (disposed || !adoptSettingsSnapshot(snapshot)) {
			return false;
		}
		hasAuthoritativeSnapshot = true;
		setStatus("ready");
		return true;
	};

	void source
		.listen((event) => {
			handleSnapshot(event.payload);
		})
		.then(async (stop) => {
			if (disposed) {
				stop();
				return;
			}
			unlisten = stop;
			try {
				const snapshot = await loadSnapshot();
				if (disposed) {
					return;
				}
				// A false return means a newer event/save already won. Either way,
				// a successful load proves the renderer has an authoritative base.
				handleSnapshot(snapshot);
				hasAuthoritativeSnapshot = true;
				setStatus("ready");
			} catch (error: unknown) {
				// Keep listening after a transient load error. The next live snapshot
				// heals the window and moves the status back to ready.
				if (!(disposed || hasAuthoritativeSnapshot)) {
					setStatus("error", errorMessage(error));
				}
			}
		})
		.catch((error: unknown) => {
			if (!disposed) {
				setStatus("error", errorMessage(error));
			}
		});

	return () => {
		disposed = true;
		unlisten?.();
		unlisten = null;
	};
}

/**
 * Window-root settings bootstrap: hydrate from the backend and keep this
 * renderer converged through `settings:changed`. Pending local field edits are
 * rebased by {@link adoptSettingsSnapshot}, including edits made while the
 * initial snapshot is in flight.
 */
export function useSettingsSync(): void {
	const retryToken = useSettingsHydrationStore((state) => state.retryToken);
	useEffect(() => {
		if (!hasNativeRuntime()) {
			useSettingsHydrationStore.getState().setStatus("unavailable");
			return;
		}
		return startSettingsSync();
	}, [retryToken]);
}
