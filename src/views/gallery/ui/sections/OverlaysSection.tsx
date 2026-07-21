import { useState } from "react";
import { useTranslations } from "use-intl";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { DemoPreview } from "@/shared/ui/demo-preview";
import {
	Dialog,
	DialogActionButton,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@/shared/ui/dialog";
import { Modal } from "@/shared/ui/modal";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import {
	ToastDismissButton,
	ToastShell,
	type ToastTone,
	useAutoDismiss,
} from "@/shared/ui/toast";
import { DemoRow, GallerySection } from "../GallerySection";

const NEUTRAL_BUTTON =
	"h-8 gap-1.5 rounded-md border border-border bg-surface-3 px-3 text-foreground-secondary text-sm transition-colors hover:bg-surface-4";

function DemoToast({
	message,
	onDismiss,
	tone,
}: {
	message: string;
	onDismiss: () => void;
	tone: ToastTone;
}) {
	const t = useTranslations("gallery");
	useAutoDismiss(message, onDismiss, 4000);
	return (
		<div className="fixed right-4 bottom-4 z-toast">
			<ToastShell
				ariaLive="polite"
				className="flex items-start gap-3"
				tone={tone}
			>
				<div className="flex flex-col gap-0.5">
					<span className="font-medium text-body text-foreground">
						{t("toastHeadline")}
					</span>
					<span className="text-body-sm text-foreground-secondary">
						{message}
					</span>
				</div>
				<ToastDismissButton label={t("toastDismiss")} onClick={onDismiss} />
			</ToastShell>
		</div>
	);
}

export function OverlaysSection() {
	const t = useTranslations("gallery");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [optInOpen, setOptInOpen] = useState(false);
	const [modalOpen, setModalOpen] = useState(false);
	const [toast, setToast] = useState<{
		message: string;
		tone: ToastTone;
	} | null>(null);

	return (
		<GallerySection
			description={t("overlaysDescription")}
			id="overlays"
			title={t("overlaysTitle")}
		>
			<DemoRow label={t("rowDialogs")}>
				<Button className={NEUTRAL_BUTTON} onClick={() => setDialogOpen(true)}>
					{t("openDialog")}
				</Button>
				<Button className={NEUTRAL_BUTTON} onClick={() => setConfirmOpen(true)}>
					{t("openConfirm")}
				</Button>
				<Button className={NEUTRAL_BUTTON} onClick={() => setOptInOpen(true)}>
					{t("openOptIn")}
				</Button>
				<Button className={NEUTRAL_BUTTON} onClick={() => setModalOpen(true)}>
					{t("openModal")}
				</Button>
			</DemoRow>
			<DemoRow label={t("rowToasts")}>
				<Button
					className={NEUTRAL_BUTTON}
					onClick={() =>
						setToast({ message: t("toastNeutralBody"), tone: "neutral" })
					}
				>
					{t("showToastNeutral")}
				</Button>
				<Button
					className={NEUTRAL_BUTTON}
					onClick={() =>
						setToast({ message: t("toastErrorBody"), tone: "error" })
					}
				>
					{t("showToastError")}
				</Button>
			</DemoRow>
			<DemoRow label={t("rowDemoPreview")}>
				<DemoPreview demo="feature-tour">
					<Badge variant="secondary">{t("demoPreviewTrigger")}</Badge>
				</DemoPreview>
				<span className="text-body-sm text-foreground-muted">
					{t("demoPreviewHint")}
				</span>
			</DemoRow>

			<Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
				<DialogContent width={420}>
					<DialogTitle>{t("dialogTitle")}</DialogTitle>
					<DialogDescription>{t("dialogBody")}</DialogDescription>
					<DialogFooter>
						<DialogClose
							render={
								<DialogActionButton variant="neutral">
									{t("dialogDismiss")}
								</DialogActionButton>
							}
						/>
						<DialogClose
							render={
								<DialogActionButton variant="accent">
									{t("dialogConfirm")}
								</DialogActionButton>
							}
						/>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				cancelLabel={t("confirmCancel")}
				confirmLabel={t("confirmDelete")}
				description={t("confirmBody")}
				onConfirm={() =>
					setToast({ message: t("confirmDone"), tone: "neutral" })
				}
				onOpenChange={setConfirmOpen}
				open={confirmOpen}
				title={t("confirmTitle")}
			/>

			<OptInDialog
				body={t("optInBody")}
				cancelLabel={t("confirmCancel")}
				confirmLabel={t("optInConfirm")}
				onCancel={() => undefined}
				onConfirm={() => setToast({ message: t("optInDone"), tone: "neutral" })}
				onOpenChange={setOptInOpen}
				open={optInOpen}
				title={t("optInTitle")}
			/>

			<Modal isOpen={modalOpen} onClose={() => setModalOpen(false)}>
				<div className="flex w-[420px] max-w-[90vw] flex-col gap-3 p-6">
					<h4 className="font-semibold text-foreground text-subtitle">
						{t("modalTitle")}
					</h4>
					<p className="text-body-sm text-foreground-secondary leading-relaxed">
						{t("modalBody")}
					</p>
					<div className="flex justify-end">
						<Button
							className={NEUTRAL_BUTTON}
							onClick={() => setModalOpen(false)}
						>
							{t("modalClose")}
						</Button>
					</div>
				</div>
			</Modal>

			{toast ? (
				<DemoToast
					message={toast.message}
					onDismiss={() => setToast(null)}
					tone={toast.tone}
				/>
			) : null}
		</GallerySection>
	);
}
