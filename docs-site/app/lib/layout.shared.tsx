import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, asset, latestTag, releasesUrl, repoUrl } from "./shared";

/** The wordmark: the app's own brand mark beside its name, and the version. */
function NavTitle() {
	return (
		<span className="inline-flex items-center gap-2.5 font-semibold">
			<img
				alt=""
				className="size-6 rounded-[6px]"
				height={24}
				src={asset("brand/dimread-mark.png")}
				width={24}
			/>
			{appName}
			{/* `whitespace-nowrap` is not optional: in the mobile nav the pill is
			    the last flex item and wraps "v0.0.4-" / "alpha" onto two lines
			    without it, which doubles the header height. */}
			<span className="whitespace-nowrap rounded-full border border-fd-border px-1.5 py-px font-medium font-mono text-[0.625rem] text-fd-muted-foreground tracking-tight">
				{latestTag}
			</span>
		</span>
	);
}

export function baseOptions(): BaseLayoutProps {
	return {
		nav: { title: <NavTitle /> },
		githubUrl: repoUrl,
		links: [
			{ text: "Docs", url: "/docs", active: "nested-url" },
			{ text: "Download", url: releasesUrl, external: true },
		],
	};
}
