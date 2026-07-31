import type { AppSettings, PartialSettings } from "@/bindings";
import { markSectionsEdited } from "./pending-edits";
import { enqueueSettingsSave, waitForSettingsSaves } from "./settings-saver";
import { useSettingsStore } from "./settings-store";

/**
 * The app's single settings persister.
 *
 * Edits land in the local zustand store instantly (optimistic UI), then a
 * debounced whole-section save posts every dirty section through the shared,
 * serialized save coordinator ({@link enqueueSettingsSave}) — the SAME chain the
 * feature-level persisters (`features/display`, `features/focus-*`,
 * `features/magicx`, `features/auto-dark`) use, so no two savers can race the
 * same revision or clobber each other's section via a stale whole-tree echo.
 *
 * This lives in `entities/setting` rather than in a view because BOTH windows
 * persist settings: the settings window owns every configuration panel, and the
 * main window's quick controls write `display` / `dayNight` / `focusBlur` /
 * `magicx`. A per-window saver would reintroduce exactly the cross-saver
 * revision race {@link enqueueSettingsSave} exists to close.
 */

type SectionKey = keyof AppSettings;

const SAVE_DELAY_MS = 400;
const dirty = new Set<SectionKey>();
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
}

function pick<K extends SectionKey>(
	sections: AppSettings,
	key: K,
	include: boolean,
): AppSettings[K] | null {
	return include ? sections[key] : null;
}

/** Build the patch for the given dirty sections, reading the CURRENT store at
 *  execution time so edits that landed during the debounce window coalesce. */
function buildPatch(sections: ReadonlySet<SectionKey>): PartialSettings {
	const current = useSettingsStore.getState().settings as AppSettings;
	return {
		appearance: pick(current, "appearance", sections.has("appearance")),
		general: pick(current, "general", sections.has("general")),
		hotkeys: pick(current, "hotkeys", sections.has("hotkeys")),
		display: pick(current, "display", sections.has("display")),
		dayNight: pick(current, "dayNight", sections.has("dayNight")),
		rules: pick(current, "rules", sections.has("rules")),
		focusRead: pick(current, "focusRead", sections.has("focusRead")),
		focusBlur: pick(current, "focusBlur", sections.has("focusBlur")),
		magicx: pick(current, "magicx", sections.has("magicx")),
		autoDark: pick(current, "autoDark", sections.has("autoDark")),
	};
}

function persistDirty(): Promise<void> {
	clearTimer();
	if (dirty.size === 0) {
		return waitForSettingsSaves();
	}
	// Snapshot which sections to flush, then hand the build off to the shared
	// coordinator (it reads the live store values at execution time).
	const sections = new Set(dirty);
	dirty.clear();
	const save = enqueueSettingsSave(() => buildPatch(sections)).catch(
		(error: unknown) => {
			// A terminal error must not turn an unsaved edit into apparently-clean
			// state. Put every attempted section back so the next explicit flush or
			// edit retries it.
			for (const section of sections) {
				dirty.add(section);
			}
			throw error;
		},
	);
	// Some lifecycle callers intentionally fire-and-forget. Attach a handler so
	// those calls do not create an unhandled rejection; callers that await the
	// original promise still receive the failure.
	void save.catch(() => undefined);
	return save;
}

function scheduleFlush(): void {
	clearTimer();
	timer = setTimeout(() => {
		void persistDirty().catch(() => undefined);
	}, SAVE_DELAY_MS);
}

type SectionPatcher<K extends SectionKey> = (
	patch: Partial<AppSettings[K]>,
) => void;

/** Apply a partial edit to one settings section (instant local UI) and queue
 *  the debounced whole-section persist. */
export function patchSettingsSection<K extends SectionKey>(
	section: K,
	patch: Partial<AppSettings[K]>,
): void {
	const state = useSettingsStore.getState();
	const patchers: { [S in SectionKey]: SectionPatcher<S> } = {
		appearance: state.updateAppearanceSettings,
		general: state.updateGeneralSettings,
		hotkeys: state.updateHotkeysSettings,
		// The display section carries HashMap fields (`monitorOverrides`, `modes`),
		// which tauri-specta types as `Partial<Record<…>>` while the Zod store types
		// them as `Record<…>`. Structurally interchangeable for a section-wholesale
		// patch; bridge the map-optionality gap with a cast rather than widening the
		// store's own types.
		display: state.updateDisplaySettings as SectionPatcher<"display">,
		dayNight: state.updateDayNightSettings,
		rules: state.updateRulesSettings,
		focusRead: state.updateFocusReadSettings,
		focusBlur: state.updateFocusBlurSettings,
		// The Zod store narrows `magicx.toolbarAlign` and `autoDark.*Theme` to enums
		// while tauri-specta types them as `string`; interchangeable for a wholesale
		// section patch (same bridge the display section uses).
		magicx: state.updateMagicxSettings as SectionPatcher<"magicx">,
		autoDark: state.updateAutoDarkSettings as SectionPatcher<"autoDark">,
	};
	patchers[section](patch);
	// Mark at EDIT time (not flush time): the debounce window is exactly where
	// a broadcast/echo could otherwise wipe this edit before it is saved.
	markSectionsEdited(section);
	dirty.add(section);
	scheduleFlush();
}

/** Persist any pending edits immediately (e.g. when the window hides). */
export function flushPendingSettings(): Promise<void> {
	return persistDirty();
}

/** Test-only: clear module-local debounce/dirty state between cases. */
export function resetSettingsPatcherForTests(): void {
	clearTimer();
	dirty.clear();
}
