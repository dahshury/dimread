import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { commands, type HotkeysSettings } from "@/bindings";
import { useSettingsStore } from "@/entities/setting";
import { collectOtherCombos, useHotkeyLabels } from "@/features/hotkey-actions";
import {
	clampDelay,
	clampOffset,
	DEFAULT_TOOLBAR_COLOR,
	patchMagicxHotkeys,
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
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
import { hasNativeRuntime } from "@/shared/api";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Slider } from "@/shared/ui/slider";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { ToolbarColorField } from "./ToolbarColorField";

/** MagicX per-window hotkey rows shown here (their `settings.hotkeys` fields). */
type MagicHotkeyId = "magicDark" | "magicGray";

/** Bind a MagicX hotkey row to a combo (module scope: closes over nothing local). */
function commitHotkey(id: MagicHotkeyId, combo: string): void {
	void patchMagicxHotkeys({ [id]: combo.trim() } as Partial<HotkeysSettings>);
}

/** Clear a MagicX hotkey row (disarm live + persist ""). */
function clearHotkey(id: MagicHotkeyId): void {
	if (hasNativeRuntime()) {
		void commands.hotkeyUnregister(id).catch(() => undefined);
	}
	void patchMagicxHotkeys({ [id]: "" } as Partial<HotkeysSettings>);
}

/**
 * Magic Window section (FEATURE-PARITY F9.1-F9.4). The controls mirror the
 * CareUEyes "Magic Window" options: enable MagicX, show the hover toolbar, the
 * toolbar colour / alignment / offset / hover-delay, and the per-window Dark /
 * Gray hotkeys. Edits persist through the MagicX slice's shared, revision-checked
 * saver (`@/features/magicx`).
 */
export function MagicWindowPanel() {
	const t = useTranslations("magicxTab");
	const tHotkeys = useTranslations("hotkeys");
	const magicx = useSettingsStore((s) => s.settings.magicx);
	const hotkeys = useSettingsStore((s) => s.settings.hotkeys);

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

	const hotkeyLabels = useHotkeyLabels();

	// Full-roster conflict set (labels included) so a combo bound on ANY other
	// tab is rejected here with a named error instead of a raw backend message.
	const forbiddenFor = (id: MagicHotkeyId): ForbiddenCombo[] =>
		collectOtherCombos(hotkeys, id).map((other) => ({
			combo: other.combo,
			label: hotkeyLabels[other.id],
		}));

	return (
		<div className="mx-auto max-w-[560px]">
			<div className="flex flex-col divide-y divide-divider">
				<FormControl
					label={t("enable")}
					labelAddon={
						<Toggle
							aria-label={t("enable")}
							checked={magicx.enabled}
							onCheckedChange={(enabled) =>
								void patchMagicxSettings({ enabled })
							}
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

				{(["magicDark", "magicGray"] as const).map((id) => {
					const current = hotkeys[id];
					return (
						<FormControl
							key={id}
							label={id === "magicDark" ? t("hotkeyDark") : t("hotkeyGray")}
							labelAddon={
								<div className="flex items-center gap-1.5">
									<HotkeyRecorder
										currentKey={current}
										forbiddenCombos={forbiddenFor(id)}
										hotkeyId={id}
										onKeyRecorded={(combo) => commitHotkey(id, combo)}
									/>
									{current.length > 0 ? (
										<IconButton
											aria-label={tHotkeys("clear")}
											icon={<HugeiconsIcon icon={Delete02Icon} size={15} />}
											onClick={() => clearHotkey(id)}
											tooltip={tHotkeys("clear")}
										/>
									) : null}
								</div>
							}
							layout="row"
						/>
					);
				})}
			</div>
		</div>
	);
}
