import { useEffect, useState } from "react";
import { commands, events, type MonitorInfo } from "@/bindings";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";

export interface MonitorTopology {
	monitors: MonitorInfo[];
	ready: boolean;
}

/**
 * Every physical monitor the engine can drive. The native snapshot seeds the
 * hook and `display:topology` keeps it current after hot-plug/reconfiguration;
 * there is no renderer polling. Empty in a non-native browser preview (and
 * while the initial snapshot is in flight).
 */
export function useMonitorTopology(): MonitorTopology {
	const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
	const [ready, setReady] = useState(!hasNativeRuntime());

	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let disposed = false;
		const unsubscribe = subscribeNativeEvent(
			events.displayTopology,
			(event) => {
				setMonitors(event.payload);
				setReady(true);
			},
		);
		void commands
			.displayListMonitors()
			.then((list) => {
				if (!disposed) {
					setMonitors(list);
					setReady(true);
				}
			})
			.catch(() => {
				if (!disposed) {
					// A failed snapshot must not keep startup consumers waiting forever.
					setReady(true);
				}
			});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, []);

	return { monitors, ready };
}

export function useMonitors(): MonitorInfo[] {
	return useMonitorTopology().monitors;
}
