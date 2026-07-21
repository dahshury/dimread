import { useTranslations } from "use-intl";
import { DISPLAY_MODE_IDS } from "@/shared/config/settings-schema";
import type { SelectOption } from "@/shared/ui/select";
import { MATCH_KINDS, type MatchKind } from "../lib/rule-model";

/**
 * i18n-backed option lists + label lookups for the rules UI. Mode names live in
 * the `rulesTab` namespace (this feature's own block) rather than reaching into
 * the display agent's `displayTab`, so keys are referenced with string literals
 * (use-intl types `t` to its namespace).
 */
export interface RuleLabels {
	matchKindOptions: SelectOption[];
	matchKindLabel: (value: string) => string;
	modeOptions: SelectOption[];
}

export function useRuleLabels(): RuleLabels {
	const t = useTranslations("rulesTab");

	const matchKindLabels: Record<MatchKind, string> = {
		process: t("matchProcess"),
		class: t("matchClass"),
		title: t("matchTitle"),
	};
	const modeLabels: Record<string, string> = {
		pause: t("modePause"),
		health: t("modeHealth"),
		game: t("modeGame"),
		movie: t("modeMovie"),
		office: t("modeOffice"),
		editing: t("modeEditing"),
		reading: t("modeReading"),
		custom: t("modeCustom"),
	};

	return {
		matchKindOptions: MATCH_KINDS.map((kind) => ({
			id: kind,
			label: matchKindLabels[kind],
		})),
		matchKindLabel: (value) =>
			matchKindLabels[value as MatchKind] ?? matchKindLabels.process,
		modeOptions: DISPLAY_MODE_IDS.map((id) => ({
			id,
			label: modeLabels[id] ?? id,
		})),
	};
}
