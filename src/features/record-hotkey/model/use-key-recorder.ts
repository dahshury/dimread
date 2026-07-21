import { type Dispatch, useEffect, useReducer, useRef } from "react";
import {
	comboFromChord,
	heldModifiersFromEvent,
	isModifierToken,
	keyNameFromEvent,
	sortKeys,
} from "../lib/key-capture";

/**
 * DOM-based hotkey capture.
 *
 * Semantics (standardized across dimread / dahshury-tauri-starter):
 *   - `startRecording` arms capture; held MODIFIERS render live as they are
 *     pressed.
 *   - The chord COMMITS the instant a non-modifier main key goes down:
 *     `held modifiers + main key`. Committing on keydown (instead of waiting
 *     for every key to be released) is what makes capture reliable on
 *     Windows, where keyups are routinely swallowed (the Alt+Shift keyboard
 *     layout switch, Win-key menu handling) and a release-based recorder
 *     hangs until blur cancels it. It also guarantees exactly one main key,
 *     which is the only chord shape the accelerator parser accepts.
 *   - Held modifiers are re-read from every event's modifier bitmask
 *     (`getModifierState`), not tracked via keydown/keyup pairs, so a
 *     swallowed keyup can never leave a stale modifier in the chord.
 *   - Escape cancels. Window blur cancels (capture must not outlive focus).
 *   - The Stop button (`stopRecording`) cancels — with instant commit there
 *     is never a pending chord worth flushing.
 */

interface UseKeyRecorderOptions {
	onKeyRecorded?: (key: string) => void;
	/**
	 * Capture lifecycle signal — used to suspend/resume the live binding.
	 * On finish (`recording === false`), `committedCombo` carries the combo
	 * that was handed to `onKeyRecorded`, or null for a cancel — so the
	 * caller knows whether it must restore the suspended binding.
	 */
	onRecordingChange?: (
		recording: boolean,
		committedCombo: string | null,
	) => void;
}

interface UseKeyRecorderReturn {
	key: string | null;
	liveKeys: string[];
	recording: boolean;
	startRecording: () => void;
	stopRecording: () => void;
}

interface RecorderState {
	key: string | null;
	liveKeys: string[];
	recording: boolean;
}

type RecorderAction =
	| { type: "start" }
	| { type: "live"; keys: string[] }
	| { type: "done"; combo: string | null };

const INITIAL_STATE: RecorderState = {
	key: null,
	liveKeys: [],
	recording: false,
};

function recorderReducer(
	state: RecorderState,
	action: RecorderAction,
): RecorderState {
	switch (action.type) {
		case "start":
			return { key: null, liveKeys: [], recording: true };
		case "live":
			return { ...state, liveKeys: action.keys };
		case "done":
			return {
				key: action.combo ?? state.key,
				liveKeys: [],
				recording: false,
			};
		default:
			return state;
	}
}

interface RecorderRefs {
	recordingRef: { current: boolean };
	onKeyRecordedRef: { current: ((key: string) => void) | undefined };
	onRecordingChangeRef: {
		current:
			| ((recording: boolean, committedCombo: string | null) => void)
			| undefined;
	};
	dispatch: Dispatch<RecorderAction>;
}

function finishRecording(refs: RecorderRefs, combo: string | null): void {
	refs.recordingRef.current = false;
	refs.dispatch({ type: "done", combo });
	if (combo) {
		refs.onKeyRecordedRef.current?.(combo);
	}
	refs.onRecordingChangeRef.current?.(false, combo);
}

function handleRecorderKeyDown(refs: RecorderRefs, event: KeyboardEvent): void {
	if (!refs.recordingRef.current) {
		return;
	}
	const key = keyNameFromEvent(event);
	if (!key) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	if (event.repeat) {
		return;
	}

	if (key === "Escape") {
		finishRecording(refs, null);
		return;
	}
	// The bitmask is authoritative for which modifiers are down; a modifier's
	// OWN keydown fires with its bit already set, so no manual merge is needed.
	const modifiers = heldModifiersFromEvent(event);
	if (isModifierToken(key)) {
		refs.dispatch({ type: "live", keys: sortKeys(modifiers) });
		return;
	}
	// Main key down → the chord is complete: commit immediately.
	finishRecording(refs, comboFromChord(modifiers, key));
}

function handleRecorderKeyUp(refs: RecorderRefs, event: KeyboardEvent): void {
	if (!refs.recordingRef.current) {
		return;
	}
	const key = keyNameFromEvent(event);
	if (!key) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	// Only the live modifier chips need updating — commits happen on keydown.
	// A released modifier's own keyup fires with its bit already cleared.
	refs.dispatch({
		type: "live",
		keys: sortKeys(heldModifiersFromEvent(event)),
	});
}

export function useKeyRecorder({
	onKeyRecorded,
	onRecordingChange,
}: UseKeyRecorderOptions = {}): UseKeyRecorderReturn {
	const [state, dispatch] = useReducer(recorderReducer, INITIAL_STATE);
	const recordingRef = useRef(false);
	const onKeyRecordedRef = useRef(onKeyRecorded);
	const onRecordingChangeRef = useRef(onRecordingChange);
	useEffect(() => {
		onKeyRecordedRef.current = onKeyRecorded;
		onRecordingChangeRef.current = onRecordingChange;
	}, [onKeyRecorded, onRecordingChange]);

	const refsRef = useRef<RecorderRefs>({
		recordingRef,
		onKeyRecordedRef,
		onRecordingChangeRef,
		dispatch,
	});

	const startRecording = () => {
		if (recordingRef.current) {
			return;
		}
		recordingRef.current = true;
		dispatch({ type: "start" });
		onRecordingChangeRef.current?.(true, null);
	};

	const stopRecording = () => {
		if (recordingRef.current) {
			finishRecording(refsRef.current, null);
		}
	};

	useEffect(() => {
		const refs = refsRef.current;
		const onKeyDown = (event: KeyboardEvent) =>
			handleRecorderKeyDown(refs, event);
		const onKeyUp = (event: KeyboardEvent) => handleRecorderKeyUp(refs, event);
		// Focus loss ends capture — a background window must not keep recording.
		const onBlur = () => {
			if (refs.recordingRef.current) {
				finishRecording(refs, null);
			}
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		window.addEventListener("keyup", onKeyUp, { capture: true });
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
			window.removeEventListener("keyup", onKeyUp, { capture: true });
			window.removeEventListener("blur", onBlur);
		};
	}, []);

	return {
		recording: state.recording,
		key: state.key,
		liveKeys: state.liveKeys,
		startRecording,
		stopRecording,
	};
}
