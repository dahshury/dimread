import { platform } from "@tauri-apps/plugin-os";

/**
 * Human-readable display labels for Tauri accelerator tokens (the format the
 * HotkeyRecorder emits: "Ctrl+Shift+Space", "Alt+ArrowUp", …). Ported from
 * WinSTT's format-key-name, adapted to the starter's side-agnostic tokens.
 */
const DISPLAY_LABELS: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	PageUp: "Pg Up",
	PageDown: "Pg Dn",
};

/**
 * The platform's "Meta"/"Super" modifier label: Cmd on macOS, Super on Linux,
 * Win on Windows. `platform()` is synchronous in Tauri v2 (injected at window
 * creation) but throws outside a Tauri runtime (tests, bare browser), so the
 * read is wrapped and falls back to the generic "Super".
 */
function metaKeyLabel(): string {
	try {
		switch (platform()) {
			case "macos":
				return "Cmd";
			case "windows":
				return "Win";
			default:
				return "Super";
		}
	} catch {
		return "Super";
	}
}

/** Map one accelerator token to its display label. */
export function formatKeyName(key: string): string {
	if (key === "Super") {
		return metaKeyLabel();
	}
	return DISPLAY_LABELS[key] ?? key;
}
