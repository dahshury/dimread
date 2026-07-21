import { Separator } from "@base-ui/react/separator";
import {
	Cancel01Icon,
	MinusSignIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { cn } from "@/shared/lib/cn";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { Tooltip } from "@/shared/ui/tooltip";

function TitleBarButton({
	danger = false,
	icon,
	label,
	onClick,
}: {
	danger?: boolean;
	icon: IconSvgElement;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				aria-label={label}
				className={cn(
					"titlebar-no-drag flex h-7 w-9 shrink-0 items-center justify-center text-foreground-muted transition-colors",
					danger
						? "hover:bg-error/80 hover:text-on-error"
						: "hover:bg-surface-4 hover:text-foreground",
				)}
				onClick={onClick}
				type="button"
			>
				<HugeiconsIcon className="size-3.5" icon={icon} strokeWidth={1.8} />
			</button>
		</Tooltip>
	);
}

/**
 * Slim window header for the frameless main window: a draggable title strip
 * with settings / minimize / close controls on the right. Close routes
 * through the native CloseRequested handler, so it honors the
 * "minimize to tray" setting (and the quit watchdog) exactly like the OS
 * titlebar would.
 */
export function TitleBar() {
	const t = useTranslations("titleBar");
	return (
		<header className="titlebar-drag flex h-8 shrink-0 select-none items-stretch border-border/60 border-b bg-surface-2">
			<div className="flex min-w-0 flex-1 items-center gap-2 pl-2.5">
				<img
					alt=""
					aria-hidden="true"
					className="size-4 shrink-0 rounded-[4px]"
					draggable={false}
					src="/app-icon.png"
				/>
				<span className="truncate font-medium text-2xs text-foreground-muted tracking-wide">
					{t("appName")}
				</span>
			</div>
			<div className="flex shrink-0 items-stretch">
				<TitleBarButton
					icon={Settings01Icon}
					label={t("openSettings")}
					onClick={() => {
						fireAndForget(
							commands.openWindow("settings", null, null, null, null),
						);
					}}
				/>
				<Separator
					className="my-2 w-px shrink-0 bg-border/60"
					orientation="vertical"
				/>
				<TitleBarButton
					icon={MinusSignIcon}
					label={t("minimize")}
					onClick={() => {
						fireAndForget(getCurrentWindow().minimize());
					}}
				/>
				<TitleBarButton
					danger
					icon={Cancel01Icon}
					label={t("close")}
					onClick={() => {
						fireAndForget(getCurrentWindow().close());
					}}
				/>
			</div>
		</header>
	);
}
