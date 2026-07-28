import { asset } from "@/lib/shared";

export interface ScreenshotProps {
	/** File name inside `public/screenshots/`, e.g. `settings-display.png`. */
	src: string;
	/** Describe what the picture SHOWS, not that it is a screenshot. */
	alt: string;
	/** Optional line under the frame. */
	caption?: string;
	/** Max rendered width in px. Narrow shots (the tray flyout) want less. */
	width?: number;
	/** Skip lazy-loading for the one image above the fold. */
	priority?: boolean;
}

/**
 * A real screenshot of the real app, framed.
 *
 * Every image on this site is captured from the shipping renderer by
 * `tools/docs/capture-screenshots.mjs` in the DimRead repo — none are mock-ups.
 * The heavy, wide drop shadow is what makes a flat UI capture read as a window
 * floating above the page; it is the single component that carries the most
 * perceived polish, so it is also the only one with a bespoke shadow.
 */
export function Screenshot({
	alt,
	caption,
	priority = false,
	src,
	width = 780,
}: ScreenshotProps) {
	return (
		<figure className="not-prose my-6 flex flex-col items-center gap-3">
			<img
				alt={alt}
				className="w-full rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.35)] ring-1 ring-fd-border"
				loading={priority ? "eager" : "lazy"}
				src={asset(`screenshots/${src}`)}
				style={{ maxWidth: `min(${width}px, 100%)` }}
			/>
			{caption ? (
				<figcaption className="text-center text-fd-muted-foreground text-sm">
					{caption}
				</figcaption>
			) : null}
		</figure>
	);
}
