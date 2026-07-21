import type { IconSvgElement } from "@hugeicons/react";

/** One label/value row in an item's spec card (e.g. "License" / "MIT"). */
export interface ItemPickerFact {
	key: string;
	label: string;
	value: string;
}

/** A generic pickable item — the domain-free shape every ItemPicker consumer
 *  adapts its catalog rows into. */
export interface ItemPickerItem {
	/** Short trailing badges (version tags, formats, …). Also searched. */
	badges?: readonly string[] | undefined;
	/** Longer copy shown in the hover spec card. */
	description?: string | undefined;
	/** Group id — must match an entry in the picker's `groups` prop. Ungrouped
	 *  items list before the grouped sections. */
	group?: string | undefined;
	icon?: IconSvgElement | undefined;
	id: string;
	/** Label/value spec rows for the hover spec card. */
	meta?: readonly ItemPickerFact[] | undefined;
	/** Muted one-line detail under/after the title. Also searched. */
	subtitle?: string | undefined;
	title: string;
}

/** Group order + localized header labels, supplied by the consumer. */
export interface ItemPickerGroup {
	id: string;
	label: string;
}

/** Every user-facing string the picker renders — passed in by the consumer so
 *  the shared component stays i18n-free. */
export interface ItemPickerLabels {
	/** Clear-button label of the search field. */
	clearSearch: string;
	/** Empty-state line when the query matches nothing. */
	empty: string;
	/** Pinned favorites group header. */
	favoritesGroup: string;
	/** aria-label of the listbox. */
	list: string;
	/** aria-label of the search input. */
	search: string;
	searchPlaceholder: string;
	/** aria-label/tooltip of a row's favorite star. */
	toggleFavorite: string;
}
