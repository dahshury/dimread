import { DayNightSection } from "./DayNightSection";
import { SystemThemeSection } from "./SystemThemeSection";

/**
 * Settings → Schedule: everything DimRead does on a clock, in one place.
 *
 * The tab answers "when is it night?" ONCE — {@link DayNightSection} — and then
 * lists what that answer drives: the colour filter's ramp (same section) and the
 * Windows system theme + taskbar effect ({@link SystemThemeSection}).
 *
 * Those two used to be separate rail entries ("Day & night" under Display, "Auto
 * dark" under Features), each with its own sunrise/sunset pair. That let the app
 * hold two different opinions about dusk, of which only one could resolve a real
 * location — a discrepancy the user had to notice across two tabs. The system
 * theme now follows the day/night schedule by default
 * (`autoDark.useDayNightSchedule`, resolved in `magicx::theme`), and its manual
 * pair survives one toggle away as the deliberate opt-out.
 *
 * Order matters: the boundaries come first, then what runs on them.
 */
export function SchedulePanel() {
	return (
		<div className="flex w-full flex-col">
			<DayNightSection />
			<SystemThemeSection />
		</div>
	);
}
