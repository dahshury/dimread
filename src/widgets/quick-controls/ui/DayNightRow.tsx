import { useTranslations } from "use-intl";
import type { EditPhase } from "@/features/display";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

export interface DayNightRowProps {
	/** Whether the segmented control may be used to pick the edited endpoint. */
	canChoosePhase: boolean;
	enabled: boolean;
	onPhaseChange: (phase: EditPhase) => void;
	onToggleEnabled: (enabled: boolean) => void;
	/** The phase the sliders currently edit (live phase, or the user's override). */
	phase: EditPhase;
	/** True while the schedule is fading between the two endpoints. */
	ramping: boolean;
}

/**
 * The auto day/night row (parity F3.1): an enable switch with helper text and
 * the Day|Night segmented control that chooses which phase the sliders edit
 * (and previews that phase's values).
 *
 * Both are instant-effect controls, which is why they stay in the compact main
 * window. The schedule behind them — location vs custom sun times, latitude,
 * longitude, transition minutes — lives in Settings → Schedule.
 */
export function DayNightRow({
	canChoosePhase,
	enabled,
	onPhaseChange,
	onToggleEnabled,
	phase,
	ramping,
}: DayNightRowProps) {
	const t = useTranslations("displayTab");

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center justify-between gap-3">
				<span className="font-semibold text-body-sm text-foreground">
					{t("autoDayNight")}
				</span>
				<Toggle
					aria-label={t("autoDayNight")}
					checked={enabled}
					onCheckedChange={onToggleEnabled}
				/>
			</div>
			{/* A settled auto phase is the clock's to choose, so the control shows it
			    read-only. Mid-ramp neither endpoint is "current" — the screen is
			    between them — so the choice comes back rather than silently picking
			    one. Default ("md") segment height matches the preset mode grid
			    directly below it — a 18px `sm` segment read as a thin sliver next to
			    the 32px mode buttons. */}
			<Switcher<EditPhase>
				fullWidth
				onChange={onPhaseChange}
				options={[
					{ value: "day", label: t("day"), disabled: !canChoosePhase },
					{ value: "night", label: t("night"), disabled: !canChoosePhase },
				]}
				value={phase}
			/>
			{/* Without this the sliders look broken: they show an endpoint while the
			    readout shows the blend, and a drag moves the screen by less than its
			    own travel. Say so instead of leaving the user to conclude the
			    brightness control has a floor it does not have. */}
			{ramping ? (
				<p className="text-body-sm text-foreground-muted">
					{t("phaseTransitionHelper")}
				</p>
			) : null}
		</div>
	);
}
