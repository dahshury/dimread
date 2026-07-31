import { ArrowReloadHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import {
	ALL_MONITORS,
	BRIGHTNESS_STEP,
	brightnessRange,
	buildBrightnessPatch,
	buildKelvinPatch,
	buildMonitorEnabledPatch,
	buildMonitorInheritPatch,
	clampBrightness,
	clampKelvin,
	defaultBrightnessFor,
	defaultKelvinFor,
	type EditPhase,
	editPhaseFor,
	isAllMonitors,
	isRampingPhase,
	KELVIN_STEP,
	kelvinRange,
	type MonitorSelection,
	patchDayNightSettings,
	patchDisplaySettings,
	useDisplaySliders,
	useDisplayState,
	useMonitorTopology,
} from "@/features/display";
import { IconButton } from "@/shared/ui/icon-button";
import { Slider } from "@/shared/ui/slider";
import { DayNightRow } from "./DayNightRow";
import { LiveReadout } from "./LiveReadout";
import { ModeGrid } from "./ModeGrid";
import { MonitorTargets } from "./MonitorTargets";

/**
 * The live display controls (parity F1–F3): the monitor selector, the engine's
 * K/% readout, the colour-temperature and brightness sliders, the auto
 * day/night switch with its Day|Night phase selector, and the eight preset
 * modes.
 *
 * These used to be the whole of a separate "main" window. That window is gone —
 * DimRead is a tray app with ONE visible surface — so this block now sits at the
 * top of Settings → Display, above the engine's behavioural switches. Keep it a
 * widget rather than folding it into that panel: the tray flyout renders the
 * same controls from the same `features/display` seam, and this is the block a
 * future compact surface would reuse verbatim.
 *
 * All state flows through the `display` / `dayNight` settings sections and the
 * `display_*` IPC seam: slider drags stream a live `display_preview`, releases
 * persist through `settings_save` and then refresh the engine, and the readout
 * follows the `display:state` broadcast. That is what keeps this panel, the tray
 * flyout and the global hotkeys in sync with one persistence contract.
 */
export function QuickControls() {
	const t = useTranslations("displayTab");
	const display = useSettingsStore((s) => s.settings.display);
	const dayNight = useSettingsStore((s) => s.settings.dayNight);
	const { monitors } = useMonitorTopology();
	const state = useDisplayState();

	const mode = display.mode;
	const wideRange = display.wideRange;
	const brightnessWideRange = display.brightnessWideRange;

	// Which phase the sliders edit: the endpoint that dominates the engine's live
	// output by default, or the user's Day/Night override (which also previews
	// that phase's values). `transition` is NOT an editable endpoint, and it is
	// not "day" either — see `editPhaseFor`.
	const livePhase: EditPhase = editPhaseFor(state);
	const [phaseOverride, setPhaseOverride] = useState<EditPhase | null>(null);
	// Mid-ramp the schedule owns neither endpoint outright, so the user is
	// allowed to say which profile they are authoring even with auto on. Once the
	// ramp settles the schedule owns the phase again and a leftover override is
	// simply ignored — derived, so nothing has to remember to clear it.
	const ramping = isRampingPhase(state);
	const canChoosePhase = !dayNight.enabled || ramping;
	const effectivePhase = canChoosePhase
		? (phaseOverride ?? livePhase)
		: livePhase;
	// Only an explicit Day/Night choice requests an idle endpoint preview.
	// Merely opening this tab midway through a ramp must not snap to (and pin)
	// whichever endpoint the segmented control happens to display.
	const previewSelectedEndpoint = canChoosePhase && phaseOverride !== null;

	// Monitor-roster selection derived from `syncMonitors` (the source of truth for
	// "all vs one monitor") plus a local pointer to the last-chosen monitor, so the
	// roster stays consistent across window reopens. Falls back to the primary
	// monitor when the stored pointer is empty or points at an unplugged display.
	const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(
		null,
	);
	const fallbackMonitorId =
		(monitors.find((m) => m.isPrimary) ?? monitors[0])?.id ?? ALL_MONITORS;
	const specificMonitorId =
		selectedMonitorId && monitors.some((m) => m.id === selectedMonitorId)
			? selectedMonitorId
			: fallbackMonitorId;
	const selection: MonitorSelection = display.syncMonitors
		? ALL_MONITORS
		: specificMonitorId;

	const { max: kelvinMax, min: kelvinMin } = kelvinRange(wideRange);
	const { max: brightnessMax, min: brightnessMin } =
		brightnessRange(brightnessWideRange);

	// The drag/preview/commit cycle (shared with the tray flyout). This panel
	// additionally keeps the preview live while showing the OFF phase's values,
	// so the screen previews what that phase will look like.
	const {
		brightness,
		commitBrightness,
		commitKelvin,
		dragBrightness,
		dragKelvin,
		kelvin,
		runSettled,
	} = useDisplaySliders({
		display,
		mode,
		phase: effectivePhase,
		previewWhenIdle: previewSelectedEndpoint,
		// Mid-ramp a blended drag preview compresses the slider's travel into a
		// fraction of the screen's range; show the endpoint being authored.
		rawEndpointPreview: ramping,
		selection,
	});

	const handleResetTemperature = () =>
		runSettled(() =>
			patchDisplaySettings(
				buildKelvinPatch(
					display,
					mode,
					selection,
					effectivePhase,
					clampKelvin(
						defaultKelvinFor(mode, selection, effectivePhase),
						wideRange,
					),
				),
			),
		);
	const handleResetBrightness = () =>
		runSettled(() =>
			patchDisplaySettings(
				buildBrightnessPatch(
					display,
					mode,
					selection,
					effectivePhase,
					clampBrightness(
						defaultBrightnessFor(mode, selection, effectivePhase),
						brightnessWideRange,
					),
				),
			),
		);

	// --- mode / monitor / day-night handlers ---
	const handleSelectMode = (nextMode: string) =>
		runSettled(() => patchDisplaySettings({ mode: nextMode }));
	const handleSelectMonitor = (next: MonitorSelection) => {
		if (!isAllMonitors(next)) {
			setSelectedMonitorId(next);
		}
		return runSettled(() =>
			patchDisplaySettings({ syncMonitors: isAllMonitors(next) }),
		);
	};
	const handleToggleAutoDayNight = (enabled: boolean) => {
		if (enabled) {
			setPhaseOverride(null);
		}
		return runSettled(() => patchDayNightSettings({ enabled }));
	};
	// Opting a monitor out while it is the slider target would leave the sliders
	// editing an override the engine no longer applies — a control that looks
	// live and does nothing. Hand the target back to "all monitors" in the same
	// patch, so the two settings can never disagree.
	const handleSetMonitorEnabled = (monitorId: string, enabled: boolean) => {
		const retarget = !enabled && selection === monitorId;
		return runSettled(() =>
			patchDisplaySettings({
				...buildMonitorEnabledPatch(display, monitorId, enabled),
				...(retarget ? { syncMonitors: true } : {}),
			}),
		);
	};
	const handleUseModeValues = (monitorId: string) =>
		runSettled(() =>
			patchDisplaySettings(buildMonitorInheritPatch(display, monitorId)),
		);

	return (
		<div className="flex flex-col gap-3">
			<MonitorTargets
				excluded={display.excludedMonitors}
				monitors={monitors}
				onSelect={(next) => void handleSelectMonitor(next)}
				onSetEnabled={(id, enabled) =>
					void handleSetMonitorEnabled(id, enabled)
				}
				onUseModeValues={(id) => void handleUseModeValues(id)}
				overridden={Object.keys(display.monitorOverrides)}
				selection={selection}
			/>

			<div className="flex flex-col gap-4 rounded-xl border border-divider bg-surface-2 p-4 shadow-elevated">
				<div className="flex justify-center">
					<LiveReadout state={state} />
				</div>
				<div className="flex items-center gap-1.5">
					<Slider
						aria-label={t("temperature")}
						className="min-w-0 flex-1"
						endLabel={t("cool")}
						formatValue={(v) => t("kelvinValue", { kelvin: Math.round(v) })}
						label={t("warm")}
						max={kelvinMax}
						min={kelvinMin}
						onChange={dragKelvin}
						onCommit={(value) => void commitKelvin(value)}
						step={KELVIN_STEP}
						value={kelvin}
						variant="temperature"
					/>
					<IconButton
						aria-label={t("resetTemperature")}
						className="shrink-0"
						icon={<HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} />}
						onClick={() => void handleResetTemperature()}
						tooltip={t("resetTemperature")}
					/>
				</div>
				<div className="flex items-center gap-1.5">
					<Slider
						aria-label={t("brightness")}
						className="min-w-0 flex-1"
						endLabel={t("brighter")}
						formatValue={(v) => t("percentValue", { percent: Math.round(v) })}
						label={t("dimmer")}
						max={brightnessMax}
						min={brightnessMin}
						onChange={dragBrightness}
						onCommit={(value) => void commitBrightness(value)}
						step={BRIGHTNESS_STEP}
						value={brightness}
						variant="brightness"
					/>
					<IconButton
						aria-label={t("resetBrightness")}
						className="shrink-0"
						icon={<HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} />}
						onClick={() => void handleResetBrightness()}
						tooltip={t("resetBrightness")}
					/>
				</div>
				<div aria-hidden="true" className="h-px bg-divider" />
				<DayNightRow
					canChoosePhase={canChoosePhase}
					enabled={dayNight.enabled}
					onPhaseChange={setPhaseOverride}
					onToggleEnabled={(enabled) => void handleToggleAutoDayNight(enabled)}
					phase={effectivePhase}
					ramping={ramping}
				/>
			</div>

			<ModeGrid
				activeMode={mode}
				grayscaleApplied={state?.grayscaleApplied}
				onSelect={(next) => void handleSelectMode(next)}
			/>
		</div>
	);
}
