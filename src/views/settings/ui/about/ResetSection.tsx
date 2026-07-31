import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import {
	adoptSettingsSnapshot,
	SettingSection,
	flushPendingSettings,
} from "@/entities/setting";
import { hasNativeRuntime } from "@/shared/api";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { AboutActionRow } from "./AboutActionRow";

export function ResetSection() {
	const t = useTranslations("settings");
	const common = useTranslations("common");
	const native = hasNativeRuntime();
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const reset = () => {
		setStatus(null);
		void flushPendingSettings()
			.then(() => commands.settingsResetDefaults())
			.then((result) => {
				if (result.status === "error") {
					setStatus(result.error);
					return;
				}
				adoptSettingsSnapshot(result.data);
				setStatus(t("aboutResetComplete"));
			})
			.catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error)),
			);
	};
	return (
		<>
			<ConfirmDialog
				cancelLabel={common("cancel")}
				confirmLabel={t("aboutResetButton")}
				description={t("aboutResetConfirmDescription")}
				onConfirm={reset}
				onOpenChange={setOpen}
				open={open}
				title={t("aboutResetConfirmTitle")}
			/>
			<SettingSection icon={ArrowTurnBackwardIcon} title={t("aboutResetTitle")}>
				<AboutActionRow
					buttonLabel={t("aboutResetButton")}
					danger
					disabled={!native}
					icon={ArrowTurnBackwardIcon}
					onClick={() => setOpen(true)}
					summary={t("aboutResetSummary")}
					title={t("aboutResetButton")}
				/>
				{status ? (
					<p className="py-2 text-body-sm text-foreground-muted" role="status">
						{status}
					</p>
				) : null}
			</SettingSection>
		</>
	);
}
