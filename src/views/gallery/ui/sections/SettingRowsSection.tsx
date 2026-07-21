import { useState } from "react";
import { useTranslations } from "use-intl";
import { Kbd, KbdCombo } from "@/shared/ui/kbd";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SettingField } from "@/shared/ui/setting-field";
import { Slider } from "@/shared/ui/slider";
import { TextField } from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import { DemoRow, GallerySection } from "../GallerySection";

const VOLUME_DEFAULT = 80;
const PORT_MIN = 1;
const PORT_MAX = 65_535;

/** SettingField with a live reset affordance driven by value drift. */
function ResetRowDemo() {
	const t = useTranslations("settingsField");
	const [volume, setVolume] = useState(VOLUME_DEFAULT);
	return (
		<SettingField
			caption={t("demoVolumeCaption")}
			defaultValue={VOLUME_DEFAULT}
			label={t("demoVolume")}
			onReset={() => setVolume(VOLUME_DEFAULT)}
			tooltip={t("demoVolumeTooltip")}
			value={volume}
		>
			<Slider
				aria-label={t("demoVolume")}
				max={100}
				min={0}
				onChange={setVolume}
				step={1}
				value={volume}
			/>
		</SettingField>
	);
}

/** Parent toggle + child row gated behind it with a disabled reason. */
function GatedRowsDemo() {
	const t = useTranslations("settingsField");
	const [enabled, setEnabled] = useState(false);
	const [count, setCount] = useState(2);
	return (
		<>
			<SettingField
				caption={t("demoNotifyCaption")}
				label={t("demoNotify")}
				labelAddon={
					<Toggle
						aria-label={t("demoNotify")}
						checked={enabled}
						onCheckedChange={setEnabled}
					/>
				}
				layout="row"
			/>
			<SettingField
				caption={t("demoChildCaption")}
				disabled={!enabled}
				disabledReason={t("demoNotify")}
				label={t("demoChild")}
				layout="row"
			>
				<NumberStepper max={5} min={1} onChange={setCount} value={count} />
			</SettingField>
		</>
	);
}

/** Inline validation error via the error token. */
function ErrorRowDemo() {
	const t = useTranslations("settingsField");
	const [port, setPort] = useState("70000");
	const numeric = Number(port);
	const invalid =
		!Number.isInteger(numeric) || numeric < PORT_MIN || numeric > PORT_MAX;
	return (
		<SettingField
			caption={t("demoErrorCaption")}
			error={invalid ? t("demoErrorMessage") : undefined}
			label={t("demoErrorLabel")}
		>
			<TextField
				aria-label={t("demoErrorLabel")}
				onChange={(event) => setPort(event.target.value)}
				value={port}
			/>
		</SettingField>
	);
}

const ESCAPE_LABEL = "Esc";

/** Key-combo chips (WinSTT's shortcuts-legend keycaps) in a setting row. */
function ShortcutRowDemo() {
	const t = useTranslations("settingsField");
	return (
		<SettingField
			caption={t("demoShortcutCaption")}
			label={t("demoShortcut")}
			layout="row"
		>
			<span className="flex items-center gap-3">
				<KbdCombo emphasizedIndex={2} keys={["Ctrl", "Shift", "Space"]} />
				<Kbd>{ESCAPE_LABEL}</Kbd>
			</span>
		</SettingField>
	);
}

export function SettingRowsSection() {
	const t = useTranslations("settingsField");
	return (
		<GallerySection
			description={t("sectionDescription")}
			id="settingRows"
			title={t("sectionTitle")}
		>
			<DemoRow label={t("rowReset")}>
				<div className="w-full max-w-xl">
					<ResetRowDemo />
				</div>
			</DemoRow>
			<DemoRow label={t("rowGated")}>
				<div className="w-full max-w-xl divide-y divide-divider">
					<GatedRowsDemo />
				</div>
			</DemoRow>
			<DemoRow label={t("rowError")}>
				<div className="w-full max-w-xl">
					<ErrorRowDemo />
				</div>
			</DemoRow>
			<DemoRow label={t("rowShortcut")}>
				<div className="w-full max-w-xl">
					<ShortcutRowDemo />
				</div>
			</DemoRow>
		</GallerySection>
	);
}
