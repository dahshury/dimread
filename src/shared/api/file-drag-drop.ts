// ── Native file drag-drop bridge (ported from WinSTT) ───────────────────────
// Tauri's webview does NOT expose native paths on the DOM `File` object
// (security), and on some platforms the native drag-drop handler swallows DOM
// drag events entirely. This module bridges both gaps:
//
//   1. `wireFileDragDrop()` subscribes ONCE to the window's Tauri
//      `onDragDropEvent` stream and re-broadcasts every phase as a DOM
//      CustomEvent (`FILE_DRAG_DROP_EVENT`) so plain React components can
//      listen without importing @tauri-apps/api.
//   2. Both the `enter` and `drop` phases carry absolute `paths`; they are
//      stashed in a name-keyed map so `droppedFilePath(file)` can resolve a
//      DOM `File` to its native path SYNCHRONOUSLY inside a DOM drop handler
//      (the native `enter` fires before the DOM `drop`, so the map is already
//      populated by the time the drop is handled).
//
// Outside a Tauri window (browser preview, tests) everything no-ops cleanly.

import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";

export const FILE_DRAG_DROP_EVENT = "starter:file-drag-drop";

export type FileDragDropType = "enter" | "over" | "drop" | "leave";

export interface FileDragDropPayload {
	type: FileDragDropType;
	paths: string[];
}

export function emitFileDragDropEvent(payload: FileDragDropPayload): void {
	if (typeof window === "undefined") {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<FileDragDropPayload>(FILE_DRAG_DROP_EVENT, {
			detail: payload,
		}),
	);
}

export function fileDragDropPayloadFromEvent(
	event: Event,
): FileDragDropPayload | null {
	if (!(event instanceof CustomEvent)) {
		return null;
	}
	const detail = event.detail as Partial<FileDragDropPayload> | undefined;
	if (
		detail === undefined ||
		(detail.type !== "enter" &&
			detail.type !== "over" &&
			detail.type !== "drop" &&
			detail.type !== "leave") ||
		!Array.isArray(detail.paths)
	) {
		return null;
	}
	return { type: detail.type, paths: detail.paths };
}

const lastDropPaths = new Map<string, string>();

function rememberDropPaths(paths: readonly string[]): void {
	for (const path of paths) {
		const name = path.split(/[\\/]/).pop();
		if (name) {
			// Key by bare name — the DOM File exposes name+size, never the path.
			lastDropPaths.set(name, path);
		}
	}
}

/**
 * Resolve a DOM `File` from a drop event to the absolute native path the
 * OS announced for it, or `""` when unknown (browser preview, or the file
 * did not arrive through a native drag).
 */
export function droppedFilePath(file: File): string {
	return lastDropPaths.get(file.name) ?? "";
}

let wired: Promise<void> | null = null;

/**
 * Idempotently subscribe to the current window's native drag-drop stream.
 * Safe to call from every consumer mount — only the first call installs the
 * listener; later calls reuse the same subscription.
 */
export function wireFileDragDrop(): Promise<void> {
	if (wired) {
		return wired;
	}
	if (!hasTauriRuntime()) {
		wired = Promise.resolve();
		return wired;
	}
	wired = (async () => {
		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			await getCurrentWindow().onDragDropEvent((event) => {
				const payload = event.payload;
				// `enter` AND `drop` carry `paths` in Tauri v2. Stash on BOTH: `enter`
				// (before the DOM drop) makes the synchronous `droppedFilePath`
				// resolve; `drop` is the backstop. `over`/`leave` carry no paths.
				if (payload.type === "enter" || payload.type === "drop") {
					rememberDropPaths(payload.paths);
				}
				emitFileDragDropEvent({
					type: payload.type,
					paths:
						payload.type === "enter" || payload.type === "drop"
							? [...payload.paths]
							: [],
				});
			});
		} catch {
			// Not in a Tauri window context — drag-drop bridge unavailable.
		}
	})();
	return wired;
}
