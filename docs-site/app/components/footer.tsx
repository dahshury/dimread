import { Link } from "react-router";
import {
	appName,
	asset,
	issuesUrl,
	latestTag,
	releasesUrl,
	repoUrl,
} from "@/lib/shared";

const COLUMNS: { heading: string; links: { text: string; to: string }[] }[] = [
	{
		heading: "Documentation",
		links: [
			{ text: "Getting started", to: "/docs" },
			{ text: "Display", to: "/docs/display" },
			{ text: "Schedule", to: "/docs/schedule" },
			{ text: "Hotkeys", to: "/docs/hotkeys" },
		],
	},
	{
		heading: "Reference",
		links: [
			{ text: "App rules", to: "/docs/app-rules" },
			{ text: "Window effects", to: "/docs/window-effects" },
			{ text: "File locations", to: "/docs/general" },
			{ text: "Diagnostics", to: "/docs/diagnostics" },
		],
	},
	{
		heading: "Help",
		links: [
			{ text: "Troubleshooting", to: "/docs/troubleshooting" },
			{ text: "FAQ", to: "/docs/faq" },
			{ text: "About", to: "/docs/about" },
		],
	},
];

const EXTERNAL: { text: string; href: string }[] = [
	{ text: "Source", href: repoUrl },
	{ text: `Releases (${latestTag})`, href: releasesUrl },
	{ text: "Report an issue", href: issuesUrl },
];

/**
 * The site footer.
 *
 * Shared by the marketing routes and the 404, which is the page most likely
 * to be a visitor's first — a dead end deserves the same set of exits as the
 * home page.
 */
export function Footer() {
	return (
		<footer className="mt-24 border-fd-border border-t">
			<div className="mx-auto w-full max-w-[1100px] px-6 py-14">
				<div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.3fr_repeat(4,1fr)]">
					<div className="flex flex-col gap-3">
						<span className="inline-flex items-center gap-2.5 font-semibold">
							<img
								alt=""
								className="size-6 rounded-[6px]"
								height={24}
								src={asset("brand/dimread-mark.png")}
								width={24}
							/>
							{appName}
						</span>
						<p className="max-w-[30ch] text-fd-muted-foreground text-sm leading-relaxed">
							A blue-light filter and screen dimmer that lives in your tray. MIT
							licensed, no account, no telemetry.
						</p>
					</div>

					{COLUMNS.map((column) => (
						<nav className="flex flex-col gap-3" key={column.heading}>
							<h2 className="font-semibold text-fd-foreground text-xs uppercase tracking-[0.09em]">
								{column.heading}
							</h2>
							<ul className="flex list-none flex-col gap-2 p-0">
								{column.links.map((link) => (
									<li key={link.to}>
										<Link
											className="text-fd-muted-foreground text-sm no-underline transition-colors hover:text-fd-foreground"
											to={link.to}
										>
											{link.text}
										</Link>
									</li>
								))}
							</ul>
						</nav>
					))}

					<nav className="flex flex-col gap-3">
						<h2 className="font-semibold text-fd-foreground text-xs uppercase tracking-[0.09em]">
							Project
						</h2>
						<ul className="flex list-none flex-col gap-2 p-0">
							{EXTERNAL.map((link) => (
								<li key={link.href}>
									<a
										className="text-fd-muted-foreground text-sm no-underline transition-colors hover:text-fd-foreground"
										href={link.href}
									>
										{link.text}
									</a>
								</li>
							))}
						</ul>
					</nav>
				</div>

				<div className="mt-12 flex flex-col gap-3 border-fd-border border-t pt-6 text-fd-muted-foreground text-xs sm:flex-row sm:items-center sm:justify-between">
					<p>© 2026 dahshury · MIT licence</p>
					<p>
						Every screenshot on this site is captured from the shipping app.
					</p>
				</div>
			</div>
		</footer>
	);
}
