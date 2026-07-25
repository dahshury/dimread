/** Synchronous disposer returned by {@link subscribeNativeEvent}. */
export type Unsubscribe = () => void;

interface NativeEventSource<TEvent> {
	listen: (handler: (event: TEvent) => void) => Promise<Unsubscribe>;
}

type AfterSubscribed = (
	isDisposed: () => boolean,
) => Promise<unknown> | unknown;

function runAfterSubscribed(
	afterSubscribed: AfterSubscribed | undefined,
	isDisposed: () => boolean,
): void {
	if (!afterSubscribed) {
		return;
	}
	void Promise.resolve()
		.then(() => afterSubscribed(isDisposed))
		.catch((error: unknown) => {
			console.error("[events] post-subscribe handshake failed:", error);
		});
}

/**
 * Bridge a promise-based event registration (Tauri's `listen()` resolves to
 * its unlisten fn asynchronously) to the SYNCHRONOUS disposer a `useEffect`
 * cleanup needs. Disposing before the registration resolves runs the unlisten
 * on resolve, and events that race the disposal are dropped — so no
 * subscription (or stale handler call) can outlive its effect.
 */
export function subscribeNativeEvent<TEvent>(
	source: NativeEventSource<TEvent>,
	handler: (event: TEvent) => void,
	afterSubscribed?: AfterSubscribed,
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
			runAfterSubscribed(afterSubscribed, () => disposed);
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

/** Two-stream variant for lifecycle handshakes that must install both live
 * listeners before reading a backend snapshot or announcing renderer-ready.
 * Cleanup remains synchronous even when registration is still in flight. */
export function subscribeNativeEventPair<TFirst, TSecond>(
	firstSource: NativeEventSource<TFirst>,
	firstHandler: (event: TFirst) => void,
	secondSource: NativeEventSource<TSecond>,
	secondHandler: (event: TSecond) => void,
	afterSubscribed?: AfterSubscribed,
): Unsubscribe {
	let disposed = false;
	let failed = false;
	let unlisteners: Unsubscribe[] = [];
	void Promise.all([
		firstSource
			.listen((event) => {
				if (!disposed) {
					firstHandler(event);
				}
			})
			.then((unlisten) => {
				if (disposed || failed) {
					unlisten();
				} else {
					unlisteners.push(unlisten);
				}
			}),
		secondSource
			.listen((event) => {
				if (!disposed) {
					secondHandler(event);
				}
			})
			.then((unlisten) => {
				if (disposed || failed) {
					unlisten();
				} else {
					unlisteners.push(unlisten);
				}
			}),
	])
		.then(() => {
			if (disposed) {
				return;
			}
			runAfterSubscribed(afterSubscribed, () => disposed);
		})
		.catch((error: unknown) => {
			failed = true;
			for (const unlisten of unlisteners) {
				unlisten();
			}
			unlisteners = [];
			console.error("[events] failed to initialize event streams:", error);
		});
	return () => {
		disposed = true;
		for (const unlisten of unlisteners) {
			unlisten();
		}
		unlisteners = [];
	};
}
