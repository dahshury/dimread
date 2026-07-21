/**
 * On-demand demo clips for settings hover-previews.
 *
 * The clips are NOT bundled in the installer — they're fetched from a remote
 * docs site / CDN only when the user hovers a control, and fail soft when
 * offline. Keeping them remote keeps the installer small and lets you refresh
 * the demos without shipping an update.
 *
 * Point `DEMO_PREVIEW_BASE` at your own host (each demo name resolves to
 * `<base>/<name>.webm`).
 */
export const DEMO_PREVIEW_BASE = "https://example.com/demos";

/** Resolve a demo name (e.g. "feature-tour") to its remote .webm URL. */
export function demoPreviewUrl(name: string): string {
	return `${DEMO_PREVIEW_BASE}/${name}.webm`;
}

/**
 * Known demo clip names. Extend with your app's published demo clips —
 * used only for editor autocomplete on `<DemoPreview demo={...} />`.
 */
export type DemoName = string;
