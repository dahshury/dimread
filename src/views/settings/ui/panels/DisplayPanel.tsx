import { SlidersHorizontalIcon, Sun03Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";
import { QuickControls } from "@/widgets/quick-controls";

/** Settings → Display — the app's landing tab and its only "live" surface.
 *
 *  Top: the {@link QuickControls} block (the monitor roster, K/% readout, colour
 *  temperature + brightness sliders, auto day/night, the eight preset modes) —
 *  the controls that used to be a separate main window, rendered by the very
 *  same components. Below it: the engine's behavioural switches (smooth
 *  transition, wide ranges, fullscreen detection), wired to the `display`
 *  settings section (FEATURE-PARITY F1.2 / F1.8).
 *
 *  What is NOT here: "disable for full-screen apps". That switch reads like an
 *  engine option but is driven by the rules watcher (see `display::engine`) —
 *  it is the built-in first entry of Settings → App rules, and lives there with
 *  the rest of the foreground-window automation.
 *
 *  The detected-monitor inventory used to be a third section down here. It is
 *  now part of the roster inside `QuickControls`: naming a display and choosing
 *  it are the same act, so they are the same card.
 *
 *  Keep the split in that order — instant effect first, configuration second. */
export function DisplayPanel() {
	const t = useTranslations("optionsTab");
	const tDisplay = useTranslations("displayTab");
	const display = useSettingsStore((s) => s.settings.display);

	return (
		<>
			<SettingSection
				icon={SlidersHorizontalIcon}
				title={tDisplay("quickControlsSectionTitle")}
			>
				<div className="pt-2">
					<QuickControls />
				</div>
			</SettingSection>

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
			</SettingSection>
		</>
	);
}
