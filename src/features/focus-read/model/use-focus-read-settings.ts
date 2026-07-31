import { useEffect, useState } from "react";
import { commands, events, type FocusReadSettings } from "@/bindings";
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

interface FocusReadSettingsDependencies {
	loadSnapshot: () => Promise<SettingsSnapshotLike>;
	settingsChanged: SettingsChangedSource;
}

const nativeDependencies: FocusReadSettingsDependencies = {
	loadSnapshot: () => commands.settingsLoadSnapshot(),
	settingsChanged: {
		listen: (handler) =>
			events.settingsChanged.listen((event) =>
				handler({ payload: event.payload }),
			),
	},
};

/** Subscribe-then-snapshot bridge, exported for a deterministic race test. */
export function subscribeFocusReadSettings(
	onSettings: (settings: FocusReadSettings) => void,
	dependencies: FocusReadSettingsDependencies = nativeDependencies,
): () => void {
	let newestRevision = -1;
	const applySnapshot = (snapshot: SettingsSnapshotLike) => {
		if (snapshot.revision < newestRevision) {
			return;
		}
		newestRevision = snapshot.revision;
		onSettings(normalizeSettings(snapshot.settings).focusRead);
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
 * The live `focusRead` settings for the `focus-overlay` window.
 *
 * The overlay is its own webview: its zustand store hydrates from the shared
 * localStorage cache, but cross-window edits only reach it through the backend
 * `settings:changed` broadcast. This seeds from `settings_load_snapshot` on
 * mount (backend wins) and stays fresh via that broadcast, so the shade's
 * colour / transparency / band height track edits made in the main window even
 * mid-preview.
 */
export function useFocusReadSettings(): FocusReadSettings {
	const stored = useSettingsStore((s) => s.settings.focusRead);
	const [live, setLive] = useState<FocusReadSettings>(stored);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		return subscribeFocusReadSettings(setLive);
	}, []);

	return live;
}
