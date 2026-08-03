import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { resolvePageIcon } from "./page-icons";
import { docsRoute } from "./shared";

export const source = loader({
	source: docs.toFumadocsSource(),
	baseUrl: docsRoute,
	// Frontmatter `icon:` names a glyph in `page-icons`. Fumadocs renders the
	// result to an HTML string inside `serializePageTree`, so the resolver must
	// return static SVG — see the note in that module.
	icon: resolvePageIcon,
});
