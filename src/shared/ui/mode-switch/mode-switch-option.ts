import type { IconSvgElement } from "@hugeicons/react";

/** One selectable mode in a {@link ModeSwitch} (2–5 per control). */
export interface ModeSwitchMode<T extends string = string> {
	/** When true the mode is dimmed and skipped while cycling. */
	disabled?: boolean;
	/** Leading glyph rendered before the label (and alone in tight pills). */
	icon?: IconSvgElement;
	label: string;
	value: T;
}

/**
 * The pill's cycle step: the next enabled mode after `current`, wrapping at
 * the end. Returns `current` when nothing else is enabled (nowhere to go).
 */
export function cycleMode<T extends string>(
	modes: readonly ModeSwitchMode<T>[],
	current: T,
	delta: 1 | -1 = 1,
): T {
	if (modes.length === 0) {
		return current;
	}
	const start = modes.findIndex((mode) => mode.value === current);
	// Unknown current value: land on the first enabled mode.
	const from = start === -1 ? (delta === 1 ? -1 : 0) : start;
	for (let step = 1; step <= modes.length; step++) {
		const index = (from + delta * step + modes.length * step) % modes.length;
		const candidate = modes[index];
		if (candidate && !candidate.disabled && candidate.value !== current) {
			return candidate.value;
		}
	}
	return current;
}

/** The mode entry for `value`, if it exists. */
export function findMode<T extends string>(
	modes: readonly ModeSwitchMode<T>[],
	value: T,
): ModeSwitchMode<T> | undefined {
	return modes.find((mode) => mode.value === value);
}
