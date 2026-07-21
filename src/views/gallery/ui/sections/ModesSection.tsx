import {
	Coffee02Icon,
	Edit02Icon,
	LayoutTwoColumnIcon,
	Moon02Icon,
	Target02Icon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	ModeSwitch,
	type ModeSwitchMode,
	ModeSwitchPill,
} from "@/shared/ui/mode-switch";
import { DemoRow, GallerySection } from "../GallerySection";

type EditorMode = "edit" | "preview" | "split";
type LevelMode = "off" | "low" | "medium" | "high" | "max";
type PresenceMode = "focus" | "casual" | "away";

export function ModesSection() {
	const t = useTranslations("gallery");
	const [editorMode, setEditorMode] = useState<EditorMode>("edit");
	const [level, setLevel] = useState<LevelMode>("medium");

	const editorModes: ModeSwitchMode<EditorMode>[] = [
		{ value: "edit", label: t("modeEdit"), icon: Edit02Icon },
		{ value: "preview", label: t("modePreview"), icon: ViewIcon },
		{ value: "split", label: t("modeSplit"), icon: LayoutTwoColumnIcon },
	];
	const levelModes: ModeSwitchMode<LevelMode>[] = [
		{ value: "off", label: t("modeOff") },
		{ value: "low", label: t("modeLow") },
		{ value: "medium", label: t("modeMedium") },
		{ value: "high", label: t("modeHigh") },
		{ value: "max", label: t("modeMax") },
	];
	const presenceModes: ModeSwitchMode<PresenceMode>[] = [
		{ value: "focus", label: t("modeFocus"), icon: Target02Icon },
		{ value: "casual", label: t("modeCasual"), icon: Coffee02Icon },
		{ value: "away", label: t("modeAway"), icon: Moon02Icon },
	];

	return (
		<GallerySection
			description={t("modesDescription")}
			id="modes"
			title={t("modesTitle")}
		>
			<DemoRow label={t("rowModeSegmented")}>
				<ModeSwitch
					modes={editorModes}
					onChange={setEditorMode}
					value={editorMode}
				/>
			</DemoRow>
			<DemoRow label={t("rowModeFiveWay")}>
				<ModeSwitch
					modes={levelModes}
					onChange={setLevel}
					size="sm"
					value={level}
				/>
			</DemoRow>
			<DemoRow label={t("rowModePill")}>
				<ModeSwitchPill
					defaultValue="focus"
					describeMode={(mode) => t("modePillTooltip", { mode })}
					modes={presenceModes}
				/>
			</DemoRow>
		</GallerySection>
	);
}
