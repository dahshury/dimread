import {
	Delete02Icon,
	FileAudioIcon,
	Mic01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { formatBytes } from "@/shared/lib/format-bytes";
import { generateId } from "@/shared/lib/generate-id";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { type DroppedFile, FileDropZone } from "@/shared/ui/file-drop-zone";
import { Select, type SelectOption } from "@/shared/ui/select";
import { SortableList } from "@/shared/ui/sortable-list";
import { DemoRow, GallerySection } from "../GallerySection";

interface DroppedEntry extends DroppedFile {
	entryId: string;
}

/** FileDropZone demo: dropped/browsed file names + sizes append to a list. */
function DropZoneDemo() {
	const t = useTranslations("dropZone");
	const [entries, setEntries] = useState<DroppedEntry[]>([]);

	return (
		<div className="flex w-full flex-col gap-2">
			<FileDropZone
				accept={["wav", "mp3"]}
				onFiles={(files) =>
					setEntries((current) => [
						...current,
						...files.map((file) => ({ ...file, entryId: generateId() })),
					])
				}
			/>
			{entries.length === 0 ? (
				<p className="px-1 text-body-sm text-foreground-muted">
					{t("demoEmpty")}
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{entries.map((entry) => (
						<li
							className="flex items-center gap-2 px-1 text-body-sm"
							key={entry.entryId}
						>
							<HugeiconsIcon
								aria-hidden="true"
								className="shrink-0 text-foreground-muted"
								icon={FileAudioIcon}
								size={14}
							/>
							<span className="min-w-0 flex-1 truncate text-foreground">
								{entry.name}
							</span>
							<span className="shrink-0 font-mono text-foreground-muted text-xs-tight tabular-nums">
								{formatBytes(entry.size) ?? t("demoSizeUnknown")}
							</span>
						</li>
					))}
				</ul>
			)}
			{entries.length > 0 ? (
				<Button
					className="h-7 gap-1.5 self-start rounded-md border border-border bg-surface-3 px-2.5 text-foreground-secondary text-xs-tight transition-colors hover:bg-surface-4"
					onClick={() => setEntries([])}
				>
					<HugeiconsIcon icon={Delete02Icon} size={12} />
					{t("demoClear")}
				</Button>
			) : null}
		</div>
	);
}

interface DemoDevice {
	id: string;
	label: string;
}

function useDemoDevices(): DemoDevice[] {
	const t = useTranslations("sortable");
	return [
		{ id: "headset", label: t("demoDevice1") },
		{ id: "usb", label: t("demoDevice2") },
		{ id: "webcam", label: t("demoDevice3") },
		{ id: "condenser", label: t("demoDevice4") },
	];
}

function reorderByIds<T extends { id: string }>(
	items: readonly T[],
	orderedIds: readonly string[],
): T[] {
	const byId = new Map(items.map((item) => [item.id, item]));
	const reordered = orderedIds
		.map((id) => byId.get(id))
		.filter((item): item is T => item !== undefined);
	const ordered = new Set(orderedIds);
	return [...reordered, ...items.filter((item) => !ordered.has(item.id))];
}

/** SortableList demo: mic-priority style drag-to-reorder rows. */
function SortableListDemo() {
	const t = useTranslations("sortable");
	const initial = useDemoDevices();
	const [devices, setDevices] = useState<DemoDevice[]>(initial);

	return (
		<div className="flex w-full max-w-md flex-col gap-2">
			<SortableList
				handleLabel={t("handleLabel")}
				items={devices}
				onReorder={(ids) => setDevices((current) => reorderByIds(current, ids))}
				renderItem={(device) => (
					<span className="flex items-center gap-2 text-body-sm text-foreground">
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-foreground-muted"
							icon={Mic01Icon}
							size={14}
						/>
						<span className="min-w-0 flex-1 truncate">{device.label}</span>
						<Badge variant="secondary">
							{`#${devices.findIndex((d) => d.id === device.id) + 1}`}
						</Badge>
					</span>
				)}
			/>
			<p className="px-1 text-foreground-muted text-xs-tight">
				{t("listHint")}
			</p>
		</div>
	);
}

/** The Select's own drag-sortable rows (WinSTT's mic-priority picker). */
function SortableSelectDemo() {
	const t = useTranslations("sortable");
	const initial = useDemoDevices();
	const [order, setOrder] = useState<DemoDevice[]>(initial);
	const [selected, setSelected] = useState("default");

	const options: SelectOption[] = [
		{ id: "default", label: t("demoDeviceDefault") },
		...order.map((device) => ({
			id: device.id,
			label: device.label,
			sortable: true,
		})),
	];

	return (
		<ElevatedSurface inline>
			<Select
				aria-label={t("selectLabel")}
				className="w-56"
				onChange={setSelected}
				onReorder={(ids) => setOrder((current) => reorderByIds(current, ids))}
				options={options}
				reorderHandleLabel={t("handleLabel")}
				value={selected}
			/>
		</ElevatedSurface>
	);
}

export function DndSection() {
	const td = useTranslations("dropZone");
	const ts = useTranslations("sortable");

	return (
		<GallerySection
			description={td("sectionDescription")}
			id="dnd"
			title={td("sectionTitle")}
		>
			<DemoRow label={td("rowDropZone")}>
				<DropZoneDemo />
			</DemoRow>
			<DemoRow label={ts("rowList")}>
				<SortableListDemo />
			</DemoRow>
			<DemoRow label={ts("rowSelect")}>
				<SortableSelectDemo />
			</DemoRow>
		</GallerySection>
	);
}
