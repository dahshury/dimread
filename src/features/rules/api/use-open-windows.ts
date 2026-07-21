import { useCallback, useEffect, useState } from "react";
import { commands, type OpenWindow } from "@/bindings";
import { commandOrDefault, hasNativeRuntime } from "@/shared/api";

/**
 * Loads the running top-level windows from the `rules_list_windows` IPC command
 * — the data behind the rule editor's window picker (our replacement for
 * CareUEyes' drag "Finder Tool"). Fetches when `active` (the dialog is open) and
 * exposes a manual refresh.
 */
export interface UseOpenWindows {
	windows: OpenWindow[];
	loading: boolean;
	refresh: () => void;
}

const EMPTY: OpenWindow[] = [];

export function useOpenWindows(active: boolean): UseOpenWindows {
	const [windows, setWindows] = useState<OpenWindow[]>(EMPTY);
	const [reloadToken, setReloadToken] = useState(0);
	const [loadedToken, setLoadedToken] = useState(-1);

	const refresh = useCallback(() => {
		setReloadToken((token) => token + 1);
	}, []);

	useEffect(() => {
		if (!(active && hasNativeRuntime())) {
			return;
		}
		let disposed = false;
		void commandOrDefault(
			"rules_list_windows",
			() => commands.rulesListWindows(),
			EMPTY,
		)
			.then((list) => {
				if (!disposed) {
					setWindows(list);
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
	}, [active, reloadToken]);

	// Derived (no synchronous setState in the effect body): a fetch is in flight
	// whenever the dialog is open and the latest reload hasn't resolved yet.
	const loading = active && loadedToken !== reloadToken;

	return { windows, loading, refresh };
}
