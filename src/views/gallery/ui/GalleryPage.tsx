import { Button as BaseButton } from "@base-ui/react/button";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { cn } from "@/shared/lib/cn";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Tooltip } from "@/shared/ui/tooltip";
import { ButtonsSection } from "./sections/ButtonsSection";
import { ChartsSection } from "./sections/ChartsSection";
import { DataSection } from "./sections/DataSection";
import { DndSection } from "./sections/DndSection";
import { DownloadsSection } from "./sections/DownloadsSection";
import { FormSection } from "./sections/FormSection";
import { ModesSection } from "./sections/ModesSection";
import { MotionSection } from "./sections/MotionSection";
import { OverlayNotifySection } from "./sections/OverlayNotifySection";
import { OverlaysSection } from "./sections/OverlaysSection";
import { PickersSection } from "./sections/PickersSection";
import { PrimitivesSection } from "./sections/PrimitivesSection";
import { SelectsSection } from "./sections/SelectsSection";
import { SettingRowsSection } from "./sections/SettingRowsSection";

const SECTION_IDS = [
	"primitives",
	"buttons",
	"form",
	"selects",
	"pickers",
	"modes",
	"overlays",
	"motion",
	"settingRows",
	"dnd",
	"data",
	"charts",
	"downloads",
	"overlay-notify",
] as const;

type SectionId = (typeof SECTION_IDS)[number];

/** How long a nav click suppresses the scrollspy while smooth-scroll settles. */
const CLICK_SCROLL_SETTLE_MS = 900;

function NavLink({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	const substrate = useSurface();
	const activeLevel = Math.min(substrate + 2, 8);
	return (
		<BaseButton
			className={cn(
				"w-full cursor-pointer select-none rounded-md px-3 py-1.5 text-start text-body-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
				active
					? cn(
							"font-medium text-foreground ring-1 ring-divider",
							surfaceBg(activeLevel),
						)
					: "text-foreground-secondary hover:text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			{label}
		</BaseButton>
	);
}

/**
 * The component showroom: every kept shared/ui primitive with realistic
 * props, grouped into anchored sections on elevated cards. A left rail jumps
 * between sections (the content pane is one shared ScrollArea).
 */
export function GalleryPage() {
	const t = useTranslations("gallery");
	// The overlay/hotkey demo keeps its strings in the feature-scoped
	// `overlay` namespace (shared with the overlay window) rather than
	// `gallery`; the DnD, charts, and setting-row sections likewise use
	// their component namespaces (`dropZone`, `charts`, `settingsField`).
	const tOverlay = useTranslations("overlay");
	const tDropZone = useTranslations("dropZone");
	const tCharts = useTranslations("charts");
	const tSettingsField = useTranslations("settingsField");
	const viewportRef = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState<SectionId>("primitives");
	// While a nav click smooth-scrolls, intermediate sections stream past the
	// observer; hold the clicked target until the scroll settles. A boolean
	// flag armed/reset by a timer (rather than a deadline timestamp) keeps
	// impure clock reads out of render-adjacent code paths.
	const clickScrollActive = useRef(false);
	const clickScrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	// Scrollspy: on scroll, activate the LAST section whose heading has passed
	// the top of the pane (with a small activation band), so the section you
	// are reading is the one highlighted — including at section boundaries.
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) {
			return;
		}
		let raf = 0;
		const update = () => {
			raf = 0;
			if (clickScrollActive.current) {
				return;
			}
			const paneTop = viewport.getBoundingClientRect().top;
			let current: SectionId = "primitives";
			for (const id of SECTION_IDS) {
				const el = viewport.querySelector(`#${id}`);
				if (!el) {
					continue;
				}
				// Sections are in DOM order; stop at the first one still below
				// the activation band.
				if (el.getBoundingClientRect().top - paneTop > 140) {
					break;
				}
				current = id;
			}
			setActive(current);
		};
		const onScroll = () => {
			if (!raf) {
				raf = requestAnimationFrame(update);
			}
		};
		viewport.addEventListener("scroll", onScroll, { passive: true });
		update();
		return () => {
			viewport.removeEventListener("scroll", onScroll);
			if (raf) {
				cancelAnimationFrame(raf);
			}
			clearTimeout(clickScrollTimer.current);
		};
	}, []);

	// Escape closes the gallery, mirroring the settings window.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				fireAndForget(commands.closeSelfWindow());
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const sectionLabels: Record<SectionId, string> = {
		primitives: t("primitivesTitle"),
		buttons: t("buttonsTitle"),
		form: t("formTitle"),
		selects: t("selectsTitle"),
		pickers: t("pickersTitle"),
		modes: t("modesTitle"),
		overlays: t("overlaysTitle"),
		motion: t("motionTitle"),
		settingRows: tSettingsField("sectionTitle"),
		dnd: tDropZone("sectionTitle"),
		data: t("dataTitle"),
		charts: tCharts("sectionTitle"),
		downloads: t("downloadsTitle"),
		"overlay-notify": tOverlay("galleryTitle"),
	};

	const jumpTo = (id: SectionId) => {
		setActive(id);
		clickScrollActive.current = true;
		clearTimeout(clickScrollTimer.current);
		clickScrollTimer.current = setTimeout(() => {
			clickScrollActive.current = false;
		}, CLICK_SCROLL_SETTLE_MS);
		viewportRef.current
			?.querySelector(`#${id}`)
			?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	return (
		<div className="flex h-full flex-col">
			{/* Frameless window: the header doubles as the drag handle. */}
			<header className="titlebar-drag flex shrink-0 select-none items-center gap-2 border-divider border-b px-5 py-3">
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="font-semibold text-[18px] text-foreground leading-tight tracking-[-0.02em]">
						{t("title")}
					</h1>
					<p className="min-w-0 truncate text-body-sm text-foreground-muted">
						{t("subtitle")}
					</p>
				</div>
				<Tooltip content={t("close")}>
					<button
						aria-label={t("close")}
						className="titlebar-no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-error/80 hover:text-on-error"
						onClick={() => fireAndForget(commands.closeSelfWindow())}
						type="button"
					>
						<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
					</button>
				</Tooltip>
			</header>
			<div className="flex min-h-0 flex-1">
				<nav
					aria-label={t("navLabel")}
					className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-divider border-e p-3"
				>
					{SECTION_IDS.map((id) => (
						<NavLink
							active={active === id}
							key={id}
							label={sectionLabels[id]}
							onClick={() => jumpTo(id)}
						/>
					))}
				</nav>
				<ScrollArea
					className="min-h-0 flex-1"
					verticalOnly
					viewportClassName="px-6 pt-5 pb-10"
					viewportRef={viewportRef}
				>
					<PrimitivesSection />
					<ButtonsSection />
					<FormSection />
					<SelectsSection />
					<PickersSection />
					<ModesSection />
					<OverlaysSection />
					<MotionSection />
					<SettingRowsSection />
					<DndSection />
					<DataSection />
					<ChartsSection />
					<DownloadsSection />
					<OverlayNotifySection />
				</ScrollArea>
			</div>
		</div>
	);
}
