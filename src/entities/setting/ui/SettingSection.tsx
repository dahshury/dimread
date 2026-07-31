import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, useSurface } from "@/shared/lib/surface";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSectionProps {
	children?: ReactNode;
	/** Optional help text shown in an info-icon tooltip next to the title. */
	description?: string;
	/** Custom footer content for status or hints that must stay visible. */
	footer?: ReactNode;
	/** Action rendered on the trailing edge of the header (e.g. a button). */
	headerAction?: ReactNode;
	/** Optional leading icon shown before the title. */
	icon?: IconSvgElement;
	onToggle?: (checked: boolean) => void;
	title: string;
	/** When provided, renders a toggle switch on the header's trailing edge. */
	toggled?: boolean;
	toggleDisabled?: boolean;
}

/**
 * Top-level grouping inside a settings panel (ported from WinSTT). Every
 * section uses the same small title label followed by a rounded, hairline-ringed
 * group whose direct children are separated into rows. Keeping that treatment
 * intrinsic to the component prevents individual tabs from drifting between
 * flat and grouped presentations.
 *
 * The section re-provides a +1 surface step downward without painting a second
 * opaque surface, so nested elevated controls still climb from the card.
 */
export function SettingSection({
	children,
	description,
	footer,
	headerAction,
	icon,
	onToggle,
	title,
	toggled,
	toggleDisabled,
}: SettingSectionProps) {
	const substrate = useSurface();
	const contentLevel = Math.min(substrate + 1, 8);

	const hasToggle = onToggle !== undefined;
	const isDisabled = hasToggle && !toggled;
	const hasBody =
		children !== undefined && children !== null && children !== false;

	return (
		<SurfaceProvider value={contentLevel}>
			{/* Uniform top gap on EVERY section so spacing reads the same within a
			    panel and across composed panels; the page header supplies the gap
			    above the very first section. */}
			<section className="pt-8">
				<header className="flex items-center gap-2 ps-1">
					{icon && (
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-foreground-muted"
							icon={icon}
							size={13}
						/>
					)}
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<h3 className="min-w-0 font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]">
							{title}
						</h3>
						{description ? <InfoTooltip content={description} /> : null}
					</div>
					{headerAction ? <div className="shrink-0">{headerAction}</div> : null}
					{hasToggle && (
						<div className="shrink-0">
							<Toggle
								aria-label={title}
								checked={toggled ?? false}
								disabled={toggleDisabled}
								onCheckedChange={onToggle}
							/>
						</div>
					)}
				</header>
				{hasBody ? (
					<div
						className={cn(
							"mt-2.5 flex flex-col divide-y divide-divider overflow-hidden rounded-xl bg-foreground/[0.03] px-4 py-1 ring-1 ring-divider transition-opacity duration-200 ease-out",
							isDisabled && "settings-dim pointer-events-none",
						)}
					>
						{children}
					</div>
				) : null}
				{footer ? (
					<div className="ps-1 pt-2 text-body-sm text-foreground-muted">
						{footer}
					</div>
				) : null}
			</section>
		</SurfaceProvider>
	);
}
