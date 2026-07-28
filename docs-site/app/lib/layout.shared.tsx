import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { asset, appName, releasesUrl, repoUrl } from "./shared";

/** The wordmark: the app's own brand mark beside its name. */
function NavTitle() {
	return (
		<span className="inline-flex items-center gap-2 font-semibold">
			<img
				alt=""
				className="size-6 rounded-[6px]"
				height={24}
				src={asset("brand/dimread-mark.png")}
				width={24}
			/>
			{appName}
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
