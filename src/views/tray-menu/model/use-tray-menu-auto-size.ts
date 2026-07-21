import { useEffect, useRef } from "react";
import { commands } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";

/**
 * Size the `tray-menu` OS window to the panel it contains.
 *
 * The flyout is a frameless transparent window, so any slack between the window
 * and the drawn panel is an invisible rectangle that still swallows clicks —
 * and the popup's height genuinely varies (the readout row appears once the
 * engine reports state). Rather than pad the window to a worst-case size, the
 * renderer measures the panel and asks Rust to match it.
 *
 * Rust owns the two hard parts: it no-ops an unchanged size (a `ResizeObserver`
 * fires on every reflow — hover, focus rings, subpixel rounding — and an
 * unguarded resize loops), and it re-clamps the window against the tray anchor
 * afterwards so growth never pushes the popup under the taskbar.
 *
 * @returns the ref to attach to the element whose box the window should match.
 */
export function useTrayMenuAutoSize() {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const element = ref.current;
		if (!(element && hasNativeRuntime())) {
			return;
		}
		const report = () => {
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				return;
			}
			void commands
				.trayMenuResize(rect.width, rect.height)
				.catch(() => undefined);
		};
		const observer = new ResizeObserver(report);
		observer.observe(element);
		// Report once up front: the observer only fires on CHANGE, and the seed
		// window size from `WINDOW_SPECS` is almost certainly wrong.
		report();
		return () => observer.disconnect();
	}, []);

	return ref;
}
