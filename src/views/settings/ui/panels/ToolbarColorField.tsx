import { cn } from "@/shared/lib/cn";

export interface ToolbarColorFieldProps {
	/** Accessible label for the colour swatch input. */
	colorLabel: string;
	disabled?: boolean;
	onChange: (color: string) => void;
	onReset: () => void;
	/** Text for the reset link (e.g. "Reset"). */
	resetLabel: string;
	/** Current colour, `#rrggbb`. */
	value: string;
}

/**
 * The Magic Toolbar colour picker (F9.3): a native colour swatch plus a reset
 * link, matching the CareUEyes "Magic Toolbar Color … Reset" row. The colour is
 * arbitrary user data, so the swatch shows it directly (not a theme token).
 */
export function ToolbarColorField({
	colorLabel,
	disabled = false,
	onChange,
	onReset,
	resetLabel,
	value,
}: ToolbarColorFieldProps) {
	return (
		<div className="flex items-center gap-2.5">
			<input
				aria-label={colorLabel}
				className={cn(
					"h-6 w-9 cursor-pointer rounded-md border border-divider bg-transparent p-0",
					"disabled:cursor-not-allowed disabled:opacity-50",
				)}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				type="color"
				value={value}
			/>
			<button
				className={cn(
					"font-medium text-accent text-body-sm transition-colors hover:text-accent-dim",
					"disabled:cursor-not-allowed disabled:opacity-50",
				)}
				disabled={disabled}
				onClick={onReset}
				type="button"
			>
				{resetLabel}
			</button>
		</div>
	);
}
