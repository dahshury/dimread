import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, useSurface } from "@/shared/lib/surface";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSectionProps {
	/**
	 * Grouped-card presentation: the title demotes to a small uppercase
	 * micro-label and the body rows sit inside a hairline-ringed, rounded group
	 * with a translucent additive fill — it lifts gently above the panel's
	 * bloomed gradient without out-climbing the raised controls inside it.
	 */
	boxed?: boolean;
	children?: ReactNode;
	/** Optional help text shown in an info-icon tooltip next to the title. */
	description?: string;
	/**
	 * Wrap the body in the standard settings field column with a hairline
	 * divider between rows, so a run of bare fields reads as one grouped list.
	 */
	divided?: boolean;
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
 * Top-level grouping inside a settings panel (ported from WinSTT). Default is
 * a FLAT flowing section: heading row + hairline divider + form rows on the
 * panel surface. `boxed` demotes the title to a micro-label and frames the
 * rows in a rounded group. Either way the section re-provides a +1 surface
 * step downward WITHOUT painting it, so nested elevated controls keep the
 * same elevation regardless of presentation.
 */
export function SettingSection({
	boxed,
	children,
	description,
	divided,
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
	const body = divided ? (
		<div className="flex flex-col divide-y divide-divider">{children}</div>
	) : (
		children
	);

	return (
		<SurfaceProvider value={contentLevel}>
			{/* Uniform top gap on EVERY section so spacing reads the same within a
			    panel and across composed panels; the page header supplies the gap
			    above the very first section. */}
			<section className="pt-8">
				<header
					className={cn("flex items-center", boxed ? "gap-2 ps-1" : "gap-2.5")}
				>
					{icon && (
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-foreground-muted"
							icon={icon}
							size={boxed ? 13 : 15}
						/>
					)}
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<h3
							className={
								boxed
									? "min-w-0 font-semibold text-2xs text-foreground-muted uppercase tracking-[0.11em]"
									: "min-w-0 font-semibold text-foreground text-subtitle tracking-[-0.01em]"
							}
						>
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
				{boxed ? null : (
					<div aria-hidden="true" className="mt-2.5 h-px w-full bg-divider" />
				)}
				{hasBody ? (
					<div
						className={cn(
							"transition-opacity duration-200 ease-out",
							boxed
								? "mt-2.5 rounded-xl bg-foreground/[0.03] px-4 py-1 ring-1 ring-divider"
								: "pt-1",
							isDisabled && "settings-dim pointer-events-none",
						)}
					>
						{body}
					</div>
				) : null}
				{footer ? (
					<div
						className={cn(
							"pt-2 text-body-sm text-foreground-muted",
							boxed && "ps-1",
						)}
					>
						{footer}
					</div>
				) : null}
			</section>
		</SurfaceProvider>
	);
}
