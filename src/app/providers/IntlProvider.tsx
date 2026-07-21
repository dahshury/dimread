import { type ReactNode, useEffect, useState } from "react";
import { IntlProvider as UseIntlProvider } from "use-intl/react";
import defaultMessages from "../../../messages/en.json";
import {
	DEFAULT_LOCALE,
	loadMessages,
	pickLocaleFromSystem,
	useLocaleStore,
} from "@/shared/i18n";

const LOCALE_STORAGE_KEY = "starter-locale";
const DEFAULT_MESSAGE_BUNDLE = defaultMessages as Record<string, unknown>;

export function IntlProvider({ children }: { children: ReactNode }) {
	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	// Messages are loaded lazily per-locale, but the first frame uses the
	// synchronous English bundle. That keeps the Tauri webview mounted even if
	// a Vite dev-server chunk request stalls during startup.
	const [bundle, setBundle] = useState<{
		locale: string;
		messages: Record<string, unknown>;
	}>({
		locale: DEFAULT_LOCALE,
		messages: DEFAULT_MESSAGE_BUNDLE,
	});

	useEffect(() => {
		// The default-locale case needs no async load: its messages are derived
		// synchronously during render (see `messages` below).
		if (locale === DEFAULT_LOCALE) {
			return;
		}
		let cancelled = false;
		loadMessages(locale)
			.then((loaded) => {
				if (!cancelled) {
					setBundle({ locale, messages: loaded });
				}
			})
			.catch(() => {
				// Keep the renderer mounted with the synchronous English bundle if a
				// dev-server chunk load stalls or fails during first boot.
				if (!cancelled) {
					setBundle({ locale, messages: DEFAULT_MESSAGE_BUNDLE });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [locale]);

	useEffect(() => {
		// First-launch only: if the user has already chosen a locale, the Zustand
		// persist middleware will have written this key. Otherwise adopt the
		// closest supported locale to the browser/OS language.
		if (typeof window === "undefined") {
			return;
		}
		if (window.localStorage.getItem(LOCALE_STORAGE_KEY) !== null) {
			return;
		}
		setLocale(pickLocaleFromSystem(globalThis.navigator?.language));
	}, [setLocale]);

	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}
		document.documentElement.setAttribute("lang", locale);
	}, [locale]);

	const messages =
		bundle.locale === locale ? bundle.messages : DEFAULT_MESSAGE_BUNDLE;

	return (
		<UseIntlProvider
			locale={locale}
			messages={messages}
			timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
		>
			{children}
		</UseIntlProvider>
	);
}
