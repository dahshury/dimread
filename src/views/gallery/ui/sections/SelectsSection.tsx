import {
	GlobeIcon,
	Moon02Icon,
	MusicNote01Icon,
	Sun01Icon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { generateId } from "@/shared/lib/generate-id";
import {
	CreatableCombobox,
	type CreatableComboboxItem,
} from "@/shared/ui/creatable-combobox";
import { EditableListCombobox } from "@/shared/ui/editable-list-combobox";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOptionGroup } from "@/shared/ui/select";
import { DemoRow, GallerySection } from "../GallerySection";

export function SelectsSection() {
	const t = useTranslations("gallery");
	const [flatValue, setFlatValue] = useState("sun");
	const [groupedValue, setGroupedValue] = useState("alpha-2");
	const [searchableValue, setSearchableValue] = useState("alpha-1");
	const [presets, setPresets] = useState<CreatableComboboxItem[]>([
		{ id: "preset-default", label: t("presetDefault") },
		{ id: "preset-compact", label: t("presetCompact"), deletable: true },
	]);
	const [presetValue, setPresetValue] = useState("preset-default");
	const [tags, setTags] = useState<string[]>([
		t("tagSample1"),
		t("tagSample2"),
	]);

	const groups: SelectOptionGroup[] = [
		{
			value: "alpha",
			label: t("selectGroupAlpha"),
			badge: "A",
			options: [
				{ id: "alpha-1", label: t("selectOptionAurora"), icon: Sun01Icon },
				{ id: "alpha-2", label: t("selectOptionNocturne"), icon: Moon02Icon },
			],
		},
		{
			value: "beta",
			label: t("selectGroupBeta"),
			badge: "B",
			options: [
				{ id: "beta-1", label: t("selectOptionOrbit"), icon: GlobeIcon },
				{ id: "beta-2", label: t("selectOptionEcho"), icon: MusicNote01Icon },
			],
		},
	];

	return (
		<GallerySection
			description={t("selectsDescription")}
			id="selects"
			title={t("selectsTitle")}
		>
			<DemoRow label={t("rowSelect")}>
				<ElevatedSurface inline>
					<Select
						aria-label={t("rowSelect")}
						className="w-44"
						onChange={setFlatValue}
						options={[
							{ id: "sun", label: t("selectOptionAurora"), icon: Sun01Icon },
							{
								id: "moon",
								label: t("selectOptionNocturne"),
								icon: Moon02Icon,
							},
							{ id: "globe", label: t("selectOptionOrbit"), icon: GlobeIcon },
						]}
						value={flatValue}
					/>
				</ElevatedSurface>
				<ElevatedSurface inline>
					<Select
						aria-label={t("selectGroupedLabel")}
						className="w-48"
						groups={groups}
						onChange={setGroupedValue}
						value={groupedValue}
					/>
				</ElevatedSurface>
			</DemoRow>
			<DemoRow label={t("rowSearchableSelect")}>
				<SearchableSelect
					className="w-64"
					groups={groups}
					onChange={setSearchableValue}
					placeholder={t("searchablePlaceholder")}
					value={searchableValue}
				/>
			</DemoRow>
			<DemoRow label={t("rowCreatableCombobox")}>
				<CreatableCombobox
					className="w-64"
					createLabel={(name) => t("createPreset", { name })}
					deleteAriaLabel={t("deletePreset")}
					emptyLabel={t("noPresets")}
					items={presets}
					onCreate={(name) => {
						const id = generateId();
						setPresets((prev) => [
							...prev,
							{ id, label: name, deletable: true },
						]);
						setPresetValue(id);
					}}
					onDelete={(id) => {
						setPresets((prev) => prev.filter((item) => item.id !== id));
						setPresetValue((prev) => (prev === id ? "preset-default" : prev));
					}}
					onSelect={setPresetValue}
					placeholder={t("presetPlaceholder")}
					value={presetValue}
				/>
			</DemoRow>
			<DemoRow label={t("rowEditableList")}>
				<EditableListCombobox
					cancelAriaLabel={t("tagCancelEdit")}
					className="w-72"
					createLabel={(candidate) => t("tagCreate", { name: candidate })}
					editAriaLabel={(entry) => t("tagEdit", { name: entry })}
					emptyLabel={t("tagEmpty")}
					inputAriaLabel={t("rowEditableList")}
					onChange={setTags}
					placeholder={t("tagPlaceholder")}
					removeAriaLabel={(entry) => t("tagRemove", { name: entry })}
					saveAriaLabel={t("tagSaveEdit")}
					summaryLabel={(count) => t("tagSummary", { count })}
					value={tags}
				/>
			</DemoRow>
		</GallerySection>
	);
}
