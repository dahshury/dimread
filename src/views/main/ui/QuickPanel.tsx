import { ArrowReloadHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import {
	ALL_MONITORS,
	BRIGHTNESS_STEP,
	brightnessRange,
	buildKelvinPatch,
	clampKelvin,
	defaultKelvinFor,
	type EditPhase,
	isAllMonitors,
	KELVIN_STEP,
	kelvinRange,
	type MonitorSelection,
	patchDayNightSettings,
	patchDisplaySettings,
	useDisplaySliders,
	useDisplayState,
	useMonitors,
} from "@/features/display";
import { IconButton } from "@/shared/ui/icon-button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Slider } from "@/shared/ui/slider";
import { useMainWindowFit } from "../model/use-main-window-fit";
import { DayNightRow } from "./quick/DayNightRow";
import { LiveReadout } from "./quick/LiveReadout";
import { ModeGrid } from "./quick/ModeGrid";
import { MonitorStrip } from "./quick/MonitorStrip";
import { QuickToggles } from "./quick/QuickToggles";

/**
 * The main window's entire content — a compact, single-column quick-control
 * panel (parity F1–F3).
 *
 * Scope is deliberate: this window holds ONLY the controls whose effect is
 * immediate and visible — the monitor selector, the live K/% readout, the
 * colour-temperature and brightness sliders, the eight preset modes, the auto
 * day/night switch and phase selector, and the Focus Blur / MagicX switches.
 * Every configuration surface (hotkeys, rules, per-feature numbers, schedules,
 * engine behaviour) lives in the settings window, reachable from the title-bar
 * gear. Keep it that way — controls that need explanation don't belong here.
 *
 * All state flows through the `display` / `dayNight` settings sections and the
 * `display_*` IPC seam: slider drags stream a live `display_preview`, releases
 * persist through `settings_save` and then refresh the engine, and the readout
 * follows the `display:state` broadcast.
 */
export function QuickPanel() {
	const t = useTranslations("displayTab");
	const display = useSettingsStore((s) => s.settings.display);
	const dayNight = useSettingsStore((s) => s.settings.dayNight);
	const monitors = useMonitors();
	const state = useDisplayState();
	const fitRef = useMainWindowFit();

	const mode = display.mode;
	const wideRange = display.wideRange;
	const brightnessWideRange = display.brightnessWideRange;

	// Which phase the sliders edit: the engine's live phase by default, or the
	// user's Day/Night override (which also previews that phase's values).
	const livePhase: EditPhase = state?.phase === "night" ? "night" : "day";
	const [phaseOverride, setPhaseOverride] = useState<EditPhase | null>(null);
	const effectivePhase = phaseOverride ?? livePhase;

	// Monitor-strip selection derived from `syncMonitors` (the source of truth for
	// "all vs one monitor") plus a local pointer to the last-chosen monitor, so the
	// strip stays consistent across window reopens. Falls back to the primary
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
		previewWhenIdle: phaseOverride !== null && phaseOverride !== livePhase,
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
	const handleToggleAutoDayNight = (enabled: boolean) =>
		runSettled(() => patchDayNightSettings({ enabled }));

	return (
		<section className="h-full">
			<ScrollArea
				className="h-full"
				rubberBandOnTouch
				verticalOnly
				viewportClassName="px-4 py-4"
			>
				<div className="flex flex-col gap-3" ref={fitRef}>
					{monitors.length > 1 ? (
						<MonitorStrip
							monitors={monitors}
							onSelect={(next) => void handleSelectMonitor(next)}
							selection={selection}
						/>
					) : null}

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
								icon={
									<HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} />
								}
								onClick={() => void handleResetTemperature()}
								tooltip={t("resetTemperature")}
							/>
						</div>
						<Slider
							aria-label={t("brightness")}
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
						<div aria-hidden="true" className="h-px bg-divider" />
						<DayNightRow
							enabled={dayNight.enabled}
							onPhaseChange={setPhaseOverride}
							onToggleEnabled={(enabled) =>
								void handleToggleAutoDayNight(enabled)
							}
							phase={effectivePhase}
						/>
					</div>

					<ModeGrid
						activeMode={mode}
						onSelect={(next) => void handleSelectMode(next)}
					/>

					<QuickToggles />
				</div>
			</ScrollArea>
		</section>
	);
}
