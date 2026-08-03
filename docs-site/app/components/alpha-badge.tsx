/**
 * "Alpha" pill beside a page title.
 *
 * Driven by `alpha: true` in a page's frontmatter, so a surface that is not
 * finished says so at the top of its own page instead of being discovered the
 * hard way. DimRead's macOS and Linux display backends are the current users.
 */
export function AlphaBadge() {
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full border border-fd-primary/40 bg-fd-primary/10 px-2.5 py-0.5 font-semibold text-[0.6875rem] text-fd-primary uppercase tracking-[0.08em]">
			<span className="size-1.5 rounded-full bg-fd-primary" />
			Alpha
		</span>
	);
}
