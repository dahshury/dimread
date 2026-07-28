import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

/**
 * Content collections for the DimRead docs.
 *
 * `alpha` mirrors the badge handy.computer drives from frontmatter: a page
 * documenting a surface that is not finished yet says so next to its title,
 * rather than reading as settled.
 */
export const docs = defineDocs({
	dir: "content/docs",
	docs: {
		schema: pageSchema.extend({
			alpha: z.boolean().default(false),
		}),
	},
	meta: {
		schema: metaSchema.extend({}),
	},
});

export default defineConfig();
