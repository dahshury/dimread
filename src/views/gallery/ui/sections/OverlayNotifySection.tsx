import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { commands, events, type OverlayTone } from "@/bindings";
import { formatCombo } from "@/features/record-hotkey";
import { hasNativeRuntime, subscribeNativeEvent } from "@/shared/api";
import { Button } from "@/shared/ui/button";
import { ToastShell, useAutoDismiss } from "@/shared/ui/toast";
import { DemoRow, GallerySection } from "../GallerySection";

const NEUTRAL_BUTTON =
	"h-8 gap-1.5 rounded-md border border-border bg-surface-3 px-3 text-foreground-secondary text-sm transition-colors hover:bg-surface-4";

const TONES: readonly OverlayTone[] = [
	"neutral",
	"success",
	"warning",
	"error",
];

function fireOverlayNotify(tone: OverlayTone, title: string, message: string) {
	void commands
		.overlayNotify({ title, message, tone, durationMs: null })
		.catch(() => undefined);
}

/** Bottom-corner toast confirming a `hotkey:triggered` broadcast landed. */
function HotkeyFiredToast({
	message,
	onDismiss,
}: {
	message: string | null;
	onDismiss: () => void;
}) {
	const t = useTranslations("overlay");
	useAutoDismiss(message, onDismiss, 4000);
	if (!message) {
		return null;
	}
	return (
		<div className="fixed right-4 bottom-4 z-toast">
			<ToastShell ariaLive="polite" className="flex flex-col gap-0.5">
				<span className="font-medium text-body text-foreground">
					{t("hotkeyToastTitle")}
				</span>
				<span className="text-body-sm text-foreground-muted">{message}</span>
			</ToastShell>
		</div>
	);
}

/**
 * Live wiring demo for the two native features: the overlay notification
 * pill (`overlay_notify` per tone + `overlay_dismiss`) and the global-hotkey
 * broadcast (`hotkey:triggered` → toast). The overlay buttons drive the REAL
 * top-of-screen pill window — outside the Tauri runtime they no-op.
 */
export function OverlayNotifySection() {
	const t = useTranslations("overlay");
	const [hotkeyMessage, setHotkeyMessage] = useState<string | null>(null);

	// Any registered hotkey (e.g. the settings' "toggle main window" combo)
	// lights the toast — the demo listener for the `hotkey:triggered` event.
	useEffect(() => {
		if (!hasNativeRuntime()) {
			return;
		}
		return subscribeNativeEvent(events.hotkeyTriggered, (event) => {
			setHotkeyMessage(
				`${event.payload.id} — ${formatCombo(event.payload.accelerator)}`,
			);
		});
	}, []);

	const toneLabels: Record<OverlayTone, string> = {
		neutral: t("toneNeutral"),
		success: t("toneSuccess"),
		warning: t("toneWarning"),
		error: t("toneError"),
	};

	return (
		<GallerySection
			description={t("galleryDescription")}
			id="overlay-notify"
			title={t("galleryTitle")}
		>
			<DemoRow label={t("rowTones")}>
				{TONES.map((tone) => (
					<Button
						className={NEUTRAL_BUTTON}
						key={tone}
						onClick={() =>
							fireOverlayNotify(
								tone,
								toneLabels[tone],
								t("demoMessage", { tone: toneLabels[tone] }),
							)
						}
					>
						{toneLabels[tone]}
					</Button>
				))}
				<Button
					className={NEUTRAL_BUTTON}
					onClick={() => void commands.overlayDismiss().catch(() => undefined)}
				>
					{t("dismiss")}
				</Button>
			</DemoRow>
			<DemoRow label={t("rowHotkey")}>
				<p className="max-w-xl text-body-sm text-foreground-muted">
					{t("hotkeyHint")}
				</p>
			</DemoRow>
			<HotkeyFiredToast
				message={hotkeyMessage}
				onDismiss={() => setHotkeyMessage(null)}
			/>
		</GallerySection>
	);
}
