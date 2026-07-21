import {
	type RefObject,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";

type SettingsWindowMotionPhase = "closed" | "resetting" | "open" | "closing";

/** Request the native hide slightly BEFORE the fade-out completes — the tail
 *  is visually gone already and the head start absorbs the IPC + OS hide
 *  latency that would otherwise hold a faded window on screen. */
const CLOSE_HIDE_OVERLAP_MS = 40;

/** If the content-ready gate hasn't opened this long after a reveal was
 *  requested, reveal anyway: a stalled hydration must degrade to "window
 *  appears with whatever is there", never "window never appears" (the OS
 *  window is transparent — until the reveal the user sees NOTHING). */
const REVEAL_FAILSAFE_MS = 1500;

function modalCloseDurationMs(): number {
	const reducedMotion = window.matchMedia?.(
		"(prefers-reduced-motion: reduce)",
	).matches;
	if (reducedMotion) {
		return 0;
	}
	const raw = window
		.getComputedStyle(document.documentElement)
		.getPropertyValue("--modal-close-dur")
		.trim();
	if (raw.endsWith("ms")) {
		return Number.parseFloat(raw) || 150;
	}
	if (raw.endsWith("s")) {
		return (Number.parseFloat(raw) || 0.15) * 1000;
	}
	return 150;
}

function settingsMotionClassName(phase: SettingsWindowMotionPhase): string {
	switch (phase) {
		case "open":
			return "is-open";
		case "closing":
			return "is-closing";
		case "resetting":
			return "is-resetting";
		case "closed":
			return "";
	}
}

// Hoisted so the component body holds no raw dynamic `import()` expression
// (React Compiler bails out of components containing one). Dynamic imports
// are memoized by specifier, so repeat calls return the cached module.
const loadTauriWindowApi = () => import("@tauri-apps/api/window");

/**
 * Enter/exit animation driver for the transparent settings window (a
 * simplified port of WinSTT's hook). The OS window is an invisible rect; the
 * CSS card (`t-modal`) IS the visible window, so:
 *
 *  - the reveal is gated on `contentReady` (never show an empty card) with a
 *    bounded failsafe;
 *  - the window is hide-on-close and the renderer stays alive, so re-opens
 *    replay the enter animation from the `visibilitychange`/focus signals
 *    (WebView2 suspends a hidden webview and resumes it on show);
 *  - `requestClose` plays the fade, then asks the backend to hide slightly
 *    before it completes.
 */
export function useSettingsWindowMotion(
	onClosed: () => void,
	contentReady: boolean,
): {
	motionClassName: string;
	requestClose: () => void;
	shellRef: RefObject<HTMLDivElement | null>;
} {
	const shellRef = useRef<HTMLDivElement | null>(null);
	const [phase, setPhase] = useState<SettingsWindowMotionPhase>("closed");
	const phaseRef = useRef<SettingsWindowMotionPhase>("closed");
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openFrameRef = useRef<number | null>(null);
	const contentReadyRef = useRef(contentReady);
	const pendingRevealRef = useRef(false);
	const failsafeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const setMotionPhase = useEffectEvent((next: SettingsWindowMotionPhase) => {
		phaseRef.current = next;
		setPhase(next);
	});

	const clearCloseTimer = useEffectEvent(() => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	});

	const clearOpenFrame = useEffectEvent(() => {
		if (openFrameRef.current !== null) {
			cancelAnimationFrame(openFrameRef.current);
			openFrameRef.current = null;
		}
	});

	const clearRevealFailsafe = useEffectEvent(() => {
		if (failsafeTimerRef.current !== null) {
			clearTimeout(failsafeTimerRef.current);
			failsafeTimerRef.current = null;
		}
	});

	const playOpen = useEffectEvent(() => {
		clearCloseTimer();
		clearOpenFrame();
		// "resetting" commits the start state with transitions DISABLED, so a
		// replay from a visually-open shell snaps to opacity 0 instead of
		// starting a reverse fade the `is-open` re-add would catch mid-dip.
		setMotionPhase("resetting");
		openFrameRef.current = requestAnimationFrame(() => {
			// Force a style flush of the committed start state — a webview that
			// was suspended while hidden otherwise coalesces the resetting→open
			// class flip into one recalc and SKIPS the transition entirely.
			shellRef.current?.getBoundingClientRect();
			openFrameRef.current = requestAnimationFrame(() => {
				openFrameRef.current = null;
				setMotionPhase("open");
			});
		});
	});

	// Content-ready gate in front of playOpen, with a bounded failsafe.
	const requestReveal = useEffectEvent(() => {
		if (contentReadyRef.current) {
			pendingRevealRef.current = false;
			clearRevealFailsafe();
			playOpen();
			return;
		}
		pendingRevealRef.current = true;
		if (failsafeTimerRef.current === null) {
			failsafeTimerRef.current = setTimeout(() => {
				failsafeTimerRef.current = null;
				if (pendingRevealRef.current) {
					pendingRevealRef.current = false;
					playOpen();
				}
			}, REVEAL_FAILSAFE_MS);
		}
	});

	useEffect(() => {
		contentReadyRef.current = contentReady;
		if (contentReady && pendingRevealRef.current) {
			pendingRevealRef.current = false;
			clearRevealFailsafe();
			playOpen();
		}
	}, [contentReady]);

	// Mount-time reveal — the cold-open case (window created + shown before
	// this renderer subscribed to anything). While the window is prewarmed /
	// hidden we do nothing; the visibilitychange listener below drives the
	// reveal when the webview resumes on the first real show.
	useEffect(() => {
		let cancelled = false;
		void loadTauriWindowApi()
			.then(({ getCurrentWindow }) => getCurrentWindow().isVisible())
			.then((visible) => {
				if (!cancelled && visible) {
					requestReveal();
				}
			})
			.catch(() => {
				// Visibility unknown (browser preview / tests) — reveal so the
				// window can never get stuck invisible.
				if (!cancelled) {
					requestReveal();
				}
			});
		return () => {
			cancelled = true;
			clearCloseTimer();
			clearOpenFrame();
			clearRevealFailsafe();
		};
		// Effect events are stable and intentionally omitted from deps.
	}, []);

	// Re-open replay: WebView2 suspends the hidden webview, so a re-shown
	// window fires visibilitychange→visible (and usually focus). A hide from
	// any path (incl. native Alt+F4) fires visibilitychange→hidden, which
	// resets the shell so the next open animates from a clean slate.
	useEffect(() => {
		const markClosed = () => {
			pendingRevealRef.current = false;
			clearRevealFailsafe();
			clearCloseTimer();
			clearOpenFrame();
			setMotionPhase("closed");
		};
		const maybeReplayOpen = () => {
			if (phaseRef.current === "closed") {
				requestReveal();
			}
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				markClosed();
				return;
			}
			maybeReplayOpen();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		window.addEventListener("focus", maybeReplayOpen);
		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			window.removeEventListener("focus", maybeReplayOpen);
		};
		// Effect events are stable; the listeners are mount-only.
	}, []);

	// Plain function (returned to the parent's close handler); touches only
	// refs + the stable setPhase setter.
	const requestClose = () => {
		if (phaseRef.current === "closing" || phaseRef.current === "closed") {
			return;
		}
		pendingRevealRef.current = false;
		if (failsafeTimerRef.current !== null) {
			clearTimeout(failsafeTimerRef.current);
			failsafeTimerRef.current = null;
		}
		if (openFrameRef.current !== null) {
			cancelAnimationFrame(openFrameRef.current);
			openFrameRef.current = null;
		}
		phaseRef.current = "closing";
		setPhase("closing");
		closeTimerRef.current = setTimeout(
			() => {
				closeTimerRef.current = null;
				phaseRef.current = "closed";
				setPhase("closed");
				onClosed();
			},
			Math.max(0, modalCloseDurationMs() - CLOSE_HIDE_OVERLAP_MS),
		);
	};

	return {
		motionClassName: settingsMotionClassName(phase),
		requestClose,
		shellRef,
	};
}
