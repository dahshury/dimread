import { SunriseIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { patchDayNightSettings } from "@/features/display";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Switcher } from "@/shared/ui/switcher";
import { TimeField } from "./TimeField";

/**
 * Settings → Day & Night: how the engine decides when night starts (parity
 * F3.2–F3.4). Choose location-based sun times (latitude/longitude) or fixed
 * custom times, and set the transition window.
 *
 * The main window keeps only the instant controls — the auto day/night switch
 * and the Day|Night phase selector. Everything numeric lives here, and each
 * edit persists straight through the `dayNight` section (no draft/Save step),
 * matching every other settings panel.
 */
export function DayNightPanel() {
	const t = useTranslations("displayTab");
	const dayNight = useSettingsStore((s) => s.settings.dayNight);

	return (
		<SettingSection divided icon={SunriseIcon} title={t("dayNightSettings")}>
			<FormControl
				caption={t("timeSourceCaption")}
				label={t("timeSource")}
				layout="row"
			>
				<Switcher
					onChange={(next) =>
						patchDayNightSettings({ useLocation: next === "location" })
					}
					options={[
						{ value: "location", label: t("timeSourceLocation") },
						{ value: "custom", label: t("timeSourceCustom") },
					]}
					size="sm"
					value={dayNight.useLocation ? "location" : "custom"}
				/>
			</FormControl>

			{dayNight.useLocation ? (
				<>
					<FormControl label={t("latitude")} layout="row">
						<NumberStepper
							max={90}
							min={-90}
							onChange={(next) => patchDayNightSettings({ latitude: next })}
							smallStep={0.1}
							value={dayNight.latitude}
						/>
					</FormControl>
					<FormControl label={t("longitude")} layout="row">
						<NumberStepper
							max={180}
							min={-180}
							onChange={(next) => patchDayNightSettings({ longitude: next })}
							smallStep={0.1}
							value={dayNight.longitude}
						/>
					</FormControl>
				</>
			) : (
				<>
					<FormControl label={t("sunrise")} layout="row">
						<TimeField
							ariaHourLabel={t("sunrise")}
							ariaMinuteLabel={t("sunrise")}
							onChange={(next) => patchDayNightSettings({ sunrise: next })}
							value={dayNight.sunrise}
						/>
					</FormControl>
					<FormControl label={t("sunset")} layout="row">
						<TimeField
							ariaHourLabel={t("sunset")}
							ariaMinuteLabel={t("sunset")}
							onChange={(next) => patchDayNightSettings({ sunset: next })}
							value={dayNight.sunset}
						/>
					</FormControl>
				</>
			)}

			<FormControl
				caption={t("transitionCaption")}
				label={t("transition")}
				layout="row"
			>
				<div className="flex items-center gap-2">
					<NumberStepper
						max={240}
						min={0}
						onChange={(next) =>
							patchDayNightSettings({ transitionMinutes: next })
						}
						step={15}
						value={dayNight.transitionMinutes}
					/>
					<span className="text-body-sm text-foreground-muted">
						{t("minutesSuffix")}
					</span>
				</div>
			</FormControl>
		</SettingSection>
	);
}
