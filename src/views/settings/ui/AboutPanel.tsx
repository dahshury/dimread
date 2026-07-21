import {
	Book02Icon,
	GithubIcon,
	GlobeIcon,
	InformationCircleIcon,
	Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSection } from "@/entities/setting";
import { hasNativeRuntime } from "@/shared/api";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";

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

/** About tab: app identity (name/version via @tauri-apps/api/app), external
 *  links through the opener plugin, and the template credits. */
export function AboutPanel() {
	const t = useTranslations("settings");
	const info = useAppInfo();

	return (
		<>
			<SettingSection
				boxed
				divided
				icon={InformationCircleIcon}
				title={t("aboutApp")}
			>
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

			<SettingSection icon={Link01Icon} title={t("aboutLinks")}>
				<div className="flex flex-wrap gap-2 pt-2">
					<LinkButton
						icon={GithubIcon}
						label={t("aboutLinkSource")}
						url="https://github.com/dahshury"
					/>
					<LinkButton
						icon={Book02Icon}
						label={t("aboutLinkTauriDocs")}
						url="https://v2.tauri.app"
					/>
					<LinkButton
						icon={GlobeIcon}
						label={t("aboutLinkWinstt")}
						url="https://github.com/dahshury/WinSTT"
					/>
				</div>
			</SettingSection>

			<SettingSection icon={InformationCircleIcon} title={t("aboutCredits")}>
				<p className="max-w-xl pt-2 text-body-sm text-foreground-muted leading-relaxed">
					{t("aboutCreditsBody")}
				</p>
			</SettingSection>
		</>
	);
}
