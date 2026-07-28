import { Moon02Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { patchAutoDarkSettings } from "@/features/auto-dark";
import { FormControl } from "@/shared/ui/form-control";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Toggle } from "@/shared/ui/toggle";
import { TimeField } from "./TimeField";

/**
 * Windows theme section of the Schedule tab (FEATURE-PARITY F9.5-F9.6).
 * OWNER: the auto-dark slice.
 *
 * Schedules the Windows SYSTEM theme (Light / Dark / From day to night /
 * Disable) plus the transparent-taskbar effect, wired to the `autoDark` settings
 * section and the `magicx::theme` seam.
 *
 * This used to be its own "Auto dark" tab, which put the app's SECOND answer to
 * "when is it night?" a full rail entry away from its first one — two sunrise
 * pairs that could silently disagree, only one of which could resolve a real
 * location. It now sits directly under the day/night schedule it defaults to
 * following (`autoDark.useDayNightSchedule`), so the relationship is visible:
 * the times above drive this unless you say otherwise.
 *
 * DimRead's OWN appearance is not configurable here — it is permanently dark (see
 * `color-scheme: dark` in `app/styles/globals.css`). There was previously an "App
 * theme" control in this panel, but it wrote `AppsUseLightTheme`, i.e. it re-themed
 * every other Windows app rather than this one, which read as a bug. Re-skinning
 * happens only in the `@theme` blocks of `globals.css`.
 */
export function SystemThemeSection() {
	const t = useTranslations("magicxTab");
	const autoDark = useSettingsStore((s) => s.settings.autoDark);

	const themeOptions: SelectOption[] = [
		{ id: "light", label: t("themeLight") },
		{ id: "dark", label: t("themeDark") },
		{ id: "auto", label: t("themeAuto") },
		{ id: "disable", label: t("themeDisable") },
	];

	const scheduled = autoDark.systemTheme === "auto";
	// The manual pair is the OPT-OUT, so it only appears once the schedule is
	// both in play and deliberately not shared.
	const showOwnTimes = scheduled && !autoDark.useDayNightSchedule;

	return (
		<SettingSection
			description={t("themeNote")}
			divided
			icon={Moon02Icon}
			title={t("subAutoDark")}
		>
			<FormControl caption={t("autoDarkCaption")} label={t("systemTheme")}>
				<Select
					aria-label={t("systemTheme")}
					className="w-full"
					onChange={(value) =>
						void patchAutoDarkSettings({ systemTheme: value })
					}
					options={themeOptions}
					value={autoDark.systemTheme}
				/>
			</FormControl>

			{scheduled ? (
				<FormControl
					caption={t("followDayNightCaption")}
					label={t("followDayNight")}
					labelAddon={
						<Toggle
							aria-label={t("followDayNight")}
							checked={autoDark.useDayNightSchedule}
							onCheckedChange={(next) =>
								void patchAutoDarkSettings({ useDayNightSchedule: next })
							}
						/>
					}
					layout="row"
				/>
			) : null}

			{showOwnTimes ? (
				<>
					<FormControl label={t("systemSunrise")} layout="row">
						<TimeField
							ariaHourLabel={t("systemSunrise")}
							ariaMinuteLabel={t("systemSunrise")}
							onChange={(next) =>
								void patchAutoDarkSettings({ systemSunrise: next })
							}
							value={autoDark.systemSunrise}
						/>
					</FormControl>
					<FormControl label={t("systemSunset")} layout="row">
						<TimeField
							ariaHourLabel={t("systemSunset")}
							ariaMinuteLabel={t("systemSunset")}
							onChange={(next) =>
								void patchAutoDarkSettings({ systemSunset: next })
							}
							value={autoDark.systemSunset}
						/>
					</FormControl>
				</>
			) : null}

			<FormControl
				label={t("taskbarTransparent")}
				labelAddon={
					<Toggle
						aria-label={t("taskbarTransparent")}
						checked={autoDark.taskbarTransparent}
						onCheckedChange={(next) =>
							void patchAutoDarkSettings({ taskbarTransparent: next })
						}
					/>
				}
				layout="row"
			/>
		</SettingSection>
	);
}
