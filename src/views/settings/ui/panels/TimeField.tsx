import { NumberStepper } from "@/shared/ui/number-stepper";
import { formatHm, parseHm } from "./hm-time";

export interface TimeFieldProps {
	ariaHourLabel: string;
	ariaMinuteLabel: string;
	onChange: (value: string) => void;
	/** "HH:MM" clock string. */
	value: string;
}

/**
 * An "HH:MM" time editor built from two hour/minute steppers (matching the
 * CareUEyes sunrise/sunset boxes). Parses the stored clock string, edits each
 * part with its own {@link NumberStepper}, and re-formats on change.
 */
export function TimeField({
	ariaHourLabel,
	ariaMinuteLabel,
	onChange,
	value,
}: TimeFieldProps) {
	const { hours, minutes } = parseHm(value);

	return (
		<div className="flex items-center gap-1.5">
			<div aria-label={ariaHourLabel}>
				<NumberStepper
					max={23}
					min={0}
					onChange={(next) => onChange(formatHm(next, minutes))}
					value={hours}
				/>
			</div>
			<span aria-hidden="true" className="font-mono text-foreground-muted">
				:
			</span>
			<div aria-label={ariaMinuteLabel}>
				<NumberStepper
					max={59}
					min={0}
					onChange={(next) => onChange(formatHm(hours, next))}
					value={minutes}
				/>
			</div>
		</div>
	);
}
