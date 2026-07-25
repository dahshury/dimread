import { useTranslations } from "use-intl";
import { DISPLAY_MODES } from "@/shared/config/display-modes";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";

export interface ModeGridProps {
	activeMode: string;
	grayscaleApplied: boolean | undefined;
	onSelect: (mode: string) => void;
}

/**
 * The eight-mode preset switch (parity F1.3/F1.4): one segmented control laid
 * out as a 4×2 grid, using the shared `Switcher` — the same rectangular
 * button-group the tray presets use in the source app. Selecting a segment
 * patches `display.mode`; the sliding pill marks the active mode and each
 * segment's description shows in its tooltip. A one-line description of the
 * active mode sits beneath the control.
 */
export function ModeGrid({
	activeMode,
	grayscaleApplied,
	onSelect,
}: ModeGridProps) {
	const t = useTranslations("displayTab");
	const readingDegraded =
		activeMode === "reading" && grayscaleApplied === false;

	const options: readonly SwitcherOption[] = DISPLAY_MODES.map((mode) => ({
		icon: mode.icon,
		label: t(mode.nameKey),
		tooltip: t(mode.descKey),
		value: mode.id,
	}));

	const activeEntry =
		DISPLAY_MODES.find((mode) => mode.id === activeMode) ?? DISPLAY_MODES[0];

	return (
		<div className="flex flex-col gap-3">
			<Switcher
				columns={4}
				fullWidth
				onChange={onSelect}
				options={options}
				value={activeMode}
			/>
			<p className="min-h-[1.25rem] text-body-sm text-foreground-muted leading-5">
				{readingDegraded
					? t("modeReadingGrayscaleUnavailable")
					: activeEntry
						? t(activeEntry.descKey)
						: null}
			</p>
		</div>
	);
}
