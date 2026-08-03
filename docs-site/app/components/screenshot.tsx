import { asset } from "@/lib/shared";

export interface ScreenshotProps {
	/** File name inside `public/screenshots/`, e.g. `settings-display.webp`. */
	src: string;
	/** Describe what the picture SHOWS, not that it is a screenshot. */
	alt: string;
	/** Optional line under the frame. */
	caption?: string;
	/** Max rendered width in px. Narrow shots (the tray flyout) want less. */
	width?: number;
	/** Skip lazy-loading for the one image above the fold. */
	priority?: boolean;
	/** Drop the title bar — for crops that are not a whole window. */
	bare?: boolean;
}

/**
 * A real screenshot of the real app, in a window frame.
 *
 * Every image on this site is captured from the shipping renderer by
 * `tools/docs/capture-screenshots.mjs` in the DimRead repo — none are
 * mock-ups. The frame matters more than it looks like it should: these are
 * dark, flat, chrome-less captures, and on a dark page an unframed one
 * dissolves into the background. The title bar and the layered shadow
 * (`--dim-frame-shadow`) are what make it read as a window sitting above
 * the page rather than a hole punched through it.
 */
export function Screenshot({
	alt,
	bare = false,
	caption,
	priority = false,
	src,
	width = 820,
}: ScreenshotProps) {
	return (
		<figure className="not-prose my-8 flex flex-col items-center gap-3">
			<div
				className="dim-frame w-full"
				style={{ maxWidth: `min(${width}px, 100%)` }}
			>
				{bare ? null : (
					<div className="dim-frame-bar">
						<span className="dim-frame-dot" />
						<span className="dim-frame-dot" />
						<span className="dim-frame-dot" />
					</div>
				)}
				<img
					alt={alt}
					className="block w-full"
					loading={priority ? "eager" : "lazy"}
					src={asset(`screenshots/${src}`)}
				/>
			</div>
			{caption ? (
				<figcaption className="max-w-[62ch] text-center text-fd-muted-foreground text-sm leading-relaxed">
					{caption}
				</figcaption>
			) : null}
		</figure>
	);
}
