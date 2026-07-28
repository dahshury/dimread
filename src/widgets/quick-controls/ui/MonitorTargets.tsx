import {
	CheckmarkBadge01Icon,
	ComputerIcon,
	Layers01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { MonitorInfo } from "@/bindings";
import { ALL_MONITORS, type MonitorSelection } from "@/features/display";
import { cn } from "@/shared/lib/cn";
import { Elevated } from "@/shared/lib/surface";
import { Badge } from "@/shared/ui/badge";
import { Toggle } from "@/shared/ui/toggle";

export interface MonitorTargetsProps {
	/** Ids the user has opted out of filtering entirely. */
	excluded: readonly string[];
	monitors: readonly MonitorInfo[];
	/** Opt a monitor in/out of filtering. */
	onSetEnabled: (monitorId: string, enabled: boolean) => void;
	/** Point the sliders at every monitor, or at one specific display. */
	onSelect: (selection: MonitorSelection) => void;
	selection: MonitorSelection;
}

/**
 * The monitor roster — targeting, opt-out, and inventory in one control.
 *
 * This replaces two components that described the same hardware in two
 * vocabularies: a numbered "Monitor 1 | Monitor 2" segmented strip above the
 * sliders, and a read-only "Monitor information" card list at the bottom of the
 * tab. Selecting a display and reading what that display actually IS are the
 * same question, so they are the same card here: the friendly name is the
 * target label, and the row that names your hardware is the row you click.
 *
 * Two independent axes per monitor, which is why a card carries both a radio
 * and a switch:
 *
 *  - **Target** (the radio) — which preset the sliders edit. {@link ALL_MONITORS}
 *    edits the active mode's shared preset; a specific monitor edits its
 *    override. Purely an editing choice; it changes nothing on screen.
 *  - **Participate** (the switch) — whether the engine filters that display at
 *    all (`display.excludedMonitors`). An opted-out monitor gets its original
 *    ramp back and is skipped by every apply and preview pass.
 *
 * An opted-out monitor cannot be targeted: its override would be written and
 * never applied, which is exactly the phantom-setting trap. Its radio is
 * disabled and the caller drops the selection back to "All monitors".
 *
 * With a single display both axes are meaningless — there is nothing to choose
 * between, and opting the only monitor out is just `pause` by another name — so
 * the control degrades to one read-only row. That row still earns its space: it
 * is the answer to "does DimRead actually see my display, and under what
 * name/id", which is the first thing to check when filtering does nothing.
 */
export function MonitorTargets({
	excluded,
	monitors,
	onSelect,
	onSetEnabled,
	selection,
}: MonitorTargetsProps) {
	const t = useTranslations("displayTab");

	if (monitors.length === 0) {
		return (
			<p className="rounded-xl border border-border border-dashed px-4 py-6 text-center text-body-sm text-foreground-dim">
				{t("monitorEmpty")}
			</p>
		);
	}

	// Single display: inventory only — no target to pick, no opt-out to offer.
	if (monitors.length === 1 && monitors[0]) {
		return <MonitorIdentity monitor={monitors[0]} />;
	}

	// Never let the last participating monitor be switched off: that is `pause`
	// expressed as a roster, and it strands the readout reporting a filter no
	// display is showing. The mode grid is where "stop filtering" lives.
	const enabledCount = monitors.filter((m) => !excluded.includes(m.id)).length;

	return (
		<div
			aria-label={t("monitors")}
			className="flex flex-col gap-1.5"
			role="radiogroup"
		>
			<MonitorRow
				icon={Layers01Icon}
				label={t("allMonitors")}
				onSelect={() => onSelect(ALL_MONITORS)}
				selected={selection === ALL_MONITORS}
			/>
			{monitors.map((monitor) => {
				const enabled = !excluded.includes(monitor.id);
				return (
					<MonitorRow
						enabled={enabled}
						icon={ComputerIcon}
						key={monitor.id}
						label={monitor.friendlyName}
						monitor={monitor}
						onSelect={() => onSelect(monitor.id)}
						onSetEnabled={(next) => onSetEnabled(monitor.id, next)}
						selected={selection === monitor.id}
						toggleDisabled={enabled && enabledCount <= 1}
					/>
				);
			})}
		</div>
	);
}

/**
 * The single-monitor case: a compact identity line, no controls.
 *
 * Deliberately NOT an `Elevated` plate. The multi-monitor rows are elevated,
 * ringed cards because they are hit targets; wearing the same costume here
 * advertises an affordance this row does not have, and the first thing a user
 * does with a plate that looks like a button is click it and conclude the app
 * is broken. Rendered at caption altitude instead — a label for the controls
 * below, which is all it ever was.
 */
function MonitorIdentity({ monitor }: { monitor: MonitorInfo }) {
	return (
		<div className="flex items-center gap-2 px-1.5 text-foreground-dim">
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0"
				icon={ComputerIcon}
				size={14}
			/>
			<span className="min-w-0 truncate text-xs-tight">
				{monitor.friendlyName}
			</span>
			<span className="min-w-0 flex-1 truncate text-right font-mono text-2xs">
				{monitor.id}
			</span>
		</div>
	);
}

interface MonitorRowProps {
	/** Whether this monitor participates in filtering. Absent on the "All" row. */
	enabled?: boolean;
	icon: typeof ComputerIcon;
	label: string;
	/** Absent on the "All monitors" row, which has no hardware behind it. */
	monitor?: MonitorInfo;
	onSelect: () => void;
	onSetEnabled?: (enabled: boolean) => void;
	selected: boolean;
	/** True for the last participating monitor — it may not be switched off. */
	toggleDisabled?: boolean;
}

function MonitorRow({
	enabled = true,
	icon,
	label,
	monitor,
	onSelect,
	onSetEnabled,
	selected,
	toggleDisabled,
}: MonitorRowProps) {
	const t = useTranslations("displayTab");

	return (
		<Elevated
			className={cn(
				"flex items-center gap-1 rounded-xl p-1.5 pr-2.5 ring-1 transition-colors",
				selected ? "ring-accent" : "ring-divider",
			)}
			offset={1}
		>
			{/* The radio owns the name + id so the whole identity block is the hit
			    target, and it is a SIBLING of the switch rather than its parent —
			    nesting a switch inside a radio would make one control swallow the
			    other's clicks and flatten the accessibility tree. */}
			<button
				aria-checked={selected}
				className={cn(
					"flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-opacity",
					"focus-visible:ring-2 focus-visible:ring-accent",
					enabled
						? "cursor-pointer hover:opacity-90"
						: "cursor-not-allowed opacity-45",
				)}
				disabled={!enabled}
				onClick={onSelect}
				role="radio"
				type="button"
			>
				{/* Unselected leaves the chip unpainted rather than picking a
				    `bg-surface-N`: the row is already an elevated plate, so a second
				    hardcoded level would fight the surfaces ladder. */}
				<span
					className={cn(
						"flex size-7 shrink-0 items-center justify-center rounded-lg",
						selected
							? "bg-accent-wash text-accent"
							: "ring-1 ring-divider text-foreground-muted",
					)}
				>
					<HugeiconsIcon aria-hidden="true" icon={icon} size={15} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex items-center gap-1.5">
						<span className="min-w-0 truncate font-medium text-body-sm text-foreground">
							{label}
						</span>
						{monitor?.isPrimary ? (
							<Badge className="shrink-0 gap-1" variant="secondary">
								<HugeiconsIcon icon={CheckmarkBadge01Icon} size={11} />
								{t("monitorPrimary")}
							</Badge>
						) : null}
					</span>
					{monitor ? (
						<span className="truncate font-mono text-2xs text-foreground-dim">
							{monitor.id}
						</span>
					) : (
						<span className="truncate text-2xs text-foreground-dim">
							{t("allMonitorsCaption")}
						</span>
					)}
				</span>
			</button>
			{monitor && onSetEnabled ? (
				<Toggle
					aria-label={t("monitorEnabledLabel", { name: monitor.friendlyName })}
					checked={enabled}
					disabled={toggleDisabled}
					onCheckedChange={onSetEnabled}
				/>
			) : null}
		</Elevated>
	);
}
