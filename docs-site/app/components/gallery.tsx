import { useState } from "react";
import { asset } from "@/lib/shared";

interface Shot {
	tab: string;
	src: string;
	alt: string;
	caption: string;
	/** The tray flyout is a narrow panel, not a 940×680 window. */
	narrow?: boolean;
}

const SHOTS: Shot[] = [
	{
		tab: "Display",
		src: "settings-display.webp",
		alt: "The Display tab: a monitor roster with All monitors selected, a 5500K · 85% readout, warm-to-cool and dimmer-to-brighter sliders, an Auto day/night switch with a Day | Night selector, and the eight preset modes in a 4×2 grid.",
		caption:
			"Quick controls sit at the top of the tab. The radio picks which monitor the sliders edit; the switch decides whether that monitor is filtered at all.",
	},
	{
		tab: "Schedule",
		src: "settings-schedule.webp",
		alt: "The Schedule tab, showing the Automatic, Manual and Custom time segments, latitude and longitude fields, and the transition width slider.",
		caption:
			"Sun times come from your system timezone via a 418-zone table compiled into the binary — no location prompt, and no request leaves the machine.",
	},
	{
		tab: "App rules",
		src: "settings-app-rules.webp",
		alt: "The App rules tab, showing the full-screen suspension switch and a list of custom rules with their match kind, pattern and target mode.",
		caption:
			"Match on process name, window class or window title. First match wins, top to bottom, and full-screen apps suspend the filter after 700 ms.",
	},
	{
		tab: "Window effects",
		src: "settings-window-effects.webp",
		alt: "The Window effects tab, with the Focus Read, Focus Blur and MagicX sections and their transparency and colour controls.",
		caption:
			"Focus Read draws a clear band over a dimmed screen. Focus Blur spotlights the active window. MagicX inverts or greys a single window.",
	},
	{
		tab: "Hotkeys",
		src: "settings-hotkeys.webp",
		alt: "The Hotkeys tab, listing bindable actions with a record button and the recorded key combination on each row.",
		caption:
			"Twelve actions, all unbound out of the box. The recorder rejects a combination that duplicates, contains or is contained by one you already use.",
	},
	{
		tab: "Tray flyout",
		src: "tray-flyout.webp",
		alt: "The tray flyout anchored above the notification area, showing the temperature and brightness sliders and the eight preset modes.",
		caption:
			"Right-click the tray icon for 284 px of the same controls: both sliders, all eight modes, and a row for Settings and Quit.",
		narrow: true,
	},
];

/**
 * One large screenshot with a tab strip, rather than six small ones in a grid.
 *
 * Every settings tab is the same 940×680 window with different contents, so a
 * gallery of thumbnails reads as six copies of one picture and none of them
 * are legible. Showing one at full width and letting the reader switch is the
 * only arrangement where the UI can actually be seen — and the tab strip is
 * modelled on the app's own segmented controls.
 */
export function Gallery() {
	// Opens on Schedule, not Display: the hero already shows the Display tab
	// at full width, and repeating it here wastes the one section where the
	// reader is being invited to look at something new.
	const [active, setActive] = useState(1);
	const shot = SHOTS[active];

	return (
		<div className="not-prose flex w-full flex-col gap-5">
			{/* Deliberately NOT a `role="tablist"`. Declaring tab semantics
			    commits to arrow-key roving focus, `aria-controls` and a real
			    `tabpanel`; a strip of plain buttons that swap an image is more
			    honest and works with Tab out of the box. `aria-pressed` is what
			    conveys the selected one. */}
			<div className="flex flex-wrap gap-1 rounded-xl border border-fd-border bg-fd-card/60 p-1">
				{SHOTS.map((item, index) => (
					<button
						aria-pressed={index === active}
						className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 font-medium text-xs transition-colors sm:text-sm ${
							index === active
								? "bg-fd-primary text-fd-primary-foreground"
								: "text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground"
						}`}
						key={item.src}
						onClick={() => setActive(index)}
						type="button"
					>
						{item.tab}
					</button>
				))}
			</div>

			<figure className="flex flex-col gap-4">
				<div className="dim-frame">
					<div className="dim-frame-bar">
						<span className="dim-frame-dot" />
						<span className="dim-frame-dot" />
						<span className="dim-frame-dot" />
						<span className="ms-2 font-medium text-fd-muted-foreground text-xs">
							DimRead — {shot.tab}
						</span>
					</div>
					{shot.narrow ? (
						// The flyout is a 288 px panel; centring it on the card surface
						// keeps the frame from stretching a small image to window size.
						<div className="flex justify-center bg-fd-muted/40 py-8">
							<img
								alt={shot.alt}
								className="w-[288px] max-w-full rounded-lg border border-fd-border"
								loading="lazy"
								src={asset(`screenshots/${shot.src}`)}
							/>
						</div>
					) : (
						<img
							alt={shot.alt}
							className="block w-full"
							loading="lazy"
							src={asset(`screenshots/${shot.src}`)}
						/>
					)}
				</div>
				<figcaption className="mx-auto max-w-[70ch] text-center text-fd-muted-foreground text-sm leading-relaxed">
					{shot.caption}
				</figcaption>
			</figure>
		</div>
	);
}
