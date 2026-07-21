import { FileUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
// Type-only: erased at compile time, the runtime module stays lazy-loaded.
import type { OpenDialogOptions } from "@tauri-apps/plugin-dialog";
import {
	type DragEvent as ReactDragEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslations } from "use-intl";
import {
	droppedFilePath,
	FILE_DRAG_DROP_EVENT,
	fileDragDropPayloadFromEvent,
	hasNativeRuntime,
	wireFileDragDrop,
} from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import {
	acceptSummary,
	type DroppedFile,
	fileNameFromPath,
	isAcceptedName,
	partitionDroppedFiles,
} from "./lib";

export interface FileDropZoneProps {
	/** Allowed extensions (lowercase, no dot, e.g. `["wav", "mp3"]`).
	 *  Omit to accept every file. */
	accept?: readonly string[] | undefined;
	className?: string | undefined;
	disabled?: boolean | undefined;
	/** Override the main line (defaults to the localized "Drop files here"). */
	label?: string | undefined;
	/** Allow multiple files per drop/pick (default true). */
	multiple?: boolean | undefined;
	/** Receives every accepted file from a drop or a browse pick. */
	onFiles: (files: DroppedFile[]) => void;
}

/** How long after a native (Tauri) drop the duplicate DOM drop is ignored. */
const NATIVE_DROP_DEDUPE_MS = 500;

/**
 * Lazy-load the dialog plugin and open the native picker. Module scope because
 * React Compiler can't lower dynamic `import()` expressions inside a component
 * (the whole component would bail out of automatic memoization).
 */
async function pickViaNativeDialog(
	options: OpenDialogOptions,
): Promise<string | string[] | null> {
	const { open } = await import("@tauri-apps/plugin-dialog");
	return await open(options);
}

function toDroppedFile(file: File): DroppedFile {
	const path = droppedFilePath(file);
	return {
		name: file.name,
		size: file.size,
		...(path ? { path } : {}),
	};
}

/**
 * A generic dashed-border file target, ported from WinSTT's drop patterns
 * (`AudioDisplay` + the recording-sound drop): accepts files from BOTH the
 * native Tauri window drag-drop stream (which carries absolute paths and, on
 * some platforms, suppresses DOM drag events entirely) and plain DOM drops
 * (browser preview), plus a click-to-browse fallback through the dialog
 * plugin (hidden `<input type="file">` outside Tauri).
 *
 * Native drag-drop is window-scoped, not element-scoped — while a native drag
 * hovers anywhere over the window the zone arms itself, mirroring WinSTT's
 * whole-window drop affordance.
 */
export function FileDropZone({
	accept,
	className,
	disabled = false,
	label,
	multiple = true,
	onFiles,
}: FileDropZoneProps) {
	const t = useTranslations("dropZone");
	const [dragOver, setDragOver] = useState(false);
	const [rejectedCount, setRejectedCount] = useState(0);
	const dragCounter = useRef(0);
	const lastNativeDropAt = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const zoneBg = surfaceBg(Math.min(useSurface() + 1, 8));

	// Latest-props refs so the window-level native listener (mounted once) never
	// acts on stale accept/disabled/onFiles values.
	const propsRef = useRef({ accept, disabled, multiple, onFiles });
	useEffect(() => {
		propsRef.current = { accept, disabled, multiple, onFiles };
	});

	useEffect(() => {
		void wireFileDragDrop();
		const handleNative = (event: Event) => {
			const payload = fileDragDropPayloadFromEvent(event);
			const current = propsRef.current;
			if (payload === null || current.disabled) {
				return;
			}
			if (payload.type === "enter" || payload.type === "over") {
				const anyAccepted =
					payload.paths.length === 0 ||
					payload.paths.some((p) =>
						isAcceptedName(fileNameFromPath(p), current.accept),
					);
				if (anyAccepted) {
					setDragOver(true);
				}
				return;
			}
			dragCounter.current = 0;
			setDragOver(false);
			if (payload.type !== "drop") {
				return;
			}
			lastNativeDropAt.current = Date.now();
			const candidates = payload.paths.map((path) => ({
				name: fileNameFromPath(path),
				path,
			}));
			const limited = current.multiple ? candidates : candidates.slice(0, 1);
			const { accepted, rejectedCount: rejected } = partitionDroppedFiles(
				limited,
				current.accept,
			);
			setRejectedCount(rejected);
			if (accepted.length > 0) {
				current.onFiles(accepted);
			}
		};
		window.addEventListener(FILE_DRAG_DROP_EVENT, handleNative);
		return () => window.removeEventListener(FILE_DRAG_DROP_EVENT, handleNative);
	}, []);

	const deliver = (candidates: DroppedFile[]) => {
		const limited = multiple ? candidates : candidates.slice(0, 1);
		const { accepted, rejectedCount: rejected } = partitionDroppedFiles(
			limited,
			accept,
		);
		setRejectedCount(rejected);
		if (accepted.length > 0) {
			onFiles(accepted);
		}
	};

	const handleDragEnter = (e: ReactDragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (disabled) {
			return;
		}
		dragCounter.current += 1;
		if (e.dataTransfer.types.includes("Files")) {
			setDragOver(true);
		}
	};

	const handleDragOver = (e: ReactDragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = disabled ? "none" : "copy";
	};

	const handleDragLeave = (e: ReactDragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current -= 1;
		if (dragCounter.current <= 0) {
			dragCounter.current = 0;
			setDragOver(false);
		}
	};

	const handleDrop = (e: ReactDragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current = 0;
		setDragOver(false);
		if (disabled) {
			return;
		}
		// The native drop already delivered these files (with real paths) — the
		// DOM echo would double-report them.
		if (Date.now() - lastNativeDropAt.current < NATIVE_DROP_DEDUPE_MS) {
			return;
		}
		deliver(Array.from(e.dataTransfer.files).map(toDroppedFile));
	};

	const browseViaDialog = async (): Promise<boolean> => {
		try {
			const picked = await pickViaNativeDialog({
				multiple,
				...(accept && accept.length > 0
					? { filters: [{ extensions: [...accept], name: t("filterName") }] }
					: {}),
			});
			const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
			if (paths.length > 0) {
				deliver(paths.map((path) => ({ name: fileNameFromPath(path), path })));
			}
			return true;
		} catch {
			return false;
		}
	};

	const handleBrowse = async () => {
		if (disabled) {
			return;
		}
		setRejectedCount(0);
		if (hasNativeRuntime() && (await browseViaDialog())) {
			return;
		}
		inputRef.current?.click();
	};

	const hint =
		accept && accept.length > 0
			? t("hintExtensions", { extensions: acceptSummary(accept) })
			: t("hintAny");

	return (
		<div className={cn("flex w-full flex-col gap-1.5", className)}>
			<button
				aria-label={label ?? t("dropLabel")}
				className={cn(
					"flex w-full cursor-pointer select-none flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 outline-none transition-colors duration-150",
					"focus-visible:ring-2 focus-visible:ring-accent",
					dragOver
						? "border-accent bg-accent/[0.06]"
						: cn("border-divider hover:border-border-hover", zoneBg),
					disabled && "cursor-not-allowed opacity-40",
				)}
				disabled={disabled}
				onClick={() => void handleBrowse()}
				onDragEnter={handleDragEnter}
				onDragLeave={handleDragLeave}
				onDragOver={handleDragOver}
				onDrop={handleDrop}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={dragOver ? "text-accent" : "text-foreground-muted"}
					icon={FileUploadIcon}
					size={22}
					strokeWidth={1.5}
				/>
				<span
					className={cn(
						"font-medium text-body",
						dragOver ? "text-accent" : "text-foreground",
					)}
				>
					{label ?? t("dropLabel")}
				</span>
				<span className="text-body-sm text-foreground-muted">{hint}</span>
			</button>
			{rejectedCount > 0 ? (
				<p className="text-error text-xs-tight leading-snug" role="alert">
					{accept && accept.length > 0
						? t("rejected", {
								count: rejectedCount,
								extensions: acceptSummary(accept),
							})
						: t("rejectedGeneric", { count: rejectedCount })}
				</p>
			) : null}
			<input
				accept={accept?.map((ext) => `.${ext}`).join(",")}
				className="hidden"
				multiple={multiple}
				onChange={(e) => {
					deliver(Array.from(e.target.files ?? []).map(toDroppedFile));
					e.target.value = "";
				}}
				ref={inputRef}
				type="file"
			/>
		</div>
	);
}
