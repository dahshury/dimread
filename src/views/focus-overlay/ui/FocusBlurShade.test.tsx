import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactNode } from "react";
import type { FocusAnchorEvent } from "@/bindings";
import { FocusBlurShade } from "./FocusBlurShade";

/**
 * The generated `events` object is a Proxy that mints a FRESH accessor on every
 * property read, so `events.focusAnchor.listen` cannot be stubbed in place — the
 * component's next read rebuilds it. The accessor delegates to
 * `@tauri-apps/api/event`, so that module is the only stable seam; stubbing it
 * lets a test push a `focus:anchor` sample without a real webview.
 *
 * Mocking a module is process-wide in bun, but the blast radius here is nil:
 * this is the only suite that sets `__TAURI_INTERNALS__` truthy, and every other
 * suite explicitly clears it, so no other test ever reaches a real `listen`.
 */
const listeners = new Map<string, (event: { payload: unknown }) => void>();

mock.module("@tauri-apps/api/event", () => ({
	listen: (name: string, cb: (event: { payload: unknown }) => void) => {
		listeners.set(name, cb);
		return Promise.resolve(() => listeners.delete(name));
	},
	once: () => Promise.resolve(() => undefined),
	emit: () => Promise.resolve(),
}));

/** The shade paints one absolutely-positioned region container per monitor. */
const REGION_SELECTOR = ".pointer-events-none.absolute.overflow-hidden";

/** The shade is built from `m.*` components, which throw outside the strict
 *  LazyMotion provider the `focus-overlay` entry wraps the tree in. */
function Motion({ children }: { children: ReactNode }) {
	return (
		<LazyMotion features={domAnimation} strict>
			{children}
		</LazyMotion>
	);
}

/** A window-local anchor sample; `monitors` is the per-display shade region set.
 *  `windowId` is the focused window's handle — override it to model a focus
 *  SWITCH, keep it to model the same window moving. */
function anchor(over: Partial<FocusAnchorEvent> = {}): FocusAnchorEvent {
	return {
		windowId: 1,
		x: 100,
		y: 200,
		width: 400,
		height: 300,
		monitorLeft: 0,
		monitorTop: 0,
		monitorRight: 1920,
		monitorBottom: 1040,
		taskbar: false,
		monitors: [{ left: 0, top: 0, right: 1920, bottom: 1040 }],
		...over,
	};
}

function regions(container: HTMLElement): NodeListOf<Element> {
	return container.querySelectorAll(REGION_SELECTOR);
}

describe("FocusBlurShade", () => {
	beforeEach(() => {
		listeners.clear();
		// Pretend we are inside a Tauri webview so the component subscribes. The
		// settings hook's `settings_load_snapshot` call rejects against this empty
		// internals object and is swallowed by its own `.catch`, leaving the store
		// defaults (onlyCurrentMonitor: false) in effect — exactly the mode under
		// test.
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = {};
	});

	afterEach(() => {
		cleanup();
		listeners.clear();
		(
			window as unknown as { __TAURI_INTERNALS__?: unknown }
		).__TAURI_INTERNALS__ = undefined;
	});

	/** Render, then deliver one anchor sample through the stubbed listener. */
	async function renderWithAnchor(event: FocusAnchorEvent, active = true) {
		const view = render(
			<Motion>
				<FocusBlurShade active={active} />
			</Motion>,
		);
		// The listen() promise resolves on a microtask; flush before emitting.
		await act(async () => undefined);
		await act(async () => {
			listeners.get("focus:anchor")?.({ payload: event });
		});
		return view;
	}

	test("paints nothing before an anchor arrives", async () => {
		const { container } = render(
			<Motion>
				<FocusBlurShade active={true} />
			</Motion>,
		);
		await act(async () => undefined);
		// No hole-less full-screen shade may flash while we wait for the tracker.
		expect(regions(container)).toHaveLength(0);
	});

	test("paints nothing while Focus Blur is inactive", async () => {
		const { container } = await renderWithAnchor(anchor(), false);
		expect(regions(container)).toHaveLength(0);
	});

	test("paints one region for a single-monitor desktop", async () => {
		const { container } = await renderWithAnchor(anchor());
		expect(regions(container)).toHaveLength(1);
	});

	test("paints one region per monitor so every taskbar stays clear", async () => {
		// The regression this guards: whole-virtual-screen mode used to paint a
		// single viewport-sized shade, which swallowed every monitor's taskbar and
		// made the "include taskbar" toggle a no-op.
		const { container } = await renderWithAnchor(
			anchor({
				monitors: [
					{ left: 0, top: 0, right: 1920, bottom: 1040 },
					{ left: 1920, top: 0, right: 3840, bottom: 1030 },
				],
			}),
		);
		const painted = regions(container);
		expect(painted).toHaveLength(2);
		// Each region is its own monitor's work area, not one spanning rect.
		expect((painted[0] as HTMLElement).style.height).toBe("1040px");
		expect((painted[1] as HTMLElement).style.left).toBe("1920px");
		expect((painted[1] as HTMLElement).style.height).toBe("1030px");
	});

	test("falls back to a single region when monitor enumeration is empty", async () => {
		const { container } = await renderWithAnchor(anchor({ monitors: [] }));
		// The tint must never silently disappear if EnumDisplayMonitors fails.
		expect(regions(container)).toHaveLength(1);
	});

	/** Deliver a further anchor sample to an already-rendered shade. */
	async function emitAnchor(event: FocusAnchorEvent) {
		await act(async () => {
			listeners.get("focus:anchor")?.({ payload: event });
		});
	}

	/** The clear hole's transform, which is where the cutout's position lives. */
	function cutoutTransform(container: HTMLElement): string {
		const cutout = container.querySelector(".will-change-transform");
		return (cutout as HTMLElement | null)?.style.transform ?? "";
	}

	test("snaps the cutout when the SAME window moves", async () => {
		// The lag fix: a spring chasing a window that is still being dragged is
		// itself perceived as lag, so a move must land on the new position in the
		// same frame rather than easing toward it.
		const { container } = await renderWithAnchor(anchor({ x: 100, y: 200 }));
		await emitAnchor(anchor({ x: 700, y: 500 }));
		expect(cutoutTransform(container)).toContain("700px");
		expect(cutoutTransform(container)).toContain("500px");
	});

	test("does not snap when focus SWITCHES to a different window", async () => {
		// A switch is a discrete jump between two windows, which should glide —
		// so the cutout must NOT be sitting on the destination immediately.
		const { container } = await renderWithAnchor(
			anchor({ windowId: 1, x: 100, y: 200 }),
		);
		await emitAnchor(anchor({ windowId: 2, x: 700, y: 500 }));
		expect(cutoutTransform(container)).not.toContain("700px");
	});
});
