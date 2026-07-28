import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Link } from "react-router";
import { baseOptions } from "@/lib/layout.shared";
import { asset, latestTag, releasesUrl } from "@/lib/shared";

export function meta() {
	return [
		{ title: "DimRead — blue-light filter and screen dimmer" },
		{
			name: "description",
			content:
				"Documentation for DimRead: colour temperature and brightness control per monitor, day/night scheduling, per-app rules, and global hotkeys for Windows, macOS and Linux.",
		},
	];
}

const FACTS: { value: string; label: string }[] = [
	{ value: "1000–6500 K", label: "colour temperature range" },
	{ value: "8", label: "preset modes" },
	{ value: "12", label: "bindable hotkeys" },
	{ value: "3", label: "platforms" },
];

export default function Home() {
	return (
		<HomeLayout {...baseOptions()}>
			<main className="mx-auto flex w-full max-w-[940px] flex-1 flex-col gap-10 px-4 py-16">
				<section className="flex flex-col items-center gap-5 text-center">
					<img
						alt=""
						className="size-20 rounded-2xl"
						height={80}
						src={asset("brand/dimread-mark.png")}
						width={80}
					/>
					<h1 className="font-bold text-4xl tracking-tight">DimRead</h1>
					<p className="max-w-xl text-fd-muted-foreground text-lg">
						A blue-light filter and screen dimmer that lives in your tray. Warm
						the display, dim it below what the hardware allows, per monitor —
						with day/night scheduling, per-app rules and global hotkeys.
					</p>
					<div className="flex flex-wrap items-center justify-center gap-3">
						<Link
							className="rounded-full bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground text-sm no-underline"
							to="/docs"
						>
							Read the docs
						</Link>
						<a
							className="rounded-full border border-fd-border px-5 py-2.5 font-medium text-sm no-underline hover:bg-fd-accent"
							href={releasesUrl}
						>
							Download {latestTag}
						</a>
					</div>
				</section>

				<img
					alt="The DimRead settings window on its Display tab: a monitor list, colour temperature and brightness sliders, and the eight preset modes."
					className="w-full rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.35)] ring-1 ring-fd-border"
					src={asset("screenshots/settings-display.webp")}
				/>

				<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
					{FACTS.map((fact) => (
						<div
							className="rounded-xl border border-fd-border bg-fd-card p-4 text-center"
							key={fact.label}
						>
							<dt className="font-semibold text-lg tabular-nums">
								{fact.value}
							</dt>
							<dd className="text-fd-muted-foreground text-sm">{fact.label}</dd>
						</div>
					))}
				</dl>
			</main>
		</HomeLayout>
	);
}
