import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/shared/ui/button";

interface AboutActionRowProps {
	buttonLabel: string;
	danger?: boolean;
	disabled?: boolean;
	icon: IconSvgElement;
	onClick: () => void;
	summary: string;
	title: string;
}

export function AboutActionRow({
	buttonLabel,
	danger = false,
	disabled,
	icon,
	onClick,
	summary,
	title,
}: AboutActionRowProps) {
	return (
		<div className="flex items-center gap-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="font-medium text-body text-foreground">{title}</span>
				<span className="text-body-sm text-foreground-muted leading-snug">
					{summary}
				</span>
			</div>
			<Button
				className={
					danger
						? "h-8 w-48 shrink-0 gap-2 rounded-lg bg-error-dim/30 px-3 font-medium text-error hover:bg-error-dim/50"
						: "h-8 w-48 shrink-0 gap-2 rounded-lg border border-border bg-surface-3 px-3 text-foreground-secondary hover:bg-surface-4"
				}
				disabled={disabled}
				onClick={onClick}
			>
				<HugeiconsIcon aria-hidden="true" icon={icon} size={14} />
				<span className="truncate">{buttonLabel}</span>
			</Button>
		</div>
	);
}
