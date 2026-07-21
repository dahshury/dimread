import { Settings01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";

/** General tab: desktop-shell behaviour (autostart, tray). Saves through the
 *  debounced revision-checked pipeline; autostart additionally reconciles
 *  OS-side state after the save lands (registry entry).
 *
 *  Global shortcuts used to live here as a lone `toggleMain` row — they now
 *  have their own Hotkeys tab covering all eight bindings, `toggleMain`
 *  included, so this tab stays a single concern. */
export function GeneralPanel() {
	const t = useTranslations("settings");
	const general = useSettingsStore((s) => s.settings.general);

	return (
		<SettingSection boxed divided icon={Settings01Icon} title={t("general")}>
			<FormControl
				caption={t("generalAutostartCaption")}
				label={t("generalAutostart")}
				labelAddon={
					<Toggle
						aria-label={t("generalAutostart")}
						checked={general.autostart}
						onCheckedChange={(next) =>
							patchSettingsSection("general", { autostart: next })
						}
					/>
				}
				layout="row"
			/>
			<FormControl
				caption={t("generalMinimizeToTrayCaption")}
				label={t("generalMinimizeToTray")}
				labelAddon={
					<Toggle
						aria-label={t("generalMinimizeToTray")}
						checked={general.minimizeToTray}
						onCheckedChange={(next) =>
							patchSettingsSection("general", { minimizeToTray: next })
						}
					/>
				}
				layout="row"
			/>
		</SettingSection>
	);
}
