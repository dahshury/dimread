import { CheckmarkBadge01Icon, ComputerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { MonitorInfo } from "@/bindings";
import { Elevated } from "@/shared/lib/surface";
import { Badge } from "@/shared/ui/badge";

/**
 * The displays the engine can drive, as elevated-surface cards (friendly name,
 * GDI device id, primary badge). This is DimRead's stand-in for CareUEyes'
 * "driver information" support tool.
 */
export function MonitorCards({ monitors }: { monitors: MonitorInfo[] }) {
	const t = useTranslations("aboutTab");

	if (monitors.length === 0) {
		return (
			<p className="rounded-xl border border-border border-dashed px-4 py-6 text-center text-body-sm text-foreground-dim">
				{t("monitorEmpty")}
			</p>
		);
	}

	return (
		<div className="grid gap-2 sm:grid-cols-2">
			{monitors.map((monitor) => (
				<Elevated
					className="flex items-start gap-3 rounded-xl p-3"
					key={monitor.id}
					offset={2}
				>
					<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-wash text-accent">
						<HugeiconsIcon icon={ComputerIcon} size={16} />
					</span>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-medium text-body-sm text-foreground">
								{monitor.friendlyName}
							</span>
							{monitor.isPrimary ? (
								<Badge className="shrink-0 gap-1" variant="secondary">
									<HugeiconsIcon icon={CheckmarkBadge01Icon} size={11} />
									{t("monitorPrimary")}
								</Badge>
							) : null}
						</div>
						<div className="flex items-baseline gap-1.5">
							<span className="shrink-0 text-2xs text-foreground-dim uppercase tracking-wide">
								{t("monitorDeviceId")}
							</span>
							<span className="truncate font-mono text-2xs text-foreground-muted">
								{monitor.id}
							</span>
						</div>
					</div>
				</Elevated>
			))}
		</div>
	);
}
