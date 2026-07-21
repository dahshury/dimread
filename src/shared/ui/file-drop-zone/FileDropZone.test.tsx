import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	emitFileDragDropEvent,
	FILE_DRAG_DROP_EVENT,
	fileDragDropPayloadFromEvent,
} from "@/shared/api";
import { FileDropZone } from "./FileDropZone";
import type { DroppedFile } from "./lib";
import {
	acceptSummary,
	fileExtension,
	fileNameFromPath,
	isAcceptedName,
	partitionDroppedFiles,
} from "./lib";

function renderZone(ui: React.ReactElement) {
	return render(<IntlProvider>{ui}</IntlProvider>);
}

function domFile(name: string, bytes = 4): File {
	return new File([new Uint8Array(bytes)], name);
}

function dropFiles(zone: HTMLElement, files: File[]) {
	fireEvent.drop(zone, {
		dataTransfer: { files, types: ["Files"] },
	});
}

describe("file-drop-zone lib", () => {
	test("fileExtension lowercases and handles missing/dot-only names", () => {
		expect(fileExtension("Sound.WAV")).toBe("wav");
		expect(fileExtension("archive.tar.gz")).toBe("gz");
		expect(fileExtension("README")).toBe("");
		expect(fileExtension(".gitignore")).toBe("gitignore");
	});

	test("isAcceptedName treats an empty filter as accept-all", () => {
		expect(isAcceptedName("a.exe")).toBe(true);
		expect(isAcceptedName("a.exe", [])).toBe(true);
		expect(isAcceptedName("a.exe", ["wav"])).toBe(false);
		expect(isAcceptedName("a.WAV", ["wav"])).toBe(true);
	});

	test("fileNameFromPath handles both separators", () => {
		expect(fileNameFromPath("C:\\tmp\\a.wav")).toBe("a.wav");
		expect(fileNameFromPath("/home/u/b.mp3")).toBe("b.mp3");
	});

	test("partitionDroppedFiles splits by the extension filter", () => {
		const files: DroppedFile[] = [{ name: "a.wav" }, { name: "b.txt" }];
		const { accepted, rejectedCount } = partitionDroppedFiles(files, ["wav"]);
		expect(accepted.map((f) => f.name)).toEqual(["a.wav"]);
		expect(rejectedCount).toBe(1);
	});

	test("acceptSummary formats a dotted list", () => {
		expect(acceptSummary(["wav", "mp3"])).toBe(".wav, .mp3");
	});
});

describe("file-drag-drop event codec", () => {
	test("round-trips a payload through the DOM CustomEvent", () => {
		let seen: unknown = null;
		const listener = (event: Event) => {
			seen = fileDragDropPayloadFromEvent(event);
		};
		window.addEventListener(FILE_DRAG_DROP_EVENT, listener);
		emitFileDragDropEvent({ type: "drop", paths: ["C:\\x\\a.wav"] });
		window.removeEventListener(FILE_DRAG_DROP_EVENT, listener);
		expect(seen).toEqual({ type: "drop", paths: ["C:\\x\\a.wav"] });
	});

	test("rejects malformed payloads", () => {
		expect(
			fileDragDropPayloadFromEvent(
				new CustomEvent(FILE_DRAG_DROP_EVENT, { detail: { type: "nope" } }),
			),
		).toBeNull();
		expect(
			fileDragDropPayloadFromEvent(new Event(FILE_DRAG_DROP_EVENT)),
		).toBeNull();
	});
});

describe("FileDropZone", () => {
	test("delivers DOM-dropped files with name and size", () => {
		const onFiles = mock((_files: DroppedFile[]) => undefined);
		renderZone(<FileDropZone label="Drop it" onFiles={onFiles} />);
		const zone = screen.getByRole("button", { name: "Drop it" });
		dropFiles(zone, [domFile("a.wav", 8), domFile("b.mp3", 16)]);
		expect(onFiles).toHaveBeenCalledTimes(1);
		const delivered = onFiles.mock.calls[0]?.[0] ?? [];
		expect(delivered.map((f) => f.name)).toEqual(["a.wav", "b.mp3"]);
		expect(delivered.map((f) => f.size)).toEqual([8, 16]);
	});

	test("filters rejected extensions and surfaces the rejection notice", () => {
		const onFiles = mock((_files: DroppedFile[]) => undefined);
		renderZone(
			<FileDropZone accept={["wav"]} label="Drop it" onFiles={onFiles} />,
		);
		const zone = screen.getByRole("button", { name: "Drop it" });
		dropFiles(zone, [domFile("a.wav"), domFile("virus.exe")]);
		expect(onFiles).toHaveBeenCalledTimes(1);
		expect((onFiles.mock.calls[0]?.[0] ?? []).map((f) => f.name)).toEqual([
			"a.wav",
		]);
		expect(screen.getByRole("alert")).toBeDefined();
	});

	test("does not call onFiles when every file is rejected", () => {
		const onFiles = mock((_files: DroppedFile[]) => undefined);
		renderZone(
			<FileDropZone accept={["wav"]} label="Drop it" onFiles={onFiles} />,
		);
		dropFiles(screen.getByRole("button", { name: "Drop it" }), [
			domFile("virus.exe"),
		]);
		expect(onFiles).toHaveBeenCalledTimes(0);
		expect(screen.getByRole("alert")).toBeDefined();
	});

	test("single mode keeps only the first dropped file", () => {
		const onFiles = mock((_files: DroppedFile[]) => undefined);
		renderZone(
			<FileDropZone label="Drop it" multiple={false} onFiles={onFiles} />,
		);
		dropFiles(screen.getByRole("button", { name: "Drop it" }), [
			domFile("a.wav"),
			domFile("b.wav"),
		]);
		expect((onFiles.mock.calls[0]?.[0] ?? []).map((f) => f.name)).toEqual([
			"a.wav",
		]);
	});

	test("native drop events deliver paths and suppress the DOM echo", () => {
		const onFiles = mock((_files: DroppedFile[]) => undefined);
		renderZone(<FileDropZone label="Drop it" onFiles={onFiles} />);
		emitFileDragDropEvent({ type: "drop", paths: ["C:\\snd\\chime.wav"] });
		expect(onFiles).toHaveBeenCalledTimes(1);
		expect(onFiles.mock.calls[0]?.[0]).toEqual([
			{ name: "chime.wav", path: "C:\\snd\\chime.wav" },
		]);
		// The duplicate DOM drop that follows a native drop is ignored.
		dropFiles(screen.getByRole("button", { name: "Drop it" }), [
			domFile("chime.wav"),
		]);
		expect(onFiles).toHaveBeenCalledTimes(1);
	});

	test("ignores drops while disabled", () => {
		const onFiles = mock((_files: DroppedFile[]) => undefined);
		renderZone(<FileDropZone disabled label="Drop it" onFiles={onFiles} />);
		dropFiles(screen.getByRole("button", { name: "Drop it" }), [
			domFile("a.wav"),
		]);
		emitFileDragDropEvent({ type: "drop", paths: ["C:\\a.wav"] });
		expect(onFiles).toHaveBeenCalledTimes(0);
	});
});
