import { emit } from "@tauri-apps/api/event";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { hasNativeRuntime, NATIVE_EVENTS } from "@/shared/api";
import { DEFAULT_PICKER_ITEM_ID } from "./picker-items";

/**
 * Cross-window sync payload for the picker selection.
 *
 * Every window persists the store to its own localStorage (webviews share the
 * storage file, so the LAST writer wins on next cold start), but a live window
 * does not observe another window's localStorage writes — so user actions
 * additionally broadcast the full state on the `picker:selected` Tauri event
 * and every other window applies it via {@link usePickerSelectionSync}.
 * `applyRemote` never re-emits, so the echo a sender receives is a no-op
 * rather than a loop.
 */
export interface PickerSelectionBroadcast {
	favorites: string[];
	selectedId: string;
}

function broadcast(payload: PickerSelectionBroadcast): void {
	if (!hasNativeRuntime()) {
		return;
	}
	emit(NATIVE_EVENTS.PICKER_SELECTED, payload).catch((error: unknown) => {
		console.warn("picker selection broadcast failed", error);
	});
}

interface PickerSelectionState {
	/** Apply a broadcast from another window — no re-emit. */
	applyRemote: (payload: PickerSelectionBroadcast) => void;
	favorites: string[];
	/** User action: select an item (persists + broadcasts). */
	select: (id: string) => void;
	selectedId: string;
	/** User action: star/unstar an item (persists + broadcasts). */
	toggleFavorite: (id: string) => void;
}

export const usePickerSelectionStore = create<PickerSelectionState>()(
	persist(
		(set, get) => ({
			selectedId: DEFAULT_PICKER_ITEM_ID,
			favorites: [],
			select: (id) => {
				set({ selectedId: id });
				const { selectedId, favorites } = get();
				broadcast({ selectedId, favorites });
			},
			toggleFavorite: (id) => {
				set((state) => ({
					favorites: state.favorites.includes(id)
						? state.favorites.filter((fav) => fav !== id)
						: [...state.favorites, id],
				}));
				const { selectedId, favorites } = get();
				broadcast({ selectedId, favorites });
			},
			applyRemote: (payload) =>
				set({
					selectedId: payload.selectedId,
					favorites: payload.favorites,
				}),
		}),
		{
			name: "starter-picker-selection",
			partialize: (state) => ({
				favorites: state.favorites,
				selectedId: state.selectedId,
			}),
		},
	),
);
