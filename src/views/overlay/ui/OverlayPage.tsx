import {
	Alert02Icon,
	AlertCircleIcon,
	CheckmarkCircle02Icon,
	InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { useEffect } from "react";
import {
	commands,
	type OverlayNotification,
	type OverlayTone,
} from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";
import { useTransparentBody } from "@/shared/lib/window-effects";
import {
	DynamicIsland,
	DynamicIslandProvider,
} from "@/shared/ui/dynamic-island";
import { useOverlayNotifications } from "../model/use-overlay-notifications";

/** tone → icon + status-token color class (see globals.css `@theme`). */
const TONE_PRESENTATION: Record<
	OverlayTone,
	{ icon: IconSvgElement; className: string }
> = {
	neutral: { icon: InformationCircleIcon, className: "text-foreground-muted" },
	success: { icon: CheckmarkCircle02Icon, className: "text-success" },
	warning: { icon: Alert02Icon, className: "text-warning" },
	error: { icon: AlertCircleIcon, className: "text-error" },
};

function reportOverlayHideComplete(sequence: number): void {
	if (hasNativeRuntime()) {
		void commands.overlayHideComplete(sequence);
	}
}

function NotificationContent({
	notification,
}: {
	notification: OverlayNotification;
}) {
	const tone = TONE_PRESENTATION[notification.tone];
	return (
		<div className="flex items-center gap-3 px-5 py-3">
			<HugeiconsIcon
				aria-hidden="true"
				className={`shrink-0 ${tone.className}`}
				icon={tone.icon}
				size={20}
				strokeWidth={2}
			/>
			<div className="flex min-w-0 flex-col gap-0.5">
				{notification.title ? (
					<span className="truncate font-semibold text-overlay-foreground text-sm leading-tight">
						{notification.title}
					</span>
				) : null}
				<span className="line-clamp-3 break-words text-overlay-foreground/75 text-xs leading-snug">
					{notification.message}
				</span>
			</div>
		</div>
	);
}

/**
 * The overlay window's whole surface: a DynamicIsland pill hanging flush from
 * the top screen edge (`flatTop`), fed by `overlay:notify`. The OS window is
 * click-through and non-focusable, so the pill is purely presentational —
 * dismissal is time- or command-driven (`overlay_dismiss`), never a click.
 *
 * Enter/exit is the `t-panel-slide-top` reveal that DynamicIsland applies via
 * its `data-open` wrapper: hidden state = the `empty` (0×0) preset. Rust hides
 * the renderer reports the actual retract completion before Rust hides the
 * native window.
 */
export function OverlayPage() {
	// The OS window is fully transparent — html/body must be too, or WebView2
	// paints an opaque page background behind the pill.
	useTransparentBody();
	const { generation, notification, visible } = useOverlayNotifications();

	useEffect(() => {
		if (
			generation > 0 &&
			!visible &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
		) {
			reportOverlayHideComplete(generation);
		}
	}, [generation, visible]);

	return (
		<div
			className="flex h-dvh items-start justify-center overflow-hidden"
			onTransitionEnd={(event) => {
				const target = event.target;
				if (
					target instanceof HTMLElement &&
					target.classList.contains("t-panel-slide-top") &&
					target.dataset["open"] === "false" &&
					event.propertyName === "transform"
				) {
					reportOverlayHideComplete(generation);
				}
			}}
		>
			<DynamicIslandProvider initialSize="empty">
				<div aria-live="polite" role="status">
					<DynamicIsland
						fitContent
						flatTop
						id="overlay-notification-island"
						size={visible ? "compactLong" : "empty"}
					>
						{notification ? (
							<NotificationContent notification={notification} />
						) : null}
					</DynamicIsland>
				</div>
			</DynamicIslandProvider>
		</div>
	);
}
