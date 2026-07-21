import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { AnimatedValueText, IconSwap } from "@/shared/ui/animated-value";
import { Button } from "@/shared/ui/button";
import {
	DynamicIsland,
	DynamicIslandProvider,
	type DynamicIslandSize,
} from "@/shared/ui/dynamic-island";
import { MediaSeekBar } from "@/shared/ui/media-seek-bar";
import { ScrollingText } from "@/shared/ui/scrolling-text";
import { StaggerReveal } from "@/shared/ui/stagger-reveal";
import { Switcher } from "@/shared/ui/switcher";
import { DemoRow, GallerySection } from "../GallerySection";

const NEUTRAL_BUTTON =
	"h-8 gap-1.5 rounded-md border border-border bg-surface-3 px-3 text-foreground-secondary text-sm transition-colors hover:bg-surface-4";

type IslandSize = Extract<DynamicIslandSize, "default" | "compact" | "large">;

function TickingCounter() {
	const t = useTranslations("gallery");
	const [count, setCount] = useState(0);
	useEffect(() => {
		const timer = setInterval(
			() => setCount((value) => (value + 1) % 1000),
			1000,
		);
		return () => clearInterval(timer);
	}, []);
	return (
		<AnimatedValueText
			className="font-mono text-foreground-secondary text-sm tabular-nums"
			text={t("counterValue", { count })}
		/>
	);
}

export function MotionSection() {
	const t = useTranslations("gallery");
	const [iconState, setIconState] = useState<"a" | "b">("a");
	const [staggerKey, setStaggerKey] = useState(0);
	const [islandSize, setIslandSize] = useState<IslandSize>("default");
	const [playhead, setPlayhead] = useState(42);

	return (
		<GallerySection
			description={t("motionDescription")}
			id="motion"
			title={t("motionTitle")}
		>
			<DemoRow label={t("rowAnimatedValue")}>
				<TickingCounter />
				<Button
					className={NEUTRAL_BUTTON}
					onClick={() => setIconState((s) => (s === "a" ? "b" : "a"))}
				>
					<IconSwap
						a={<HugeiconsIcon icon={Sun01Icon} size={15} />}
						b={<HugeiconsIcon icon={Moon02Icon} size={15} />}
						state={iconState}
					/>
					{t("iconSwapLabel")}
				</Button>
			</DemoRow>
			<DemoRow label={t("rowScrollingText")}>
				<div className="w-72 rounded-md bg-surface-2 px-3 py-2 ring-1 ring-divider">
					<ScrollingText
						className="text-body-sm text-foreground-secondary"
						fadeColor="var(--color-surface-2)"
						maxLines={2}
						text={t("scrollingTextBody")}
					/>
				</div>
			</DemoRow>
			<DemoRow label={t("rowStaggerReveal")}>
				<div className="flex flex-col gap-2">
					<Button
						className={NEUTRAL_BUTTON}
						onClick={() => setStaggerKey((k) => k + 1)}
					>
						{t("staggerReplay")}
					</Button>
					<StaggerReveal active key={staggerKey}>
						<p className="t-stagger-line max-w-md text-body-sm text-foreground-secondary">
							{t("staggerLine1")}
						</p>
						<p className="t-stagger-line max-w-md text-body-sm text-foreground-secondary">
							{t("staggerLine2")}
						</p>
						<p className="t-stagger-line max-w-md text-body-sm text-foreground-secondary">
							{t("staggerLine3")}
						</p>
					</StaggerReveal>
				</div>
			</DemoRow>
			<DemoRow label={t("rowDynamicIsland")}>
				<div className="flex w-full flex-col items-center gap-3">
					<Switcher<IslandSize>
						onChange={setIslandSize}
						options={[
							{ value: "default", label: t("islandDefault") },
							{ value: "compact", label: t("islandCompact") },
							{ value: "large", label: t("islandLarge") },
						]}
						size="sm"
						value={islandSize}
					/>
					<DynamicIslandProvider initialSize="default">
						<DynamicIsland id="gallery-island" size={islandSize}>
							<div className="flex h-full items-center justify-center gap-2 px-4">
								<span className="size-1.5 rounded-full bg-accent" />
								<span className="truncate font-mono text-overlay-foreground/80 text-xs">
									{t("islandContent")}
								</span>
							</div>
						</DynamicIsland>
					</DynamicIslandProvider>
				</div>
			</DemoRow>
			<DemoRow label={t("rowMediaSeekBar")}>
				<div className="w-80">
					<MediaSeekBar
						bufferedEnd={120}
						currentTime={playhead}
						duration={180}
						onSeek={setPlayhead}
						tone="surface"
					/>
				</div>
			</DemoRow>
		</GallerySection>
	);
}
