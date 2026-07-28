import { PaintBrush03Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { appearanceSettingsSchema } from "@/shared/config/settings-schema";
import { isLocale, LOCALE_NAMES, LOCALES, useLocaleStore } from "@/shared/i18n";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Select } from "@/shared/ui/select";
import { SettingField } from "@/shared/ui/setting-field";
import { Toggle } from "@/shared/ui/toggle";

/** Schema defaults drive the per-setting reset buttons. */
const APPEARANCE_DEFAULTS = appearanceSettingsSchema.parse({});

/** General tab: everything about the app itself rather than the filter —
 *  desktop-shell behaviour (autostart, tray) and presentation (language,
 *  motion), as two sections of ONE tab. They were separate "General" and
 *  "Appearance" tabs; two rows apiece did not earn two rail entries.
 *
 *  Saves go through the debounced revision-checked pipeline; autostart
 *  additionally reconciles OS-side state after the save lands (registry entry).
 *
 *  Global shortcuts used to live here as a lone `toggleMain` row — they now
 *  have their own Hotkeys tab covering all eight bindings, `toggleMain`
 *  included. */
export function GeneralPanel() {
	const t = useTranslations("settings");
	const general = useSettingsStore((s) => s.settings.general);

	return (
		<>
			<SettingSection
				boxed
				divided
				icon={Settings01Icon}
				title={t("generalStartupSection")}
			>
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
			<AppearanceSection />
		</>
	);
}

/**
 * Presentation half of the General tab: locale picker (a single "English"
 * entry — the app ships en only, but the picker proves the multi-locale
 * plumbing) and the reduced-motion override. Rows are `SettingField`s, so each
 * scalar setting gets the label/caption/reset-affordance treatment for free.
 */
function AppearanceSection() {
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
				defaultValue={APPEARANCE_DEFAULTS.locale}
				label={t("appearanceLocale")}
				layout="row"
				onReset={() => handleLocaleChange(APPEARANCE_DEFAULTS.locale)}
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
				defaultValue={APPEARANCE_DEFAULTS.reducedMotion}
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
						reducedMotion: APPEARANCE_DEFAULTS.reducedMotion,
					})
				}
				value={appearance.reducedMotion}
			/>
		</SettingSection>
	);
}
