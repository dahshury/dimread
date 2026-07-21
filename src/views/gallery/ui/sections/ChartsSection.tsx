import { useTranslations } from "use-intl";
import { formatBytes } from "@/shared/lib/format-bytes";
import {
	BarChart,
	type BarChartDatum,
	LineChart,
	type LineChartPoint,
	StatRing,
	type StatRingSlice,
} from "@/shared/ui/charts";
import { DemoRow, GallerySection } from "../GallerySection";

/** Deterministic pseudo-random series (no Math.random flicker). */
function seedSeries(
	days: number,
	labelFor: (day: number) => string,
): LineChartPoint[] {
	return Array.from({ length: days }, (_, index) => ({
		label: labelFor(index + 1),
		value: ((index + 3) * 7919) % 97,
	}));
}

const GIB = 1024 ** 3;

export function ChartsSection() {
	const t = useTranslations("charts");

	const line = seedSeries(14, (day) => t("demoDay", { day }));
	const area = seedSeries(21, (day) => t("demoDay", { day }));

	const bars: BarChartDatum[] = [
		{ key: "documents", label: t("demoBarDocuments"), value: 42 },
		{ key: "images", label: t("demoBarImages"), value: 27 },
		{ key: "audio", label: t("demoBarAudio"), value: 18 },
		{ key: "video", label: t("demoBarVideo"), value: 9 },
		{ key: "other", label: t("demoBarOther"), value: 4 },
	];

	const ring: StatRingSlice[] = [
		{ key: "models", label: t("demoRingModels"), value: 3.2 * GIB },
		{ key: "audio", label: t("demoRingAudio"), value: 1.1 * GIB },
		{ key: "cache", label: t("demoRingCache"), value: 0.6 * GIB },
		{ key: "logs", label: t("demoRingLogs"), value: 0.2 * GIB },
	];
	const ringTotal = ring.reduce((sum, slice) => sum + slice.value, 0);

	return (
		<GallerySection
			description={t("sectionDescription")}
			id="charts"
			title={t("sectionTitle")}
		>
			<DemoRow label={t("rowLine")}>
				<LineChart
					ariaLabel={t("lineAria")}
					className="h-24 w-full max-w-xl"
					data={line}
					formatValue={(value) => t("demoWords", { value })}
				/>
			</DemoRow>
			<DemoRow label={t("rowArea")}>
				<LineChart
					area
					ariaLabel={t("areaAria")}
					className="h-24 w-full max-w-xl"
					color="var(--color-teal)"
					data={area}
				/>
			</DemoRow>
			<DemoRow label={t("rowBars")}>
				<div className="w-full max-w-xl">
					<BarChart
						data={bars}
						formatLabel={(datum) => `${datum.value} ${datum.label}`}
					/>
				</div>
			</DemoRow>
			<DemoRow label={t("rowRing")}>
				<StatRing
					ariaLabel={t("ringAria")}
					centerLabel={t("ringCenterLabel")}
					centerValue={formatBytes(ringTotal) ?? ""}
					className="w-full max-w-xs"
					formatValue={(value) => formatBytes(value) ?? ""}
					slices={ring}
				/>
			</DemoRow>
		</GallerySection>
	);
}
