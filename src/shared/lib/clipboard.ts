import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { fireAndForget } from "./fire-and-forget";

/**
 * Copy text to the clipboard, preferring the Web Clipboard API and falling
 * back to the Tauri clipboard plugin when it is unavailable or rejects
 * (focus/permission quirks inside the WebView).
 */
export function copyToClipboard(text: string): void {
	if (!text) {
		return;
	}
	const webClipboard = globalThis.navigator?.clipboard;
	if (webClipboard?.writeText) {
		webClipboard.writeText(text).catch(() => {
			fireAndForget(tauriWriteText(text), "clipboard.tauriFallback");
		});
		return;
	}
	fireAndForget(tauriWriteText(text), "clipboard.tauriFallback");
}

/** How long a "copied" checkmark stays lit after a clipboard write, in ms. */
export const COPY_FEEDBACK_MS = 1600;
