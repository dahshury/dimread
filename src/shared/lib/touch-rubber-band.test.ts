import { afterEach, describe, expect, test } from "bun:test";
import { installTouchRubberBand } from "./touch-rubber-band";

function touchEvent(type: string, clientY: number) {
	const event = new Event(type, {
		bubbles: true,
		cancelable: true,
	}) as Event & {
		touches: Array<{ clientY: number }>;
	};
	Object.defineProperty(event, "touches", {
		value: type === "touchend" || type === "touchcancel" ? [] : [{ clientY }],
	});
	return event;
}

function transitionEvent(
	type: "transitionend" | "transitioncancel",
	propertyName: string,
) {
	const event = new Event(type, { bubbles: true });
	Object.defineProperty(event, "propertyName", { value: propertyName });
	return event;
}

function setScrollMetrics(
	element: HTMLElement,
	metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
	Object.defineProperty(element, "clientHeight", {
		configurable: true,
		value: metrics.clientHeight,
	});
	Object.defineProperty(element, "scrollHeight", {
		configurable: true,
		value: metrics.scrollHeight,
	});
	Object.defineProperty(element, "scrollTop", {
		configurable: true,
		value: metrics.scrollTop,
		writable: true,
	});
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("installTouchRubberBand", () => {
	test("pulls a native overflow scroller down at the top edge", () => {
		installTouchRubberBand();
		const scroller = document.createElement("div");
		scroller.style.overflowY = "auto";
		const content = document.createElement("div");
		scroller.append(content);
		document.body.append(scroller);
		setScrollMetrics(scroller, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 0,
		});

		content.dispatchEvent(touchEvent("touchstart", 100));
		content.dispatchEvent(touchEvent("touchmove", 150));

		expect(scroller.style.translate).toStartWith("0 ");
		expect(scroller.style.translate).not.toContain("0px");
	});

	test("restores styles when the translate release transition ends", () => {
		installTouchRubberBand();
		const scroller = document.createElement("div");
		scroller.style.overflowY = "auto";
		scroller.style.transition = "opacity 100ms linear";
		scroller.style.translate = "3px 4px";
		const content = document.createElement("div");
		scroller.append(content);
		document.body.append(scroller);
		setScrollMetrics(scroller, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 0,
		});

		content.dispatchEvent(touchEvent("touchstart", 100));
		content.dispatchEvent(touchEvent("touchmove", 150));
		content.dispatchEvent(touchEvent("touchend", 150));

		expect(scroller.style.transition).toContain("translate 420ms");
		expect(scroller.style.translate).toBe("0 0.00px");

		scroller.dispatchEvent(transitionEvent("transitionend", "opacity"));
		expect(scroller.style.transition).toContain("translate 420ms");

		scroller.dispatchEvent(transitionEvent("transitionend", "translate"));
		expect(scroller.style.transition).toBe("opacity 100ms linear");
		expect(scroller.style.translate).toBe("3px 4px");
	});

	test("restores styles when the translate release transition is canceled", () => {
		installTouchRubberBand();
		const scroller = document.createElement("div");
		scroller.style.overflowY = "auto";
		const content = document.createElement("div");
		scroller.append(content);
		document.body.append(scroller);
		setScrollMetrics(scroller, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 0,
		});

		content.dispatchEvent(touchEvent("touchstart", 100));
		content.dispatchEvent(touchEvent("touchmove", 150));
		content.dispatchEvent(touchEvent("touchcancel", 150));
		scroller.dispatchEvent(transitionEvent("transitioncancel", "translate"));

		expect(scroller.style.transition).toBe("");
		expect(scroller.style.translate ?? "").toBe("");
	});

	test("skips scroll areas that are managed by the local ScrollArea behavior", () => {
		installTouchRubberBand();
		const scroller = document.createElement("div");
		scroller.dataset["rubberBandManaged"] = "local";
		scroller.style.overflowY = "auto";
		const content = document.createElement("div");
		scroller.append(content);
		document.body.append(scroller);
		setScrollMetrics(scroller, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 0,
		});

		content.dispatchEvent(touchEvent("touchstart", 100));
		content.dispatchEvent(touchEvent("touchmove", 150));

		expect(scroller.style.translate ?? "").toBe("");
	});
});
