import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { AlphaBadge } from "@/components/alpha-badge";
import { getMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import type { Route } from "./+types/docs";

export async function loader({ params }: Route.LoaderArgs) {
	const slugs = params["*"].split("/").filter((segment) => segment.length > 0);
	const page = source.getPage(slugs);
	if (!page) {
		throw new Response("Not found", { status: 404 });
	}

	// Only serializable data crosses this boundary: the compiled MDX stays
	// behind the code-split client loader below.
	return {
		path: page.path,
		pageTree: await source.serializePageTree(source.getPageTree()),
	};
}

const clientLoader = browserCollections.docs.createClientLoader({
	component({ toc, frontmatter, default: Mdx }) {
		const title = `${frontmatter.title} — DimRead docs`;
		return (
			<DocsPage toc={toc}>
				<title>{title}</title>
				<meta content={frontmatter.description} name="description" />
				<meta content={title} property="og:title" />
				<meta content={frontmatter.description} property="og:description" />
				<div className="flex items-center gap-3">
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

export default function Page({ loaderData }: Route.ComponentProps) {
	const { pageTree } = useFumadocsLoader(loaderData);

	return (
		<DocsLayout {...baseOptions()} tree={pageTree}>
			{clientLoader.useContent(loaderData.path)}
		</DocsLayout>
	);
}
