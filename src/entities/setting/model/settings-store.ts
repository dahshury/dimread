import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	type AppSettingsOutput,
	appSettingsSchema,
} from "@/shared/config/settings-schema";

const DEFAULTS: AppSettingsOutput = appSettingsSchema.parse({});

/**
 * Re-parse a settings tree through the Zod schema so every field heals to its
 * default when a persisted/broadcast payload is partially invalid.
 */
export function normalizeSettings(input: unknown): AppSettingsOutput {
	const result = appSettingsSchema.safeParse(input ?? {});
	return result.success ? result.data : DEFAULTS;
}

/**
 * Top-level settings keys whose value is an object section.
 */
type SectionKey = keyof AppSettingsOutput;

/** Shallow-merge `patch` into a single top-level section of the settings tree. */
function patchSection<K extends SectionKey>(
	settings: AppSettingsOutput,
	key: K,
	patch: Partial<AppSettingsOutput[K]>,
): AppSettingsOutput {
	return {
		...settings,
		[key]: { ...settings[key], ...patch },
	};
}

interface SettingsState {
	isLoaded: boolean;
	resetSettings: () => void;
	setLoaded: (loaded: boolean) => void;
	/**
	 * HYDRATION / cross-window BROADCAST path, not a user edit. The writer
	 * normalizes before persisting, so the value handed here is already
	 * consistent.
	 */
	setSettings: (settings: AppSettingsOutput) => void;
	settings: AppSettingsOutput;
	updateAppearanceSettings: (
		patch: Partial<AppSettingsOutput["appearance"]>,
	) => void;
	updateAutoDarkSettings: (
		patch: Partial<AppSettingsOutput["autoDark"]>,
	) => void;
	updateDayNightSettings: (
		patch: Partial<AppSettingsOutput["dayNight"]>,
	) => void;
	updateDisplaySettings: (patch: Partial<AppSettingsOutput["display"]>) => void;
	updateFocusBlurSettings: (
		patch: Partial<AppSettingsOutput["focusBlur"]>,
	) => void;
	updateFocusReadSettings: (
		patch: Partial<AppSettingsOutput["focusRead"]>,
	) => void;
	updateMagicxSettings: (patch: Partial<AppSettingsOutput["magicx"]>) => void;
	updateDownloadsSettings: (
		patch: Partial<AppSettingsOutput["downloads"]>,
	) => void;
	updateGeneralSettings: (patch: Partial<AppSettingsOutput["general"]>) => void;
	updateHotkeysSettings: (patch: Partial<AppSettingsOutput["hotkeys"]>) => void;
	updateRulesSettings: (patch: Partial<AppSettingsOutput["rules"]>) => void;
}

export const useSettingsStore = create<SettingsState>()(
	persist(
		(set) => ({
			settings: DEFAULTS,
			isLoaded: false,
			setSettings: (settings) => set({ settings, isLoaded: true }),
			updateAppearanceSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "appearance", patch),
				})),
			updateGeneralSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "general", patch),
				})),
			updateDownloadsSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "downloads", patch),
				})),
			updateHotkeysSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "hotkeys", patch),
				})),
			updateDisplaySettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "display", patch),
				})),
			updateDayNightSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "dayNight", patch),
				})),
			updateRulesSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "rules", patch),
				})),
			updateFocusReadSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "focusRead", patch),
				})),
			updateFocusBlurSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "focusBlur", patch),
				})),
			updateMagicxSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "magicx", patch),
				})),
			updateAutoDarkSettings: (patch) =>
				set((state) => ({
					settings: patchSection(state.settings, "autoDark", patch),
				})),
			resetSettings: () => set({ settings: DEFAULTS }),
			setLoaded: (loaded) => set({ isLoaded: loaded }),
		}),
		{
			name: "dimread-settings",
			partialize: (state) => ({ settings: state.settings }),
		},
	),
);

export function getSettingsStoreState(): SettingsState {
	return useSettingsStore.getState();
}

// Mark loaded after localStorage hydration completes.
// Cannot use onRehydrateStorage because it fires during create() before
// useSettingsStore is assigned, causing a ReferenceError.
// Use onFinishHydration + hasHydrated check to cover both sync and async
// hydration.
if (typeof window !== "undefined") {
	if (useSettingsStore.persist.hasHydrated()) {
		useSettingsStore.setState({ isLoaded: true });
	}
	useSettingsStore.persist.onFinishHydration(() => {
		useSettingsStore.setState({ isLoaded: true });
	});
}
