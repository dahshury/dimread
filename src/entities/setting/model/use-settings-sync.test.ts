import { beforeEach, describe, expect, test } from "bun:test";
import type { AppSettings, SettingsSnapshot } from "@/bindings";
import { clearPendingEdits } from "./pending-edits";
import { useSettingsHydrationStore } from "./settings-hydration-store";
import { normalizeSettings, useSettingsStore } from "./settings-store";
import { startSettingsSync } from "./use-settings-sync";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function snapshot(revision: number): SettingsSnapshot {
	return {
		revision,
		settings: normalizeSettings({}) as AppSettings,
	};
}

describe("settings sync bootstrap", () => {
	beforeEach(() => {
		useSettingsStore.getState().resetSettings();
		clearPendingEdits();
		useSettingsHydrationStore.setState({
			error: null,
			revision: 0,
			status: "idle",
		});
	});

	test("subscribes before loading and recovers a load error from a live event", async () => {
		const order: string[] = [];
		let handler: ((event: { payload: SettingsSnapshot }) => void) | null = null;
		let unlistened = 0;
		const stop = startSettingsSync(
			{
				listen: async (next) => {
					order.push("listen");
					handler = next;
					return () => {
						unlistened += 1;
					};
				},
			},
			async () => {
				order.push("load");
				throw new Error("temporarily unavailable");
			},
		);

		await flush();
		expect(order).toEqual(["listen", "load"]);
		expect(useSettingsHydrationStore.getState()).toMatchObject({
			error: "temporarily unavailable",
			status: "error",
		});

		const emit = handler as unknown as (event: {
			payload: SettingsSnapshot;
		}) => void;
		emit({ payload: snapshot(3) });
		expect(useSettingsHydrationStore.getState()).toMatchObject({
			error: null,
			revision: 3,
			status: "ready",
		});

		stop();
		expect(unlistened).toBe(1);
	});
});
