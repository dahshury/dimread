import { useEffect } from "react";

/**
 * Make the document background transparent for the lifetime of the caller.
 * Transparent OS windows (settings, picker) need this: without it WebView2
 * paints an opaque page background behind the view's rounded card.
 */
export function useTransparentBody() {
	useEffect(() => {
		document.documentElement.classList.add("bg-transparent");
		document.body.classList.add("bg-transparent");
		return () => {
			document.documentElement.classList.remove("bg-transparent");
			document.body.classList.remove("bg-transparent");
		};
	}, []);
}

const DEFAULT_ESCAPE_BLOCKING_LAYER_SELECTOR = [
	'[role="dialog"]',
	'[role="alertdialog"]',
	'[role="menu"]',
	'[role="listbox"]',
].join(",");

function isVisibleLayer(element: HTMLElement): boolean {
	const style = window.getComputedStyle(element);
	return (
		style.display !== "none" &&
		style.visibility !== "hidden" &&
		element.getClientRects().length > 0
	);
}

function hasVisibleBlockingLayer(
	selector: string,
	ignoreLayer?: (element: HTMLElement) => boolean,
): boolean {
	for (const layer of document.querySelectorAll<HTMLElement>(selector)) {
		if (!ignoreLayer?.(layer) && isVisibleLayer(layer)) {
			return true;
		}
	}
	return false;
}

export interface EscapeToCloseOptions {
	/** Visible layers that should receive Escape before the owning window closes. */
	blockingLayerSelector?: string;
	/** Ignore a matched visible layer. Used by detached picker windows whose
	 *  primary inline listbox is always open but should not block window Escape. */
	ignoreLayer?: (element: HTMLElement) => boolean;
}

/**
 * Close the owning window on Escape — unless a dismissable layer (dialog,
 * menu, listbox) is visibly open, in which case Escape belongs to that layer.
 */
export function useEscapeToClose(
	close: () => void,
	options: EscapeToCloseOptions = {},
) {
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (
				e.key === "Escape" &&
				!e.defaultPrevented &&
				!hasVisibleBlockingLayer(
					options.blockingLayerSelector ??
						DEFAULT_ESCAPE_BLOCKING_LAYER_SELECTOR,
					options.ignoreLayer,
				)
			) {
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [close, options.blockingLayerSelector, options.ignoreLayer]);
}
