import { Moon02Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { patchAutoDarkSettings } from "@/features/auto-dark";
import { FormControl } from "@/shared/ui/form-control";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Toggle } from "@/shared/ui/toggle";
import { TimeField } from "./TimeField";

/**
 * Auto Dark section (FEATURE-PARITY F9.5-F9.6). OWNER: the auto-dark slice.
 *
 * Schedules the Windows SYSTEM theme (Light / Dark / From day to night / Disable)
 * plus the transparent-taskbar effect, wired to the `autoDark` settings section
 * and the `magicx::theme` seam. The "From day to night" schedule carries its own
 * sunrise/sunset times, decoupled from the Display tab's blue-light schedule.
 *
 * DimRead's OWN appearance is not configurable here — it is permanently dark (see
 * `color-scheme: dark` in `app/styles/globals.css`). There was previously an "App
 * theme" control in this panel, but it wrote `AppsUseLightTheme`, i.e. it re-themed
 * every other Windows app rather than this one, which read as a bug. Re-skinning
 * happens only in the `@theme` blocks of `globals.css`.
 */
export function AutoDarkPanel() {
	const t = useTranslations("magicxTab");
	const autoDark = useSettingsStore((s) => s.settings.autoDark);

	const themeOptions: SelectOption[] = [
		{ id: "light", label: t("themeLight") },
		{ id: "dark", label: t("themeDark") },
		{ id: "auto", label: t("themeAuto") },
		{ id: "disable", label: t("themeDisable") },
	];

	return (
		<div className="mx-auto flex max-w-[520px] flex-col">
			<p className="pt-2 text-body-sm text-foreground-muted leading-snug">
				{t("autoDarkCaption")}
			</p>

			<SettingSection
				description={t("themeNote")}
				divided
				icon={Moon02Icon}
				title={t("subAutoDark")}
			>
				<FormControl label={t("systemTheme")}>
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

				{autoDark.systemTheme === "auto" ? (
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
		</div>
	);
}
