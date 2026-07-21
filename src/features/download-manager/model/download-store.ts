import { create } from "zustand";
import {
	commands,
	type DownloadPhase,
	type DownloadSnapshot,
	type Result,
} from "@/bindings";
import {
	mergeProgressIntoSnapshot,
	type ProgressSnapshotFields,
} from "@/shared/lib/download-progress-core";

/** Log a failed download command; the store's state stays event-driven, so a
 *  rejected command simply produces no snapshot frame. */
function logIfError(label: string, pending: Promise<Result<null, string>>) {
	void pending
		.then((result) => {
			if (result.status === "error") {
				console.error(`${label} failed`, result.error);
			}
		})
		.catch((e: unknown) => {
			console.error(`${label} failed`, e);
		});
}

/** Renderer view of one download: the backend snapshot's identity/phase plus
 *  monotonic byte fields (the bar never goes backwards even if events land
 *  out of order). */
export interface DownloadState extends ProgressSnapshotFields {
	error: string | null;
	etaSeconds: number | null;
	fileName: string;
	id: string;
	phase: DownloadPhase;
	speedBps: number | null;
	url: string;
}

const TERMINAL_PHASES: ReadonlySet<DownloadPhase> = new Set([
	"completed",
	"cancelled",
	"failed",
]);

export function isTerminalPhase(phase: DownloadPhase): boolean {
	return TERMINAL_PHASES.has(phase);
}

function toDownloadState(
	previous: DownloadState | undefined,
	snapshot: DownloadSnapshot,
): DownloadState {
	// A terminal or restarted download resets the monotonic floor; an in-flight
	// one merges monotonically so late/duplicate frames can't regress the bar.
	const startedOver =
		previous === undefined ||
		snapshot.phase === "queued" ||
		isTerminalPhase(previous.phase);
	const bytes = mergeProgressIntoSnapshot(startedOver ? undefined : previous, {
		downloadedBytes: snapshot.downloadedBytes,
		progress: snapshot.progress,
		totalBytes: snapshot.totalBytes ?? 0,
	});
	return {
		...bytes,
		id: snapshot.id,
		url: snapshot.url,
		fileName: snapshot.fileName,
		phase: snapshot.phase,
		speedBps: snapshot.speedBps ?? null,
		etaSeconds: snapshot.etaSeconds ?? null,
		error: snapshot.error ?? null,
	};
}

interface DownloadManagerState {
	/** Apply one backend-authoritative snapshot frame. */
	applySnapshot: (snapshot: DownloadSnapshot) => void;
	cancel: (id: string) => void;
	downloads: Record<string, DownloadState>;
	pause: (id: string) => void;
	/** Drop a download's file + entry (backend) and its local record. */
	remove: (id: string) => void;
	resume: (id: string) => void;
	start: (id: string, url: string, fileName: string) => void;
}

export const useDownloadStore = create<DownloadManagerState>()((set) => ({
	downloads: {},
	applySnapshot: (snapshot) =>
		set((state) => ({
			downloads: {
				...state.downloads,
				[snapshot.id]: toDownloadState(state.downloads[snapshot.id], snapshot),
			},
		})),
	start: (id, url, fileName) => {
		logIfError("download start", commands.downloadStart(id, url, fileName));
	},
	pause: (id) => {
		logIfError("download pause", commands.downloadPause(id));
	},
	resume: (id) => {
		logIfError("download resume", commands.downloadResume(id));
	},
	cancel: (id) => {
		logIfError("download cancel", commands.downloadCancel(id));
	},
	remove: (id) => {
		set((state) => {
			const downloads = { ...state.downloads };
			delete downloads[id];
			return { downloads };
		});
		logIfError("download remove", commands.downloadRemove(id));
	},
}));

/** Whether `id` has an in-flight (non-terminal) download. Read synchronously
 *  (not a hook) so non-React callers can check the live map. */
export function isDownloading(id: string): boolean {
	const entry = useDownloadStore.getState().downloads[id];
	return entry !== undefined && !isTerminalPhase(entry.phase);
}
