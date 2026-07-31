import { PowerSocket01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import type { AppSettings } from "@/bindings";
import { SettingSection } from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { Toggle } from "@/shared/ui/toggle";

interface StartupSectionProps {
	general: AppSettings["general"];
	onPatch: (patch: Partial<AppSettings["general"]>) => void;
}

export function StartupSection({ general, onPatch }: StartupSectionProps) {
	const t = useTranslations("settings");
	return (
		<SettingSection icon={PowerSocket01Icon} title={t("aboutStartupTitle")}>
			<FormControl
				caption={t("aboutStartOnLoginCaption")}
				label={t("aboutStartOnLogin")}
				labelAddon={
					<Toggle
						aria-label={t("aboutStartOnLogin")}
						checked={general.autostart}
						onCheckedChange={(autostart) => onPatch({ autostart })}
					/>
				}
				layout="row"
			/>
			<FormControl
				caption={t("aboutAnonymousReportsCaption")}
				label={t("aboutAnonymousReports")}
				labelAddon={
					<Toggle
						aria-label={t("aboutAnonymousReports")}
						checked={general.anonymousReports}
						onCheckedChange={(anonymousReports) =>
							onPatch({ anonymousReports })
						}
					/>
				}
				layout="row"
			/>
		</SettingSection>
	);
}
