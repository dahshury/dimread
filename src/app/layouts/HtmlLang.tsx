import { useEffect } from "react";
import { useLocaleStore } from "@/shared/i18n/locale-store";
import { installScrollbarAutoHide } from "@/shared/lib/scrollbar-autohide";
import { installTouchRubberBand } from "@/shared/lib/touch-rubber-band";

// Shared window interaction shims are tiny and idempotent; install them
// before any window subtree mounts.
installScrollbarAutoHide();
installTouchRubberBand();

/** Keeps the <html lang="..."> attribute in sync with the selected locale. */
export function HtmlLang() {
	const locale = useLocaleStore((s) => s.locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return null;
}
