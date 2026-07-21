import { useEffect, useState } from "react";
import { commands, events, type FocusBlurSettings } from "@/bindings";
import { normalizeSettings, useSettingsStore } from "@/entities/setting";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

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
		let disposed = false;
		void commands
			.settingsLoadSnapshot()
			.then((snapshot) => {
				if (!disposed) {
					setLive(normalizeSettings(snapshot.settings).focusBlur);
				}
			})
			.catch(() => undefined);
		const unsubscribe = subscribeNativeEvent(
			events.settingsChanged,
			(event) => {
				setLive(normalizeSettings(event.payload.settings).focusBlur);
			},
		);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, []);

	return live;
}
