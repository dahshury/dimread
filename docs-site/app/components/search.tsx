import { create } from "@orama/orama";
import { useDocsSearch } from "fumadocs-core/search/client";
import { oramaStaticClient } from "fumadocs-core/search/client/orama-static";
import {
	SearchDialog,
	SearchDialogClose,
	SearchDialogContent,
	SearchDialogHeader,
	SearchDialogIcon,
	SearchDialogInput,
	SearchDialogList,
	SearchDialogOverlay,
	type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useI18n } from "fumadocs-ui/contexts/i18n";

function initOrama() {
	return create({ schema: { _: "string" }, language: "english" });
}

/**
 * Static search: the whole index is a pre-rendered file at `/api/search`,
 * fetched on first open. `oramaStaticClient` resolves that path against
 * `import.meta.env.BASE_URL`, so it follows the GitHub Pages sub-path with no
 * extra configuration.
 */
export default function DefaultSearchDialog(props: SharedProps) {
	const { locale } = useI18n();
	const { search, setSearch, query } = useDocsSearch({
		client: oramaStaticClient({ initOrama, locale }),
	});

	return (
		<SearchDialog
			isLoading={query.isLoading}
			onSearchChange={setSearch}
			search={search}
			{...props}
		>
			<SearchDialogOverlay />
			<SearchDialogContent>
				<SearchDialogHeader>
					<SearchDialogIcon />
					<SearchDialogInput />
					<SearchDialogClose />
				</SearchDialogHeader>
				<SearchDialogList items={query.data === "empty" ? null : query.data} />
			</SearchDialogContent>
		</SearchDialog>
	);
}
