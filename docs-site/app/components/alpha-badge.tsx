/**
 * "Alpha" pill beside a page title.
 *
 * Driven by `alpha: true` in a page's frontmatter, so a surface that is not
 * finished says so at the top of its own page instead of being discovered the
 * hard way. DimRead's macOS and Linux display backends are the current users.
 */
export function AlphaBadge() {
	return (
		<span className="rounded-full bg-fd-primary px-2 py-0.5 font-semibold text-fd-primary-foreground text-xs uppercase tracking-wide">
			Alpha
		</span>
	);
}
