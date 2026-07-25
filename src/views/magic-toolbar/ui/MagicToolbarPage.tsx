import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m as motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { commands, events } from "@/bindings";
import { useSettingsStore, useSettingsSync } from "@/entities/setting";
import {
	cleared,
	INITIAL_TOOLBAR_STATE,
	isEffectActive,
	onHide,
	onShow,
	safeToolbarColor,
	toggleDark,
	toggleGray,
} from "@/features/magicx";
import { hasNativeRuntime, subscribeNativeEventPair } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { GLASS_SURFACE } from "@/shared/ui/glass-pill";
import { springs } from "@/shared/lib/springs";
import { useTransparentBody } from "@/shared/lib/window-effects";

/** Fire a backend command when the native runtime is present (a no-op in the
 *  browser preview). Module-scope: it closes over nothing component-local. */
function runCommand(thunk: () => Promise<unknown>): void {
	if (hasNativeRuntime()) {
		void thunk().catch(() => undefined);
	}
}

/** One Dark / Gray effect toggle. Active buttons tint with the user's toolbar
 *  colour (a runtime value, so it's applied inline, not via a token). */
function EffectButton({
	active,
	color,
	label,
	onClick,
}: {
	active: boolean;
	color: string;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"h-6 rounded-full px-2.5 font-medium text-[11px] leading-none transition-colors",
				active
					? "text-white"
					: "text-foreground-secondary hover:bg-surface-3 hover:text-foreground",
			)}
			onClick={onClick}
			style={active ? { backgroundColor: color } : undefined}
			type="button"
		>
			{label}
		</button>
	);
}

/**
 * The `magic-toolbar` window's whole surface — the tiny hover Magic Toolbar
 * (Dark / Gray / Close; F9.2) that appears near the top of a hovered window. It
 * is transparent, always-on-top and non-activating (clickable without stealing
 * focus). Its visibility + target effect flags follow the `magictoolbar:show` /
 * `magictoolbar:hide` events; the buttons drive `magicx_toggle_effect` /
 * `magicx_clear_target`; backend callbacks push authoritative flag changes.
 */
export function MagicToolbarPage() {
	// The OS window is fully transparent — html/body must be too.
	useTransparentBody();
	// Keep the local settings store live so the toolbar tint follows edits.
	useSettingsSync();
	const t = useTranslations("magicxTab");
	const toolbarColor = safeToolbarColor(
		useSettingsStore((s) => s.settings.magicx.toolbarColor),
	);

	const [state, setState] = useState(INITIAL_TOOLBAR_STATE);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		return subscribeNativeEventPair(
			events.magictoolbarShow,
			(event) => {
				setState(onShow(event.payload.targetDark, event.payload.targetGray));
			},
			events.magictoolbarHide,
			() => {
				setState((prev) => onHide(prev));
			},
			() => commands.magictoolbarRendererReady(),
		);
	}, []);

	const handleDark = () => {
		setState(toggleDark);
		runCommand(() => commands.magicxToggleEffect("dark"));
	};
	const handleGray = () => {
		setState(toggleGray);
		runCommand(() => commands.magicxToggleEffect("gray"));
	};
	const handleClose = () => {
		setState(cleared);
		runCommand(() => commands.magicxClearTarget());
	};

	return (
		<div className="flex h-dvh w-dvw items-center justify-center overflow-hidden">
			<AnimatePresence
				onExitComplete={() =>
					runCommand(() => commands.magictoolbarHideComplete())
				}
			>
				{state.visible ? (
					<motion.div
						animate={{ opacity: 1, y: 0, scale: 1 }}
						className={cn(
							"relative flex items-center gap-0.5 rounded-full px-1 py-1 shadow-glass-chip",
							GLASS_SURFACE,
						)}
						exit={{ opacity: 0, y: -4, scale: 0.96 }}
						initial={{ opacity: 0, y: -4, scale: 0.96 }}
						transition={springs.fast}
					>
						{/* Coloured grip along the top edge (the toolbar's "handle"). */}
						<span
							aria-hidden="true"
							className="pointer-events-none absolute inset-x-4 top-0 h-0.5 rounded-full"
							style={{ backgroundColor: toolbarColor }}
						/>
						<EffectButton
							active={state.dark}
							color={toolbarColor}
							label={t("buttonDark")}
							onClick={handleDark}
						/>
						<EffectButton
							active={state.gray}
							color={toolbarColor}
							label={t("buttonGray")}
							onClick={handleGray}
						/>
						<AnimatePresence initial={false}>
							{isEffectActive(state) ? (
								<motion.button
									animate={{ opacity: 1, scale: 1 }}
									aria-label={t("buttonClose")}
									className="flex h-6 items-center justify-center rounded-full px-1.5 text-foreground-muted hover:bg-surface-3 hover:text-foreground"
									exit={{ opacity: 0, scale: 0.7 }}
									initial={{ opacity: 0, scale: 0.7 }}
									key="close"
									onClick={handleClose}
									transition={springs.fast}
									type="button"
								>
									<HugeiconsIcon
										icon={Cancel01Icon}
										size={13}
										strokeWidth={2.5}
									/>
								</motion.button>
							) : null}
						</AnimatePresence>
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}
