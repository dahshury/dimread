import { useEffect, useState } from "react";
import { commands, events, type FocusReadSettings } from "@/bindings";
import { normalizeSettings, useSettingsStore } from "@/entities/setting";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

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
		let disposed = false;
		void commands
			.settingsLoadSnapshot()
			.then((snapshot) => {
				if (!disposed) {
					setLive(normalizeSettings(snapshot.settings).focusRead);
				}
			})
			.catch(() => undefined);
		const unsubscribe = subscribeNativeEvent(
			events.settingsChanged,
			(event) => {
				setLive(normalizeSettings(event.payload.settings).focusRead);
			},
		);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, []);

	return live;
}
