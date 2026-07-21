import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_PICKER_ITEM_ID, PICKER_ITEMS } from "./picker-items";
import { usePickerSelectionStore } from "./picker-selection-store";

const PERSIST_KEY = "starter-picker-selection";

function resetStore(): void {
	window.localStorage.removeItem(PERSIST_KEY);
	usePickerSelectionStore.setState({
		selectedId: DEFAULT_PICKER_ITEM_ID,
		favorites: [],
	});
}

beforeEach(resetStore);
afterEach(resetStore);

describe("picker items dataset", () => {
	test("has unique ids", () => {
		const ids = PICKER_ITEMS.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("default selection is a real item", () => {
		expect(
			PICKER_ITEMS.some((item) => item.id === DEFAULT_PICKER_ITEM_ID),
		).toBe(true);
	});
});

describe("usePickerSelectionStore", () => {
	test("select updates selectedId and persists it", () => {
		usePickerSelectionStore.getState().select("theme-weaver");
		expect(usePickerSelectionStore.getState().selectedId).toBe("theme-weaver");
		const raw = window.localStorage.getItem(PERSIST_KEY);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw as string).state.selectedId).toBe("theme-weaver");
	});

	test("toggleFavorite adds then removes an id", () => {
		const store = usePickerSelectionStore.getState();
		store.toggleFavorite("code-prism");
		expect(usePickerSelectionStore.getState().favorites).toEqual([
			"code-prism",
		]);
		usePickerSelectionStore.getState().toggleFavorite("code-prism");
		expect(usePickerSelectionStore.getState().favorites).toEqual([]);
	});

	test("toggleFavorite keeps other favorites intact", () => {
		usePickerSelectionStore.getState().toggleFavorite("code-prism");
		usePickerSelectionStore.getState().toggleFavorite("daylight");
		usePickerSelectionStore.getState().toggleFavorite("code-prism");
		expect(usePickerSelectionStore.getState().favorites).toEqual(["daylight"]);
	});

	test("applyRemote replaces both fields (idempotent echo)", () => {
		const payload = { selectedId: "midnight", favorites: ["web-bridge"] };
		usePickerSelectionStore.getState().applyRemote(payload);
		expect(usePickerSelectionStore.getState().selectedId).toBe("midnight");
		expect(usePickerSelectionStore.getState().favorites).toEqual([
			"web-bridge",
		]);
		// A second identical apply (the sender's own echo) is a no-op.
		usePickerSelectionStore.getState().applyRemote(payload);
		expect(usePickerSelectionStore.getState().selectedId).toBe("midnight");
	});
});
