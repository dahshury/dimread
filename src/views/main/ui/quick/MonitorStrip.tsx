import { ComputerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { MonitorInfo } from "@/bindings";
import { ALL_MONITORS, type MonitorSelection } from "@/features/display";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";

export interface MonitorStripProps {
	monitors: readonly MonitorInfo[];
	onSelect: (selection: MonitorSelection) => void;
	selection: MonitorSelection;
}

/**
 * The multi-monitor selector (parity F2.3): a monitor glyph followed by an
 * "All monitors" chip and one numbered chip per physical display. "All" edits
 * the active mode's shared preset; a numbered chip edits that monitor's
 * override. Rendered by the panel only when more than one monitor is present.
 */
export function MonitorStrip({
	monitors,
	onSelect,
	selection,
}: MonitorStripProps) {
	const t = useTranslations("displayTab");

	const options: SwitcherOption<string>[] = [
		{ value: ALL_MONITORS, label: t("allMonitors") },
		...monitors.map((monitor, index) => ({
			value: monitor.id,
			label: t("monitorLabel", { index: index + 1 }),
		})),
	];

	return (
		<div className="flex items-center gap-2">
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0 text-foreground-muted"
				icon={ComputerIcon}
				size={18}
			/>
			<Switcher<string>
				className="min-w-0"
				onChange={onSelect}
				options={options}
				size="sm"
				value={selection}
			/>
		</div>
	);
}
