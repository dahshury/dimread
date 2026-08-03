import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
// The page primitives are per-layout: the notebook DocsLayout provides a
// notebook layout context, and the `docs` DocsPage hard-errors under it.
import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
} from "fumadocs-ui/layouts/notebook/page";
import { AlphaBadge } from "@/components/alpha-badge";
import { getMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import type { Route } from "./+types/docs";
import NotFound from "./not-found";

export async function loader({ params }: Route.LoaderArgs) {
	const slugs = params["*"].split("/").filter((segment) => segment.length > 0);
	const page = source.getPage(slugs);
	if (!page) {
		throw new Response("Not found", { status: 404 });
	}

	// Only serializable data crosses this boundary: the compiled MDX stays
	// behind the code-split client loader below. Page-tree icons survive it
	// because Fumadocs renders them to HTML strings — see `lib/page-icons`.
	return {
		path: page.path,
		pageTree: await source.serializePageTree(source.getPageTree()),
	};
}

const clientLoader = browserCollections.docs.createClientLoader({
	component({ toc, frontmatter, default: Mdx }) {
		const title = `${frontmatter.title} — DimRead docs`;
		return (
			// Fumadocs renders the page as an <article>, which leaves the docs
			// shell with no main landmark at all; `role` overrides the implicit
			// one so screen-reader users get a "main" to jump to.
			<DocsPage
				breadcrumb={{ enabled: true }}
				footer={{ enabled: true }}
				role="main"
				toc={toc}
			>
				<title>{title}</title>
				<meta content={frontmatter.description} name="description" />
				<meta content={title} property="og:title" />
				<meta content={frontmatter.description} property="og:description" />
				<div className="flex flex-wrap items-center gap-3">
					<DocsTitle>{frontmatter.title}</DocsTitle>
					{frontmatter.alpha ? <AlphaBadge /> : null}
				</div>
				<DocsDescription>{frontmatter.description}</DocsDescription>
				<DocsBody>
					<Mdx components={getMDXComponents()} />
				</DocsBody>
			</DocsPage>
		);
	},
});

/**
 * Anything that goes wrong under `/docs/*` renders the 404, not a stack trace.
 *
 * Two different failures land here and neither reaches the root boundary on
 * its own. The loader's deliberate `throw new Response(404)` is the obvious
 * one. The other only appears in the built SPA: an un-prerendered path has no
 * `.data` file to fetch, so React Router rejects the navigation with "No
 * result found for routeId" — which is a mistyped URL wearing a stack trace.
 */
export function ErrorBoundary() {
	return <NotFound />;
}

export default function Page({ loaderData }: Route.ComponentProps) {
	const { pageTree } = useFumadocsLoader(loaderData);

	return (
		// The notebook layout puts the wordmark and search in a full-width bar
		// across the top and drops the sidebar underneath it, which is what
		// keeps a twelve-page site from reading as a bare template. `tabs` is
		// off: with one section there is nothing to tab between.
		<DocsLayout
			{...baseOptions()}
			nav={{ ...baseOptions().nav, mode: "top" }}
			tabs={false}
			tree={pageTree}
		>
			{clientLoader.useContent(loaderData.path)}
		</DocsLayout>
	);
}
