import { useState } from "react";
import { useTranslations } from "use-intl";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { GlassPill } from "@/shared/ui/glass-pill";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { Pending, PendingBadge } from "@/shared/ui/pending";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { Spinner } from "@/shared/ui/spinner";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";
import { Toggle } from "@/shared/ui/toggle";
import { Tooltip } from "@/shared/ui/tooltip";
import { DemoRow, GallerySection } from "../GallerySection";

const NEUTRAL_BUTTON =
	"h-8 gap-1.5 rounded-md border border-border bg-surface-3 px-3 text-foreground-secondary text-sm transition-colors hover:bg-surface-4";

export function PrimitivesSection() {
	const t = useTranslations("gallery");
	const [pendingToggle, setPendingToggle] = useState(false);

	return (
		<GallerySection
			description={t("primitivesDescription")}
			id="primitives"
			title={t("primitivesTitle")}
		>
			<DemoRow label={t("rowBadges")}>
				<Badge variant="default">{t("badgeDefault")}</Badge>
				<Badge variant="secondary">{t("badgeSecondary")}</Badge>
				<Badge variant="outline">{t("badgeOutline")}</Badge>
			</DemoRow>
			<DemoRow label={t("rowStatus")}>
				<Spinner aria-label={t("spinnerLabel")} />
				<PulseDot
					aria-label={t("pulseDotLabel")}
					className="size-2 text-accent"
				/>
				<GlassPill className="gap-2 px-3 py-1.5">
					<PulseDot className="size-1.5 text-accent" />
					<span className="font-mono text-overlay-foreground/80 text-xs">
						{t("glassPillText")}
					</span>
				</GlassPill>
				<ThinkingIndicator
					words={[t("thinkingWord1"), t("thinkingWord2"), t("thinkingWord3")]}
				/>
			</DemoRow>
			<DemoRow label={t("rowTooltips")}>
				<Tooltip content={t("tooltipBody")}>
					<Button className={NEUTRAL_BUTTON}>{t("tooltipTrigger")}</Button>
				</Tooltip>
				<span className="inline-flex items-center gap-1.5 text-body-sm text-foreground-secondary">
					{t("infoTooltipLabel")}
					<InfoTooltip content={t("infoTooltipBody")} />
				</span>
			</DemoRow>
			<DemoRow label={t("rowPending")}>
				<Pending isPending>
					<Button className={NEUTRAL_BUTTON}>{t("pendingButton")}</Button>
				</Pending>
				<PendingBadge pending={pendingToggle}>
					<Toggle
						aria-label={t("pendingToggle")}
						checked={pendingToggle}
						onCheckedChange={setPendingToggle}
					/>
				</PendingBadge>
				<span className="text-body-sm text-foreground-muted">
					{t("pendingHint")}
				</span>
			</DemoRow>
		</GallerySection>
	);
}
