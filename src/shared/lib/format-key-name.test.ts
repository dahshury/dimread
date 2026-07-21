import { describe, expect, it } from "bun:test";
import { formatKeyName } from "./format-key-name";

describe("formatKeyName", () => {
	it("maps arrow tokens to glyphs", () => {
		expect(formatKeyName("ArrowUp")).toBe("↑");
		expect(formatKeyName("ArrowRight")).toBe("→");
	});

	it("labels Super per-platform with a safe fallback", () => {
		// Outside a Tauri runtime the platform read throws → generic label.
		expect(formatKeyName("Super")).toBe("Super");
	});

	it("passes plain tokens through", () => {
		expect(formatKeyName("Ctrl")).toBe("Ctrl");
		expect(formatKeyName("F5")).toBe("F5");
		expect(formatKeyName("K")).toBe("K");
	});
});
