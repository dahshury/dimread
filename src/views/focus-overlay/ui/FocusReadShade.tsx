import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";
import { events } from "@/bindings";
import {
	computeBand,
	shadeColor,
	useFocusReadSettings,
} from "@/features/focus-read";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

/**
 * Focus Read shade (FEATURE-PARITY F8.1) — a full-window dim with a clear
 * horizontal band that tracks the cursor. Two full-height shade panes are pushed
 * apart by the band using transform-only CSS variables (`--band-top` /
 * `--band-bottom`), so the reading ruler follows the pointer at the poll rate
 * without any per-frame React re-render or layout.
 *
 * The backend (`focus::read`) sizes the `focus-overlay` window to the whole
 * virtual screen and streams the PHYSICAL cursor via `focus:cursor`; this maps
 * that to the window's CSS-px band edges using the window's physical origin +
 * scale factor. The shade colour comes from the `focusRead` settings (a
 * user-chosen colour, so it is applied inline rather than via a theme token).
 */
export function FocusReadShade({ active }: { active: boolean }) {
	const settings = useFocusReadSettings();
	const rootRef = useRef<HTMLDivElement>(null);
	// The overlay window's physical top + scale, refreshed whenever Read turns on
	// (the engine repositions the window to the virtual screen on show).
	const geometryRef = useRef<{ top: number; dpr: number }>({ top: 0, dpr: 1 });
	// The last PHYSICAL cursor Y sample, so the band can be re-applied when only
	// the height (or geometry) changes without waiting for the pointer to move.
	const lastCursorYRef = useRef<number | null>(null);
	// Live height mirror so `applyBand` stays referentially stable (no re-subscribe
	// of the cursor listener when the height slider changes). Seeded here and
	// afterwards written only from the reflow effect below — a ref write during
	// render can leak from work React replays or discards.
	const heightRef = useRef(settings.height);

	// Recompute + apply the clear-band edges from the last known cursor sample and
	// geometry. Until a real `focus:cursor` lands we seed the band to the viewport
	// centre so a height edit still reflows immediately.
	const applyBand = useCallback(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const { top, dpr } = geometryRef.current;
		const cursorY =
			lastCursorYRef.current ?? top + (window.innerHeight / 2) * dpr;
		const { bandTop, bandBottom } = computeBand(
			cursorY,
			top,
			dpr,
			heightRef.current,
		);
		root.style.setProperty("--band-top", `${bandTop}px`);
		root.style.setProperty("--band-bottom", `${bandBottom}px`);
	}, []);

	useEffect(() => {
		if (!active) {
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const win = getCurrentWindow();
				const [position, dpr] = await Promise.all([
					win.outerPosition(),
					win.scaleFactor(),
				]);
				if (!cancelled) {
					geometryRef.current = { top: position.y, dpr: dpr || 1 };
					// Re-apply with correct geometry: a `focus:cursor` sample that
					// landed before this resolved was mapped with the 0/1 fallback
					// (wrong on a negative-origin monitor); fix it now.
					applyBand();
				}
			} catch {
				// Browser preview / no native runtime: keep the 0/1 fallback.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [active, applyBand]);

	useEffect(() => {
		if (!(active && hasNativeRuntime())) {
			return;
		}
		return subscribeNativeEvent(events.focusCursor, (event) => {
			lastCursorYRef.current = event.payload.y;
			applyBand();
		});
	}, [active, applyBand]);

	// Publish the new height to the mirror, then reflow the band the instant it
	// changes (or on activation) even if the cursor is still — the CSS vars persist
	// across renders, so without this a keyboard height edit stays invisible until
	// the next `focus:cursor` sample. The mirror is written before `applyBand`
	// reads it, and unconditionally, so an edit made while Read is off still
	// applies when it turns back on.
	useEffect(() => {
		heightRef.current = settings.height;
		if (!active) {
			return;
		}
		applyBand();
	}, [active, settings.height, applyBand]);

	if (!active) {
		return null;
	}

	const shade = shadeColor(settings.color, settings.transparency);
	return (
		<div className="fixed inset-0 overflow-hidden" ref={rootRef}>
			<div
				className="absolute inset-x-0 top-0 h-full will-change-transform"
				style={{
					backgroundColor: shade,
					transform: "translateY(calc(var(--band-top, 50vh) - 100%))",
				}}
			/>
			<div
				className="absolute inset-x-0 top-0 h-full will-change-transform"
				style={{
					backgroundColor: shade,
					transform: "translateY(var(--band-bottom, 50vh))",
				}}
			/>
		</div>
	);
}
