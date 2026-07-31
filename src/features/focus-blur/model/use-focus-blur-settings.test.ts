import { describe, expect, test } from "bun:test";
import { appSettingsSchema } from "@/shared/config/settings-schema";
import { subscribeFocusBlurSettings } from "./use-focus-blur-settings";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((onResolve) => {
		resolve = onResolve;
	});
	return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("subscribeFocusBlurSettings", () => {
	test("subscribes first and refuses a stale snapshot after a newer event", async () => {
		const registration = deferred<() => void>();
		const load = deferred<{ revision: number; settings: unknown }>();
		let handler:
			| ((event: { payload: { revision: number; settings: unknown } }) => void)
			| undefined;
		let loadCalls = 0;
		let unlistenCalls = 0;
		const applied: number[] = [];

		const unsubscribe = subscribeFocusBlurSettings(
			(settings) => applied.push(settings.transparency),
			{
				loadSnapshot: () => {
					loadCalls += 1;
					return load.promise;
				},
				settingsChanged: {
					listen: (next) => {
						handler = next;
						return registration.promise;
					},
				},
			},
		);

		expect(loadCalls).toBe(0);
		registration.resolve(() => {
			unlistenCalls += 1;
		});
		await flush();
		expect(loadCalls).toBe(1);

		const newer = appSettingsSchema.parse({});
		newer.focusBlur.transparency = 77;
		handler?.({ payload: { revision: 4, settings: newer } });
		const stale = appSettingsSchema.parse({});
		stale.focusBlur.transparency = 14;
		load.resolve({ revision: 3, settings: stale });
		await flush();

		expect(applied).toEqual([77]);
		unsubscribe();
		expect(unlistenCalls).toBe(1);
	});
});
