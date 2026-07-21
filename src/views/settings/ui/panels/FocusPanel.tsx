import {
	CenterFocusIcon,
	ComputerIcon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	patchFocusBlurHotkey,
	patchFocusBlurSettings,
	useFocusBlurActive,
} from "@/features/focus-blur";
import {
	clampHeight,
	clampTransparency,
	HEIGHT_MAX,
	HEIGHT_MIN,
	HEIGHT_STEP,
	patchFocusReadHotkey,
	patchFocusReadSettings,
	TRANSPARENCY_MAX,
	TRANSPARENCY_MIN,
	useFocusReadActive,
} from "@/features/focus-read";
import { collectOtherCombos, useHotkeyLabels } from "@/features/hotkey-actions";
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
import { hasNativeRuntime } from "@/shared/api";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Slider } from "@/shared/ui/slider";
import { Toggle } from "@/shared/ui/toggle";

const PREVIEW_BUTTON =
	"h-9 min-w-[13rem] gap-1.5 rounded-lg bg-accent px-4 font-medium text-body text-on-accent shadow-elevated transition-colors hover:bg-accent-dim";

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

/** Recorder + clear button pair used by both focus hotkey rows. */
function HotkeyField({
	clearLabel,
	forbiddenCombos,
	hotkeyId,
	onClear,
	onRecorded,
	value,
}: {
	clearLabel: string;
	forbiddenCombos: readonly ForbiddenCombo[];
	hotkeyId: "focusRead" | "focusBlur";
	onClear: () => void;
	onRecorded: (combo: string) => void;
	value: string;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<HotkeyRecorder
				currentKey={value}
				forbiddenCombos={forbiddenCombos}
				hotkeyId={hotkeyId}
				onKeyRecorded={onRecorded}
			/>
			{value.length > 0 ? (
				<IconButton
					aria-label={clearLabel}
					icon={<HugeiconsIcon icon={Delete02Icon} size={15} />}
					onClick={onClear}
					tooltip={clearLabel}
				/>
			) : null}
		</div>
	);
}

/**
 * Settings → Focus: both focus effects on one tab (FEATURE-PARITY F8.1–F8.2),
 * mirroring the CareUEyes Focus tab that groups them.
 *
 * Focus Read is the reading-ruler band — transparency, shade colour, band
 * height, a toggle hotkey and a Preview button that arms the full-screen shade
 * (ESC or a second press quits). Focus Blur is the HazeOver-style dimmer — an
 * enable switch that reflects the running effect (`focus:state`) and drives it
 * through `focus_blur_toggle`, plus its taskbar / monitor / animation options.
 *
 * Each section persists through its own feature slice's settings saver, so the
 * live overlay shades pick up edits at once; the hotkeys are captured with the
 * shared recorder and land in the `hotkeys` section.
 */
export function FocusPanel() {
	const t = useTranslations("focusTab");
	const tHotkeys = useTranslations("hotkeys");
	const focusRead = useSettingsStore((s) => s.settings.focusRead);
	const focusBlur = useSettingsStore((s) => s.settings.focusBlur);
	const hotkeys = useSettingsStore((s) => s.settings.hotkeys);
	const readHotkey = hotkeys.focusRead;
	const blurHotkey = hotkeys.focusBlur;
	const readActive = useFocusReadActive();
	const blurActive = useFocusBlurActive();

	// Full-roster conflict set (labels included) so a combo bound on ANY other
	// tab is rejected here with a named error instead of a raw backend message.
	const labels = useHotkeyLabels();
	const forbiddenFor = (id: "focusRead" | "focusBlur"): ForbiddenCombo[] =>
		collectOtherCombos(hotkeys, id).map((other) => ({
			combo: other.combo,
			label: labels[other.id],
		}));

	const handlePreview = () => {
		if (!hasNativeRuntime()) {
			return;
		}
		void commands.focusReadToggle().catch(() => undefined);
	};

	const handleBlurEnable = (next: boolean) => {
		// Persist the preference (for the boot auto-start) and drive the running
		// effect to match — `focus_blur_toggle` flips it, so only call it when the
		// desired state differs from what's already running.
		void patchFocusBlurSettings({ enabled: next });
		if (hasNativeRuntime() && next !== blurActive) {
			void commands.focusBlurToggle().catch(() => undefined);
		}
	};

	const clearReadHotkey = () => {
		if (hasNativeRuntime()) {
			void commands.hotkeyUnregister("focusRead").catch(() => undefined);
		}
		void patchFocusReadHotkey("");
	};

	const clearBlurHotkey = () => {
		if (hasNativeRuntime()) {
			void commands.hotkeyUnregister("focusBlur").catch(() => undefined);
		}
		void patchFocusBlurHotkey("");
	};

	return (
		<div className="mx-auto flex max-w-[520px] flex-col">
			<SettingSection
				description={t("readCaption")}
				divided
				footer={
					<div className="flex flex-col items-center gap-2 pt-2">
						<Button className={PREVIEW_BUTTON} onClick={handlePreview}>
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
						aria-label={t("readTransparency")}
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

				<FormControl
					label={t("readHotkey")}
					labelAddon={
						<HotkeyField
							clearLabel={tHotkeys("clear")}
							forbiddenCombos={forbiddenFor("focusRead")}
							hotkeyId="focusRead"
							onClear={clearReadHotkey}
							onRecorded={(combo) => void patchFocusReadHotkey(combo)}
							value={readHotkey}
						/>
					}
					layout="row"
				/>
			</SettingSection>

			<SettingSection
				description={t("blurCaption")}
				divided
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
						aria-label={t("blurTransparency")}
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

				<FormControl
					label={t("blurHotkey")}
					labelAddon={
						<HotkeyField
							clearLabel={tHotkeys("clear")}
							forbiddenCombos={forbiddenFor("focusBlur")}
							hotkeyId="focusBlur"
							onClear={clearBlurHotkey}
							onRecorded={(combo) => void patchFocusBlurHotkey(combo)}
							value={blurHotkey}
						/>
					}
					layout="row"
				/>
			</SettingSection>
		</div>
	);
}
