import { commands } from "@/bindings";
import { hasNativeRuntime } from "@/shared/api";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import { TrayMenuPanel } from "./TrayMenuPanel";

function close(): void {
	if (hasNativeRuntime()) {
		void commands.trayMenuHide().catch(() => undefined);
	}
}

/**
 * The `tray-menu` window's whole surface: the tray flyout that replaced the
 * native tray context menu.
 *
 * The window is transparent, frameless and sized to the panel, so this page is
 * just the panel plus its dismiss affordances. Click-away is handled in Rust
 * (the window takes focus on open, and losing focus parks it off-screen); this
 * layer only adds Escape.
 */
export function TrayMenuPage() {
	useEscapeToClose(close);
	return <TrayMenuPanel />;
}
