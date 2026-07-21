import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import {
	PICKER_GROUP_ORDER,
	PICKER_ITEMS,
	type PickerGroupId,
	usePickerSelectionStore,
} from "@/entities/picker-selection";
import { SurfaceProvider } from "@/shared/lib/surface";
import { findToggledFavorite } from "../lib/favorite-diff";
import {
	ItemPicker,
	type ItemPickerItem,
	type ItemPickerLabels,
} from "@/shared/ui/item-picker";

/** Marks the panel's always-open listbox so window-level Escape handling can
 *  ignore it (an inline list is not a dismissable layer). */
export const PICKER_INLINE_LIST_SLOT = "picker-inline-list";

/**
 * The visible picker panel body — the shared generic `ItemPicker` wired to the
 * demo plugin catalog: fuzzy search over a virtualized grouped list with
 * pinned favorites, keyboard traversal, and a hover spec card. Selecting an
 * item persists + broadcasts the pick and closes the window. Remounted per
 * open (via the host's `key`) so the search query never carries over.
 */
export function PickerPanel({ active }: { active: boolean }) {
	const t = useTranslations("picker");
	const tItemPicker = useTranslations("itemPicker");
	const selectedId = usePickerSelectionStore((s) => s.selectedId);
	const favorites = usePickerSelectionStore((s) => s.favorites);
	const select = usePickerSelectionStore((s) => s.select);
	const toggleFavorite = usePickerSelectionStore((s) => s.toggleFavorite);

	const groupLabels: Record<PickerGroupId, string> = {
		productivity: t("groupProductivity"),
		development: t("groupDevelopment"),
		appearance: t("groupAppearance"),
		integrations: t("groupIntegrations"),
	};
	const groups = PICKER_GROUP_ORDER.map((id) => ({
		id,
		label: groupLabels[id],
	}));
	const items: ItemPickerItem[] = PICKER_ITEMS.map((item) => ({
		id: item.id,
		title: item.name,
		icon: item.icon,
		badges: [item.badge],
		group: item.group,
		meta: [
			{ key: "group", label: t("specGroup"), value: groupLabels[item.group] },
			{ key: "version", label: t("specVersion"), value: item.badge },
		],
	}));
	const labels: ItemPickerLabels = {
		clearSearch: tItemPicker("clearSearch"),
		empty: tItemPicker("empty"),
		favoritesGroup: tItemPicker("favoritesGroup"),
		list: tItemPicker("list"),
		search: tItemPicker("search"),
		searchPlaceholder: tItemPicker("searchPlaceholder"),
		toggleFavorite: tItemPicker("toggleFavorite"),
	};

	const handleSelect = (id: string) => {
		select(id);
		void commands.closeSelfWindow();
	};

	const handleFavoritesChange = (next: string[]) => {
		const toggled = findToggledFavorite(favorites, next);
		if (toggled !== undefined) {
			toggleFavorite(toggled);
		}
	};

	return (
		<SurfaceProvider value={2}>
			<div
				className="picker-content-substrate flex h-full min-h-0 flex-col overflow-hidden rounded-lg shadow-picker-popup ring-1 ring-divider-strong"
				data-slot={PICKER_INLINE_LIST_SLOT}
			>
				<ItemPicker
					autoFocusSearch={active}
					favorites={favorites}
					groups={groups}
					items={items}
					labels={labels}
					onFavoritesChange={handleFavoritesChange}
					onValueChange={handleSelect}
					specCard={{ side: "right" }}
					value={selectedId}
				/>
			</div>
		</SurfaceProvider>
	);
}
