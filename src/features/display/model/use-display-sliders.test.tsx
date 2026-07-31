import { afterEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DisplaySettings } from "@/bindings";
import { NATIVE_EVENTS } from "@/shared/api";
import { ALL_MONITORS } from "./display-values";
import { useDisplaySliders } from "./use-display-sliders";

const MON = "\\\\.\\DISPLAY2";

function makeDisplay(): DisplaySettings {
	return {
		mode: "office",
		wideRange: false,
		brightnessWideRange: false,
		disableOnFullscreen: true,
		smoothTransition: true,
		syncMonitors: true,
		monitorOverrides: {},
		excludedMonitors: [],
		modes: {
			office: {
				kelvinDay: 5500,
				kelvinNight: 5000,
				brightnessDay: 85,
				brightnessNight: 80,
			},
		},
	};
}

afterEach(() => {
	clearMocks();
});

describe("useDisplaySliders", () => {
	test("drops a stale remote mirror immediately when the target changes", async () => {
		mockIPC(() => undefined, { shouldMockEvents: true });
		const display = makeDisplay();
		const { result, rerender, unmount } = renderHook(
			({ selection }: { selection: string }) =>
				useDisplaySliders({
					display,
					mode: "office",
					phase: "day",
					selection,
				}),
			{ initialProps: { selection: ALL_MONITORS } },
		);

		await act(async () => {
			await emit(NATIVE_EVENTS.DISPLAY_EDIT, {
				mode: "office",
				monitorId: null,
				origin: "other-window",
				phase: "day",
				value: { kelvin: 4200, brightness: null },
			});
		});
		await waitFor(() => expect(result.current.kelvin).toBe(4200));

		// An unrelated sender does not own (and therefore cannot erase) the
		// matching drag that is still in flight.
		await act(async () => {
			await emit(NATIVE_EVENTS.DISPLAY_EDIT, {
				mode: "office",
				monitorId: MON,
				origin: "unrelated-window",
				phase: "day",
				value: { kelvin: 3900, brightness: null },
			});
		});
		expect(result.current.kelvin).toBe(4200);

		rerender({ selection: MON });
		// No override exists, so this monitor inherits the active Office preset;
		// the old all-monitor mirror must not leak onto it for even one render.
		expect(result.current.kelvin).toBe(5500);
		unmount();
	});

	test("a rejected commit clears both surfaces and ends native preview", async () => {
		const commands: string[] = [];
		mockIPC(
			(command) => {
				commands.push(command);
				if (command === "display_set_value") {
					return Promise.reject(new Error("settings write rejected"));
				}
				return undefined;
			},
			{ shouldMockEvents: true },
		);
		const display = makeDisplay();
		const { result, unmount } = renderHook(() => ({
			owner: useDisplaySliders({
				display,
				mode: "office",
				phase: "day",
				selection: ALL_MONITORS,
			}),
			mirror: useDisplaySliders({
				display,
				mode: "office",
				phase: "day",
				selection: ALL_MONITORS,
			}),
		}));

		act(() => result.current.owner.dragKelvin(4200));
		await waitFor(() => expect(result.current.mirror.kelvin).toBe(4200));
		await waitFor(() => expect(commands).toContain("display_preview"));

		await act(async () => {
			await result.current.owner.commitKelvin(4200);
		});

		await waitFor(() => {
			expect(result.current.owner.kelvin).toBe(5500);
			expect(result.current.mirror.kelvin).toBe(5500);
		});
		expect(commands).toContain("display_preview_end");
		unmount();
	});

	test("a mid-ramp drag previews the raw endpoint, not the day/night blend", async () => {
		// Regression: routing a drag through the blend mid-ramp scales the whole
		// slider travel by the ramp factor, so the screen stops well short of the
		// value under the thumb and the control reads as having a floor.
		const previews: unknown[] = [];
		mockIPC(
			(command, payload) => {
				if (command === "display_preview") {
					previews.push(payload);
				}
				return undefined;
			},
			{ shouldMockEvents: true },
		);
		const display = makeDisplay();
		const { result, unmount } = renderHook(() =>
			useDisplaySliders({
				display,
				mode: "office",
				phase: "night",
				rawEndpointPreview: true,
				selection: ALL_MONITORS,
			}),
		);

		act(() => result.current.dragBrightness(10));
		await waitFor(() => expect(previews.length).toBeGreaterThan(0));
		const last = previews.at(-1) as {
			brightness: number;
			endpointPhase: unknown;
		};
		expect(last.brightness).toBe(10);
		expect(last.endpointPhase).toBeNull();
		unmount();
	});

	test("a drag commits to the endpoint it started on, not the one the ramp moved to", async () => {
		// The schedule re-evaluates every few seconds during a ramp, so the live
		// phase can flip while the pointer is still down. The release must not
		// write the value the user picked for one profile into the other.
		const edits: { phase: string }[] = [];
		mockIPC((command, payload) => {
			if (command === "display_set_value") {
				edits.push((payload as { edit: { phase: string } }).edit);
				return { settings: {}, revision: -1 };
			}
			return undefined;
		});
		const display = makeDisplay();
		const { result, rerender, unmount } = renderHook(
			({ phase }: { phase: "day" | "night" }) =>
				useDisplaySliders({
					display,
					mode: "office",
					phase,
					selection: ALL_MONITORS,
				}),
			{ initialProps: { phase: "day" as "day" | "night" } },
		);

		act(() => result.current.dragBrightness(30));
		rerender({ phase: "night" });
		await act(async () => {
			await result.current.commitBrightness(30);
		});

		expect(edits).toHaveLength(1);
		expect(edits[0]?.phase).toBe("day");
		unmount();
	});
});
