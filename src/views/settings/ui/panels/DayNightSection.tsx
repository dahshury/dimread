import { SunriseIcon } from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { patchDayNightSettings, useDayNightLocation } from "@/features/display";
import {
	asLocationSource,
	type LocationSourceId,
} from "@/shared/config/settings-schema";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Switcher } from "@/shared/ui/switcher";
import { TimeField } from "./TimeField";
import { manualScheduleKind, normalizeTransitionMinutes } from "./hm-time";
import {
	buildTimezoneGroups,
	formatMinutesOfDay,
	zoneCity,
} from "./timezone-options";

/**
 * The "when night starts" section of Settings → Schedule: how the engine decides
 * the day/night phase (parity F3.2–F3.4).
 *
 * It leads the tab because everything else scheduled — the ramp width below it,
 * and the Windows theme section under that — resolves against the boundaries
 * chosen here.
 *
 * Coordinates used to be the ONLY way to say "here", so a fresh install sat at
 * 0°, 0° and computed an equatorial 06:00/18:00 day for everyone who picked
 * location-based times — the mode looked broken because it was, unless you
 * happened to know your own latitude. `Automatic` now reads the system timezone
 * instead, and telling DimRead where you are by hand is a SECOND-level choice:
 * a timezone or exact coordinates are two ways of doing the same thing, so they
 * are one `Manual` source refined by the Location row rather than two
 * unrelated-looking entries in the top switcher.
 *
 * Whichever is chosen, the resolved location and today's sun times are shown
 * underneath, straight from the engine (`useDayNightLocation`) — that readout is
 * how a user can tell the schedule is right without waiting until dusk.
 *
 * Each edit persists straight through the `dayNight` section (no draft/Save
 * step), matching every other settings panel.
 */

/** Top-level source. `manual` = "I will say where I am", which
 *  {@link LocationMethod} then refines. */
type TimeSource = "automatic" | "manual" | "custom";

/** The two ways to give a location by hand. */
type LocationMethod = Exclude<LocationSourceId, "auto">;

/** Which method a `manual` source is currently using. Anything else (i.e.
 *  `"auto"`) means the user has not chosen one yet — start at the timezone
 *  picker, the option that needs no outside knowledge. */
function methodOf(locationSource: string): LocationMethod {
	return asLocationSource(locationSource) === "manual" ? "manual" : "timezone";
}

export function DayNightSection() {
	const t = useTranslations("displayTab");
	const common = useTranslations("common");
	const dayNight = useSettingsStore((s) => s.settings.dayNight);
	const locale = useSettingsStore((s) => s.settings.appearance.locale);
	const {
		locationLoadError,
		retryLocation,
		retryTimezones,
		status,
		timezones,
		timezonesLoadError,
	} = useDayNightLocation();

	const source: TimeSource = dayNight.useLocation
		? asLocationSource(dayNight.locationSource) === "auto"
			? "automatic"
			: "manual"
		: "custom";

	// `locationSource` cannot remember the manual method while it is holding
	// "auto" — that value IS the source — so a trip through Automatic would
	// otherwise drop a user back on the timezone picker after they had chosen
	// coordinates. Remembered here; the persisted value still wins whenever it
	// names a method, so this can never drift from what the engine is using.
	const [lastMethod, setLastMethod] = useState<LocationMethod>(() =>
		methodOf(dayNight.locationSource),
	);
	const method =
		asLocationSource(dayNight.locationSource) === "auto"
			? lastMethod
			: methodOf(dayNight.locationSource);

	const selectMethod = (next: LocationMethod) => {
		setLastMethod(next);
		return patchDayNightSettings({ locationSource: next });
	};

	const timezoneGroups = useMemo(
		() =>
			buildTimezoneGroups({
				formatLabel: (city, country) =>
					t("timezoneOptionLabel", { city, country }),
				locale,
				zones: timezones,
			}),
		[locale, t, timezones],
	);
	const scheduleKind = manualScheduleKind(dayNight.sunrise, dayNight.sunset);

	const selectSource = (next: TimeSource) => {
		if (next === "custom") {
			// `locationSource` is deliberately left alone: coming back to a
			// location-based schedule should return to the way the user had
			// already set up, not reset it.
			return patchDayNightSettings({ useLocation: false });
		}
		return patchDayNightSettings({
			locationSource: next === "automatic" ? "auto" : method,
			useLocation: true,
		});
	};

	return (
		<SettingSection icon={SunriseIcon} title={t("dayNightSettings")}>
			<FormControl
				caption={t("timeSourceCaption")}
				label={t("timeSource")}
				layout="row"
			>
				{/* Default ("md") segment height, matching the Day|Night selector in
				    the Display tab — segmented controls across the app read as one
				    control, so this row must not be a thinner variant of it. */}
				<Switcher<TimeSource>
					onChange={(next) => void selectSource(next)}
					options={[
						{ value: "automatic", label: t("timeSourceAuto") },
						{ value: "manual", label: t("timeSourceManual") },
						{ value: "custom", label: t("timeSourceCustom") },
					]}
					value={source}
				/>
			</FormControl>

			{source === "manual" ? (
				<FormControl
					caption={t("locationMethodCaption")}
					label={t("locationMethod")}
					layout="row"
				>
					<Switcher<LocationMethod>
						onChange={(next) => void selectMethod(next)}
						options={[
							{ value: "timezone", label: t("timeSourceTimezone") },
							{ value: "manual", label: t("timeSourceCoordinates") },
						]}
						value={method}
					/>
				</FormControl>
			) : null}

			{source === "manual" && method === "timezone" ? (
				<FormControl
					caption={t("timezoneCaption")}
					label={t("timezone")}
					layout="row"
				>
					{/* The row label ("Your timezone") reaches the combobox through
					    FormControl's `aria-labelledby`, so it must NOT read the same as
					    the Location switcher's "Timezone" segment right above it —
					    two controls answering to one name is a screen-reader trap. */}
					{timezonesLoadError ? (
						<LoadError
							message={t("timezoneLoadFailed")}
							onRetry={retryTimezones}
							retryLabel={common("retry")}
						/>
					) : (
						<SearchableSelect
							ariaLabel={t("timezone")}
							className="w-64"
							groups={timezoneGroups}
							onChange={(next) =>
								void patchDayNightSettings({ timezone: next })
							}
							placeholder={t("timezonePlaceholder")}
							value={dayNight.timezone}
						/>
					)}
				</FormControl>
			) : null}

			{source === "manual" && method === "manual" ? (
				<>
					<FormControl label={t("latitude")} layout="row">
						<NumberStepper
							ariaLabel={t("latitude")}
							max={90}
							min={-90}
							onChange={(next) => patchDayNightSettings({ latitude: next })}
							smallStep={0.1}
							value={dayNight.latitude}
						/>
					</FormControl>
					<FormControl label={t("longitude")} layout="row">
						<NumberStepper
							ariaLabel={t("longitude")}
							max={180}
							min={-180}
							onChange={(next) => patchDayNightSettings({ longitude: next })}
							smallStep={0.1}
							value={dayNight.longitude}
						/>
					</FormControl>
				</>
			) : null}

			{source === "custom" ? (
				<>
					<FormControl label={t("sunrise")} layout="row">
						<TimeField
							ariaHourLabel={t("sunriseHours")}
							ariaMinuteLabel={t("sunriseMinutes")}
							onChange={(next) => patchDayNightSettings({ sunrise: next })}
							value={dayNight.sunrise}
						/>
					</FormControl>
					<FormControl label={t("sunset")} layout="row">
						<TimeField
							ariaHourLabel={t("sunsetHours")}
							ariaMinuteLabel={t("sunsetMinutes")}
							onChange={(next) => patchDayNightSettings({ sunset: next })}
							value={dayNight.sunset}
						/>
					</FormControl>
					<p className="text-right text-body-sm text-foreground-muted">
						{scheduleKind === "equal"
							? t("scheduleEqual")
							: scheduleKind === "overnight"
								? t("scheduleOvernight")
								: t("scheduleSameDay")}
					</p>
				</>
			) : locationLoadError ? (
				<FormControl label={t("detectedLocation")} layout="row">
					<LoadError
						message={t("locationLoadFailed")}
						onRetry={retryLocation}
						retryLabel={common("retry")}
					/>
				</FormControl>
			) : (
				<LocationReadout status={status} />
			)}

			<FormControl
				caption={t("transitionCaption")}
				label={t("transition")}
				layout="row"
			>
				<div className="flex items-center gap-2">
					<NumberStepper
						ariaLabel={t("transition")}
						max={240}
						min={0}
						onChange={(next) =>
							patchDayNightSettings({
								transitionMinutes: normalizeTransitionMinutes(next),
							})
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

function LoadError({
	message,
	onRetry,
	retryLabel,
}: {
	message: string;
	onRetry: () => void;
	retryLabel: string;
}) {
	return (
		<div
			className="flex max-w-72 items-center justify-end gap-2 text-right"
			role="alert"
		>
			<span className="text-body-sm text-error">{message}</span>
			<Button
				className="h-8 rounded-lg px-3 text-body-sm text-foreground-secondary hover:bg-surface-hover"
				onClick={onRetry}
			>
				{retryLabel}
			</Button>
		</div>
	);
}

/**
 * Where the schedule thinks it is, and what that means for today. Reported by
 * the engine so it can never disagree with the sun times actually being applied
 * — including the two failure branches (`unresolved`), which say what to do next
 * instead of silently leaving the schedule on 0°, 0°.
 */
function LocationReadout({
	status,
}: {
	status: ReturnType<typeof useDayNightLocation>["status"];
}) {
	const t = useTranslations("displayTab");
	if (!status) {
		return null;
	}
	const { detectedTimezone, resolved, sunriseMinutes, sunsetMinutes } = status;

	const place =
		resolved.source === "unresolved"
			? detectedTimezone
				? t("unresolvedTimezone", { timezone: detectedTimezone })
				: t("detectedFailed")
			: resolved.timezone
				? t("detectedFrom", { timezone: zoneCity(resolved.timezone) })
				: null;

	const sun =
		sunriseMinutes === null || sunsetMinutes === null
			? t("sunTimesPolar")
			: t("sunTimesToday", {
					sunrise: formatMinutesOfDay(sunriseMinutes),
					sunset: formatMinutesOfDay(sunsetMinutes),
				});

	return (
		<FormControl label={t("detectedLocation")} layout="row">
			<div className="flex max-w-72 flex-col items-end gap-0.5 text-right">
				{place ? (
					<span className="text-body-sm text-foreground-muted">{place}</span>
				) : null}
				<span className="text-body-sm text-foreground-muted">{sun}</span>
			</div>
		</FormControl>
	);
}
