import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { type FocusAnchorEvent, events } from "@/bindings";
import {
	type BlurViewport,
	computeBlurLayout,
	shadeColorRgba,
	useFocusBlurSettings,
} from "@/features/focus-blur";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";
import { springs } from "@/shared/lib/springs";

/** Instant transition used when the "transition animation" setting is off. */
const NO_TRANSITION = { duration: 0 } as const;
/** Box-shadow spread large enough to fill any clipped container edge-to-edge. */
const SHADE_SPREAD = "200vmax";

/** The latest anchor plus how we got to it. */
interface TrackedAnchor {
	anchor: FocusAnchorEvent;
	/** True when this anchor is the SAME window as the previous one (it moved or
	 *  resized), false on a focus switch or the first anchor of an activation. */
	moved: boolean;
}

function readViewport(): BlurViewport {
	return {
		width: window.innerWidth,
		height: window.innerHeight,
		dpr: window.devicePixelRatio || 1,
	};
}

/**
 * Focus Blur shade (FEATURE-PARITY F8.2) — dims `focusBlur.color` at
 * `transparency`% over the whole virtual screen (or just the active window's
 * monitor when `onlyCurrentMonitor`) and masks a clear hole at the active-window
 * rect streamed by `focus:anchor`.
 *
 * The backend (`focus::blur`) sizes the `focus-overlay` window to the virtual
 * screen and emits WINDOW-LOCAL physical px, so the geometry only divides by the
 * device-pixel-ratio. The mask is a spotlight box-shadow: a transparent element
 * casts a huge shadow filling the clipped container everywhere EXCEPT its own
 * box, so one element both dims the background and reveals the active window. The
 * hole is positioned with a `translate` transform (GPU-composited, no per-frame
 * layout); its size is applied as a plain style (it snaps on resize rather than
 * animating a layout property). The shade colour is user-chosen, so it is applied
 * inline rather than via a token.
 *
 * The cutout's transition is chosen per update from `focus:anchor`'s `windowId`:
 * a switch to a different window glides, but the same window moving snaps. This
 * is a tracking-latency fix, not a style choice — springing the hole toward a
 * window that is still being dragged renders the animation itself as lag.
 *
 * Whole-virtual-screen mode paints ONE such spotlight per monitor region rather
 * than a single viewport-sized one: that is how `includeTaskbar` is honoured on
 * every display (each region is the monitor's work area when the taskbar is
 * excluded). Each region clamps the hole to itself, so a window straddling two
 * monitors is revealed by the union of its two slices, and a region the window
 * never touches keeps a zero-area hole and stays fully shaded.
 */
export function FocusBlurShade({ active }: { active: boolean }) {
	const settings = useFocusBlurSettings();
	const [tracked, setTracked] = useState<TrackedAnchor | null>(null);
	const [viewport, setViewport] = useState<BlurViewport>(readViewport);

	useEffect(() => {
		if (!(active && hasNativeRuntime())) {
			return;
		}
		return subscribeNativeEvent(events.focusAnchor, (event) => {
			// `moved` is resolved HERE rather than during render because it is a
			// property of the TRANSITION between two anchors, not of either one.
			setTracked((previous) => ({
				anchor: event.payload,
				moved: previous?.anchor.windowId === event.payload.windowId,
			}));
		});
	}, [active]);

	useEffect(() => {
		const onResize = () => setViewport(readViewport());
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// Only paint while Blur owns the overlay AND an anchor has arrived, so it
	// never flashes a hole-less full-screen shade. A stale anchor from a previous
	// activation is harmless: it stays hidden while inactive (regions is empty),
	// and on re-activation the enter fade + glide mask it as the fresh sample
	// lands.
	const regions =
		active && tracked
			? computeBlurLayout(tracked.anchor, viewport, settings.onlyCurrentMonitor)
			: [];
	// The shade fade uses the `moderate` spring tier (a panel-sized surface that
	// must settle precisely); the "transition animation" setting snaps everything
	// to 0 when off.
	const enter = settings.animate ? springs.moderate : NO_TRANSITION;
	const exitTransition = settings.animate
		? springs.moderate.exit
		: NO_TRANSITION;
	// The cutout is the exception: it only springs when focus SWITCHES to a
	// different window. While the same window is being dragged or resized, every
	// spring is a frame of the hole trailing the window — the animation itself
	// reads as tracking lag, and it compounds because each new anchor restarts the
	// spring from wherever the previous one had got to. So a move snaps.
	const glide = tracked?.moved ? NO_TRANSITION : enter;

	const shade = shadeColorRgba(settings.color, settings.transparency);

	return (
		<AnimatePresence>
			{regions.map((region, index) => (
				<m.div
					animate={{ opacity: 1 }}
					className="pointer-events-none absolute overflow-hidden"
					exit={{ opacity: 0, transition: exitTransition }}
					initial={{ opacity: 0 }}
					// Regions are homogeneous fills addressed purely by position, so
					// the enumeration index is their identity: keying on geometry
					// would remount (and re-fade) every region whenever the taskbar
					// toggle or a resolution change reshapes the rects.
					key={`focus-blur-region-${index}`}
					style={{
						left: region.container.left,
						top: region.container.top,
						width: region.container.width,
						height: region.container.height,
					}}
					transition={enter}
				>
					<m.div
						animate={{ x: region.cutout.left, y: region.cutout.top }}
						className="absolute top-0 left-0 will-change-transform"
						initial={false}
						style={{
							width: region.cutout.width,
							height: region.cutout.height,
							background: "transparent",
							boxShadow: `0 0 0 ${SHADE_SPREAD} ${shade}`,
						}}
						transition={glide}
					/>
				</m.div>
			))}
		</AnimatePresence>
	);
}
