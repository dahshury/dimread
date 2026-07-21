import { PaintBrush03Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { appearanceSettingsSchema } from "@/shared/config/settings-schema";
import { isLocale, LOCALE_NAMES, LOCALES, useLocaleStore } from "@/shared/i18n";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Select } from "@/shared/ui/select";
import { SettingField } from "@/shared/ui/setting-field";
import { Toggle } from "@/shared/ui/toggle";

/** Schema defaults drive the per-setting reset buttons. */
const DEFAULTS = appearanceSettingsSchema.parse({});

/**
 * Appearance tab: locale picker (a single "English" entry — the starter ships
 * en only, but the picker proves the multi-locale plumbing) and the
 * reduced-motion override. Rows are `SettingField`s, so each scalar setting
 * gets the label/caption/reset-affordance treatment for free.
 */
export function AppearancePanel() {
	const t = useTranslations("settings");
	const appearance = useSettingsStore((s) => s.settings.appearance);
	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	const localeOptions = LOCALES.map((code) => ({
		id: code,
		label: LOCALE_NAMES[code].native,
	}));

	const handleLocaleChange = (next: string) => {
		if (!isLocale(next)) {
			return;
		}
		// The locale lives in TWO places on purpose: the locale store drives
		// use-intl immediately (per-window, localStorage-cached), and the
		// settings tree persists it durably for the backend snapshot.
		setLocale(next);
		patchSettingsSection("appearance", { locale: next });
	};

	return (
		<SettingSection
			boxed
			divided
			icon={PaintBrush03Icon}
			title={t("appearance")}
		>
			<SettingField
				caption={t("appearanceLocaleCaption")}
				defaultValue={DEFAULTS.locale}
				label={t("appearanceLocale")}
				layout="row"
				onReset={() => handleLocaleChange(DEFAULTS.locale)}
				value={locale}
			>
				<ElevatedSurface inline>
					<Select
						aria-label={t("appearanceLocale")}
						className="w-44"
						onChange={handleLocaleChange}
						options={localeOptions}
						value={locale}
					/>
				</ElevatedSurface>
			</SettingField>
			<SettingField
				caption={t("appearanceReducedMotionCaption")}
				defaultValue={DEFAULTS.reducedMotion}
				label={t("appearanceReducedMotion")}
				labelAddon={
					<Toggle
						aria-label={t("appearanceReducedMotion")}
						checked={appearance.reducedMotion}
						onCheckedChange={(next) =>
							patchSettingsSection("appearance", { reducedMotion: next })
						}
					/>
				}
				layout="row"
				onReset={() =>
					patchSettingsSection("appearance", {
						reducedMotion: DEFAULTS.reducedMotion,
					})
				}
				value={appearance.reducedMotion}
			/>
		</SettingSection>
	);
}
