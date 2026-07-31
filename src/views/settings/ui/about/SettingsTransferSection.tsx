import { FileExportIcon, FileImportIcon } from "@hugeicons/core-free-icons";
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

export function SettingsTransferSection() {
	"use no memo";
	const t = useTranslations("settings");
	const common = useTranslations("common");
	const native = hasNativeRuntime();
	const [busy, setBusy] = useState<"export" | "import" | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	const exportSettings = () => {
		setBusy("export");
		setStatus(null);
		void flushPendingSettings()
			.then(() => commands.settingsExportBackup())
			.then((result) => {
				if (result.ok) {
					setStatus(t("aboutSettingsExported"));
				} else if (!result.cancelled) {
					setStatus(result.error ?? t("aboutSettingsExportFailed"));
				}
			})
			.catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error)),
			)
			.finally(() => setBusy(null));
	};

	const importSettings = () => {
		setBusy("import");
		setStatus(null);
		void flushPendingSettings()
			.then(() => commands.settingsImportBackup())
			.then((result) => {
				if (result.ok && result.snapshot) {
					adoptSettingsSnapshot(result.snapshot);
					setStatus(t("aboutSettingsImported"));
				} else if (!result.cancelled) {
					setStatus(result.error ?? t("aboutSettingsImportFailed"));
				}
			})
			.catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error)),
			)
			.finally(() => setBusy(null));
	};

	return (
		<>
			<ConfirmDialog
				cancelLabel={common("cancel")}
				confirmLabel={t("aboutSettingsImportConfirm")}
				description={t("aboutSettingsImportConfirmDescription")}
				onConfirm={importSettings}
				onOpenChange={setConfirmOpen}
				open={confirmOpen}
				title={t("aboutSettingsImportConfirmTitle")}
			/>
			<SettingSection
				icon={FileExportIcon}
				title={t("aboutSettingsTransferTitle")}
			>
				<AboutActionRow
					buttonLabel={t("aboutSettingsExport")}
					disabled={!native || busy !== null}
					icon={FileExportIcon}
					onClick={exportSettings}
					summary={t("aboutSettingsExportSummary")}
					title={t("aboutSettingsExport")}
				/>
				<AboutActionRow
					buttonLabel={t("aboutSettingsImport")}
					disabled={!native || busy !== null}
					icon={FileImportIcon}
					onClick={() => setConfirmOpen(true)}
					summary={t("aboutSettingsImportSummary")}
					title={t("aboutSettingsImport")}
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
