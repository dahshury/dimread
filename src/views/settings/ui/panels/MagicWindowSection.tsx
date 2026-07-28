import { MagicWand01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	clampDelay,
	clampOffset,
	DEFAULT_TOOLBAR_COLOR,
	patchMagicxSettings,
	safeToolbarColor,
	TOOLBAR_DELAY_MAX,
	TOOLBAR_DELAY_MIN,
	TOOLBAR_DELAY_STEP,
	TOOLBAR_OFFSET_MAX,
	TOOLBAR_OFFSET_MIN,
	TOOLBAR_OFFSET_STEP,
	type ToolbarAlignment,
} from "@/features/magicx";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { ToolbarColorField } from "./ToolbarColorField";

/**
 * Magic Window section of Settings → Window effects (FEATURE-PARITY F9.1-F9.4).
 * The controls mirror the CareUEyes "Magic Window" options: enable MagicX, show
 * the hover toolbar, and the toolbar colour / alignment / offset / hover-delay.
 * Edits persist through the MagicX slice's shared, revision-checked saver
 * (`@/features/magicx`).
 *
 * It sits with the two Focus effects rather than on a rail entry of its own: all
 * three shade or recolour WINDOWS through an overlay, as opposed to the gamma
 * ramp the Display tab configures — and six rows did not earn their own tab next
 * to them.
 *
 * The per-window Dark / Gray SHORTCUTS are bound on the Hotkeys tab, which owns
 * every global binding.
 */
export function MagicWindowSection() {
	const t = useTranslations("magicxTab");
	const magicx = useSettingsStore((s) => s.settings.magicx);

	// The toolbar options are meaningless while MagicX or the toolbar is off.
	const toolbarDisabled = !(magicx.enabled && magicx.toolbarEnabled);

	// The offset slider streams continuously; keep the drag value local and
	// persist on a trailing debounce (a drag shouldn't fan out a save per frame).
	// `null` = not dragging, so the persisted store value shows through — no
	// prop-mirroring effect (which would cascade renders).
	const [dragOffset, setDragOffset] = useState<number | null>(null);
	const offsetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (offsetTimer.current) {
				clearTimeout(offsetTimer.current);
			}
		},
		[],
	);
	const displayedOffset = dragOffset ?? magicx.toolbarOffset;
	const handleOffsetChange = (value: number) => {
		const next = clampOffset(value);
		setDragOffset(next);
		if (offsetTimer.current) {
			clearTimeout(offsetTimer.current);
		}
		offsetTimer.current = setTimeout(() => {
			void patchMagicxSettings({ toolbarOffset: next });
			setDragOffset(null);
		}, 150);
	};

	const alignOptions: SwitcherOption<ToolbarAlignment>[] = [
		{ value: "center", label: t("alignCenter") },
		{ value: "left", label: t("alignLeft") },
		{ value: "right", label: t("alignRight") },
	];

	return (
		<SettingSection
			description={t("magicWindowCaption")}
			divided
			icon={MagicWand01Icon}
			title={t("subMagicWindow")}
		>
			<FormControl
				label={t("enable")}
				labelAddon={
					<Toggle
						aria-label={t("enable")}
						checked={magicx.enabled}
						onCheckedChange={(enabled) => void patchMagicxSettings({ enabled })}
					/>
				}
				layout="row"
			/>

			<FormControl
				caption={t("toolbarCaption")}
				disabled={!magicx.enabled}
				label={t("toolbarEnable")}
				labelAddon={
					<Toggle
						aria-label={t("toolbarEnable")}
						checked={magicx.toolbarEnabled}
						disabled={!magicx.enabled}
						onCheckedChange={(toolbarEnabled) =>
							void patchMagicxSettings({ toolbarEnabled })
						}
					/>
				}
				layout="row"
			/>

			<FormControl
				disabled={toolbarDisabled}
				label={t("toolbarColor")}
				labelAddon={
					<ToolbarColorField
						colorLabel={t("toolbarColor")}
						disabled={toolbarDisabled}
						onChange={(color) =>
							void patchMagicxSettings({ toolbarColor: color })
						}
						onReset={() =>
							void patchMagicxSettings({
								toolbarColor: DEFAULT_TOOLBAR_COLOR,
							})
						}
						resetLabel={t("colorReset")}
						value={safeToolbarColor(magicx.toolbarColor)}
					/>
				}
				layout="row"
			/>

			<FormControl
				disabled={toolbarDisabled}
				label={t("toolbarAlign")}
				labelAddon={
					<Switcher<ToolbarAlignment>
						onChange={(align) =>
							void patchMagicxSettings({ toolbarAlign: align })
						}
						options={alignOptions}
						size="sm"
						value={magicx.toolbarAlign as ToolbarAlignment}
					/>
				}
				layout="row"
			/>

			<FormControl disabled={toolbarDisabled} label={t("toolbarOffset")}>
				<Slider
					aria-label={t("toolbarOffset")}
					disabled={toolbarDisabled}
					formatValue={(value) => t("offsetValue", { value })}
					max={TOOLBAR_OFFSET_MAX}
					min={TOOLBAR_OFFSET_MIN}
					onChange={handleOffsetChange}
					step={TOOLBAR_OFFSET_STEP}
					value={displayedOffset}
				/>
			</FormControl>

			<FormControl
				disabled={toolbarDisabled}
				label={t("toolbarDelay")}
				labelAddon={
					<div className="flex items-center gap-2">
						<NumberStepper
							disabled={toolbarDisabled}
							max={TOOLBAR_DELAY_MAX}
							min={TOOLBAR_DELAY_MIN}
							onChange={(value) =>
								void patchMagicxSettings({
									toolbarDelayMs: clampDelay(value),
								})
							}
							step={TOOLBAR_DELAY_STEP}
							value={magicx.toolbarDelayMs}
						/>
						<span className="text-body-sm text-foreground-muted">
							{t("delayUnit")}
						</span>
					</div>
				}
				layout="row"
			/>
		</SettingSection>
	);
}
