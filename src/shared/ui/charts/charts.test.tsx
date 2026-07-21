import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { BarChart } from "./BarChart";
import {
	areaPoints,
	type ChartFrame,
	pointYPercents,
	polylinePoints,
	rankFadeColor,
	ringArcs,
	sharePercents,
	valueToY,
} from "./chart-math";
import { LineChart } from "./LineChart";
import { StatRing } from "./StatRing";

const FRAME: ChartFrame = { width: 100, height: 40, pad: 2 };

describe("chart-math", () => {
	test("valueToY maps max to the top pad and zero to the baseline", () => {
		expect(valueToY(10, 10, FRAME)).toBe(2);
		expect(valueToY(0, 10, FRAME)).toBe(38);
		expect(valueToY(5, 10, FRAME)).toBe(20);
	});

	test("valueToY pins a zero-max series to the baseline", () => {
		expect(valueToY(0, 0, FRAME)).toBe(38);
	});

	test("polylinePoints spaces points evenly across the width", () => {
		const points = polylinePoints([0, 10, 0], FRAME);
		expect(points).toBe("0.00,38.00 50.00,2.00 100.00,38.00");
	});

	test("areaPoints closes the polygon along the baseline", () => {
		const points = areaPoints([0, 10], FRAME);
		expect(points.startsWith("0,38 ")).toBe(true);
		expect(points.endsWith(" 100,38")).toBe(true);
	});

	test("pointYPercents converts frame y into percentages", () => {
		const [first, second] = pointYPercents([10, 0], FRAME);
		expect(first).toBe(5);
		expect(second).toBe(95);
	});

	test("ringArcs sizes wedges to exact shares with the seam gap", () => {
		const arcs = ringArcs([3, 1], 100, 2);
		expect(arcs[0]?.dash).toBe(73);
		expect(arcs[1]?.dash).toBe(23);
		expect(arcs[0]?.offset).toBe(-0);
		expect(arcs[1]?.offset).toBe(-75);
	});

	test("ringArcs skips the gap for a lone full-ring slice", () => {
		const arcs = ringArcs([5], 100, 2);
		expect(arcs[0]?.dash).toBe(100);
	});

	test("ringArcs handles an all-zero series", () => {
		expect(ringArcs([0, 0], 100, 2)).toEqual([
			{ dash: 0, offset: 0 },
			{ dash: 0, offset: 0 },
		]);
	});

	test("sharePercents rounds display shares", () => {
		expect(sharePercents([1, 1, 1])).toEqual([33, 33, 33]);
		expect(sharePercents([0, 0])).toEqual([0, 0]);
	});

	test("rankFadeColor steps darker down the ranking with a floor", () => {
		expect(rankFadeColor(0, "var(--color-accent)")).toContain("70%");
		expect(rankFadeColor(2, "var(--color-accent)")).toContain("56%");
		expect(rankFadeColor(20, "var(--color-accent)")).toContain("40%");
	});
});

describe("LineChart", () => {
	test("renders nothing with fewer than two points", () => {
		const { container } = render(
			<TooltipPrimitive.Provider>
				<LineChart ariaLabel="Trend" data={[{ label: "Mon", value: 3 }]} />
			</TooltipPrimitive.Provider>,
		);
		expect(container.firstElementChild).toBeNull();
	});

	test("renders the polyline plus one hover column per point", () => {
		const { container } = render(
			<TooltipPrimitive.Provider>
				<LineChart
					ariaLabel="Trend"
					data={[
						{ label: "Mon", value: 1 },
						{ label: "Tue", value: 4 },
						{ label: "Wed", value: 2 },
					]}
				/>
			</TooltipPrimitive.Provider>,
		);
		expect(screen.getByRole("img", { name: "Trend" })).toBeDefined();
		expect(container.querySelectorAll("polyline").length).toBe(1);
		expect(container.querySelectorAll("polygon").length).toBe(0);
		expect(container.querySelectorAll(".group").length).toBe(3);
	});

	test("area mode adds the fill polygon", () => {
		const { container } = render(
			<TooltipPrimitive.Provider>
				<LineChart
					area
					ariaLabel="Trend"
					data={[
						{ label: "Mon", value: 1 },
						{ label: "Tue", value: 4 },
					]}
				/>
			</TooltipPrimitive.Provider>,
		);
		expect(container.querySelectorAll("polygon").length).toBe(1);
	});
});

describe("BarChart", () => {
	test("renders nothing when empty", () => {
		const { container } = render(<BarChart data={[]} />);
		expect(container.firstElementChild).toBeNull();
	});

	test("renders one pill row per datum with default percent text", () => {
		render(
			<BarChart
				data={[
					{ key: "a", label: "Alpha", value: 3 },
					{ key: "b", label: "Beta", value: 1 },
				]}
			/>,
		);
		expect(screen.getByText("Alpha")).toBeDefined();
		expect(screen.getByText("Beta")).toBeDefined();
		expect(screen.getByText("75%")).toBeDefined();
		expect(screen.getByText("25%")).toBeDefined();
	});
});

describe("StatRing", () => {
	test("renders nothing when the total is zero", () => {
		const { container } = render(
			<StatRing
				ariaLabel="Spend"
				centerLabel="total"
				centerValue="$0"
				slices={[{ key: "a", label: "A", value: 0 }]}
			/>,
		);
		expect(container.firstElementChild).toBeNull();
	});

	test("renders wedges, the center value, and the legend", () => {
		const { container } = render(
			<StatRing
				ariaLabel="Spend"
				centerLabel="total"
				centerValue="$4"
				slices={[
					{ key: "a", label: "Alpha", value: 3 },
					{ key: "b", label: "Beta", value: 1 },
				]}
			/>,
		);
		expect(screen.getByRole("img", { name: "Spend" })).toBeDefined();
		// 1 track circle + 2 wedges.
		expect(container.querySelectorAll("circle").length).toBe(3);
		expect(screen.getByText("$4")).toBeDefined();
		expect(screen.getByText("Alpha")).toBeDefined();
		expect(screen.getByText("75%")).toBeDefined();
	});

	test("legend can be hidden", () => {
		const { container } = render(
			<StatRing
				ariaLabel="Spend"
				centerLabel="total"
				centerValue="$1"
				showLegend={false}
				slices={[{ key: "a", label: "Alpha", value: 1 }]}
			/>,
		);
		expect(container.querySelector("ul")).toBeNull();
	});
});
