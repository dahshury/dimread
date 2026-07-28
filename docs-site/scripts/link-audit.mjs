/**
 * Internal-link and asset audit for the docs content.
 *
 * Authoring agents (and humans) invent plausible-but-wrong slugs — `/docs/hotkey`
 * for `/docs/hotkeys`, an `#anchor` for a heading that was renamed, a screenshot
 * file that was never captured. None of those fail the Vite build: they ship as
 * dead links. This does fail.
 *
 * Checks:
 *   1. every `/docs/...` link resolves to a real MDX page
 *   2. every `#anchor` matches a heading that exists on the target page
 *   3. every `<Screenshot src="…">` names a file in public/screenshots
 *   4. every page listed in meta.json exists, and every page is listed
 *   5. the download version in app/lib/shared.ts matches the app's tauri.conf.json
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

// 1 + 2 — internal links.
for (const [, page] of pages) {
	for (const match of page.body.matchAll(/\]\((\/docs[^)\s]*)\)/g)) {
		const [target, anchor] = match[1].split("#");
		const normalized = target.replace(/\/$/, "") || "/docs";
		const destination = pages.get(normalized);
		if (!destination) {
			fail(page.file, `link to unknown page "${match[1]}"`);
			continue;
		}
		if (anchor && !destination.anchors.has(anchor)) {
			fail(
				page.file,
				`link "${match[1]}" points at a heading that does not exist`,
			);
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
const listed = new Set(meta.pages);
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

// 5 — the download version.
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

if (problems.length > 0) {
	console.error(`link-audit: ${problems.length} problem(s)\n`);
	for (const problem of problems) {
		console.error(`  ✗ ${problem}`);
	}
	process.exit(1);
}
console.log(`link-audit: ${pages.size} pages, all links and assets resolve.`);
