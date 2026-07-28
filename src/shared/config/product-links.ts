/**
 * Every outward-facing DimRead URL, in one place.
 *
 * The About tab, the tray flyout, and anything else that opens a browser reads
 * from here so a fork changes one file. The repository URL is duplicated in
 * `src-tauri/src/update/mod.rs` (the update check runs in Rust because the
 * app's CSP blocks renderer network calls) — a test in that module keeps the
 * two spellings honest.
 */
export const PRODUCT_LINKS = {
	/** The public documentation site, published from `docs-site/`. Deep-links
	 *  past the landing page — someone clicking "Docs" wants the docs. */
	docs: "https://dahshury.github.io/dimread/docs",
	/** Bug reports and feature requests. */
	issues: "https://github.com/dahshury/dimread/issues",
	/** Download page for every platform's build. */
	releases: "https://github.com/dahshury/dimread/releases",
	/** The product's source, NOT the author's profile. */
	repository: "https://github.com/dahshury/dimread",
} as const;
