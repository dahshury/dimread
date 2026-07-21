import { create } from "zustand";

export type SettingsHydrationStatus =
	| "idle"
	| "loading"
	| "ready"
	| "unavailable"
	| "error";

interface SettingsHydrationState {
	error: string | null;
	/**
	 * Backend snapshot revision the renderer last observed. Saves send this
	 * back for optimistic concurrency; a stale revision is rejected by the
	 * backend and the renderer re-hydrates.
	 */
	revision: number;
	setRevision: (revision: number) => void;
	setStatus: (status: SettingsHydrationStatus, error?: string | null) => void;
	status: SettingsHydrationStatus;
}

export const useSettingsHydrationStore = create<SettingsHydrationState>(
	(set) => ({
		error: null,
		revision: 0,
		setRevision: (revision) => set({ revision }),
		setStatus: (status, error = null) => set({ error, status }),
		status: "idle",
	}),
);
