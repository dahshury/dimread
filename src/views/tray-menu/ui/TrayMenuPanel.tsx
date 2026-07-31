import { Cancel01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { useSettingsStore, useSettingsSync } from "@/entities/setting";
import {
	ALL_MONITORS,
	BRIGHTNESS_STEP,
	brightnessRange,
	type EditPhase,
	editPhaseFor,
	isRampingPhase,
	KELVIN_STEP,
	kelvinRange,
	patchDisplaySettings,
	useDisplaySliders,
	useDisplayState,
} from "@/features/display";
import { hasNativeRuntime } from "@/shared/api";
import { DISPLAY_MODES } from "@/shared/config/display-modes";
import { cn } from "@/shared/lib/cn";
import { Slider } from "@/shared/ui/slider";
import { useTrayMenuAutoSize } from "../model/use-tray-menu-auto-size";

/** Dismiss the flyout (a park off-screen in Rust, not a hide). */
function closeTrayMenu(): void {
	if (hasNativeRuntime()) {
		void commands.trayMenuHide().catch(() => undefined);
	}
}

/** Run a backend command, then dismiss — every row in the footer behaves this
 *  way, matching the native menu it replaced. */
function runAndClose(thunk: () => Promise<unknown>): void {
	if (hasNativeRuntime()) {
		void thunk().catch(() => undefined);
	}
	closeTrayMenu();
}

interface MenuRowProps {
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
	tone?: "danger" | "default";
}

/** One footer action row (Show / Settings / Quit). */
function MenuRow({ icon, label, onClick, tone = "default" }: MenuRowProps) {
	return (
		<button
			className={cn(
				"flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-body-sm transition-colors",
				tone === "danger"
					? "text-foreground-secondary hover:bg-danger-wash hover:text-danger"
					: "text-foreground-secondary hover:bg-surface-3 hover:text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			<HugeiconsIcon aria-hidden="true" icon={icon} size={15} />
			<span>{label}</span>
		</button>
	);
}

function Section({ children }: { children: ReactNode }) {
	return <div className="flex flex-col gap-2.5 px-3 py-2.5">{children}</div>;
}

function Divider() {
	return <div aria-hidden="true" className="h-px bg-divider" />;
}

/**
 * The tray flyout's contents — the whole reason the native tray menu was
 * replaced. A native `CheckMenuItem` roster could only offer brightness as ten
 * fixed quick-set rows; here the tray hosts the SAME gradient-variant `Slider`s
 * the main window uses, at 1 % precision with live preview.
 *
 * Everything writes through the ordinary display seam (`useDisplaySliders` →
 * `display_preview` while dragging, `settings_save` on release), so the tray,
 * the main window, and the hotkeys all share one persistence contract. Notably
 * that means dragging brightness while in `pause` redirects the edit into
 * `custom` (handled in `display/values.rs`) rather than persisting a value the
 * would never apply.
 *
 * The panel measures itself and asks Rust to size the OS window to match (see
 * {@link useTrayMenuAutoSize}), so the window is exactly the popup — there is no
 * transparent slack to swallow clicks.
 */
export function TrayMenuPanel() {
	const t = useTranslations("displayTab");
	const tTray = useTranslations("trayMenu");
	// This window has no RootLayout, so it mounts the settings bootstrap itself.
	useSettingsSync();
	const containerRef = useTrayMenuAutoSize();

	const display = useSettingsStore((s) => s.settings.display);
	const state = useDisplayState();

	const mode = display.mode;
	// The flyout always edits the LIVE phase and ALL monitors: it is the quick
	// surface, and per-phase / per-monitor targeting belongs to the full panel.
	// Mid-ramp "live" means the endpoint that dominates the screen, not day —
	// this surface has no phase selector, so a wrong guess here leaves the user
	// with a slider that moves and a screen that does not (see `editPhaseFor`).
	const phase: EditPhase = editPhaseFor(state);

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
		phase,
		rawEndpointPreview: isRampingPhase(state),
		selection: ALL_MONITORS,
	});

	const { max: kelvinMax, min: kelvinMin } = kelvinRange(display.wideRange);
	const { max: brightnessMax, min: brightnessMin } = brightnessRange(
		display.brightnessWideRange,
	);

	// Selecting a mode keeps the flyout OPEN — the point of a slider surface is
	// to try a mode and then tune it without reopening the popup.
	const handleSelectMode = (next: string) =>
		runSettled(() => patchDisplaySettings({ mode: next }));

	const activeMode =
		DISPLAY_MODES.find((entry) => entry.id === mode) ?? DISPLAY_MODES[0];
	const readingDegraded =
		mode === "reading" && state?.grayscaleApplied === false;

	return (
		// The 2px gutter + the outer rounding clip exist because the OS window is
		// sized to EXACTLY this element: an unclipped shadow would be cut square
		// at the corners.
		<div className="w-[288px] overflow-hidden rounded-[0.9rem] p-0.5">
			<div
				className="flex w-[284px] flex-col overflow-hidden rounded-xl bg-surface-1 shadow-elevated ring-1 ring-divider-strong"
				ref={containerRef}
			>
				{/* Live readout — what the engine is actually doing right now. */}
				<div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
					<span className="flex items-center gap-1.5 font-medium text-body-sm text-foreground">
						<HugeiconsIcon
							aria-hidden="true"
							className="text-accent"
							icon={activeMode.icon}
							size={15}
						/>
						{t(activeMode.nameKey)}
					</span>
					<span className="font-mono text-2xs text-foreground-muted tabular-nums">
						{state
							? t("currentReadout", {
									kelvin: state.kelvin,
									percent: state.brightness,
								})
							: null}
					</span>
				</div>

				<Section>
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
					<Slider
						aria-label={t("temperature")}
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
				</Section>

				<Divider />

				{/* Compact mode grid — the same eight presets as the Display tab. */}
				<div className="grid grid-cols-4 gap-1 px-3 py-2.5">
					{DISPLAY_MODES.map((entry) => {
						const isActive = entry.id === mode;
						return (
							<button
								aria-pressed={isActive}
								className={cn(
									"flex flex-col items-center justify-center gap-1 rounded-md border py-1.5 text-2xs transition-colors",
									isActive
										? "border-accent bg-accent-wash text-accent"
										: "border-transparent text-foreground-muted hover:bg-surface-3 hover:text-foreground",
								)}
								key={entry.id}
								onClick={() => void handleSelectMode(entry.id)}
								title={
									entry.id === "reading" && readingDegraded
										? t("modeReadingGrayscaleUnavailable")
										: t(entry.descKey)
								}
								type="button"
							>
								<HugeiconsIcon aria-hidden="true" icon={entry.icon} size={16} />
								<span className="font-medium">{t(entry.nameKey)}</span>
							</button>
						);
					})}
				</div>

				<Divider />

				{/* Two rows, not three: there is no separate main window to "Show"
				    any more — Settings IS the app window, and a plain LEFT click on
				    the tray icon already surfaces it. */}
				<div className="flex flex-col gap-0.5 p-1.5">
					<MenuRow
						icon={Settings01Icon}
						label={tTray("settings")}
						onClick={() => runAndClose(() => commands.openWindow("settings"))}
					/>
					<MenuRow
						icon={Cancel01Icon}
						label={tTray("quit")}
						onClick={() => runAndClose(() => commands.appQuit())}
						tone="danger"
					/>
				</div>
			</div>
		</div>
	);
}
