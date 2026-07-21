import {
	CloudIcon,
	Database01Icon,
	DownloadCircle01Icon,
	FlashIcon,
	GlobeIcon,
	Link01Icon,
	Shield01Icon,
	Wifi01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { Badge } from "@/shared/ui/badge";
import { IconButton } from "@/shared/ui/icon-button";
import { ItemCard } from "@/shared/ui/item-card";
import {
	ItemPicker,
	type ItemPickerItem,
	type ItemPickerLabels,
} from "@/shared/ui/item-picker";
import {
	MultiCombobox,
	type MultiComboboxOption,
} from "@/shared/ui/multi-combobox";
import { DemoRow, GallerySection } from "../GallerySection";

/** Demo channel options for the MultiCombobox (proper nouns, untranslated —
 *  the picker-items convention). */
const CHANNEL_OPTIONS: MultiComboboxOption[] = [
	{ id: "stable", label: "Stable", badge: "S" },
	{ id: "beta", label: "Beta", badge: "B" },
	{ id: "nightly", label: "Nightly", badge: "N" },
	{ id: "canary", label: "Canary", badge: "C" },
	{ id: "lts", label: "LTS", badge: "L" },
];

export function PickersSection() {
	const t = useTranslations("gallery");
	// The generic label bundle lives in the shared `itemPicker` namespace (the
	// same strings the detached picker window uses).
	const tItemPicker = useTranslations("itemPicker");
	const [cardSelection, setCardSelection] = useState("nimbus-sync");
	const [cardFavorites, setCardFavorites] = useState<string[]>(["halo-vault"]);
	const [channels, setChannels] = useState<string[]>(["stable", "beta"]);

	const pickerLabels: ItemPickerLabels = {
		clearSearch: tItemPicker("clearSearch"),
		empty: tItemPicker("empty"),
		favoritesGroup: tItemPicker("favoritesGroup"),
		list: tItemPicker("list"),
		search: tItemPicker("search"),
		searchPlaceholder: tItemPicker("searchPlaceholder"),
		toggleFavorite: tItemPicker("toggleFavorite"),
	};

	// Titles are product-style proper nouns (untranslated, the picker-items
	// convention); sentence copy comes from the i18n bundle.
	const pickerItems: ItemPickerItem[] = [
		{
			id: "nimbus-sync",
			title: "Nimbus Sync",
			icon: CloudIcon,
			badges: ["v3.1"],
			group: "services",
			description: t("demoDescSync"),
			meta: [
				{ key: "license", label: t("specLicense"), value: "MIT" },
				{ key: "size", label: t("specSize"), value: "4.2 MB" },
			],
		},
		{
			id: "quartz-cache",
			title: "Quartz Cache",
			icon: Database01Icon,
			badges: ["v1.8"],
			group: "services",
			description: t("demoDescCache"),
			meta: [
				{ key: "license", label: t("specLicense"), value: "Apache-2.0" },
				{ key: "size", label: t("specSize"), value: "1.1 MB" },
			],
		},
		{
			id: "ember-queue",
			title: "Ember Queue",
			icon: FlashIcon,
			badges: ["v2.0"],
			group: "services",
			description: t("demoDescQueue"),
			meta: [{ key: "size", label: t("specSize"), value: "2.7 MB" }],
		},
		{
			id: "drift-relay",
			title: "Drift Relay",
			icon: Wifi01Icon,
			badges: ["v0.9"],
			group: "network",
			meta: [{ key: "size", label: t("specSize"), value: "890 KB" }],
		},
		{
			id: "halo-vault",
			title: "Halo Vault",
			icon: Shield01Icon,
			badges: ["v4.4"],
			group: "network",
			meta: [{ key: "license", label: t("specLicense"), value: "GPL-3.0" }],
		},
		{
			id: "pulse-beacon",
			title: "Pulse Beacon",
			icon: Link01Icon,
			badges: ["v1.2"],
			group: "network",
		},
	];
	const pickerGroups = [
		{ id: "services", label: t("pickerGroupServices") },
		{ id: "network", label: t("pickerGroupNetwork") },
	];

	const toggleCardFavorite = (id: string) => {
		setCardFavorites((current) =>
			current.includes(id)
				? current.filter((candidate) => candidate !== id)
				: [...current, id],
		);
	};

	return (
		<GallerySection
			description={t("pickersDescription")}
			id="pickers"
			title={t("pickersTitle")}
		>
			<DemoRow label={t("rowItemPicker")}>
				<div className="h-72 w-80 overflow-hidden rounded-lg ring-1 ring-divider">
					<ItemPicker
						defaultFavorites={["quartz-cache"]}
						defaultValue="nimbus-sync"
						groups={pickerGroups}
						items={pickerItems}
						labels={pickerLabels}
						specCard={{ side: "right" }}
					/>
				</div>
			</DemoRow>
			<DemoRow label={t("rowItemCards")}>
				<div className="grid w-full gap-2 sm:grid-cols-2">
					<ItemCard
						actions={
							<IconButton
								aria-label={t("cardDownload")}
								icon={
									<HugeiconsIcon
										aria-hidden="true"
										icon={DownloadCircle01Icon}
										size={14}
									/>
								}
								onClick={() => undefined}
							/>
						}
						badges={<Badge variant="outline">{t("cardInstalled")}</Badge>}
						chips={[
							{ key: "size", label: "4.2 MB" },
							{ key: "license", label: "MIT" },
							{ key: "version", label: "v3.1" },
						]}
						description={t("demoDescSync")}
						favorite={{
							isFavorited: cardFavorites.includes("nimbus-sync"),
							label: tItemPicker("toggleFavorite"),
							onToggle: () => toggleCardFavorite("nimbus-sync"),
						}}
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-foreground-secondary"
								icon={CloudIcon}
							/>
						}
						onSelect={() => setCardSelection("nimbus-sync")}
						selected={cardSelection === "nimbus-sync"}
						title="Nimbus Sync"
					/>
					<ItemCard
						chips={[
							{ key: "size", label: "1.1 MB" },
							{ key: "license", label: "Apache-2.0" },
						]}
						description={t("demoDescCache")}
						favorite={{
							isFavorited: cardFavorites.includes("halo-vault"),
							label: tItemPicker("toggleFavorite"),
							onToggle: () => toggleCardFavorite("halo-vault"),
						}}
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-foreground-secondary"
								icon={Database01Icon}
							/>
						}
						onSelect={() => setCardSelection("quartz-cache")}
						selected={cardSelection === "quartz-cache"}
						shelf={
							<span className="font-mono text-[10px] text-foreground-muted">
								{t("cardShelfHint")}
							</span>
						}
						title="Quartz Cache"
					/>
					<ItemCard
						errorMessage={t("cardBrokenError")}
						icon={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-foreground-secondary"
								icon={GlobeIcon}
							/>
						}
						title="Drift Relay"
						unavailable
						unavailableLabel={t("cardBroken")}
					/>
				</div>
			</DemoRow>
			<DemoRow label={t("rowMultiCombobox")}>
				<div className="w-72">
					<MultiCombobox
						ariaLabel={t("multiLabel")}
						clearAllLabel={t("multiClear")}
						emptyLabel={t("multiEmpty")}
						onChange={setChannels}
						options={CHANNEL_OPTIONS}
						placeholder={t("multiPlaceholder")}
						removeLabel={(item) => t("multiRemove", { item })}
						selectAllLabel={t("multiSelectAll")}
						selectedCountLabel={(count) => t("multiCount", { count })}
						selectedHeading={t("multiSelectedHeading")}
						value={channels}
					/>
				</div>
			</DemoRow>
		</GallerySection>
	);
}
