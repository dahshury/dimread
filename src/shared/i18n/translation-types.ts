import type { useTranslations } from "use-intl";

export type TranslateFn = ReturnType<typeof useTranslations>;
export type CommonTranslateFn = ReturnType<typeof useTranslations<"common">>;
export type SettingsTranslateFn = ReturnType<
	typeof useTranslations<"settings">
>;
