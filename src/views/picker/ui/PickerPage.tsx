import { commands } from "@/bindings";
import { usePickerSelectionSync } from "@/entities/picker-selection";
import { cn } from "@/shared/lib/cn";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import { panelOrigin } from "../lib/panel-math";
import { usePanelRect } from "../model/use-panel-rect";
import { PICKER_INLINE_LIST_SLOT, PickerPanel } from "./PickerPanel";

function close(): void {
	// Routes through the Rust animated close (emits picker:closing, hides
	// after the fade grace) — never a bare webview hide.
	void commands.closeSelfWindow();
}

function isInlinePanelList(element: HTMLElement): boolean {
	return (
		element.getAttribute("role") === "listbox" &&
		element.closest(`[data-slot="${PICKER_INLINE_LIST_SLOT}"]`) !== null
	);
}

/**
 * The detached picker window: a full-workarea transparent backdrop (click
 * outside dismisses) with the visible panel positioned at the rect Rust
 * reports via `picker:anchor`, animated in/out with the t-dropdown recipe
 * and honoring `picker:closing`.
 */
export function PickerPage() {
	// This window both edits and displays the selection; stay in sync with
	// changes made elsewhere too.
	usePickerSelectionSync();
	const {
		dropdownStateClass,
		openGeneration,
		panelInteractive,
		panelRevealed,
		warmPanel,
	} = usePanelRect();
	useEscapeToClose(close, { ignoreLayer: isInlinePanelList });

	const viewportHeight =
		typeof window === "undefined" ? warmPanel.height : window.innerHeight;

	return (
		<div
			className="fixed inset-0 overflow-hidden"
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) {
					close();
				}
			}}
		>
			<div
				className={cn("t-dropdown absolute flex flex-col", dropdownStateClass)}
				data-origin={panelOrigin(warmPanel, viewportHeight)}
				style={{
					left: warmPanel.x,
					top: warmPanel.y,
					width: warmPanel.width,
					height: warmPanel.height,
					opacity: panelRevealed ? undefined : 0,
					pointerEvents: panelInteractive ? undefined : "none",
				}}
			>
				{/* Warm-mounted (never unmounted) so the first open repositions an
				    already-built tree; the generation key remounts it while hidden
				    to reset transient state (the search query). */}
				<PickerPanel active={panelInteractive} key={openGeneration} />
			</div>
		</div>
	);
}
