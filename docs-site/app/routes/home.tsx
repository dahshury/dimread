import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Footer } from "@/components/footer";
import { Gallery } from "@/components/gallery";
import {
	IconApple,
	IconArrowRight,
	IconDisplay,
	IconDownload,
	IconEffects,
	IconHotkeys,
	IconLinux,
	IconRules,
	IconSchedule,
	IconTray,
	IconWindows,
} from "@/components/icons";
import { Spectrum } from "@/components/spectrum";
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

/* ── Content ──────────────────────────────────────────────────────────
   Every number below is checked against the app's source, not against the
   prose: 8 comes from `DISPLAY_MODE_IDS`, 12 from the fields of
   `HotkeysSettings`, 418 from the length of the generated `ZONES` table,
   and 1000–6500 K from the default temperature bounds. Change one in the
   app and this file is wrong — the docs' link audit cannot catch that, so
   it is worth re-deriving whenever this page is edited.
   ──────────────────────────────────────────────────────────────────── */

const STATS: { value: string; label: string }[] = [
	{ value: "1000–6500 K", label: "colour temperature" },
	{ value: "8", label: "preset modes" },
	{ value: "12", label: "global hotkeys" },
	{ value: "418", label: "time zones, offline" },
];

interface Feature {
	title: string;
	body: string;
	href: string;
	icon: ReactNode;
}

const FEATURES: Feature[] = [
	{
		title: "Per-monitor targeting",
		body: "Every display shares one setting, or each one carries its own override. Switch a monitor off entirely and it keeps the original ramp it booted with.",
		href: "/docs/display",
		icon: <IconDisplay className="size-[18px]" />,
	},
	{
		title: "Sunrise to sunset",
		body: "Sun times are computed offline from a 418-zone table compiled into the app. No location prompt, no geolocation API, no network request.",
		href: "/docs/schedule",
		icon: <IconSchedule className="size-[18px]" />,
	},
	{
		title: "Rules per app",
		body: "Match on process name, window class or title and switch modes when that window takes the foreground. Full-screen games drop the filter automatically.",
		href: "/docs/app-rules",
		icon: <IconRules className="size-[18px]" />,
	},
	{
		title: "Window effects",
		body: "A clear band that follows your reading, a spotlight that dims every other window, and per-window invert or grayscale on top of the global filter.",
		href: "/docs/window-effects",
		icon: <IconEffects className="size-[18px]" />,
	},
	{
		title: "Twelve hotkeys",
		body: "Step temperature and brightness, toggle the filter, Reading, Editing and every window effect. Bindings arm on save — nothing needs a restart.",
		href: "/docs/hotkeys",
		icon: <IconHotkeys className="size-[18px]" />,
	},
	{
		title: "It lives in the tray",
		body: "Right-click gets you the flyout: the same two sliders and all eight modes, without opening a window. The icon itself reports the active mode and phase.",
		href: "/docs/tray-and-overlay",
		icon: <IconTray className="size-[18px]" />,
	},
];

interface Platform {
	name: string;
	version: string;
	icon: ReactNode;
	body: string;
	caveat?: string;
}

const PLATFORMS: Platform[] = [
	{
		name: "Windows",
		version: "10 and 11",
		icon: <IconWindows className="size-5" />,
		body: "Everything works here. The default install is portable: settings and logs sit beside the app, with no Add/Remove entry and no shortcuts.",
	},
	{
		name: "macOS",
		version: "10.15 and later",
		icon: <IconApple className="size-5" />,
		body: "Temperature and brightness apply through public CoreGraphics calls, with no permission prompts at all.",
		caveat: "Per-app rules and the window effects are not wired up yet.",
	},
	{
		name: "Linux",
		version: "X11 and wlroots",
		icon: <IconLinux className="size-5" />,
		body: "X11 goes through RandR 1.2. On Wayland, sway, Hyprland, river and labwc expose the gamma protocol DimRead needs.",
		caveat:
			"GNOME and KDE do not expose it, so the filter has no effect there.",
	},
];

/* ── Sections ─────────────────────────────────────────────────────── */

function Eyebrow({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/70 px-3 py-1 font-medium text-fd-muted-foreground text-xs backdrop-blur-sm">
			{children}
		</span>
	);
}

function SectionHeading({
	eyebrow,
	title,
	body,
}: {
	eyebrow: string;
	title: string;
	body?: string;
}) {
	return (
		<div className="flex max-w-[54ch] flex-col gap-3">
			<div className="flex items-center gap-3">
				<span className="dim-spectrum-rule w-9" />
				<span className="font-semibold text-fd-muted-foreground text-xs uppercase tracking-[0.12em]">
					{eyebrow}
				</span>
			</div>
			<h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
				{title}
			</h2>
			{body ? (
				<p className="text-fd-muted-foreground leading-relaxed">{body}</p>
			) : null}
		</div>
	);
}

function Hero() {
	return (
		<section className="relative overflow-hidden px-6 pt-16 pb-8 sm:pt-24">
			<div aria-hidden="true" className="dim-aurora" />
			<div aria-hidden="true" className="dim-grid" />

			<div className="relative z-10 mx-auto flex w-full max-w-[1100px] flex-col items-center gap-6 text-center">
				<Eyebrow>
					<span className="size-1.5 rounded-full bg-fd-primary" />
					{latestTag} · Windows, macOS and Linux
				</Eyebrow>

				<h1 className="max-w-[18ch] font-semibold text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.03] tracking-[-0.035em]">
					A <span className="dim-spectrum-text">warmer</span> screen, from
					sunset to sunrise.
				</h1>

				<p className="max-w-[62ch] text-balance text-fd-muted-foreground text-lg leading-relaxed">
					DimRead is a tray app that controls your display's colour temperature
					and brightness in software — per monitor, on a schedule, and below the
					floor your monitor's own controls will go.
				</p>

				<div className="flex flex-wrap items-center justify-center gap-3">
					<Link
						className="inline-flex items-center gap-2 rounded-full bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground text-sm no-underline transition-transform hover:scale-[1.02]"
						to="/docs"
					>
						Get started
						<IconArrowRight className="size-4" />
					</Link>
					<a
						className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/60 px-5 py-2.5 font-medium text-sm no-underline backdrop-blur-sm transition-colors hover:bg-fd-accent"
						href={releasesUrl}
					>
						<IconDownload className="size-4" />
						Download {latestTag}
					</a>
				</div>

				<div className="dim-rise relative mt-8 w-full">
					{/* The bloom under the window. Without it a dark capture on a dark
					    page has no edge at all. */}
					<div
						aria-hidden="true"
						className="-z-10 -translate-x-1/2 absolute top-8 left-1/2 h-40 w-[70%] rounded-full opacity-70 blur-[70px]"
						style={{ background: "var(--dim-glow-cool)" }}
					/>
					<div className="dim-frame mx-auto max-w-[980px]">
						<div className="dim-frame-bar">
							<span className="dim-frame-dot" />
							<span className="dim-frame-dot" />
							<span className="dim-frame-dot" />
							<span className="ms-2 font-medium text-fd-muted-foreground text-xs">
								DimRead — Display
							</span>
						</div>
						<img
							alt="The DimRead settings window on its Display tab: a monitor list, colour temperature and brightness sliders reading 5500K and 85%, an auto day/night switch, and the eight preset modes."
							className="block w-full"
							src={asset("screenshots/settings-display.webp")}
						/>
					</div>
				</div>
			</div>
		</section>
	);
}

function Stats() {
	return (
		<section className="px-6 py-16 sm:py-24">
			<dl className="mx-auto grid w-full max-w-[1100px] grid-cols-2 gap-px overflow-hidden rounded-2xl border border-fd-border bg-fd-border lg:grid-cols-4">
				{STATS.map((stat) => (
					<div
						className="flex flex-col gap-1 bg-fd-background px-5 py-6 text-center"
						key={stat.label}
					>
						<dt className="font-semibold text-xl tabular-nums tracking-tight sm:text-2xl">
							{stat.value}
						</dt>
						<dd className="text-fd-muted-foreground text-sm">{stat.label}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

function SpectrumSection() {
	return (
		<section className="px-6 py-16 sm:py-24">
			<div className="mx-auto grid w-full max-w-[1100px] items-center gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
				<SectionHeading
					body="One slider spans candle-warm to unfiltered daylight in 50 K steps, and a second takes brightness from 100 % down to 10 %. Both are software gamma, applied at scan-out — which is why a screenshot of a dimmed screen comes out clean."
					eyebrow="The filter"
					title="1000 K to 6500 K, in 50 K steps"
				/>
				<Spectrum />
			</div>
		</section>
	);
}

function FeatureCard({ feature }: { feature: Feature }) {
	return (
		<Link
			className="dim-card group flex flex-col gap-3 p-6 no-underline"
			to={feature.href}
		>
			<span className="flex size-9 items-center justify-center rounded-lg border border-fd-border bg-fd-muted/60 text-fd-primary">
				{feature.icon}
			</span>
			<h3 className="font-semibold text-base tracking-tight">
				{feature.title}
			</h3>
			<p className="text-fd-muted-foreground text-sm leading-relaxed">
				{feature.body}
			</p>
			<span className="mt-auto inline-flex items-center gap-1.5 pt-2 font-medium text-fd-primary text-sm">
				Read more
				<IconArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
			</span>
		</Link>
	);
}

function Features() {
	return (
		<section className="px-6 py-16 sm:py-24">
			<div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8">
				<SectionHeading
					body="Eight editable presets, a scheduler that interpolates between a day and a night endpoint on every axis, and a set of overlays for the times a whole-screen filter is the wrong tool."
					eyebrow="What it does"
					title="Six surfaces, one seam"
				/>
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{FEATURES.map((feature) => (
						<FeatureCard feature={feature} key={feature.href} />
					))}
				</div>
			</div>
		</section>
	);
}

function GallerySection() {
	return (
		<section className="px-6 py-16 sm:py-24">
			<div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8">
				<SectionHeading
					body="One window, seven tabs, and a tray flyout that drives the same values. Every picture here is captured from the shipping renderer — none are mock-ups."
					eyebrow="The app"
					title="All of it, in one window"
				/>
				<Gallery />
			</div>
		</section>
	);
}

function Platforms() {
	return (
		<section className="px-6 py-16 sm:py-24">
			<div className="mx-auto flex w-full max-w-[1100px] flex-col gap-8">
				<SectionHeading
					body="DimRead is alpha, and the three platforms are not at the same place. This is what actually works on each one today."
					eyebrow="Support"
					title="Where it runs, honestly"
				/>
				<div className="grid gap-4 md:grid-cols-3">
					{PLATFORMS.map((platform) => (
						<div
							className="dim-card flex flex-col gap-3 p-6"
							key={platform.name}
						>
							<div className="flex items-center gap-2.5">
								<span className="text-fd-foreground">{platform.icon}</span>
								<h3 className="font-semibold text-base">{platform.name}</h3>
								<span className="ms-auto text-fd-muted-foreground text-xs">
									{platform.version}
								</span>
							</div>
							<p className="text-fd-muted-foreground text-sm leading-relaxed">
								{platform.body}
							</p>
							{platform.caveat ? (
								<p className="mt-auto rounded-lg border border-fd-border bg-fd-muted/50 px-3 py-2 text-fd-muted-foreground text-xs leading-relaxed">
									{platform.caveat}
								</p>
							) : null}
						</div>
					))}
				</div>
				<p className="text-fd-muted-foreground text-sm">
					The full matrix, symptom by symptom, is on{" "}
					<Link
						className="text-fd-foreground underline decoration-fd-primary/50 underline-offset-4"
						to="/docs/troubleshooting"
					>
						Troubleshooting
					</Link>
					.
				</p>
			</div>
		</section>
	);
}

function CallToAction() {
	return (
		<section className="px-6 py-16 sm:py-24">
			<div className="relative mx-auto w-full max-w-[1100px] overflow-hidden rounded-2xl border border-fd-border px-8 py-14 text-center">
				<div aria-hidden="true" className="dim-aurora opacity-70" />
				<div className="relative z-10 flex flex-col items-center gap-5">
					<h2 className="max-w-[22ch] font-semibold text-2xl tracking-tight sm:text-3xl">
						Five steps to a warm screen.
					</h2>
					<p className="max-w-[52ch] text-fd-muted-foreground leading-relaxed">
						Download it, get past the one-time unsigned-app prompt, pick a mode,
						turn on the schedule, bind a key. The whole walkthrough is one page.
					</p>
					<div className="flex flex-wrap items-center justify-center gap-3">
						<Link
							className="inline-flex items-center gap-2 rounded-full bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground text-sm no-underline transition-transform hover:scale-[1.02]"
							to="/docs"
						>
							Open the guide
							<IconArrowRight className="size-4" />
						</Link>
						<a
							className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/60 px-5 py-2.5 font-medium text-sm no-underline backdrop-blur-sm transition-colors hover:bg-fd-accent"
							href={releasesUrl}
						>
							<IconDownload className="size-4" />
							All downloads
						</a>
					</div>
				</div>
			</div>
		</section>
	);
}

export default function Home() {
	return (
		// HomeLayout already renders the page's <main>, so this wrapper is a
		// plain div — nesting a second one would put the site header and the
		// footer inside the main landmark.
		<HomeLayout {...baseOptions()}>
			<div className="flex w-full flex-1 flex-col">
				<Hero />
				<Stats />
				<SpectrumSection />
				<Features />
				<GallerySection />
				<Platforms />
				<CallToAction />
			</div>
			<Footer />
		</HomeLayout>
	);
}
