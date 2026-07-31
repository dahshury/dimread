import {
	Bug01Icon,
	Copy01Icon,
	Delete02Icon,
	FileZipIcon,
	Folder01Icon,
	PauseIcon,
	PlayIcon,
	RefreshIcon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	commands,
	events,
	type DiagnosticsLogLineEvent,
	type OperationalIssue,
} from "@/bindings";
import { SettingSection } from "@/entities/setting";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";
import { copyToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { AboutActionRow } from "./AboutActionRow";

const MAX_LOG_LINES = 1000;
const ISSUE_LIMIT = 50;
type StreamStatus = "off" | "starting" | "live" | "paused" | "stopping";

function formatLogLine(line: DiagnosticsLogLineEvent): string {
	const time = new Date(line.timestampMs).toLocaleTimeString(undefined, {
		hour12: false,
	});
	return `${time} ${line.level.toUpperCase()} [${line.target}] ${line.message}`;
}

function diagnosticsErrorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function LiveDebugLogs() {
	"use no memo";
	const t = useTranslations("settings");
	const native = hasNativeRuntime();
	const [lines, setLines] = useState<DiagnosticsLogLineEvent[]>([]);
	const [stream, setStream] = useState<StreamStatus>("off");
	const [error, setError] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!native) {
			return;
		}
		const unsubscribe = subscribeNativeEvent(
			events.diagnosticsLogLine,
			(event) => {
				setLines((current) =>
					current.concat(event.payload).slice(-MAX_LOG_LINES),
				);
			},
		);
		return () => {
			unsubscribe();
			void commands.diagnosticsSetLogStreaming(false);
		};
	}, [native]);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [lines]);

	const setStreaming = (enabled: boolean, next: StreamStatus) => {
		setError(null);
		setStream(enabled ? "starting" : "stopping");
		void commands
			.diagnosticsSetLogStreaming(enabled)
			.then((result) => {
				if (result.status === "error") {
					setError(result.error);
					setStream("off");
					return;
				}
				setStream(next);
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : String(cause));
				setStream("off");
			});
	};

	const statusText =
		stream === "live"
			? t("aboutLiveLogsStatusLive", { count: lines.length })
			: stream === "paused"
				? t("aboutLiveLogsStatusPaused", { count: lines.length })
				: stream === "starting"
					? t("aboutLiveLogsStatusStarting")
					: stream === "stopping"
						? t("aboutLiveLogsStatusStopping")
						: t("aboutLiveLogsStatusOff", { count: lines.length });

	return (
		<div className="py-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-body text-foreground">
						{t("aboutLiveLogsTitle")}
					</span>
					<span className="text-body-sm text-foreground-muted">
						{t("aboutLiveLogsDescription")}
					</span>
				</div>
				<div className="flex flex-wrap gap-2">
					{stream === "off" ? (
						<Button
							className="h-8 gap-1.5 rounded-md bg-surface-3 px-2.5"
							disabled={!native}
							onClick={() => setStreaming(true, "live")}
						>
							<HugeiconsIcon icon={PlayIcon} size={13} />
							{t("aboutLiveLogsStart")}
						</Button>
					) : (
						<>
							<Button
								className="h-8 gap-1.5 rounded-md bg-surface-3 px-2.5"
								disabled={stream === "starting" || stream === "stopping"}
								onClick={() =>
									setStreaming(
										stream !== "live",
										stream === "live" ? "paused" : "live",
									)
								}
							>
								<HugeiconsIcon
									icon={stream === "live" ? PauseIcon : PlayIcon}
									size={13}
								/>
								{stream === "live"
									? t("aboutLiveLogsPause")
									: t("aboutLiveLogsResume")}
							</Button>
							<Button
								className="h-8 gap-1.5 rounded-md bg-surface-3 px-2.5"
								disabled={stream === "starting" || stream === "stopping"}
								onClick={() => setStreaming(false, "off")}
							>
								<HugeiconsIcon icon={StopIcon} size={13} />
								{t("aboutLiveLogsStop")}
							</Button>
						</>
					)}
					<Button
						aria-label={t("aboutLiveLogsCopy")}
						className="size-8 rounded-md bg-surface-3 p-0"
						disabled={lines.length === 0}
						onClick={() => copyToClipboard(lines.map(formatLogLine).join("\n"))}
					>
						<HugeiconsIcon icon={Copy01Icon} size={13} />
					</Button>
					<Button
						aria-label={t("aboutLiveLogsClear")}
						className="size-8 rounded-md bg-surface-3 p-0"
						disabled={lines.length === 0}
						onClick={() => setLines([])}
					>
						<HugeiconsIcon icon={Delete02Icon} size={13} />
					</Button>
				</div>
			</div>
			<div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface-1">
				<div className="flex items-center gap-2 border-divider border-b px-3 py-2 text-body-sm text-foreground-muted">
					<span
						className={cn(
							"size-2 rounded-full",
							stream === "live"
								? "animate-pulse bg-success"
								: "bg-foreground-muted/50",
						)}
					/>
					<span aria-live="polite">{error ?? statusText}</span>
				</div>
				<div
					aria-label={t("aboutLiveLogsOutputLabel")}
					className="h-64 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed"
					ref={scrollRef}
					role="log"
				>
					{lines.length === 0 ? (
						<p className="text-foreground-muted">{t("aboutLiveLogsEmpty")}</p>
					) : (
						lines.map((line, index) => (
							<div
								className="whitespace-pre-wrap break-words text-foreground-secondary"
								key={`${line.timestampMs}-${index}`}
							>
								{formatLogLine(line)}
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}

function OperationalIssues() {
	const t = useTranslations("settings");
	const native = hasNativeRuntime();
	const [issues, setIssues] = useState<OperationalIssue[]>([]);
	const [loading, setLoading] = useState(native);
	const [error, setError] = useState<string | null>(null);
	const refresh = () => {
		if (!native) {
			return;
		}
		setError(null);
		setLoading(true);
		void commands
			.diagnosticsRecentIssues(ISSUE_LIMIT)
			.then(setIssues)
			.catch((cause: unknown) => setError(diagnosticsErrorMessage(cause)))
			.finally(() => setLoading(false));
	};
	useEffect(() => {
		if (!native) {
			return;
		}
		let active = true;
		void commands
			.diagnosticsRecentIssues(ISSUE_LIMIT)
			.then((next) => {
				if (active) {
					setIssues(next);
				}
			})
			.catch((cause: unknown) => {
				if (active) {
					setError(diagnosticsErrorMessage(cause));
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [native]);
	const clear = () => {
		setError(null);
		void commands
			.diagnosticsClearIssues()
			.then(() => setIssues([]))
			.catch((cause: unknown) => setError(diagnosticsErrorMessage(cause)));
	};
	return (
		<div className="py-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-body text-foreground">
						{t("aboutIssuesTitle")}
					</span>
					<span className="text-body-sm text-foreground-muted">
						{t("aboutIssuesDescription")}
					</span>
				</div>
				<div className="flex gap-2">
					<Button
						className="h-8 gap-1.5 rounded-md bg-surface-3 px-2.5"
						disabled={!native || loading}
						onClick={refresh}
					>
						<HugeiconsIcon icon={RefreshIcon} size={13} />
						{t("aboutIssuesRefresh")}
					</Button>
					<Button
						className="h-8 gap-1.5 rounded-md bg-error-dim/30 px-2.5 text-error"
						disabled={!native || issues.length === 0}
						onClick={clear}
					>
						<HugeiconsIcon icon={Delete02Icon} size={13} />
						{t("aboutIssuesClear")}
					</Button>
				</div>
			</div>
			<div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface-1 p-2">
				{error ? (
					<p className="p-4 text-center text-body-sm text-error" role="alert">
						{error}
					</p>
				) : loading && issues.length === 0 ? (
					<p className="p-4 text-center text-body-sm text-foreground-muted">
						{t("aboutIssuesLoading")}
					</p>
				) : issues.length === 0 ? (
					<p className="p-4 text-center text-body-sm text-foreground-muted">
						{t("aboutIssuesEmpty")}
					</p>
				) : (
					<div className="flex flex-col divide-y divide-divider">
						{issues.map((issue) => (
							<div className="flex flex-col gap-1 px-2 py-3" key={issue.id}>
								<div className="flex items-start justify-between gap-3">
									<span className="font-medium text-body-sm text-foreground">
										{issue.summary}
									</span>
									<span className="shrink-0 text-2xs text-foreground-muted">
										{new Date(issue.timestampMs).toLocaleString()}
									</span>
								</div>
								<span className="text-body-sm text-foreground-muted">
									{issue.detail}
								</span>
								<span className="text-body-sm text-foreground-secondary">
									{issue.remediation}
								</span>
								<span className="text-2xs text-foreground-muted uppercase tracking-wide">{`${issue.area} / ${issue.operation}`}</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export function DiagnosticsSection() {
	const t = useTranslations("settings");
	const native = hasNativeRuntime();
	const [status, setStatus] = useState<string | null>(null);
	const runAction = (
		action: () => Promise<{
			cancelled?: boolean | null;
			error?: string | null;
			ok: boolean;
		}>,
		success: string,
	) => {
		setStatus(null);
		void action()
			.then((result) => {
				if (result.ok) {
					setStatus(success);
				} else if (!result.cancelled) {
					setStatus(result.error ?? t("aboutDiagnosticsFailed"));
				}
			})
			.catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error)),
			);
	};
	return (
		<SettingSection icon={Bug01Icon} title={t("aboutDiagnosticsTitle")}>
			<AboutActionRow
				buttonLabel={t("aboutOpenLogs")}
				disabled={!native}
				icon={Folder01Icon}
				onClick={() =>
					runAction(
						() => commands.diagnosticsOpenLogsFolder(),
						t("aboutLogsOpened"),
					)
				}
				summary={t("aboutOpenLogsSummary")}
				title={t("aboutOpenLogs")}
			/>
			<AboutActionRow
				buttonLabel={t("aboutSaveBundleButton")}
				disabled={!native}
				icon={FileZipIcon}
				onClick={() =>
					runAction(
						() => commands.diagnosticsSaveBundle(),
						t("aboutBundleSaved"),
					)
				}
				summary={t("aboutSaveBundleSummary")}
				title={t("aboutSaveBundle")}
			/>
			{status ? (
				<p className="py-2 text-body-sm text-foreground-muted" role="status">
					{status}
				</p>
			) : null}
			<LiveDebugLogs />
			<OperationalIssues />
		</SettingSection>
	);
}
