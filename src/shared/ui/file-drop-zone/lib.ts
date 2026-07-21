/** A file the drop zone accepted, from either the DOM drop, the native
 *  Tauri drag-drop stream, or the click-to-browse dialog. */
export interface DroppedFile {
	name: string;
	/** Absolute native path when known (Tauri drops / dialog picks). */
	path?: string | undefined;
	/** Byte size when known (DOM drops expose it; native paths do not). */
	size?: number | undefined;
}

const TRAILING_EXTENSION_RE = /\.([^./\\]+)$/;

/** Lowercased extension without the dot, or "" when the name has none. */
export function fileExtension(name: string): string {
	return TRAILING_EXTENSION_RE.exec(name)?.[1]?.toLowerCase() ?? "";
}

/** True when `name` passes the `accept` extension filter (no filter = all). */
export function isAcceptedName(
	name: string,
	accept?: readonly string[] | undefined,
): boolean {
	if (!accept || accept.length === 0) {
		return true;
	}
	return accept.includes(fileExtension(name));
}

/** Bare file name from an absolute native path (both separators). */
export function fileNameFromPath(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export interface DropPartition {
	accepted: DroppedFile[];
	rejectedCount: number;
}

/** Split candidate files into accepted/rejected by the extension filter. */
export function partitionDroppedFiles(
	files: readonly DroppedFile[],
	accept?: readonly string[] | undefined,
): DropPartition {
	const accepted: DroppedFile[] = [];
	let rejectedCount = 0;
	for (const file of files) {
		if (isAcceptedName(file.name, accept)) {
			accepted.push(file);
		} else {
			rejectedCount += 1;
		}
	}
	return { accepted, rejectedCount };
}

/** Human list of accepted extensions for hints/errors, e.g. ".wav, .mp3". */
export function acceptSummary(accept: readonly string[]): string {
	return accept.map((ext) => `.${ext}`).join(", ");
}
