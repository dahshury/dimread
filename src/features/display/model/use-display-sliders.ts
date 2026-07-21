import { useEffect, useRef, useState } from "react";
import type { DisplaySettings } from "@/bindings";
import {
	broadcastDisplayEdit,
	createEditOrigin,
	type DisplayEditValue,
	editTargetsSurface,
	subscribeDisplayEdit,
} from "./display-edit-channel";
import {
	clampBrightness,
	clampKelvin,
	type EditPhase,
	type MonitorSelection,
	previewMonitorId,
	readTargetValues,
} from "./display-values";
import { commitDisplayValue } from "./persist-display";
import { endDisplayPreview, previewDisplay } from "./preview";

/**
 * The colour-temperature / brightness drag cycle, shared by every surface that
 * hosts the display sliders — the main window's Display tab (`views/main`) and
 * the tray flyout (`widgets/tray-menu`).
 *
 * The cycle is the load-bearing part and easy to get subtly wrong, which is why
 * it lives here rather than being written twice:
 *
 *  1. **While dragging** the value is local state and streams to the engine via
 *     `display_preview` (rAF-throttled) — NOT persisted. Persisting per frame
 *     would mean a disk write and a whole-tree `settings:changed` broadcast on
 *     every pointer move.
 *  2. **On release** it persists through `display_set_value`, which takes the
 *     EDIT — axis, phase, monitor, value — rather than a copy of the settings
 *     tree, and performs the read-modify-write in Rust under the settings write
 *     lock. This is what stops two surfaces from overwriting each other: a
 *     window whose store has drifted can only ever change the field it names.
 *     The local override is then dropped so the store's value takes over.
 *  3. **When the preview stops** `display_preview_end` reverts the engine to
 *     its settings-driven output — which also doubles as "re-apply settings",
 *     so non-slider mutations need it too when no drag was in flight (see
 *     {@link DisplaySliderControls.runSettled}).
 *
 * A preview left running past unmount would pin the screen at the dragged
 * value, so the effect cleans up on teardown as well.
 *
 * Because step 1 skips persistence, `settings:changed` — the channel the other
 * windows converge on — says nothing for the whole duration of a drag, so the
 * two surfaces would visibly drift apart while one is being held. A drag is
 * therefore ALSO broadcast on its own renderer-to-renderer channel and mirrored
 * by any surface showing the same target (see `display-edit-channel`).
 * Mirroring is display-only: the surface that owns the drag remains the only
 * one driving `display_preview`.
 */

export interface UseDisplaySlidersOptions {
	/** The `display` settings section (the store's live value). */
	display: DisplaySettings;
	/** The mode whose preset the sliders read/write. */
	mode: string;
	/** Which day/night phase the edit lands on. */
	phase: EditPhase;
	/**
	 * Keep the preview live even when no drag is in flight. The Display tab
	 * sets this while showing the OFF-phase's values, so the screen previews
	 * what night (or day) will look like.
	 */
	previewWhenIdle?: boolean;
	/** All monitors, or one specific monitor's override. */
	selection: MonitorSelection;
}

export interface DisplaySliderControls {
	/** Brightness to render: the drag value if dragging, else the stored one. */
	brightness: number;
	/** Persist the released brightness (clamped to the active range). */
	commitBrightness: (value: number) => Promise<void>;
	/** Persist the released Kelvin (clamped to the active range). */
	commitKelvin: (value: number) => Promise<void>;
	/** Live brightness while dragging — streams to the engine, does not persist. */
	dragBrightness: (value: number) => void;
	/** Live Kelvin while dragging — streams to the engine, does not persist. */
	dragKelvin: (value: number) => void;
	/** Kelvin to render: the drag value if dragging, else the stored one. */
	kelvin: number;
	/**
	 * Run a NON-slider display mutation (mode switch, monitor switch, a day/night
	 * edit) and make sure the engine ends up re-applied. When a preview is
	 * already live the drag cycle owns the teardown; otherwise this ends the
	 * preview itself, which is what forces the engine to pick up the new value.
	 */
	runSettled: (mutate: () => Promise<void>) => Promise<void>;
}

export function useDisplaySliders({
	display,
	mode,
	phase,
	previewWhenIdle = false,
	selection,
}: UseDisplaySlidersOptions): DisplaySliderControls {
	const { brightnessWideRange, wideRange } = display;

	// Only the dragged axis is held here (`null` = not part of the drag). The
	// other axis must NOT be carried along: its stored endpoint can diverge from
	// what the engine is actually applying (day/night interpolation mid-
	// transition, per-monitor overrides, a rules-forced mode), and previewing it
	// would visibly snap the screen — brightness jumping to the stored 100 %
	// for the whole duration of a colour-temperature drag.
	const [drag, setDrag] = useState<{
		brightness: number | null;
		kelvin: number | null;
	} | null>(null);

	// Another surface's in-flight drag (the tray flyout and the Display tab show
	// the same sliders). Display-only: the surface that owns the drag is the one
	// driving `display_preview`, so mirroring never touches the engine.
	const [remote, setRemote] = useState<DisplayEditValue | null>(null);
	// Lazy `useState`, not a ref written during render: the id must be created
	// once per surface, and a render-phase mutation is unsafe under concurrent
	// rendering.
	const [origin] = useState(createEditOrigin);

	const target = readTargetValues(display, mode, selection, phase);
	const previewId = previewMonitorId(selection);
	// Per-axis: local drag wins over a remote one (the surface the user is
	// actually holding must never lag behind a round trip through the event
	// bus), and an axis a drag does not carry (`null`) falls through to the
	// stored value.
	const kelvin = drag?.kelvin ?? remote?.kelvin ?? target.kelvin;
	const brightness =
		drag?.brightness ?? remote?.brightness ?? target.brightness;

	useEffect(() => {
		const surface = { mode, monitorId: previewId, phase };
		return subscribeDisplayEdit((payload) => {
			if (payload.origin === origin) {
				return;
			}
			// A drag on a target this surface is not showing (the other phase, a
			// different monitor) means something different here, so it is ignored
			// rather than mirrored.
			setRemote(editTargetsSurface(payload, surface) ? payload.value : null);
		});
	}, [mode, origin, phase, previewId]);

	/** Announce a drag (or its end, with `null`) to the other surfaces. */
	const publish = (value: DisplayEditValue | null): void => {
		broadcastDisplayEdit({
			mode,
			monitorId: previewId,
			origin,
			phase,
			value,
		});
	};

	const previewActive = drag !== null || previewWhenIdle;
	const startedRef = useRef(false);

	// What the engine is asked to preview. An idle (off-phase) preview must show
	// the full stored pair; a plain drag streams ONLY its own axis and leaves the
	// other at whatever each monitor currently has applied — the stored value for
	// the untouched axis may not be what is on screen, and previewing it would
	// snap the display (see the `drag` comment above).
	const previewKelvin = previewWhenIdle ? kelvin : (drag?.kelvin ?? null);
	const previewBrightness = previewWhenIdle
		? brightness
		: (drag?.brightness ?? null);

	useEffect(() => {
		if (previewActive) {
			startedRef.current = true;
			previewDisplay(previewKelvin, previewBrightness, previewId);
		} else if (startedRef.current) {
			startedRef.current = false;
			endDisplayPreview();
		}
	}, [previewActive, previewKelvin, previewBrightness, previewId]);

	// A preview outliving the surface would pin the screen at the dragged value,
	// and a drag left un-ended would strand the other surfaces on a stale mirror.
	// Assigned in an effect, never during render: a render-phase ref write is
	// unsafe under concurrent rendering.
	const publishRef = useRef(publish);
	useEffect(() => {
		publishRef.current = publish;
	});
	useEffect(
		() => () => {
			if (startedRef.current) {
				endDisplayPreview();
				publishRef.current(null);
			}
		},
		[],
	);

	const commit = async (
		axis: "brightness" | "kelvin",
		value: number,
	): Promise<void> => {
		// Send the EDIT, never a copy of the settings tree. The backend performs
		// the read-modify-write under its own lock, so this surface cannot
		// overwrite a field it did not touch even if its store has drifted.
		await commitDisplayValue({
			axis,
			monitorId: previewMonitorId(selection),
			phase,
			value,
		});
		setDrag(null);
		// The saved value reaches every window through `settings:changed`;
		// release the other surfaces from the drag mirror.
		publish(null);
	};

	/** Set the local drag AND mirror it onto the other surfaces. */
	const startDrag = (next: DisplayEditValue): void => {
		setDrag(next);
		publish(next);
	};

	return {
		brightness,
		kelvin,
		dragKelvin: (next) =>
			startDrag({
				kelvin: clampKelvin(next, wideRange),
				brightness: null,
			}),
		dragBrightness: (next) =>
			startDrag({
				kelvin: null,
				brightness: clampBrightness(next, brightnessWideRange),
			}),
		commitKelvin: (next) => commit("kelvin", clampKelvin(next, wideRange)),
		commitBrightness: (next) =>
			commit("brightness", clampBrightness(next, brightnessWideRange)),
		runSettled: async (mutate) => {
			const hadPreview = previewActive;
			await mutate();
			if (!hadPreview) {
				endDisplayPreview();
			}
		},
	};
}
