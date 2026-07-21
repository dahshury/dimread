import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { hasNativeRuntime } from "@/shared/api";

/** Breathing room left beneath the last control before the window edge (px). */
const BOTTOM_PADDING = 16;

/**
 * Size the frameless main window to exactly fit its content.
 *
 * The main window is a fixed titlebar over a single content column whose height
 * genuinely varies — the monitor strip only appears on multi-monitor setups, so
 * any fixed height either clips it or leaves dead space beneath the toggles.
 * Following the same principle as the tray flyout (`useTrayMenuAutoSize`), the
 * renderer measures the natural content height and asks the OS window to match
 * it instead of padding to a worst case.
 *
 * Only the height tracks the content; the width is left as the window already
 * is. Resizing the window never changes the measured column's height (it is a
 * flex column of fixed-height rows at a constant width), so there is no observer
 * feedback loop — the `lastHeight` guard is only a subpixel backstop.
 *
 * @returns the ref to attach to the natural-height content column.
 */
export function useMainWindowFit() {
	const ref = useRef<HTMLDivElement>(null);
	const lastHeight = useRef(0);

	useEffect(() => {
		const column = ref.current;
		if (!(column && hasNativeRuntime())) {
			return;
		}
		const root = column.closest<HTMLElement>("[data-window-root]");
		if (!root) {
			return;
		}
		const win = getCurrentWindow();

		const fit = () => {
			// `column.bottom - root.top` spans the titlebar + top padding + content;
			// add the bottom padding for the full natural window height.
			const height = Math.ceil(
				column.getBoundingClientRect().bottom -
					root.getBoundingClientRect().top +
					BOTTOM_PADDING,
			);
			if (height <= 0 || Math.abs(height - lastHeight.current) < 1) {
				return;
			}
			lastHeight.current = height;
			void win
				.setSize(new LogicalSize(window.innerWidth, height))
				.catch(() => undefined);
		};

		const observer = new ResizeObserver(fit);
		observer.observe(column);
		// The observer only fires on CHANGE; the seed size from `lib.rs` is a
		// single-monitor guess, so measure once up front too (and again after web
		// fonts settle / the monitor strip resolves, which the observer catches).
		fit();
		return () => observer.disconnect();
	}, []);

	return ref;
}
