import {
	Clock01Icon,
	Link01Icon,
	RefreshIcon,
	Task01Icon,
	UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/button";
import {
	CalendarHeatmap,
	type WeightedDateEntry,
} from "@/shared/ui/calendar-heatmap";
import {
	EditableRecordsGrid,
	getDataGridSelectColumn,
	getFilterFn,
} from "@/shared/ui/data-grid";
import {
	EntryCard,
	type EntryCardMetaPart,
	EntryCardShell,
} from "@/shared/ui/entry-card-list";
import {
	createTask,
	isBlankTask,
	type TaskRecord,
	useCrudRecordsStore,
} from "../../model/crud-records-store";
import { DemoRow, GallerySection } from "../GallerySection";

/** Deterministic pseudo-random activity for the heatmap (stable across
 *  renders, no Math.random flicker). */
function seedActivity(now: Date): WeightedDateEntry[] {
	const entries: WeightedDateEntry[] = [];
	for (let daysAgo = 0; daysAgo < 84; daysAgo += 1) {
		const weight = (daysAgo * 7919) % 11;
		if (weight === 0) {
			continue;
		}
		const date = new Date(now);
		date.setDate(date.getDate() - daysAgo);
		entries.push({ date, weight });
	}
	return entries;
}

const HEATMAP_VARIANTS: string[] = [
	"bg-accent/20 hover:bg-accent/20 text-foreground",
	"bg-accent/40 hover:bg-accent/40 text-foreground",
	"bg-accent/65 hover:bg-accent/65 text-on-accent",
	"bg-accent hover:bg-accent text-on-accent",
];

function TasksGrid() {
	const t = useTranslations("gallery");
	const tc = useTranslations("crud");
	const rows = useCrudRecordsStore((s) => s.rows);
	const setRows = useCrudRecordsStore((s) => s.setRows);
	const resetRows = useCrudRecordsStore((s) => s.reset);
	const filterFn = getFilterFn<TaskRecord>();
	const columns: ColumnDef<TaskRecord>[] = [
		getDataGridSelectColumn<TaskRecord>(),
		{
			accessorKey: "task",
			filterFn,
			header: t("gridColumnTask"),
			id: "task",
			meta: { cell: { variant: "short-text" }, label: t("gridColumnTask") },
			minSize: 220,
		},
		{
			accessorKey: "owner",
			filterFn,
			header: t("gridColumnOwner"),
			id: "owner",
			meta: { cell: { variant: "short-text" }, label: t("gridColumnOwner") },
			minSize: 140,
		},
		{
			accessorKey: "status",
			filterFn,
			header: t("gridColumnStatus"),
			id: "status",
			meta: { cell: { variant: "short-text" }, label: t("gridColumnStatus") },
			minSize: 120,
		},
	];
	return (
		<div className="flex w-full flex-col gap-2">
			<p className="max-w-2xl text-body-sm text-foreground-muted">
				{tc("caption")}
			</p>
			<EditableRecordsGrid
				columns={columns}
				createRow={createTask}
				data={rows}
				editableColumnIds={["task", "owner", "status"]}
				focusColumnId="task"
				isEmptyRow={isBlankTask}
				onChange={setRows}
			/>
			<Button
				className="h-7 gap-1.5 self-start rounded-md border border-border bg-surface-3 px-2.5 text-foreground-secondary text-xs-tight transition-colors hover:bg-surface-4"
				onClick={resetRows}
			>
				<HugeiconsIcon icon={RefreshIcon} size={12} />
				{tc("reset")}
			</Button>
		</div>
	);
}

function DemoEntryCards() {
	const t = useTranslations("gallery");
	const cards: Array<{
		id: string;
		meta: EntryCardMetaPart[];
		text: string;
	}> = [
		{
			id: "entry-1",
			text: t("entryCardBody1"),
			meta: [
				{ key: "kind", icon: Task01Icon, value: t("entryCardKindNote") },
				{ key: "owner", icon: UserIcon, value: "Ada" },
				{ key: "when", icon: Clock01Icon, value: "09:41" },
			],
		},
		{
			id: "entry-2",
			text: t("entryCardBody2"),
			meta: [
				{ key: "kind", icon: Task01Icon, value: t("entryCardKindTask") },
				{ key: "owner", icon: UserIcon, value: "Grace" },
				{
					key: "link",
					icon: Link01Icon,
					value: "example.com/spec",
					truncate: true,
				},
			],
		},
	];
	return (
		<EntryCardShell>
			<div className="px-2 py-1">
				{cards.map((card) => (
					<EntryCard
						accent={{
							label: t("entryCardAccentLabel"),
							railClass: "bg-accent",
						}}
						footer={card.meta}
						key={card.id}
					>
						<p className="text-body text-foreground leading-relaxed">
							{card.text}
						</p>
					</EntryCard>
				))}
			</div>
		</EntryCardShell>
	);
}

export function DataSection() {
	const t = useTranslations("gallery");
	const [activity] = useState(() => seedActivity(new Date()));
	// Anchor the 2-month spread so it COVERS the generated activity (the past
	// ~12 weeks) instead of showing the current + next (empty) month.
	const [defaultMonth] = useState(() => {
		const anchor = new Date();
		anchor.setDate(1);
		anchor.setMonth(anchor.getMonth() - 1);
		return anchor;
	});

	return (
		<GallerySection
			description={t("dataDescription")}
			id="data"
			title={t("dataTitle")}
		>
			<DemoRow label={t("rowDataGrid")}>
				<div className="w-full">
					<TasksGrid />
				</div>
			</DemoRow>
			<DemoRow label={t("rowCalendarHeatmap")}>
				<div className="flex w-full justify-center">
					<CalendarHeatmap
						defaultMonth={defaultMonth}
						formatTooltip={(date, weight) =>
							t("heatmapTooltip", {
								date: date.toLocaleDateString(),
								count: weight ?? 0,
							})
						}
						nextMonthLabel={t("heatmapNextMonth")}
						numberOfMonths={2}
						prevMonthLabel={t("heatmapPrevMonth")}
						variantClassnames={HEATMAP_VARIANTS}
						weekStartsOn={0}
						weightedDates={activity}
					/>
				</div>
			</DemoRow>
			<DemoRow label={t("rowEntryCards")}>
				<div className="w-full">
					<DemoEntryCards />
				</div>
			</DemoRow>
		</GallerySection>
	);
}
