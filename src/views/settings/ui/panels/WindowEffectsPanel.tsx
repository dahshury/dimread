import { CenterFocusIcon, ComputerIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	patchFocusBlurSettings,
	useFocusBlurActive,
} from "@/features/focus-blur";
import {
	clampHeight,
	clampTransparency,
	HEIGHT_MAX,
	HEIGHT_MIN,
	HEIGHT_STEP,
	patchFocusReadSettings,
	TRANSPARENCY_MAX,
	TRANSPARENCY_MIN,
	useFocusReadActive,
} from "@/features/focus-read";
import { hasNativeRuntime } from "@/shared/api";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Slider } from "@/shared/ui/slider";
import { Toggle } from "@/shared/ui/toggle";
import { MagicWindowSection } from "./MagicWindowSection";

const PREVIEW_BUTTON =
	"h-9 min-w-[13rem] gap-1.5 rounded-lg bg-accent px-4 font-medium text-body text-on-accent shadow-elevated transition-colors hover:bg-accent-dim";

function handleFocusReadPreview(): void {
	if (!hasNativeRuntime()) {
		return;
	}
	void commands.focusReadToggle().catch(() => undefined);
}

/** Native colour picker wrapped as a small template-styled swatch. */
function ColorSwatch({
	value,
	onChange,
	ariaLabel,
}: {
	value: string;
	onChange: (color: string) => void;
	ariaLabel: string;
}) {
	return (
		<span className="relative inline-flex size-8 cursor-pointer overflow-hidden rounded-lg shadow-elevated ring-1 ring-divider">
			<span
				aria-hidden="true"
				className="absolute inset-0"
				style={{ backgroundColor: value }}
			/>
			<input
				aria-label={ariaLabel}
				className="absolute inset-0 cursor-pointer opacity-0"
				onChange={(event) => onChange(event.target.value)}
				type="color"
				value={value}
			/>
		</span>
	);
}

/**
 * Settings → Window effects: every overlay DimRead paints ON TOP of windows,
 * as opposed to the gamma ramp the Display tab configures.
 *
 * Three sections, in rising order of how much of the screen they touch: Focus
 * Read (a band), Focus Blur (everything but the active window), Magic Window
 * (one chosen window). The first two are FEATURE-PARITY F8.1–F8.2, mirroring the
 * CareUEyes Focus tab that groups them; {@link MagicWindowSection} (F9.1–F9.4)
 * joined them because it is the same KIND of thing — a per-window shade — and
 * six rows did not earn a rail entry of their own.
 *
 * Focus Read is the reading-ruler band — transparency, shade colour, band
 * height and a Preview button that arms the full-screen shade (ESC or a second
 * press quits). Focus Blur is the HazeOver-style dimmer — an enable switch that
 * reflects the running effect (`focus:state`) and drives it through
 * `focus_blur_toggle`, plus its taskbar / monitor / animation options.
 *
 * Each section persists through its own feature slice's settings saver, so the
 * live overlay shades pick up edits at once. The toggle SHORTCUTS for all three
 * effects live on the Hotkeys tab with every other binding — this tab owns the
 * effect options only.
 */
export function WindowEffectsPanel() {
	const t = useTranslations("focusTab");
	const focusRead = useSettingsStore((s) => s.settings.focusRead);
	const focusBlur = useSettingsStore((s) => s.settings.focusBlur);
	const readActive = useFocusReadActive();
	const blurActive = useFocusBlurActive();

	const handleBlurEnable = (next: boolean) => {
		// Persist the preference (for the boot auto-start) and drive the running
		// effect to match — `focus_blur_toggle` flips it, so only call it when the
		// desired state differs from what's already running.
		void patchFocusBlurSettings({ enabled: next });
		if (hasNativeRuntime() && next !== blurActive) {
			void commands.focusBlurToggle().catch(() => undefined);
		}
	};

	return (
		<div className="flex w-full flex-col">
			<SettingSection
				description={t("readCaption")}
				footer={
					<div className="flex flex-col items-center gap-2 pt-2">
						<Button className={PREVIEW_BUTTON} onClick={handleFocusReadPreview}>
							{readActive ? t("stopPreview") : t("preview")}
						</Button>
						<span className="text-2xs text-foreground-dim uppercase tracking-[0.08em]">
							{t("escHint")}
						</span>
					</div>
				}
				icon={CenterFocusIcon}
				title={t("subRead")}
			>
				<FormControl label={t("readTransparency")}>
					<Slider
						aria-label={t("readTransparencyAria")}
						formatValue={(v) =>
							t("readTransparencyValue", { percent: Math.round(v) })
						}
						max={TRANSPARENCY_MAX}
						min={TRANSPARENCY_MIN}
						onChange={(v) =>
							void patchFocusReadSettings({
								transparency: clampTransparency(v),
							})
						}
						step={1}
						value={focusRead.transparency}
					/>
				</FormControl>

				<FormControl
					label={t("readColor")}
					labelAddon={
						<ColorSwatch
							ariaLabel={t("readColor")}
							onChange={(color) => void patchFocusReadSettings({ color })}
							value={focusRead.color}
						/>
					}
					layout="row"
				/>

				<FormControl
					label={t("readHeight")}
					labelAddon={
						<NumberStepper
							ariaLabel={t("readHeight")}
							max={HEIGHT_MAX}
							min={HEIGHT_MIN}
							onChange={(v) =>
								void patchFocusReadSettings({ height: clampHeight(v) })
							}
							step={HEIGHT_STEP}
							value={focusRead.height}
						/>
					}
					layout="row"
				/>
			</SettingSection>

			<SettingSection
				description={t("blurCaption")}
				icon={ComputerIcon}
				title={t("subBlur")}
			>
				<FormControl
					label={t("blurEnable")}
					labelAddon={
						<Toggle
							aria-label={t("blurEnable")}
							checked={blurActive}
							onCheckedChange={handleBlurEnable}
						/>
					}
					layout="row"
					tooltip={t("adminHint")}
				/>

				<FormControl
					label={t("blurIncludeTaskbar")}
					labelAddon={
						<Toggle
							aria-label={t("blurIncludeTaskbar")}
							checked={focusBlur.includeTaskbar}
							onCheckedChange={(next) =>
								void patchFocusBlurSettings({ includeTaskbar: next })
							}
						/>
					}
					layout="row"
				/>

				<FormControl
					label={t("blurOnlyCurrentMonitor")}
					labelAddon={
						<Toggle
							aria-label={t("blurOnlyCurrentMonitor")}
							checked={focusBlur.onlyCurrentMonitor}
							onCheckedChange={(next) =>
								void patchFocusBlurSettings({ onlyCurrentMonitor: next })
							}
						/>
					}
					layout="row"
				/>

				<FormControl
					label={t("blurAnimate")}
					labelAddon={
						<Toggle
							aria-label={t("blurAnimate")}
							checked={focusBlur.animate}
							onCheckedChange={(next) =>
								void patchFocusBlurSettings({ animate: next })
							}
						/>
					}
					layout="row"
				/>

				<FormControl label={t("blurTransparency")}>
					<Slider
						aria-label={t("blurTransparencyAria")}
						formatValue={(v) =>
							t("blurTransparencyValue", { percent: Math.round(v) })
						}
						max={100}
						min={0}
						onChange={(v) =>
							void patchFocusBlurSettings({ transparency: Math.round(v) })
						}
						step={1}
						value={focusBlur.transparency}
					/>
				</FormControl>

				<FormControl
					label={t("blurColor")}
					labelAddon={
						<ColorSwatch
							ariaLabel={t("blurColor")}
							onChange={(color) => void patchFocusBlurSettings({ color })}
							value={focusBlur.color}
						/>
					}
					layout="row"
				/>
			</SettingSection>

			<MagicWindowSection />
		</div>
	);
}
