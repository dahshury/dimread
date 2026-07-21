import { useEffect, useRef, useState } from "react";
import type { PickerAnchorEvent } from "@/bindings";
import { NATIVE_EVENTS, on, onCast } from "@/shared/api";
import {
	DEFAULT_PANEL_RECT,
	dropdownStateClass,
	normalizePanelRect,
	type PanelPhase,
	type PanelRect,
	PICKER_CLOSE_MS,
} from "../lib/panel-math";

interface PanelRectState {
	/** t-dropdown state class derived from the current phase. */
	dropdownStateClass: string;
	/** Bumps every time the panel fully closes — fold into the body's `key`
	 *  so transient in-picker UI (the search query) resets between opens. */
	openGeneration: number;
	panelInteractive: boolean;
	panelRevealed: boolean;
	/** Rect to lay the panel out at — the real anchor when up, the default
	 *  footprint while warm-mounted invisible. */
	warmPanel: PanelRect;
}

/**
 * Owns the detached-window panel positioning state machine (ported from
 * WinSTT's usePanelRect, minus the per-mode resize protocol — the starter's
 * panel footprint is a Rust-side constant): `picker:anchor` positions +
 * reveals, `picker:closing` plays the fade then hides, and a double-rAF
 * reveal gate holds the panel invisible until the compositor has painted a
 * frame at the new anchor, so the open animation is never swallowed by
 * WebView2's show-resume lag (and never starts on a stale frame composited
 * at the previous trigger's position).
 */
export function usePanelRect(): PanelRectState {
	const [panel, setPanelState] = useState<PanelRect | null>(null);
	const [phase, setPhaseState] = useState<PanelPhase>("hidden");
	const [openGeneration, setOpenGeneration] = useState(0);

	const panelRef = useRef<PanelRect | null>(null);
	const phaseRef = useRef<PanelPhase>("hidden");
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const revealRafRef = useRef<number | null>(null);
	const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const generationRef = useRef(0);

	// Stable helper identities (state-initializer trick — same pattern the
	// WinSTT hook uses so the effects below never re-subscribe).
	const [setPanel] = useState(() => (next: PanelRect | null) => {
		panelRef.current = next;
		setPanelState(next);
	});
	const [setPhase] = useState(() => (next: PanelPhase) => {
		phaseRef.current = next;
		setPhaseState(next);
	});
	const [clearCloseTimer] = useState(() => () => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	});
	const [clearRevealWait] = useState(() => () => {
		if (revealRafRef.current !== null) {
			cancelAnimationFrame(revealRafRef.current);
			revealRafRef.current = null;
		}
		if (revealTimerRef.current !== null) {
			clearTimeout(revealTimerRef.current);
			revealTimerRef.current = null;
		}
	});

	useEffect(
		() => () => {
			clearCloseTimer();
			clearRevealWait();
		},
		[clearCloseTimer, clearRevealWait],
	);

	// picker:anchor — position + reveal. Duplicate anchors (Rust re-emits a few
	// times to cover the first-open listener race) are idempotent: an already
	// revealed panel just tracks the rect without restarting the animation.
	useEffect(
		() =>
			onCast<PickerAnchorEvent>(NATIVE_EVENTS.PICKER_ANCHOR, (payload) => {
				generationRef.current += 1;
				clearCloseTimer();
				setPanel(normalizePanelRect(payload));
				if (phaseRef.current === "open" || phaseRef.current === "pre-open") {
					return;
				}
				setPhase("pre-open");
				clearRevealWait();
				const reveal = () => {
					clearRevealWait();
					if (phaseRef.current === "pre-open") {
						setPhase("open");
					}
				};
				revealRafRef.current = requestAnimationFrame(() => {
					revealRafRef.current = requestAnimationFrame(() => {
						revealRafRef.current = null;
						reveal();
					});
				});
				// Safety net: if rAF never fires (throttled webview), reveal anyway.
				revealTimerRef.current = setTimeout(reveal, 400);
			}),
		[clearCloseTimer, clearRevealWait, setPanel, setPhase],
	);

	// picker:closing — play the fade, then drop to hidden. Closed before the
	// reveal gate fired → the panel was never visible; drop straight to hidden
	// instead of flashing it in via the out-animation.
	useEffect(() => {
		const unlisten = on(NATIVE_EVENTS.PICKER_CLOSING, () => {
			if (panelRef.current === null) {
				return;
			}
			if (phaseRef.current === "pre-open") {
				clearRevealWait();
				setPanel(null);
				setPhase("hidden");
				setOpenGeneration((generation) => generation + 1);
				return;
			}
			const closeGeneration = generationRef.current;
			clearCloseTimer();
			setPhase("closing");
			closeTimerRef.current = setTimeout(() => {
				closeTimerRef.current = null;
				if (
					generationRef.current !== closeGeneration ||
					phaseRef.current !== "closing"
				) {
					return;
				}
				setPanel(null);
				setPhase("hidden");
				setOpenGeneration((generation) => generation + 1);
			}, PICKER_CLOSE_MS);
		});
		return () => {
			clearCloseTimer();
			unlisten();
		};
	}, [clearCloseTimer, clearRevealWait, setPanel, setPhase]);

	const panelRevealed = panel !== null;
	return {
		dropdownStateClass: dropdownStateClass(phase),
		openGeneration,
		panelInteractive: panelRevealed && phase === "open",
		panelRevealed,
		warmPanel: panel ?? DEFAULT_PANEL_RECT,
	};
}
