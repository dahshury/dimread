/** Synchronous disposer returned by {@link subscribeNativeEvent}. */
export type Unsubscribe = () => void;

/**
 * Bridge a promise-based event registration (Tauri's `listen()` resolves to
 * its unlisten fn asynchronously) to the SYNCHRONOUS disposer a `useEffect`
 * cleanup needs. Disposing before the registration resolves runs the unlisten
 * on resolve, and events that race the disposal are dropped — so no
 * subscription (or stale handler call) can outlive its effect.
 */
export function subscribeNativeEvent<TEvent>(
	source: {
		listen: (handler: (event: TEvent) => void) => Promise<Unsubscribe>;
	},
	handler: (event: TEvent) => void,
): Unsubscribe {
	let disposed = false;
	let unlisten: Unsubscribe | null = null;
	void source
		.listen((event) => {
			if (!disposed) {
				handler(event);
			}
		})
		.then((off) => {
			if (disposed) {
				off();
				return;
			}
			unlisten = off;
		})
		.catch((error: unknown) => {
			// NEVER swallow this. A denied `listen()` — e.g. a window missing
			// from the capability's `windows` array, which is scoped by label —
			// leaves the window rendering perfectly while receiving no events
			// ever again. Silently discarding the rejection made that look like
			// a state-sync bug for a long time.
			console.error("[events] failed to subscribe:", error);
		});
	return () => {
		disposed = true;
		if (unlisten) {
			unlisten();
			unlisten = null;
		}
	};
}
