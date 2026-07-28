import { useTranslations } from "use-intl";
import type { EditPhase } from "@/features/display";
import { Switcher } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";

export interface DayNightRowProps {
	enabled: boolean;
	onPhaseChange: (phase: EditPhase) => void;
	onToggleEnabled: (enabled: boolean) => void;
	/** The phase the sliders currently edit (live phase, or the user's override). */
	phase: EditPhase;
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
	enabled,
	onPhaseChange,
	onToggleEnabled,
	phase,
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
			{/* Auto mode keeps the clock-derived phase visible, but makes the manual
			    phase preview unavailable. Default ("md") segment height matches the preset
			    mode grid directly below it — a 18px `sm` segment read as a thin
			    sliver next to the 32px mode buttons. */}
			<Switcher<EditPhase>
				fullWidth
				onChange={onPhaseChange}
				options={[
					{ value: "day", label: t("day"), disabled: enabled },
					{ value: "night", label: t("night"), disabled: enabled },
				]}
				value={phase}
			/>
		</div>
	);
}
