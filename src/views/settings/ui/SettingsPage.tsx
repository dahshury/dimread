import { Button as BaseButton } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
	Cancel01Icon,
	CenterFocusIcon,
	FilterIcon,
	InformationCircleIcon,
	KeyboardIcon,
	Settings01Icon,
	Sun03Icon,
	SunriseIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import {
	flushPendingSettings,
	type SettingsHydrationStatus,
	useSettingsHydrationStore,
	useSettingsStore,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import {
	useEscapeToClose,
	useTransparentBody,
} from "@/shared/lib/window-effects";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { useAppWindowReveal } from "../model/use-app-window-reveal";
import {
	useSettingsWindowMotion,
	type WindowExitIntent,
} from "../model/use-settings-window-motion";
import { AboutPanel } from "./AboutPanel";
import { GeneralPanel } from "./GeneralPanel";
import { DisplayPanel } from "./panels/DisplayPanel";
import { HotkeysPanel } from "./panels/HotkeysPanel";
import { RulesPanel } from "./panels/RulesPanel";
import { SchedulePanel } from "./panels/SchedulePanel";
import { WindowEffectsPanel } from "./panels/WindowEffectsPanel";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

function SettingsPanelContent({ tab }: { tab: string }): ReactNode {
	switch (tab) {
		case "general":
			return <GeneralPanel />;
		case "hotkeys":
			return <HotkeysPanel />;
		case "schedule":
			return <SchedulePanel />;
		case "windowEffects":
			return <WindowEffectsPanel />;
		case "rules":
			return <RulesPanel />;
		case "about":
			return <AboutPanel />;
		// `display` is the landing tab, so it is also the fallback for an
		// unrecognised key.
		default:
			return <DisplayPanel />;
	}
}

function SettingsHydrationPanel({
	error,
	status,
}: {
	error: string | null;
	status: SettingsHydrationStatus;
}) {
	const common = useTranslations("common");
	const settings = useTranslations("settings");
	const message =
		status === "error" ? (error ?? common("loading")) : common("loading");

	return (
		<div
			aria-live="polite"
			className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 text-center text-foreground-secondary"
			role={status === "error" ? "alert" : "status"}
		>
			<HugeiconsIcon icon={InformationCircleIcon} size={22} />
			<div className="font-medium text-foreground">{settings("title")}</div>
			<div className="max-w-md text-sm leading-6">{message}</div>
		</div>
	);
}

/** Sidebar rail links — every surface in the app.
 *
 *  This window IS the app: the live controls (sliders, preset modes, auto
 *  day/night) sit at the top of the Display tab and every setting behind them
 *  lives one tab away.
 *
 *  The rail is grouped on ONE axis — what a setting acts on. **Screen** holds
 *  the four surfaces that change what you see (the filter itself, the clock that
 *  drives it, the foreground-window automation that overrides it, and the
 *  overlays painted on top of windows); **App** holds the three that are about
 *  DimRead rather than your display. Display leads because it is the landing tab
 *  ({@link INITIAL_TAB}) — opening the app should land on the controls, not on a
 *  preferences page.
 *
 *  Tabs are merged, not multiplied: "Day & night" and "Auto dark" were one
 *  question ("when is it night?") answered on two tabs, and "Magic window" was
 *  six rows of the same kind of thing as Focus. Before adding a rail entry, check
 *  that it is a new AXIS and not a new section of an existing tab.
 *
 *  Each link carries per-tab search keywords (its setting names) so the sidebar
 *  search surfaces a tab by its contents, which is what keeps the roster
 *  navigable however it is grouped. */
function useSettingsSidebarLinks(): SidebarLink[] {
	const t = useTranslations("settings");
	const tHotkeys = useTranslations("hotkeys");
	return [
		{
			key: "display",
			label: t("display"),
			icon: Sun03Icon,
			tooltip: t("displayTooltip"),
			keywords: t("displayKeywords"),
			groupLabel: t("navScreen"),
		},
		{
			key: "schedule",
			label: t("schedule"),
			icon: SunriseIcon,
			tooltip: t("scheduleTooltip"),
			keywords: t("scheduleKeywords"),
		},
		{
			key: "rules",
			label: t("rules"),
			icon: FilterIcon,
			tooltip: t("rulesTooltip"),
			keywords: t("rulesKeywords"),
		},
		{
			key: "windowEffects",
			label: t("windowEffects"),
			icon: CenterFocusIcon,
			tooltip: t("windowEffectsTooltip"),
			keywords: t("windowEffectsKeywords"),
		},
		{
			key: "hotkeys",
			label: t("hotkeys"),
			icon: KeyboardIcon,
			tooltip: t("hotkeysTooltip"),
			keywords: `${tHotkeys("sectionTitle")} ${tHotkeys("toggleMainLabel")} ${tHotkeys("brightnessUpLabel")} ${tHotkeys("tempUpLabel")} ${tHotkeys("toggleFilterLabel")}`,
			groupLabel: t("navApp"),
		},
		{
			key: "general",
			label: t("general"),
			icon: Settings01Icon,
			tooltip: t("generalTooltip"),
			keywords: `${t("generalAutostart")} ${t("generalMinimizeToTray")} ${t("appearance")} ${t("appearanceLocale")} ${t("appearanceReducedMotion")}`,
		},
		{
			key: "about",
			label: t("about"),
			icon: InformationCircleIcon,
			tooltip: t("aboutTooltip"),
			keywords: `${t("aboutVersion")} ${t("aboutLinks")} ${t("aboutCredits")} ${t("aboutUpdates")}`,
		},
	];
}

/** End the exit animation the way the gesture that started it meant.
 *
 *  `close` is the X button and Alt+F4: a real close, which quits the app unless
 *  `general.minimizeToTray` is on. `dismiss` is Escape: a "get this off my
 *  screen" gesture that must ALWAYS just hide to the tray — Escape taking the
 *  whole app down (and with it the user's display filters) would be a trap. */
function runExit(intent: WindowExitIntent): void {
	void (intent === "dismiss"
		? commands.hideAppWindow()
		: commands.closeSelfWindow());
}

/** Landing tab. Opening the app shows the live controls, not a preferences
 *  page — the Display panel renders `QuickControls` above its own settings. */
const INITIAL_TAB = "display";

/**
 * The app window: a transparent OS window whose visible "window" is the CSS
 * card — sidebar rail + elevated content card — animated open/closed as one
 * unit.
 *
 * This is DimRead's ONLY top-level window. It owns both the live controls (the
 * `QuickControls` block at the top of the Display tab — sliders, preset modes,
 * auto day/night) and every configuration surface behind the rail. The tray
 * flyout is the one other control surface; it renders the same controls from
 * the same `features/display` seam, so the two stay in sync.
 *
 * Saves flow through the shared debounced, revision-checked settings pipeline
 * (`entities/setting`) and the `settings:changed` broadcast keeps every window
 * in sync. Closing this window hides to the tray, or quits, depending on
 * `general.minimizeToTray` — that decision lives in Rust
 * (`window_state::close_primary_window`), reached through `close_self_window`.
 * Escape deliberately takes the other path; see {@link ExitIntent}.
 */
export function SettingsPage() {
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const hydrationStatus = useSettingsHydrationStore((s) => s.status);
	const hydrationError = useSettingsHydrationStore((s) => s.error);
	const canRenderSettings =
		isLoaded &&
		(hydrationStatus === "ready" || hydrationStatus === "unavailable");
	const t = useTranslations("settings");
	const [activeTab, setActiveTab] = useState(INITIAL_TAB);
	const contentViewportRef = useRef<HTMLDivElement>(null);
	// Reset the shared ScrollArea to the top on each tab switch.
	useEffect(() => {
		contentViewportRef.current?.scrollTo({ top: 0 });
	}, [activeTab]);
	// The OS window is fully transparent — html/body must be too, or WebView2
	// paints an opaque page background behind the rounded card.
	useTransparentBody();
	// Flush any debounced (unsaved) edits the moment the window hides, so a
	// quick toggle-then-close never loses its save.
	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				flushPendingSettings();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);

	const contentReady = canRenderSettings || hydrationStatus === "error";
	// The OS window is created hidden; this renderer owns the moment it first
	// appears, so the user never sees an empty transparent rectangle.
	useAppWindowReveal(contentReady);
	// One exit animation, two endings: the intent rides through the motion
	// driver and comes back out in `runExit`.
	const {
		motionClassName,
		onShellTransitionEnd,
		requestClose,
		requestDismiss,
		shellRef,
	} = useSettingsWindowMotion(runExit, contentReady);
	const closeActivation = useTouchActivation(requestClose);
	useEscapeToClose(requestDismiss);

	const links = useSettingsSidebarLinks();
	const contentLink = links.find((l) => l.key === activeTab) ?? links[0];

	return (
		<SurfaceProvider value={1}>
			{/* Transparent viewport: the p-5 gutter reserves room for the card's
			    shadow; the shell card below IS the visible "window". */}
			<div className="flex h-dvh min-h-dvh p-5">
				<div
					className={cn(
						"t-modal noise-overlay settings-window-shell relative flex min-w-0 flex-1 overflow-hidden rounded-[1.35rem] shadow-settings-window ring-1 ring-divider-strong",
						motionClassName,
					)}
					onTransitionEnd={onShellTransitionEnd}
					ref={shellRef}
				>
					<Tabs.Root
						className="flex flex-1 overflow-hidden"
						onValueChange={(v) => setActiveTab(String(v))}
						orientation="vertical"
						value={activeTab}
					>
						<SettingsSidebar links={links} />
						<div className="settings-content-frame relative min-w-0 flex-1 py-2 pe-2">
							{/* Drag strip — the thin margin above the content card; the
							    window is frameless, so this gives the content side a grab
							    handle aligned with the sidebar's top drag strip. */}
							<div
								aria-hidden="true"
								className="titlebar-drag absolute inset-x-0 top-0 z-titlebar h-1.5"
							/>
							<Elevated
								className="settings-content-card relative flex h-full flex-col overflow-hidden rounded-[1.35rem] ring-1 ring-divider-strong"
								offset={2}
								shadowLevel={5}
							>
								<BaseButton
									aria-label={t("close")}
									className="titlebar-no-drag group absolute end-1.5 top-1.5 z-titlebar flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-4 text-foreground-muted outline-none transition-colors duration-150 hover:bg-error/85 hover:text-on-error focus-visible:ring-2 focus-visible:ring-accent"
									type="button"
									{...closeActivation}
								>
									<HugeiconsIcon
										className="transition-transform duration-150 ease-out group-hover:scale-110"
										icon={Cancel01Icon}
										size={15}
									/>
								</BaseButton>
								<ScrollArea
									className="min-h-0 flex-1"
									revealScrollbarOnHover={false}
									rubberBandOnTouch
									verticalOnly
									verticalScrollbarClassName="mb-3 me-1"
									viewportClassName="settings-scroll-edge-fade px-7 pt-6 pb-5"
									viewportRef={contentViewportRef}
								>
									{canRenderSettings && contentLink ? (
										<header className="titlebar-drag -mt-6 flex flex-col gap-1.5 pt-6 pb-0">
											<h2 className="min-w-0 pe-10 font-semibold text-[22px] text-foreground leading-tight tracking-[-0.02em]">
												{contentLink.label}
											</h2>
											{contentLink.tooltip ? (
												<p className="max-w-xl text-body-sm text-foreground-muted">
													{contentLink.tooltip}
												</p>
											) : null}
										</header>
									) : null}
									<Tabs.Panel className="outline-none" value={activeTab}>
										{canRenderSettings ? (
											<SettingsPanelContent tab={activeTab} />
										) : (
											<SettingsHydrationPanel
												error={hydrationError}
												status={hydrationStatus}
											/>
										)}
									</Tabs.Panel>
								</ScrollArea>
							</Elevated>
						</div>
					</Tabs.Root>
				</div>
			</div>
		</SurfaceProvider>
	);
}
