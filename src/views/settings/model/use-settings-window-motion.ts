import {
	type RefObject,
	type TransitionEventHandler,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";

type SettingsWindowMotionPhase = "closed" | "resetting" | "open" | "closing";

/** Why the window is leaving the screen — see {@link useSettingsWindowMotion}.
 *
 *  `close` is a real close (the X button, Alt+F4): the backend may quit the app.
 *  `dismiss` is Escape: always just hide. The animation is identical; only the
 *  ending differs, so the intent rides along with `requestClose` and comes back
 *  out in `onClosed` rather than living in a ref in the caller (a ref the
 *  caller would have to write during render, which React Compiler refuses to
 *  optimize around). */
export type WindowExitIntent = "close" | "dismiss";

/** Last-resort recovery if a suspended WebView suppresses transition events.
 * Normal closure is driven by the shell's real transition callback. */
const CLOSE_EVENT_FAILSAFE_MS = 1000;

/** If the content-ready gate hasn't opened this long after a reveal was
 *  requested, reveal anyway: a stalled hydration must degrade to "window
 *  appears with whatever is there", never "window never appears" (the OS
 *  window is transparent — until the reveal the user sees NOTHING). */
const REVEAL_FAILSAFE_MS = 1500;

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
 *  - `requestClose` / `requestDismiss` play the same fade, then the transition
 *    callback hands the matching {@link WindowExitIntent} to `onClosed`.
 *
 * Both exits are returned as ZERO-ARGUMENT callbacks rather than one function
 * taking an intent: they are wired straight into event handlers, which would
 * otherwise pass their event object in as the intent.
 */
export function useSettingsWindowMotion(
	onClosed: (intent: WindowExitIntent) => void,
	contentReady: boolean,
): {
	motionClassName: string;
	onShellTransitionEnd: TransitionEventHandler<HTMLDivElement>;
	requestClose: () => void;
	requestDismiss: () => void;
	shellRef: RefObject<HTMLDivElement | null>;
} {
	const shellRef = useRef<HTMLDivElement | null>(null);
	const [phase, setPhase] = useState<SettingsWindowMotionPhase>("closed");
	const phaseRef = useRef<SettingsWindowMotionPhase>("closed");
	const intentRef = useRef<WindowExitIntent>("close");
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

	const completeClose = () => {
		if (phaseRef.current !== "closing") {
			return;
		}
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		phaseRef.current = "closed";
		setPhase("closed");
		onClosed(intentRef.current);
	};

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

	// Plain function (wrapped below into the parent's two exit handlers);
	// touches only refs + the stable setPhase setter.
	const requestExit = (intent: WindowExitIntent) => {
		if (phaseRef.current === "closing" || phaseRef.current === "closed") {
			return;
		}
		intentRef.current = intent;
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
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
			completeClose();
			return;
		}
		closeTimerRef.current = setTimeout(completeClose, CLOSE_EVENT_FAILSAFE_MS);
	};

	const onShellTransitionEnd: TransitionEventHandler<HTMLDivElement> = (
		event,
	) => {
		if (
			event.target === event.currentTarget &&
			event.propertyName === "transform"
		) {
			completeClose();
		}
	};
	return {
		motionClassName: settingsMotionClassName(phase),
		onShellTransitionEnd,
		requestClose: () => requestExit("close"),
		requestDismiss: () => requestExit("dismiss"),
		shellRef,
	};
}
