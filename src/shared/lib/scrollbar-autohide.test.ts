import { describe, expect, test } from "bun:test";
import { installScrollbarAutoHide } from "./scrollbar-autohide";

const ACTIVE_ATTR = "data-scrollbar-visible";

function dispatchScroll(target: EventTarget, type: "scroll" | "scrollend") {
	target.dispatchEvent(new Event(type));
}

describe("installScrollbarAutoHide", () => {
	test("reveals a nested scroller until its scrollend event", () => {
		const doc = document.implementation.createHTMLDocument();
		const outer = doc.createElement("div");
		const inner = doc.createElement("div");
		outer.append(inner);
		doc.body.append(outer);
		installScrollbarAutoHide(doc);

		dispatchScroll(inner, "scroll");
		expect(inner.hasAttribute(ACTIVE_ATTR)).toBe(true);
		expect(outer.hasAttribute(ACTIVE_ATTR)).toBe(false);

		dispatchScroll(inner, "scrollend");
		expect(inner.hasAttribute(ACTIVE_ATTR)).toBe(false);
	});

	test("tracks nested scrollers independently", () => {
		const doc = document.implementation.createHTMLDocument();
		const outer = doc.createElement("div");
		const inner = doc.createElement("div");
		outer.append(inner);
		doc.body.append(outer);
		installScrollbarAutoHide(doc);

		dispatchScroll(outer, "scroll");
		dispatchScroll(inner, "scroll");
		dispatchScroll(inner, "scrollend");

		expect(inner.hasAttribute(ACTIVE_ATTR)).toBe(false);
		expect(outer.hasAttribute(ACTIVE_ATTR)).toBe(true);

		dispatchScroll(outer, "scrollend");
		expect(outer.hasAttribute(ACTIVE_ATTR)).toBe(false);
	});

	test("routes document scrolling to the page scrolling element", () => {
		const doc = document.implementation.createHTMLDocument();
		installScrollbarAutoHide(doc);

		dispatchScroll(doc, "scroll");
		expect(doc.documentElement.hasAttribute(ACTIVE_ATTR)).toBe(true);

		dispatchScroll(doc, "scrollend");
		expect(doc.documentElement.hasAttribute(ACTIVE_ATTR)).toBe(false);
	});

	test("is idempotent for each document", () => {
		const doc = document.implementation.createHTMLDocument();
		const registrations: string[] = [];
		const addEventListener = doc.addEventListener.bind(doc);
		doc.addEventListener = ((type: string, ...args: unknown[]) => {
			registrations.push(type);
			return Reflect.apply(addEventListener, doc, [type, ...args]);
		}) as typeof doc.addEventListener;

		installScrollbarAutoHide(doc);
		installScrollbarAutoHide(doc);

		expect(registrations).toEqual(["scroll", "scrollend"]);
	});

	test("does not schedule idle timers", () => {
		const doc = document.implementation.createHTMLDocument();
		const originalSetTimeout = window.setTimeout;
		let scheduled = 0;
		window.setTimeout = ((..._args: Parameters<typeof window.setTimeout>) => {
			scheduled += 1;
			return 0;
		}) as typeof window.setTimeout;

		try {
			installScrollbarAutoHide(doc);
			dispatchScroll(doc.body, "scroll");
			dispatchScroll(doc.body, "scrollend");
			expect(scheduled).toBe(0);
		} finally {
			window.setTimeout = originalSetTimeout;
		}
	});
});
