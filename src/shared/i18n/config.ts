// Supported renderer locales. The starter ships English only, but the
// infrastructure is multi-locale: to add a locale, each entry needs:
//   * a `messages/<code>.json` baseline (key parity with `en.json` is enforced
//     by `bun check:i18n`).
//   * a `LOCALE_NAMES` entry below for a language-picker label.
//   * (automatic) `pickLocaleFromSystem` matches the primary subtag.
export const LOCALES = ["en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const LOCALE_SEPARATOR_RE = /[-_]/;

export function isLocale(value: string): value is Locale {
	return (LOCALES as readonly string[]).includes(value);
}

function primaryLocaleTag(input: string): string {
	const [head = ""] = input.toLowerCase().split(LOCALE_SEPARATOR_RE);
	return head;
}

/** Map a BCP-47 / OS locale tag (e.g. "en-US", "zh_CN") to a supported {@link Locale}. */
export function pickLocaleFromSystem(input: string | null | undefined): Locale {
	if (!input) {
		return DEFAULT_LOCALE;
	}
	const primary = primaryLocaleTag(input);
	return isLocale(primary) ? primary : DEFAULT_LOCALE;
}

export const LOCALE_NAMES: Record<Locale, { name: string; native: string }> = {
	en: { name: "English", native: "English" },
};
