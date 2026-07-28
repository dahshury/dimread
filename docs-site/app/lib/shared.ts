export const appName = "DimRead";
export const docsRoute = "/docs";

export const gitConfig = {
	user: "dahshury",
	repo: "dimread",
	branch: "main",
} as const;

export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
export const releasesUrl = `${repoUrl}/releases`;
export const issuesUrl = `${repoUrl}/issues`;

/**
 * The version the download tables point at.
 *
 * Release assets embed the version in their file names, so a stale value here
 * produces 404 download links. It is checked against the repo's
 * `src-tauri/tauri.conf.json` by `scripts/link-audit.mjs`.
 */
export const latestVersion = "0.0.3-alpha";
export const latestTag = `v${latestVersion}`;

/** Prefix a path in `public/` with the site's base, for GitHub Pages sub-paths. */
export function asset(pathname: string): string {
	const base = import.meta.env.BASE_URL ?? "/";
	return `${base.replace(/\/$/, "")}/${pathname.replace(/^\//, "")}`;
}
