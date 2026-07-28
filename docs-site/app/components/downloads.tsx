import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { latestTag, latestVersion, releasesUrl, repoUrl } from "@/lib/shared";

interface Build {
	label: string;
	/** The release asset's exact file name. */
	file: string;
	note: string;
	primary?: boolean;
}

const WINDOWS: Build[] = [
	{
		label: "Windows 10/11 · portable",
		file: "DimRead.exe",
		note: "One file. Run it — no installer, no registry writes.",
		primary: true,
	},
	{
		label: "Windows 10/11 · zip",
		file: "DimRead-portable.zip",
		note: "The same build, zipped. Needs the Edge WebView2 runtime.",
	},
];

const MACOS: Build[] = [
	{
		label: "macOS · Apple silicon",
		file: `DimRead_${latestVersion}_aarch64.dmg`,
		note: "M1 and later. macOS 10.15+.",
		primary: true,
	},
	{
		label: "macOS · Intel",
		file: `DimRead_${latestVersion}_x64-x86_64.dmg`,
		note: "Intel Macs. macOS 10.15+.",
	},
];

const LINUX: Build[] = [
	{
		label: "Linux · AppImage",
		file: `DimRead_${latestVersion}_amd64.AppImage`,
		note: "Portable. chmod +x, then run.",
		primary: true,
	},
	{
		label: "Debian / Ubuntu",
		file: `DimRead_${latestVersion}_amd64.deb`,
		note: "Depends on libayatana-appindicator3-1.",
	},
	{
		label: "Fedora / RHEL",
		file: `DimRead-${latestVersion}-1.x86_64.rpm`,
		note: "Depends on libayatana-appindicator-gtk3.",
	},
];

function downloadUrl(file: string): string {
	return `${repoUrl}/releases/download/${latestTag}/${file}`;
}

function BuildList({ builds }: { builds: Build[] }) {
	return (
		<ul className="not-prose flex list-none flex-col gap-2 p-0">
			{builds.map((build) => (
				<li key={build.file}>
					<a
						className={`flex flex-col gap-0.5 rounded-lg border border-fd-border px-4 py-3 no-underline transition-colors ${
							build.primary
								? "bg-fd-primary/10 hover:bg-fd-primary/15"
								: "bg-fd-card hover:bg-fd-accent"
						}`}
						href={downloadUrl(build.file)}
					>
						<span className="font-semibold text-fd-foreground text-sm">
							{build.label}
						</span>
						<span className="font-mono text-fd-muted-foreground text-xs">
							{build.file}
						</span>
						<span className="text-fd-muted-foreground text-sm">
							{build.note}
						</span>
					</a>
				</li>
			))}
		</ul>
	);
}

/**
 * The download card: pick an OS, get that OS's files and nothing else.
 *
 * File names are built from `latestVersion`, which is checked against the
 * repository's `tauri.conf.json` by the link audit — a version bump that
 * forgets this file fails the docs build rather than shipping dead links.
 */
export function Downloads() {
	return (
		<div className="not-prose my-6 rounded-xl border border-fd-border bg-fd-card/60 p-4 sm:p-5">
			<div className="mb-3 flex items-baseline justify-between gap-3">
				<span className="font-semibold text-fd-muted-foreground text-xs uppercase tracking-wider">
					Download DimRead
				</span>
				<a
					className="font-mono text-fd-muted-foreground text-xs no-underline hover:text-fd-foreground"
					href={releasesUrl}
				>
					{latestTag}
				</a>
			</div>
			<Tabs items={["Windows", "macOS", "Linux"]}>
				<Tab value="Windows">
					<BuildList builds={WINDOWS} />
				</Tab>
				<Tab value="macOS">
					<BuildList builds={MACOS} />
				</Tab>
				<Tab value="Linux">
					<BuildList builds={LINUX} />
				</Tab>
			</Tabs>
		</div>
	);
}
