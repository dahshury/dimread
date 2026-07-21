import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	DownloadActions,
	type DownloadPhase,
	DownloadProgressBar,
} from "@/shared/ui/download";
import { DemoRow, GallerySection } from "../GallerySection";

/** Interactive mini state machine: Download → Pause → Resume/Discard, so the
 *  tri-state action row can be exercised without a real transfer. */
function DownloadActionsDemo() {
	const t = useTranslations("gallery");
	const [phase, setPhase] = useState<DownloadPhase>("idle");
	return (
		<div className="flex items-center gap-3">
			<DownloadActions
				discardTooltip={t("downloadDiscardTooltip")}
				labels={{
					discard: t("downloadDiscard"),
					download: t("downloadStart"),
					resume: t("downloadResume"),
					stop: t("downloadPause"),
				}}
				onDiscard={() => setPhase("idle")}
				onDownload={() => setPhase("active")}
				onResume={() => setPhase("active")}
				onStop={() => setPhase("paused")}
				phase={phase}
				size="sm"
			/>
			<span className="font-mono text-2xs text-foreground-muted">
				{t("downloadPhaseLabel", { phase })}
			</span>
		</div>
	);
}

export function DownloadsSection() {
	const t = useTranslations("gallery");

	return (
		<GallerySection
			description={t("downloadsDescription")}
			id="downloads"
			title={t("downloadsTitle")}
		>
			<DemoRow label={t("rowProgressBars")}>
				<div className="flex w-full max-w-md flex-col gap-4">
					<DownloadProgressBar
						label={t("progressActiveLabel")}
						percent={45}
						statsLabel="4.5 MB / 10 MB · 2.1 MB/s"
						variant="active"
					/>
					<DownloadProgressBar
						label={t("progressPausedLabel")}
						percent={60}
						statsLabel="6.0 MB / 10 MB"
						variant="paused"
					/>
					<DownloadProgressBar
						label={t("progressUnknownLabel")}
						percent={null}
						variant="active"
					/>
				</div>
			</DemoRow>
			<DemoRow label={t("rowDownloadActions")}>
				<DownloadActionsDemo />
			</DemoRow>
		</GallerySection>
	);
}
