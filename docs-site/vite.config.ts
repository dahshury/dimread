import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "vite";

/**
 * The site is published to GitHub Pages at https://dahshury.github.io/dimread/,
 * so every asset URL carries that prefix. `base` here and `basename` in
 * react-router.config.ts must stay identical — React Router hard-errors in dev
 * if they diverge, and a mismatch in production yields a blank page with
 * "no routes matched location".
 *
 * Override with DOCS_BASE=/ to serve from a domain root.
 */
const BASE = process.env.DOCS_BASE ?? "/dimread/";

export default defineConfig({
	base: BASE,
	// `mdx()` must come first: it emits `.source/*` (the compiled collections)
	// that the router's routes then import.
	plugins: [mdx(), tailwindcss(), reactRouter()],
	resolve: { tsconfigPaths: true },
});
