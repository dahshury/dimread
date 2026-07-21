import { listen as tauriListen } from "@tauri-apps/api/event";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";

const noop = () => undefined;

export type FallbackValue<T> = T | (() => T);

function resolveFallback<T>(fallback: FallbackValue<T>): T {
	return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

/** True when generated commands and Tauri events are available. */
export function hasNativeRuntime(): boolean {
	return hasTauriRuntime();
}

/**
 * Run a generated command while preserving the renderer's intentional browser
 * preview fallback. Backend failures remain observable instead of looking like
 * a successful empty response.
 */
export async function commandOrDefault<T>(
	label: string,
	thunk: () => Promise<T>,
	fallback: FallbackValue<T>,
): Promise<T> {
	try {
		const value = await thunk();
		return value === undefined ? resolveFallback(fallback) : value;
	} catch (error) {
		console.warn(
			`[native] command "${label}" failed — returning fallback:`,
			error,
		);
		return resolveFallback(fallback);
	}
}

/** Subscribe directly to a canonical Tauri event and return synchronous cleanup. */
export function on(
	channel: string,
	callback: (payload: unknown) => void,
): () => void {
	if (!hasTauriRuntime()) {
		return noop;
	}
	const pending = tauriListen<unknown>(channel, (event) => {
		callback(event.payload);
	});
	void pending.catch((error) => {
		console.warn(`[events] failed to listen for "${channel}":`, error);
	});
	return () => {
		void pending.then((unlisten) => unlisten()).catch(() => undefined);
	};
}

export { on as ipcOn };

/** Subscribe with an extraction step so callers receive a narrowed value. */
export function onTyped<T, V>(
	channel: string,
	extract: (data: T) => V,
	callback: (value: V) => void,
): () => void {
	return on(channel, (data) => callback(extract(data as T)));
}

/** Subscribe and cast the payload to the expected event type. */
export function onCast<T>(
	channel: string,
	callback: (value: T) => void,
): () => void {
	return on(channel, (data) => callback(data as T));
}
