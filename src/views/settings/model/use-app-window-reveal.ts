import { useEffect, useRef } from "react";
import { commands, hasNativeRuntime } from "@/shared/api";

/**
 * Ask the backend to reveal the app window once this renderer has something to
 * show.
 *
 * The OS window is created hidden in `lib.rs` setup and is fully TRANSPARENT,
 * so showing it before the card paints would flash an empty rectangle — and
 * showing it never would leave the app running invisibly. The renderer owns
 * that moment: it calls `show_app_window` the first time its settings snapshot
 * has hydrated. Rust keeps a bounded fallback (`schedule_initial_reveal_fallback`)
 * for the case where this renderer never gets there.
 *
 * Fires ONCE per renderer. Later hides/shows come from the tray, the
 * `toggleMain` hotkey, or the window's own close button; the enter animation
 * for those replays off `visibilitychange` in `useSettingsWindowMotion`.
 */
export function useAppWindowReveal(contentReady: boolean): void {
	const requested = useRef(false);

	useEffect(() => {
		if (!(contentReady && hasNativeRuntime()) || requested.current) {
			return;
		}
		requested.current = true;
		void commands.showAppWindow().catch(() => undefined);
	}, [contentReady]);
}
