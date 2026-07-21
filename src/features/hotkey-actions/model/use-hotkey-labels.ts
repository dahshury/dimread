import { useTranslations } from "use-intl";
import type { HotkeyId } from "../lib/hotkey-patch";

/**
 * The human-readable row label for EVERY hotkey id (static, type-safe map —
 * no dynamic translation keys). One shared source so every panel's conflict
 * errors name the colliding binding the same way, whichever tab owns it.
 */
export function useHotkeyLabels(): Record<HotkeyId, string> {
	const t = useTranslations("hotkeys");
	return {
		toggleMain: t("toggleMainLabel"),
		brightnessUp: t("brightnessUpLabel"),
		brightnessDown: t("brightnessDownLabel"),
		tempUp: t("tempUpLabel"),
		tempDown: t("tempDownLabel"),
		toggleFilter: t("toggleFilterLabel"),
		toggleReading: t("toggleReadingLabel"),
		toggleEditing: t("toggleEditingLabel"),
		focusRead: t("focusReadLabel"),
		focusBlur: t("focusBlurLabel"),
		magicDark: t("magicDarkLabel"),
		magicGray: t("magicGrayLabel"),
	};
}
