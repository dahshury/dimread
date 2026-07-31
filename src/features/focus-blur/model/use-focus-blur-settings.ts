import { useEffect, useState } from "react";
import { commands, events, type FocusBlurSettings } from "@/bindings";
import { normalizeSettings, useSettingsStore } from "@/entities/setting";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

interface SettingsSnapshotLike {
	revision: number;
	settings: unknown;
}

interface SettingsChangedSource {
	listen: (
		handler: (event: { payload: SettingsSnapshotLike }) => void,
	) => Promise<() => void>;
}

interface FocusBlurSettingsDependencies {
	loadSnapshot: () => Promise<SettingsSnapshotLike>;
	settingsChanged: SettingsChangedSource;
}

const nativeDependencies: FocusBlurSettingsDependencies = {
	loadSnapshot: () => commands.settingsLoadSnapshot(),
	settingsChanged: {
		listen: (handler) =>
			events.settingsChanged.listen((event) =>
				handler({ payload: event.payload }),
			),
	},
};

/** Subscribe-then-snapshot bridge, exported for a deterministic race test. */
export function subscribeFocusBlurSettings(
	onSettings: (settings: FocusBlurSettings) => void,
	dependencies: FocusBlurSettingsDependencies = nativeDependencies,
): () => void {
	let newestRevision = -1;
	const applySnapshot = (snapshot: SettingsSnapshotLike) => {
		if (snapshot.revision < newestRevision) {
			return;
		}
		newestRevision = snapshot.revision;
		onSettings(normalizeSettings(snapshot.settings).focusBlur);
	};
	return subscribeNativeEvent(
		dependencies.settingsChanged,
		(event) => {
			applySnapshot(event.payload);
		},
		async (isDisposed) => {
			// Install the event listener BEFORE reading. The revision guard then
			// prevents an older in-flight load from overwriting a newer event.
			const snapshot = await dependencies.loadSnapshot();
			if (!isDisposed()) {
				applySnapshot(snapshot);
			}
		},
	);
}

/**
 * The live `focusBlur` settings for the `focus-overlay` window.
 *
 * The overlay is its own webview: its zustand store hydrates from the shared
 * localStorage cache, but cross-window edits only reach it through the backend
 * `settings:changed` broadcast. This seeds from `settings_load_snapshot` on
 * mount (backend wins) and stays fresh via that broadcast, so the shade's colour
 * / transparency / only-current-monitor track edits made in the main window in
 * real time.
 */
export function useFocusBlurSettings(): FocusBlurSettings {
	const stored = useSettingsStore((s) => s.settings.focusBlur);
	const [live, setLive] = useState<FocusBlurSettings>(stored);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		return subscribeFocusBlurSettings(setLive);
	}, []);

	return live;
}
