import { afterEach, describe, expect, test } from "bun:test";
import { toast } from "./toast";

const originalSetTimeout = window.setTimeout;

afterEach(() => {
	window.setTimeout = originalSetTimeout;
	document.querySelector("[data-data-grid-toaster]")?.remove();
});

describe("data-grid toast lifecycle", () => {
	test("removes a dismissed toast from its transition callback", () => {
		const scheduled: Array<() => void> = [];
		window.setTimeout = ((callback: TimerHandler) => {
			if (typeof callback === "function") {
				scheduled.push(() => callback());
			}
			return scheduled.length;
		}) as typeof window.setTimeout;

		toast("Saved", { duration: 10 });
		const element = document.querySelector<HTMLElement>(
			"[data-data-grid-toaster] > div",
		);
		expect(element).not.toBeNull();
		expect(scheduled).toHaveLength(1);

		scheduled[0]?.();
		expect(element?.isConnected).toBe(true);
		const event = new Event("transitionend", { bubbles: true });
		Object.defineProperty(event, "propertyName", { value: "opacity" });
		element?.dispatchEvent(event);
		expect(element?.isConnected).toBe(false);
		expect(scheduled).toHaveLength(1);
	});
});
