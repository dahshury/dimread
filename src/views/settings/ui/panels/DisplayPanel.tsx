import { ComputerIcon, Sun03Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { useMonitors } from "@/features/display";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";
import { MonitorCards } from "./MonitorCards";

/** Settings → Display: colour-engine behaviour (smooth transition, wide colour
 *  range) plus the detected-monitor inventory. Wired to the `display` settings
 *  section (FEATURE-PARITY F1.2 / F1.8). The live temperature/brightness sliders
 *  stay in the main window — only the engine's behavioural switches live here. */
export function DisplayPanel() {
	const t = useTranslations("optionsTab");
	const tAbout = useTranslations("aboutTab");
	const display = useSettingsStore((s) => s.settings.display);
	const monitors = useMonitors();

	return (
		<>
			<SettingSection divided icon={Sun03Icon} title={t("displaySectionTitle")}>
				<FormControl
					caption={t("smoothTransitionCaption")}
					label={t("smoothTransition")}
					labelAddon={
						<Toggle
							aria-label={t("smoothTransition")}
							checked={display.smoothTransition}
							onCheckedChange={(next) =>
								patchSettingsSection("display", { smoothTransition: next })
							}
						/>
					}
					layout="row"
				/>
				<FormControl
					caption={t("wideRangeCaption")}
					label={t("wideRange")}
					labelAddon={
						<Toggle
							aria-label={t("wideRange")}
							checked={display.wideRange}
							onCheckedChange={(next) =>
								patchSettingsSection("display", { wideRange: next })
							}
						/>
					}
					layout="row"
					tooltip={t("wideRangeWarning")}
				/>
				<FormControl
					caption={t("brightnessWideRangeCaption")}
					label={t("brightnessWideRange")}
					labelAddon={
						<Toggle
							aria-label={t("brightnessWideRange")}
							checked={display.brightnessWideRange}
							onCheckedChange={(next) =>
								patchSettingsSection("display", { brightnessWideRange: next })
							}
						/>
					}
					layout="row"
					tooltip={t("brightnessWideRangeWarning")}
				/>
				<FormControl
					caption={t("fullscreenDetectionCaption")}
					label={t("fullscreenDetection")}
					labelAddon={
						<Toggle
							aria-label={t("fullscreenDetection")}
							checked={display.disableOnFullscreen}
							onCheckedChange={(next) =>
								patchSettingsSection("display", { disableOnFullscreen: next })
							}
						/>
					}
					layout="row"
				/>
			</SettingSection>

			<SettingSection icon={ComputerIcon} title={tAbout("monitorInfo")}>
				<div className="pt-2">
					<MonitorCards monitors={monitors} />
				</div>
			</SettingSection>
		</>
	);
}
