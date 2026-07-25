const ACTIVE_ATTR = "data-scrollbar-visible";
const installedDocuments = new WeakSet<Document>();

function scrollingElementFor(event: Event, doc: Document): Element | null {
	const node = event.target;
	// Page scroll events target the document rather than an Element.
	return node instanceof Element
		? node
		: (doc.scrollingElement ?? doc.documentElement);
}

/**
 * App-wide auto-hiding native scrollbars, matching the shared `ScrollArea`.
 *
 * The native thumb is transparent at rest (see `globals.css`) and is only
 * painted while its element is hovered or actively being scrolled (mouse wheel,
 * trackpad, keyboard, or dragging the thumb — all of which fire `scroll`). This
 * installs capturing listeners on the document that stamp
 * `data-scrollbar-visible` on whichever element just scrolled and clear it on
 * the matching native `scrollend` event, so the bar fades in while scrolling
 * and disappears once scrolling actually stops — everywhere (divs,
 * `<textarea>`, `<pre>`, dropdown popups), not just the Base UI ScrollArea
 * regions.
 *
 * Idempotent and self-installing per window: every window entry renders
 * `HtmlLang`, which calls this at module load, so the seam exists in all 9
 * webviews. Base UI's own ScrollArea hides its native bar entirely
 * (`scrollbar-width: none`), so it's unaffected by the global styling.
 */
export function installScrollbarAutoHide(targetDocument?: Document): void {
	const doc =
		targetDocument ?? (typeof document === "undefined" ? undefined : document);
	if (!doc || installedDocuments.has(doc)) {
		return;
	}
	installedDocuments.add(doc);

	const onScroll = (event: Event) => {
		scrollingElementFor(event, doc)?.setAttribute(ACTIVE_ATTR, "");
	};

	const onScrollEnd = (event: Event) => {
		scrollingElementFor(event, doc)?.removeAttribute(ACTIVE_ATTR);
	};

	// Capture phase: `scroll` doesn't bubble, but a capturing listener on the
	// document still receives scroll events from every nested scroller.
	doc.addEventListener("scroll", onScroll, {
		capture: true,
		passive: true,
	});
	doc.addEventListener("scrollend", onScrollEnd, {
		capture: true,
		passive: true,
	});
}
