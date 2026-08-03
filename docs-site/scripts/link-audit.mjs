/**
 * Internal-link and asset audit for the docs content.
 *
 * Authoring agents (and humans) invent plausible-but-wrong slugs — `/docs/hotkey`
 * for `/docs/hotkeys`, an `#anchor` for a heading that was renamed, a screenshot
 * file that was never captured. None of those fail the Vite build: they ship as
 * dead links. This does fail.
 *
 * Checks:
 *   1. every `/docs/...` link resolves to a real MDX page — in markdown
 *      `[text](…)` form and in JSX `href="…"` form
 *   2. every `#anchor` matches a heading that exists on the target page,
 *      including same-page `[text](#anchor)` links
 *   3. every screenshot named in MDX **or in a TSX component** exists in
 *      public/screenshots
 *   4. every page listed in meta.json exists, and every page is listed
 *   5. the download version in app/lib/shared.ts matches the app's
 *      tauri.conf.json, and README.md agrees with both
 *
 *   bun run check:links
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const CONTENT = path.join(siteRoot, "content", "docs");
const SHOTS = path.join(siteRoot, "public", "screenshots");
const TAURI_CONF = path.join(siteRoot, "..", "src-tauri", "tauri.conf.json");

const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);

/** GitHub-flavoured heading slug, matching what Fumadocs generates. */
function slugify(heading) {
	return heading
		.trim()
		.toLowerCase()
		.replace(/`/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-");
}

const files = (await readdir(CONTENT)).filter((name) => name.endsWith(".mdx"));
const pages = new Map();

for (const file of files) {
	const body = await readFile(path.join(CONTENT, file), "utf8");
	const slug =
		file === "index.mdx" ? "/docs" : `/docs/${file.replace(/\.mdx$/, "")}`;
	const anchors = new Set(
		[...body.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((match) =>
			slugify(match[1]),
		),
	);
	pages.set(slug, { anchors, body, file });
}

/**
 * Every internal reference on a page. Three shapes produce one:
 *
 *   - markdown `[text](/docs/…)`
 *   - JSX `href="/docs/…"` — how the `<Card>` navigation grids link
 *   - a same-page `[text](#anchor)`, which has no `/docs` prefix at all
 *
 * The last one is the easiest to get wrong (a renamed heading breaks it
 * silently) and was the one this audit used to miss.
 */
function internalLinks(body) {
	return [
		...[...body.matchAll(/\]\((\/docs[^)\s]*)\)/g)].map((m) => m[1]),
		...[...body.matchAll(/href="(\/docs[^"]*)"/g)].map((m) => m[1]),
		...[...body.matchAll(/\]\((#[^)\s]+)\)/g)].map((m) => m[1]),
		...[...body.matchAll(/href="(#[^"]+)"/g)].map((m) => m[1]),
	];
}

// 1 + 2 — internal links.
for (const [slug, page] of pages) {
	for (const link of internalLinks(page.body)) {
		const [target, anchor] = link.split("#");
		// An empty target means the link is same-page: resolve it to this page.
		const normalized =
			target === "" ? slug : target.replace(/\/$/, "") || "/docs";
		const destination = pages.get(normalized);
		if (!destination) {
			fail(page.file, `link to unknown page "${link}"`);
			continue;
		}
		if (anchor && !destination.anchors.has(anchor)) {
			fail(page.file, `link "${link}" points at a heading that does not exist`);
		}
	}

	// 3 — screenshots.
	for (const match of page.body.matchAll(
		/<Screenshot[^>]*?\bsrc="([^"]+)"/gs,
	)) {
		const shots = await readdir(SHOTS);
		if (!shots.includes(match[1])) {
			fail(
				page.file,
				`screenshot "${match[1]}" does not exist in public/screenshots`,
			);
		}
	}

	// Frontmatter must carry both fields the layout renders.
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(page.body)?.[1] ?? "";
	for (const key of ["title", "description"]) {
		if (!new RegExp(`^${key}:\\s*\\S`, "m").test(frontmatter)) {
			fail(page.file, `frontmatter is missing "${key}"`);
		}
	}
	// The layout renders the H1 from frontmatter; a second one in the body
	// duplicates the title and breaks the table of contents.
	if (/^#\s+/m.test(page.body.replace(/^---[\s\S]*?---/, ""))) {
		fail(page.file, "body contains an H1 — start at ##");
	}
}

// 4 — the sidebar manifest.
const meta = JSON.parse(
	await readFile(path.join(CONTENT, "meta.json"), "utf8"),
);
// Fumadocs' meta syntax allows entries that are not pages: `---Label---` is a
// sidebar section heading and `[Text](url)` is a link. Only the bare names are
// page references, so only those get checked against the filesystem.
const SEPARATOR = /^---.*---$/;
const EXTERNAL = /^\[.*]\(.*\)$/;
const isPageRef = (entry) => !(SEPARATOR.test(entry) || EXTERNAL.test(entry));

const listed = new Set(meta.pages.filter(isPageRef));
for (const name of listed) {
	if (!files.includes(`${name}.mdx`)) {
		fail("meta.json", `lists "${name}" but ${name}.mdx does not exist`);
	}
}
for (const file of files) {
	const name = file.replace(/\.mdx$/, "");
	if (!listed.has(name)) {
		fail(
			"meta.json",
			`does not list "${name}" — it would fall to the end of the sidebar`,
		);
	}
}

// 3b — screenshots named in components rather than in MDX.
//
// The landing page and the gallery hard-code file names that no MDX file
// mentions, so an MDX-only sweep declares the site clean while the home page
// renders broken images. Anything that looks like a capture file name in the
// app source has to exist too.
const shots = await readdir(SHOTS);
async function tsxFiles(dir) {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await tsxFiles(full)));
		} else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
			found.push(full);
		}
	}
	return found;
}

const APP = path.join(siteRoot, "app");
for (const file of await tsxFiles(APP)) {
	const body = await readFile(file, "utf8");
	const where = path.relative(siteRoot, file).replaceAll("\\", "/");

	for (const match of body.matchAll(/"([\w-]+\.webp)"/g)) {
		if (!shots.includes(match[1])) {
			fail(
				where,
				`screenshot "${match[1]}" does not exist in public/screenshots`,
			);
		}
	}
	// `to="/docs/…"` (React Router) and `href="/docs/…"` alike.
	for (const match of body.matchAll(/\b(?:to|href)="(\/docs[^"]*)"/g)) {
		const [target, anchor] = match[1].split("#");
		const destination = pages.get(target.replace(/\/$/, "") || "/docs");
		if (!destination) {
			fail(where, `link to unknown page "${match[1]}"`);
		} else if (anchor && !destination.anchors.has(anchor)) {
			fail(where, `link "${match[1]}" points at a heading that does not exist`);
		}
	}
}

// 5 — the download version, in all three places that state it.
const shared = await readFile(
	path.join(siteRoot, "app", "lib", "shared.ts"),
	"utf8",
);
const docsVersion = /latestVersion\s*=\s*"([^"]+)"/.exec(shared)?.[1];
const appVersion = JSON.parse(await readFile(TAURI_CONF, "utf8")).version;
if (docsVersion !== appVersion) {
	fail(
		"app/lib/shared.ts",
		`latestVersion is "${docsVersion}" but the app is "${appVersion}" — the download links would 404`,
	);
}

// The README's prose version drifted behind its own download badges once
// already ("0.0.3 alpha" under a row of 0.0.4 download buttons), which is
// exactly the kind of thing nobody re-reads. Compare on the numeric core so
// `0.0.4-alpha`, `v0.0.4-alpha` and `DimRead-0.0.4-alpha-1.x86_64.rpm` all
// count as the same version.
//
// This is deliberately strict: EVERY x.y.z in the README must be the app's.
// If a dependency version ever needs to appear there, exempt it here on
// purpose rather than loosening the rule.
const core = (version) => /^\d+\.\d+\.\d+/.exec(version)?.[0];
const appCore = core(appVersion);
const readme = await readFile(path.join(siteRoot, "..", "README.md"), "utf8");
const stale = new Set(
	[...readme.matchAll(/\d+\.\d+\.\d+/g)]
		.map((match) => match[0])
		.filter((found) => found !== appCore),
);
for (const found of stale) {
	fail(
		"README.md",
		`mentions version "${found}" but the app is "${appVersion}"`,
	);
}

if (problems.length > 0) {
	console.error(`link-audit: ${problems.length} problem(s)\n`);
	for (const problem of problems) {
		console.error(`  ✗ ${problem}`);
	}
	process.exit(1);
}
console.log(`link-audit: ${pages.size} pages, all links and assets resolve.`);
