import {
	Alert02Icon,
	Book02Icon,
	CheckmarkCircle02Icon,
	CloudDownloadIcon,
	GithubIcon,
	InformationCircleIcon,
	Link01Icon,
	RefreshIcon,
	Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { hasNativeRuntime } from "@/shared/api";
import { PRODUCT_LINKS } from "@/shared/config/product-links";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import {
	type UpdateCheckState,
	useUpdateCheck,
} from "../model/use-update-check";
import { DiagnosticsSection } from "./about/DiagnosticsSection";
import { ResetSection } from "./about/ResetSection";
import { SettingsTransferSection } from "./about/SettingsTransferSection";
import { StartupSection } from "./about/StartupSection";

interface AppInfo {
	name: string;
	tauriVersion: string;
	version: string;
}

// Dev/browser fallback — the packaged values come from @tauri-apps/api/app.
const FALLBACK_INFO: AppInfo = {
	name: "DimRead",
	version: "0.1.0",
	tauriVersion: "2.x",
};

const loadAppApi = () => import("@tauri-apps/api/app");

function useAppInfo(): AppInfo {
	const [info, setInfo] = useState<AppInfo>(FALLBACK_INFO);
	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		let cancelled = false;
		void loadAppApi()
			.then(({ getName, getTauriVersion, getVersion }) =>
				Promise.all([getName(), getVersion(), getTauriVersion()]),
			)
			.then(([name, version, tauriVersion]) => {
				if (!cancelled) {
					setInfo({ name, version, tauriVersion });
				}
			})
			.catch(() => {
				// Keep the fallback identity if metadata can't be read.
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return info;
}

function openExternal(url: string): void {
	void import("@tauri-apps/plugin-opener")
		.then(({ openUrl }) => openUrl(url))
		.catch((error: unknown) => {
			console.error("open url failed", error);
		});
}

function LinkButton({
	icon,
	label,
	url,
}: {
	icon: IconSvgElement;
	label: string;
	url: string;
}) {
	return (
		<Button
			className="h-8 gap-1.5 rounded-md border border-border bg-surface-3 px-3 text-foreground-secondary text-sm transition-colors hover:bg-surface-4"
			onClick={() => openExternal(url)}
		>
			<HugeiconsIcon icon={icon} size={14} />
			{label}
		</Button>
	);
}

/** The check's outcome as one line of copy plus the icon that frames it. */
interface UpdateReadout {
	icon: IconSvgElement | null;
	message: string;
	tone: "muted" | "success" | "accent" | "error";
}

/** Map the checker's state onto the single status line the panel shows. */
function useUpdateReadout(
	state: UpdateCheckState,
	available: boolean,
): UpdateReadout | null {
	const t = useTranslations("settings");

	if (!available) {
		return {
			icon: InformationCircleIcon,
			message: t("aboutUpdateUnavailable"),
			tone: "muted",
		};
	}
	switch (state.phase) {
		case "idle":
			return null;
		case "checking":
			return { icon: null, message: t("aboutUpdateChecking"), tone: "muted" };
		case "error":
			return {
				icon: Alert02Icon,
				message: t("aboutUpdateError", { reason: state.message }),
				tone: "error",
			};
		default:
			break;
	}
	switch (state.check.status) {
		case "upToDate":
			return {
				icon: CheckmarkCircle02Icon,
				message: t("aboutUpdateUpToDate", {
					version: state.check.latestVersion,
				}),
				tone: "success",
			};
		case "updateAvailable":
			return {
				icon: CloudDownloadIcon,
				message: t("aboutUpdateAvailable", {
					version: state.check.latestVersion,
				}),
				tone: "accent",
			};
		default:
			return {
				icon: InformationCircleIcon,
				message: t("aboutUpdateAhead", {
					current: state.check.currentVersion,
					latest: state.check.latestVersion,
				}),
				tone: "muted",
			};
	}
}

const READOUT_TONE: Record<UpdateReadout["tone"], string> = {
	accent: "text-accent",
	error: "text-error",
	muted: "text-foreground-muted",
	success: "text-success",
};

/**
 * Updates section: a manual "check for updates" button backed by the
 * `update_check` command.
 *
 * There is no in-app installer — DimRead's releases are unsigned, so the
 * Tauri updater (which requires a minisign keypair) is not wired up. What this
 * does instead is honest: ask the GitHub releases API what the newest published
 * version is, say how the running build compares, and hand over the download
 * for THIS platform when there is one.
 */
function UpdatesSection() {
	const t = useTranslations("settings");
	const { available, check, state } = useUpdateCheck();
	const readout = useUpdateReadout(state, available);
	const checking = state.phase === "checking";
	const result = state.phase === "result" ? state.check : null;
	const outdated = result?.status === "updateAvailable";

	return (
		<SettingSection
			description={t("aboutUpdatesCaption")}
			icon={RefreshIcon}
			title={t("aboutUpdates")}
		>
			<div className="flex flex-wrap items-center gap-3 py-2">
				<Button
					className="h-8 gap-1.5 rounded-md border border-border bg-surface-3 px-3 text-foreground-secondary text-sm transition-colors hover:bg-surface-4"
					disabled={!available || checking}
					onClick={check}
				>
					{checking ? (
						<Spinner className="size-3.5" />
					) : (
						<HugeiconsIcon icon={RefreshIcon} size={14} />
					)}
					{t("aboutCheckUpdates")}
				</Button>
				{readout ? (
					<p
						className={cn(
							"flex items-center gap-1.5 text-body-sm",
							READOUT_TONE[readout.tone],
						)}
						role="status"
					>
						{readout.icon ? (
							<HugeiconsIcon icon={readout.icon} size={14} />
						) : null}
						{readout.message}
					</p>
				) : null}
			</div>
			{outdated && result ? (
				<div className="flex flex-wrap gap-2 py-3">
					{result.downloadUrl && result.downloadName ? (
						<Button
							className="h-8 gap-1.5 rounded-md bg-accent px-3 text-on-accent text-sm transition-colors hover:bg-accent-hover"
							onClick={() => openExternal(result.downloadUrl ?? "")}
						>
							<HugeiconsIcon icon={CloudDownloadIcon} size={14} />
							{t("aboutUpdateDownload", { name: result.downloadName })}
						</Button>
					) : null}
					<LinkButton
						icon={Tag01Icon}
						label={t("aboutUpdateReleaseNotes")}
						url={result.releaseUrl}
					/>
				</div>
			) : null}
		</SettingSection>
	);
}

/** About tab: app identity (name/version via @tauri-apps/api/app), the update
 *  check, external links through the opener plugin, and the credits. */
export function AboutPanel() {
	const t = useTranslations("settings");
	const info = useAppInfo();
	const general = useSettingsStore((state) => state.settings.general);

	return (
		<>
			<SettingSection icon={InformationCircleIcon} title={t("aboutApp")}>
				<FormControl label={t("aboutName")} layout="row">
					<span className="font-medium text-body text-foreground">
						{info.name}
					</span>
				</FormControl>
				<FormControl label={t("aboutVersion")} layout="row">
					<Badge className="font-mono" variant="secondary">
						{info.version}
					</Badge>
				</FormControl>
				<FormControl label={t("aboutTauriVersion")} layout="row">
					<Badge className="font-mono" variant="secondary">
						{info.tauriVersion}
					</Badge>
				</FormControl>
			</SettingSection>

			<UpdatesSection />

			<StartupSection
				general={general}
				onPatch={(patch) => patchSettingsSection("general", patch)}
			/>

			<SettingsTransferSection />

			<DiagnosticsSection />

			<ResetSection />

			<SettingSection icon={Link01Icon} title={t("aboutLinks")}>
				<div className="flex flex-wrap gap-2 py-2">
					<LinkButton
						icon={GithubIcon}
						label={t("aboutLinkSource")}
						url={PRODUCT_LINKS.repository}
					/>
					<LinkButton
						icon={Book02Icon}
						label={t("aboutLinkDocs")}
						url={PRODUCT_LINKS.docs}
					/>
					<LinkButton
						icon={Tag01Icon}
						label={t("aboutLinkReleases")}
						url={PRODUCT_LINKS.releases}
					/>
				</div>
			</SettingSection>

			<SettingSection icon={InformationCircleIcon} title={t("aboutCredits")}>
				<p className="max-w-xl py-2 text-body-sm text-foreground-muted leading-relaxed">
					{t("aboutCreditsBody")}
				</p>
			</SettingSection>
		</>
	);
}
