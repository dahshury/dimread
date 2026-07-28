import { useCallback, useRef, useState } from "react";
import { commands, type UpdateCheck } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";

/**
 * One update check, as the About tab sees it.
 *
 * The check is MANUAL — the button is the only trigger, so DimRead never
 * contacts GitHub on its own. Everything the panel renders comes from a single
 * `update_check` round trip (see `src-tauri/src/update/`), which compares the
 * running bundle version against the repository's published releases.
 */
export type UpdateCheckState =
	| { phase: "idle" }
	| { phase: "checking" }
	| { phase: "result"; check: UpdateCheck }
	| { phase: "error"; message: string };

export interface UpdateChecker {
	/** True only in the desktop app; a browser preview has no backend to ask. */
	available: boolean;
	/** Start a check. A second press while one is in flight is ignored. */
	check: () => void;
	state: UpdateCheckState;
}

export function useUpdateCheck(): UpdateChecker {
	const [state, setState] = useState<UpdateCheckState>({ phase: "idle" });
	// A ref, not the state value: the guard has to be readable synchronously
	// inside the same tick as a double click.
	const inFlight = useRef(false);
	const available = hasNativeRuntime();

	const check = useCallback(() => {
		if (!available || inFlight.current) {
			return;
		}
		inFlight.current = true;
		setState({ phase: "checking" });
		void commands
			.updateCheck()
			.then((result) => {
				setState(
					result.status === "ok"
						? { phase: "result", check: result.data }
						: { phase: "error", message: result.error },
				);
			})
			.catch((error: unknown) => {
				setState({
					phase: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				inFlight.current = false;
			});
	}, [available]);

	return { available, check, state };
}
