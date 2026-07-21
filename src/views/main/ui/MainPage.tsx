import { SurfaceProvider } from "@/shared/lib/surface";
import { TitleBar } from "@/widgets/title-bar";
import { QuickPanel } from "./QuickPanel";

/**
 * The main window shell — a frameless 440×600 quick-control panel: the reused
 * {@link TitleBar} chrome across the top and the single-column
 * {@link QuickPanel} beneath it.
 *
 * There is deliberately no tab rail here. The window exists to put the controls
 * with an immediate, visible effect one click away; everything configurational
 * lives in the settings window behind the title-bar gear. If a new control
 * needs a caption to explain itself, it belongs there, not here.
 */
export function MainPage() {
	return (
		<SurfaceProvider value={1}>
			<div
				className="flex h-dvh min-h-dvh flex-col bg-surface-1"
				data-window-root
			>
				<TitleBar />
				<div className="min-h-0 flex-1">
					<QuickPanel />
				</div>
			</div>
		</SurfaceProvider>
	);
}
