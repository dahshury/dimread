import { useTranslations } from "use-intl";
import type { DisplayOutput } from "@/bindings";

export interface LiveReadoutProps {
	state: DisplayOutput | null;
}

/**
 * The real-time colour-temperature / brightness readout (parity F1.12), shown
 * at the panel's top-right. Driven by the engine's `display:state` output, so
 * it reflects the applied Kelvin/brightness (including live previews). Renders
 * nothing until the first value arrives.
 */
export function LiveReadout({ state }: LiveReadoutProps) {
	const t = useTranslations("displayTab");
	if (!state) {
		return null;
	}
	return (
		<span className="shrink-0 font-mono text-body-sm text-foreground-muted tabular-nums">
			{t("currentReadout", {
				kelvin: state.kelvin,
				percent: state.brightness,
			})}
		</span>
	);
}
