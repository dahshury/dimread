import {
	Copy01Icon,
	Delete02Icon,
	Download01Icon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import { IconButton } from "@/shared/ui/icon-button";
import { DemoRow, GallerySection } from "../GallerySection";

const ACCENT_BUTTON =
	"h-8 gap-1.5 rounded-md border border-accent bg-accent px-3 font-medium text-on-accent text-sm transition-colors hover:bg-accent-dim";
const NEUTRAL_BUTTON =
	"h-8 gap-1.5 rounded-md border border-border bg-surface-3 px-3 text-foreground-secondary text-sm transition-colors hover:bg-surface-4";
const DANGER_BUTTON =
	"h-8 gap-1.5 rounded-md border border-error/40 bg-transparent px-3 text-error text-sm transition-colors hover:bg-error/10";
const SEGMENT_BUTTON =
	"h-8 px-3 text-foreground-secondary text-sm transition-colors hover:text-foreground";

export function ButtonsSection() {
	const t = useTranslations("gallery");

	return (
		<GallerySection
			description={t("buttonsDescription")}
			id="buttons"
			title={t("buttonsTitle")}
		>
			<DemoRow label={t("rowButtonVariants")}>
				<Button className={ACCENT_BUTTON}>
					<HugeiconsIcon icon={Download01Icon} size={14} />
					{t("buttonPrimary")}
				</Button>
				<Button className={NEUTRAL_BUTTON}>{t("buttonNeutral")}</Button>
				<Button className={DANGER_BUTTON}>
					<HugeiconsIcon icon={Delete02Icon} size={14} />
					{t("buttonDanger")}
				</Button>
				<Button className={NEUTRAL_BUTTON} disabled>
					{t("buttonDisabled")}
				</Button>
			</DemoRow>
			<DemoRow label={t("rowIconButtons")}>
				<IconButton
					aria-label={t("iconButtonEdit")}
					icon={<HugeiconsIcon icon={PencilEdit01Icon} size={15} />}
				/>
				<IconButton
					aria-label={t("iconButtonCopy")}
					icon={<HugeiconsIcon icon={Copy01Icon} size={15} />}
				/>
				<IconButton
					aria-label={t("iconButtonDelete")}
					disabled
					icon={<HugeiconsIcon icon={Delete02Icon} size={15} />}
					tooltip={t("iconButtonDisabledTooltip")}
				/>
			</DemoRow>
			<DemoRow label={t("rowButtonGroup")}>
				<ButtonGroup aria-label={t("rowButtonGroup")} connected>
					<Button className={SEGMENT_BUTTON}>{t("segmentDay")}</Button>
					<Button className={SEGMENT_BUTTON}>{t("segmentWeek")}</Button>
					<Button className={SEGMENT_BUTTON}>{t("segmentMonth")}</Button>
				</ButtonGroup>
			</DemoRow>
		</GallerySection>
	);
}
