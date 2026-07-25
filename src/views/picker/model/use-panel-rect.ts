import {
	type AnimationEvent as ReactAnimationEvent,
	type AnimationEventHandler,
	useEffect,
	useRef,
	useState,
} from "react";
import { commands, events, type PickerAnchorEvent } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEventPair } from "@/shared/api";
import {
	DEFAULT_PANEL_RECT,
	dropdownStateClass,
	normalizePanelRect,
	type PanelPhase,
	type PanelRect,
} from "../lib/panel-math";

interface PanelRectState {
	/** t-dropdown state class derived from the current phase. */
	dropdownStateClass: string;
	/** Bumps every time the panel fully closes — fold into the body's `key`
	 *  so transient in-picker UI (the search query) resets between opens. */
	openGeneration: number;
	/** Completes a close from the dropdown's real CSS lifecycle. */
	onPanelAnimationEnd: AnimationEventHandler<HTMLDivElement>;
	panelInteractive: boolean;
	panelRevealed: boolean;
	/** Rect to lay the panel out at — the real anchor when up, the default
	 *  footprint while warm-mounted invisible. */
	warmPanel: PanelRect;
}

function acknowledgePickerHide(): void {
	if (hasNativeRuntime()) {
		void commands.pickerHideComplete();
	}
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
	const revealRafRef = useRef<number | null>(null);
	const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
	const [finishClose] = useState(() => () => {
		if (phaseRef.current !== "closing") {
			return;
		}
		setPanel(null);
		setPhase("hidden");
		setOpenGeneration((generation) => generation + 1);
		acknowledgePickerHide();
	});
	const [onPanelExitEvent] = useState<AnimationEventHandler<HTMLDivElement>>(
		() => (event: ReactAnimationEvent<HTMLDivElement>) => {
			if (
				event.target === event.currentTarget &&
				event.animationName === "dropdown-out"
			) {
				finishClose();
			}
		},
	);

	useEffect(
		() => () => {
			clearRevealWait();
		},
		[clearRevealWait],
	);

	const [applyAnchor] = useState(() => (payload: PickerAnchorEvent) => {
		// WebView suspension can suppress animationend. A new native
		// anchor is the authoritative boundary between opens, so finish the
		// old generation here before laying out the new one.
		if (phaseRef.current === "closing") {
			setOpenGeneration((generation) => generation + 1);
		}
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
	});

	// Install both live listeners before reading the cached anchor. This closes
	// the first-show/long-idle race without repeated delayed event emissions.
	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		const handleClosing = () => {
			if (panelRef.current === null) {
				acknowledgePickerHide();
				return;
			}
			if (phaseRef.current === "pre-open") {
				clearRevealWait();
				setPanel(null);
				setPhase("hidden");
				setOpenGeneration((generation) => generation + 1);
				acknowledgePickerHide();
				return;
			}
			setPhase("closing");
			if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
				finishClose();
			}
		};
		return subscribeNativeEventPair(
			events.pickerAnchor,
			(event) => applyAnchor(event.payload),
			events.pickerClosing,
			handleClosing,
			async (isDisposed) => {
				const snapshot = await commands.pickerAnchorSnapshot();
				if (isDisposed()) {
					return;
				}
				if (snapshot.closing) {
					handleClosing();
				} else if (snapshot.anchor) {
					applyAnchor(snapshot.anchor);
				}
			},
		);
	}, [applyAnchor, clearRevealWait, finishClose, setPanel, setPhase]);

	const panelRevealed = panel !== null;
	return {
		dropdownStateClass: dropdownStateClass(phase),
		openGeneration,
		onPanelAnimationEnd: onPanelExitEvent,
		panelInteractive: panelRevealed && phase === "open",
		panelRevealed,
		warmPanel: panel ?? DEFAULT_PANEL_RECT,
	};
}
