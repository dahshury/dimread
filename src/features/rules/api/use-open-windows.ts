import { useCallback, useEffect, useState } from "react";
import { commands, type OpenWindow } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";

/**
 * Loads the running top-level windows from the `rules_list_windows` IPC command
 * — the data behind the rule editor's window picker (our replacement for
 * CareUEyes' drag "Finder Tool"). Fetches when `active` (the dialog is open) and
 * exposes a manual refresh.
 */
export interface UseOpenWindows {
	error: string | null;
	windows: OpenWindow[];
	loading: boolean;
	refresh: () => void;
}

const EMPTY: OpenWindow[] = [];

export function useOpenWindows(active: boolean): UseOpenWindows {
	const [windows, setWindows] = useState<OpenWindow[]>(EMPTY);
	const [reloadToken, setReloadToken] = useState(0);
	const [loadedToken, setLoadedToken] = useState(-1);
	const [failure, setFailure] = useState<{
		message: string;
		token: number;
	} | null>(null);
	const native = hasNativeRuntime();

	const refresh = useCallback(() => {
		setReloadToken((token) => token + 1);
	}, []);

	useEffect(() => {
		if (!(active && native)) {
			return;
		}
		let disposed = false;
		void commands
			.rulesListWindows()
			.then((list) => {
				if (!disposed) {
					setWindows(list);
					setFailure(null);
				}
			})
			.catch((error: unknown) => {
				if (!disposed) {
					setFailure({
						message: error instanceof Error ? error.message : String(error),
						token: reloadToken,
					});
				}
			})
			.finally(() => {
				if (!disposed) {
					setLoadedToken(reloadToken);
				}
			});
		return () => {
			disposed = true;
		};
	}, [active, native, reloadToken]);

	// Derived (no synchronous setState in the effect body): a fetch is in flight
	// whenever the dialog is open and the latest reload hasn't resolved yet.
	const loading = active && native && loadedToken !== reloadToken;
	const error = failure?.token === reloadToken ? failure.message : null;

	return { error, windows, loading, refresh };
}
