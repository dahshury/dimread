import { existsSync } from "node:fs";
import { cp, glob, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "@react-router/dev/config";
import { createGetUrl, getSlugs } from "fumadocs-core/source";

/** Keep in lockstep with `base` in vite.config.ts. */
const BASE = process.env.DOCS_BASE ?? "/dimread/";
const getUrl = createGetUrl("/docs");

export default {
	// Static output only: GitHub Pages cannot run a server, so every route is
	// pre-rendered and the client bundle takes over from there.
	ssr: false,
	basename: BASE,

	async prerender({ getStaticPaths }) {
		// The non-splat routes: "/", "/api/search" (the static Orama index).
		const paths: string[] = [...getStaticPaths()];
		// One path per MDX file for the `docs/*` splat route. A page missing from
		// this list does not fail the build — it silently degrades to a
		// client-rendered page with no HTML for crawlers — so the glob, not a
		// hand-kept list, is what keeps it honest.
		for await (const entry of glob("**/*.mdx", { cwd: "content/docs" })) {
			paths.push(getUrl(getSlugs(entry)));
		}
		return paths;
	},

	/**
	 * Reshape `build/client` into what GitHub Pages actually serves.
	 *
	 * React Router writes pre-rendered files at their request pathname, which
	 * INCLUDES the basename — so everything lands in `build/client/dimread/**`
	 * while Pages already serves the artifact root at `/dimread/`. Left alone,
	 * the home page works (it is the renamed SPA fallback hydrating) and every
	 * deep link 404s. Flatten it, add the 404 fallback, and disable Jekyll.
	 */
	async buildEnd() {
		const out = path.resolve("build/client");
		const prefix = BASE.replace(/^\/|\/$/g, "");

		// Jekyll drops paths beginning with an underscore, which would eat
		// `__spa-fallback.html`.
		await writeFile(path.join(out, ".nojekyll"), "");

		const fallback = existsSync(path.join(out, "__spa-fallback.html"))
			? path.join(out, "__spa-fallback.html")
			: path.join(out, "index.html");
		if (existsSync(fallback)) {
			await cp(fallback, path.join(out, "404.html"));
		}

		if (!prefix) {
			return;
		}
		const nested = path.join(out, prefix);
		if (!existsSync(nested)) {
			return;
		}
		// Copy-then-delete rather than rename: on Windows, renaming a directory
		// onto a path that was removed microseconds earlier intermittently fails
		// with EPERM (an indexer or scanner still holding a handle).
		for (const entry of await readdir(nested, { withFileTypes: true })) {
			const from = path.join(nested, entry.name);
			const to = path.join(out, entry.name);
			await rm(to, { recursive: true, force: true });
			await mkdir(path.dirname(to), { recursive: true });
			await cp(from, to, { recursive: true, force: true });
		}
		await rm(nested, { recursive: true, force: true });
	},
} satisfies Config;
