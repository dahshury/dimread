import { beforeEach, describe, expect, test } from "bun:test";
import { getSettingsStoreState, useSettingsStore } from "./settings-store";

const PERSIST_KEY = "dimread-settings";

describe("settings localStorage hydration", () => {
	beforeEach(() => {
		getSettingsStoreState().resetSettings();
		useSettingsStore.persist.clearStorage();
		useSettingsStore.setState({ isLoaded: false });
	});

	test("normalizes a partial cache and migrates legacy location coordinates", async () => {
		window.localStorage.setItem(
			PERSIST_KEY,
			JSON.stringify({
				state: {
					settings: {
						general: { minimizeToTray: false },
						downloads: { concurrency: 99 },
						dayNight: {
							useLocation: true,
							latitude: 30.0444,
							longitude: 31.2357,
						},
					},
				},
				version: 0,
			}),
		);

		await useSettingsStore.persist.rehydrate();

		const { settings, isLoaded } = getSettingsStoreState();
		expect(isLoaded).toBe(true);
		expect(settings.general.minimizeToTray).toBe(false);
		expect(settings.general.autostart).toBe(false);
		expect(settings.appearance.locale).toBe("en");
		expect(settings.dayNight.locationSource).toBe("manual");

		// The on-finish write heals the cache too, rather than carrying the
		// partial shape into the next window launch.
		const persisted = JSON.parse(window.localStorage.getItem(PERSIST_KEY)!);
		expect(persisted.state.settings.appearance.locale).toBe("en");
		expect(persisted.state.settings.general.autostart).toBe(false);
		expect(persisted.state.settings.dayNight.locationSource).toBe("manual");
	});
});
