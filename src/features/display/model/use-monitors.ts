import { useEffect, useState } from "react";
import { commands, type MonitorInfo } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";

/**
 * Every physical monitor the engine can drive, loaded once on mount. Empty in a
 * non-native browser preview (and while the first `display_list_monitors` call
 * is in flight). The panel shows the multi-monitor strip only when more than one
 * monitor is present.
 */
export function useMonitors(): MonitorInfo[] {
	const [monitors, setMonitors] = useState<MonitorInfo[]>([]);

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		void commands
			.displayListMonitors()
			.then((list) => {
				if (!disposed) {
					setMonitors(list);
				}
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
		};
	}, []);

	return monitors;
}
