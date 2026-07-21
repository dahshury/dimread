import {
	ArrowReloadHorizontalIcon,
	Cursor02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	Dialog,
	DialogActionButton,
	DialogContent,
	DialogFooter,
	DialogHeader,
} from "@/shared/ui/dialog";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { TextField } from "@/shared/ui/text-field";
import { useOpenWindows } from "../api/use-open-windows";
import { useRuleLabels } from "../model/use-rule-labels";
import {
	DEFAULT_DRAFT,
	isDraftValid,
	patternForWindow,
	type RuleDraft,
	toMatchKind,
} from "../lib/rule-model";

export interface RuleDialogProps {
	/** Whether editing an existing rule (drives the dialog title). */
	editing?: boolean | undefined;
	/** Seed the form for the edit flow; omit for a fresh rule. */
	initialDraft?: RuleDraft | undefined;
	onOpenChange: (open: boolean) => void;
	onSubmit: (draft: RuleDraft) => void;
	open: boolean;
}

/**
 * Add / edit dialog for a custom rule (FEATURE-PARITY F4): a match-kind picker,
 * a "pick a running window" searchable-select (replacing CareUEyes' drag Finder
 * Tool) that fills the pattern, an editable pattern field, and the mode select.
 */
export function RuleDialog({
	editing = false,
	initialDraft,
	onOpenChange,
	onSubmit,
	open,
}: RuleDialogProps) {
	const t = useTranslations("rulesTab");
	const { matchKindOptions, modeOptions } = useRuleLabels();
	const { windows, loading, refresh } = useOpenWindows(open);

	const [draft, setDraft] = useState<RuleDraft>(initialDraft ?? DEFAULT_DRAFT);
	// The picked window's stable id (its HWND). Keyed by id, not process, so two
	// windows of the same process resolve to the exact one the user chose.
	const [pickedId, setPickedId] = useState("");

	// Reset the form on the rising edge of `open` only, so live edits are never
	// wiped by the parent re-rendering a fresh `initialDraft` identity.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (open && !wasOpen.current) {
			setDraft(initialDraft ?? DEFAULT_DRAFT);
			setPickedId("");
		}
		wasOpen.current = open;
	}, [open, initialDraft]);

	const windowOptions = useMemo<SelectOption[]>(
		() =>
			windows.map((win) => ({
				id: win.id,
				label: win.title ? `${win.process} · ${win.title}` : win.process,
			})),
		[windows],
	);

	function handlePickWindow(id: string): void {
		setPickedId(id);
		const picked = windows.find((win) => win.id === id);
		if (picked) {
			setDraft((prev) => ({
				...prev,
				pattern: patternForWindow(picked, prev.matchKind),
			}));
		}
	}

	function handleKindChange(value: string): void {
		const matchKind = toMatchKind(value);
		setDraft((prev) => {
			const picked = windows.find((win) => win.id === pickedId);
			return {
				...prev,
				matchKind,
				pattern: picked ? patternForWindow(picked, matchKind) : prev.pattern,
			};
		});
	}

	function handlePatternChange(event: ChangeEvent<HTMLInputElement>): void {
		const { value } = event.target;
		setDraft((prev) => ({ ...prev, pattern: value }));
	}

	function handleSubmit(): void {
		if (!isDraftValid(draft)) {
			return;
		}
		onSubmit(draft);
		onOpenChange(false);
	}

	const pickCaption =
		windows.length === 0 && !loading ? t("noWindows") : t("finderToolCaption");

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent width={440}>
				<DialogHeader
					closeLabel={t("cancel")}
					icon={<HugeiconsIcon icon={Cursor02Icon} size={18} />}
					onClose={() => onOpenChange(false)}
					title={editing ? t("dialogEdit") : t("dialogAdd")}
				/>
				<div className="flex flex-col">
					<FormControl label={t("matchKind")}>
						<Select
							aria-label={t("matchKind")}
							onChange={handleKindChange}
							options={matchKindOptions}
							value={draft.matchKind}
						/>
					</FormControl>
					<FormControl
						caption={pickCaption}
						label={t("finderTool")}
						labelTrailing={
							<IconButton
								aria-label={t("refreshWindows")}
								icon={
									<HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={14} />
								}
								onClick={refresh}
							/>
						}
					>
						<SearchableSelect
							onChange={handlePickWindow}
							options={windowOptions}
							placeholder={t("pickWindowPlaceholder")}
							value={pickedId}
						/>
					</FormControl>
					<FormControl label={t("pattern")}>
						<TextField
							onChange={handlePatternChange}
							placeholder={t("patternPlaceholder")}
							value={draft.pattern}
						/>
					</FormControl>
					<FormControl label={t("mode")}>
						<Select
							aria-label={t("mode")}
							onChange={(mode) => setDraft((prev) => ({ ...prev, mode }))}
							options={modeOptions}
							value={draft.mode}
						/>
					</FormControl>
				</div>
				<DialogFooter>
					<DialogActionButton
						onClick={() => onOpenChange(false)}
						variant="neutral"
					>
						{t("cancel")}
					</DialogActionButton>
					<DialogActionButton
						disabled={!isDraftValid(draft)}
						onClick={handleSubmit}
						variant="accent"
					>
						{t("confirm")}
					</DialogActionButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
