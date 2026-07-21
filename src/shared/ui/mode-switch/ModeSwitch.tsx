import { Button as BaseButton } from "@base-ui/react/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m as motion,
} from "motion/react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { springs } from "@/shared/lib/springs";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { useControllableState } from "@/shared/lib/use-controllable-state";
import { Switcher } from "@/shared/ui/switcher";
import { Tooltip } from "@/shared/ui/tooltip";
import { cycleMode, findMode, type ModeSwitchMode } from "./mode-switch-option";

export interface ModeSwitchProps<T extends string = string> {
	className?: string | undefined;
	/** Uncontrolled initial mode. Ignored when `value` is provided. */
	defaultValue?: T | undefined;
	/** Stretch across the container (segmented variant only). */
	fullWidth?: boolean | undefined;
	/** The 2–5 selectable modes, in cycle order. */
	modes: readonly ModeSwitchMode<T>[];
	onChange?: ((value: T) => void) | undefined;
	/** Segment density, matching the shared Switcher sizes. */
	size?: "md" | "sm" | undefined;
	/** Controlled mode value. */
	value?: T | undefined;
}

/**
 * An animated segmented mode switcher in the WinSTT recording-mode vocabulary:
 * icon + label per mode over a sliding surface-pill highlight (measured-rect
 * geometry + shared spring tiers, via the shared `Switcher` engine), with
 * arrow-key navigation from the underlying toggle group. Supports 2–5 modes
 * and both controlled (`value`) and uncontrolled (`defaultValue`) usage.
 */
export function ModeSwitch<T extends string = string>({
	className,
	defaultValue,
	fullWidth,
	modes,
	onChange,
	size = "md",
	value,
}: ModeSwitchProps<T>) {
	const fallback = modes[0]?.value as T;
	const [current, setCurrent] = useControllableState<T>(
		value,
		defaultValue ?? fallback,
		onChange,
	);
	return (
		<Switcher<T>
			className={className}
			fullWidth={fullWidth ?? false}
			onChange={setCurrent}
			options={modes.map((mode) => ({
				value: mode.value,
				label: mode.label,
				...(mode.icon ? { icon: mode.icon } : {}),
				...(mode.disabled ? { disabled: true } : {}),
			}))}
			size={size}
			value={current}
		/>
	);
}

export interface ModeSwitchPillProps<T extends string = string> {
	className?: string | undefined;
	/** Uncontrolled initial mode. Ignored when `value` is provided. */
	defaultValue?: T | undefined;
	/** Builds the accessible label / tooltip from the current mode's label,
	 *  e.g. `(label) => t("cycleHint", { mode: label })`. */
	describeMode: (modeLabel: string) => string;
	/** The 2–5 modes cycled through on click (disabled ones are skipped). */
	modes: readonly ModeSwitchMode<T>[];
	onChange?: ((value: T) => void) | undefined;
	/** Controlled mode value. */
	value?: T | undefined;
}

/**
 * The compact footer/tray companion of {@link ModeSwitch}: a one-slot pill
 * (in the footer-chip vocabulary) showing the current mode's icon + label.
 * Clicking cycles forward through the enabled modes; arrow keys cycle in
 * either direction. The label/icon swap animates with the fast spring tier.
 */
export function ModeSwitchPill<T extends string = string>({
	className,
	defaultValue,
	describeMode,
	modes,
	onChange,
	value,
}: ModeSwitchPillProps<T>): ReactNode {
	const fallback = modes[0]?.value as T;
	const [current, setCurrent] = useControllableState<T>(
		value,
		defaultValue ?? fallback,
		onChange,
	);
	const mode = findMode(modes, current) ?? modes[0];
	const substrate = useSurface();
	const pillLevel = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(substrate + 2, 8);

	const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			event.preventDefault();
			setCurrent(cycleMode(modes, current, 1));
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			event.preventDefault();
			setCurrent(cycleMode(modes, current, -1));
		}
	};

	if (!mode) {
		return null;
	}
	const description = describeMode(mode.label);
	return (
		<Tooltip content={description} side="top">
			<BaseButton
				aria-label={description}
				className={cn(
					`flex max-w-full cursor-pointer select-none items-center gap-1 rounded-full ${surfaceBg(pillLevel)} px-2 py-[1px] text-2xs text-foreground-secondary ring-1 ring-divider outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`,
					className,
				)}
				onClick={() => setCurrent(cycleMode(modes, current, 1))}
				onKeyDown={handleKeyDown}
				type="button"
			>
				<LazyMotion features={domAnimation} strict={true}>
					{/* Keyed swap: the outgoing mode fades/slips down while the incoming
					    one rises in — transform/opacity only, fast tier (no `layout`). */}
					<AnimatePresence initial={false} mode="popLayout">
						<motion.span
							animate={{ opacity: 1, y: 0 }}
							className="flex min-w-0 items-center gap-1"
							exit={{ opacity: 0, y: 3, transition: springs.fast.exit }}
							initial={{ opacity: 0, y: -3 }}
							key={mode.value}
							transition={springs.fast}
						>
							{mode.icon ? (
								<HugeiconsIcon
									aria-hidden="true"
									className="shrink-0 text-foreground-dim"
									icon={mode.icon}
									size={11}
								/>
							) : null}
							<span className="truncate">{mode.label}</span>
						</motion.span>
					</AnimatePresence>
				</LazyMotion>
			</BaseButton>
		</Tooltip>
	);
}
