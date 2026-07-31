import {
	Delete02Icon,
	PencilEdit02Icon,
	PlusSignIcon,
	FullScreenIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import type { Rule } from "@/bindings";
import {
	flushPendingSettings,
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import {
	addRule,
	RuleDialog,
	type RuleDraft,
	removeRule,
	ruleToDraft,
	updateRule,
	useRuleLabels,
} from "@/features/rules";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { EntryCardShell } from "@/shared/ui/entry-card-list";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Toggle } from "@/shared/ui/toggle";

const ADD_BUTTON =
	"h-8 gap-1.5 rounded-md border border-accent bg-accent px-3 font-medium text-body text-on-accent transition-colors hover:bg-accent-dim";

/** One rule row: match-kind badge + pattern, inline mode select, edit + delete. */
function RuleRow({
	matchKindLabel,
	modeOptions,
	onDelete,
	onEdit,
	onModeChange,
	rule,
}: {
	matchKindLabel: (value: string) => string;
	modeOptions: SelectOption[];
	onDelete: () => void;
	onEdit: () => void;
	onModeChange: (mode: string) => void;
	rule: Rule;
}) {
	const t = useTranslations("rulesTab");
	return (
		<li className="flex items-center gap-2.5 px-3 py-2.5">
			<Badge className="shrink-0" variant="secondary">
				{matchKindLabel(rule.matchKind)}
			</Badge>
			<span className="min-w-0 flex-1 truncate text-body text-foreground">
				{rule.pattern}
			</span>
			<Select
				aria-label={t("modeFor", { pattern: rule.pattern })}
				className="w-32 shrink-0"
				onChange={onModeChange}
				options={modeOptions}
				value={rule.mode}
			/>
			<IconButton
				aria-label={t("editRule", { pattern: rule.pattern })}
				icon={<HugeiconsIcon icon={PencilEdit02Icon} size={15} />}
				onClick={onEdit}
			/>
			<IconButton
				aria-label={t("removeRule", { pattern: rule.pattern })}
				icon={<HugeiconsIcon icon={Delete02Icon} size={15} />}
				onClick={onDelete}
			/>
		</li>
	);
}

/**
 * Settings → App rules: everything that re-aims the filter at the FOREGROUND
 * WINDOW, built-in behaviour first and the user's own list second.
 *
 * The built-in entry is "disable for full-screen apps" (F1.11). It used to sit
 * with the engine toggles on the Display tab, which hid what it actually is:
 * `display::engine` documents it as driven by the same rules watcher that runs
 * this tab's list, so it is this feature's zeroth rule, not a display option.
 *
 * The custom list is FEATURE-PARITY F4 — an enable switch plus one row per rule.
 * Both halves persist through the shared, revision-checked settings saver
 * (`entities/setting`), writing the `display` and `rules` sections respectively.
 */
export function RulesPanel() {
	const t = useTranslations("rulesTab");
	const tOptions = useTranslations("optionsTab");
	const rules = useSettingsStore((state) => state.settings.rules);
	const disableOnFullscreen = useSettingsStore(
		(state) => state.settings.display.disableOnFullscreen,
	);
	const { matchKindLabel, modeOptions } = useRuleLabels();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<Rule | null>(null);

	// Persist any debounced edit if the panel unmounts before it fires.
	useEffect(() => () => void flushPendingSettings(), []);

	function openAdd(): void {
		setEditingRule(null);
		setDialogOpen(true);
	}

	function openEdit(rule: Rule): void {
		setEditingRule(rule);
		setDialogOpen(true);
	}

	function handleSubmit(draft: RuleDraft): void {
		if (editingRule) {
			patchSettingsSection("rules", {
				items: updateRule(rules.items, editingRule.id, draft),
			});
		} else {
			patchSettingsSection("rules", { items: addRule(rules.items, draft) });
		}
	}

	const initialDraft: RuleDraft | undefined = editingRule
		? ruleToDraft(editingRule)
		: undefined;

	return (
		<div className="flex flex-col">
			<SettingSection
				description={t("builtInCaption")}
				icon={FullScreenIcon}
				title={t("builtIn")}
			>
				<FormControl
					caption={tOptions("fullscreenDetectionCaption")}
					label={tOptions("fullscreenDetection")}
					labelAddon={
						<Toggle
							aria-label={tOptions("fullscreenDetection")}
							checked={disableOnFullscreen}
							onCheckedChange={(next) =>
								patchSettingsSection("display", { disableOnFullscreen: next })
							}
						/>
					}
					layout="row"
				/>
			</SettingSection>

			<SettingSection
				description={t("subtitle")}
				headerAction={
					<Button className={ADD_BUTTON} onClick={openAdd}>
						<HugeiconsIcon icon={PlusSignIcon} size={14} />
						{t("add")}
					</Button>
				}
				title={t("title")}
			>
				<FormControl
					label={t("enable")}
					labelAddon={
						<Toggle
							aria-label={t("enable")}
							checked={rules.enabled}
							onCheckedChange={(enabled) =>
								patchSettingsSection("rules", { enabled })
							}
						/>
					}
					layout="row"
				/>

				{rules.items.length === 0 ? (
					<p className="px-4 py-6 text-center text-body-sm text-foreground-muted">
						{t("empty")}
					</p>
				) : (
					<EntryCardShell bare>
						<ul className="divide-y divide-border">
							{rules.items.map((rule) => (
								<RuleRow
									key={rule.id}
									matchKindLabel={matchKindLabel}
									modeOptions={modeOptions}
									onDelete={() =>
										patchSettingsSection("rules", {
											items: removeRule(rules.items, rule.id),
										})
									}
									onEdit={() => openEdit(rule)}
									onModeChange={(mode) =>
										patchSettingsSection("rules", {
											items: updateRule(rules.items, rule.id, { mode }),
										})
									}
									rule={rule}
								/>
							))}
						</ul>
					</EntryCardShell>
				)}
			</SettingSection>

			<RuleDialog
				editing={editingRule !== null}
				initialDraft={initialDraft}
				onOpenChange={setDialogOpen}
				onSubmit={handleSubmit}
				open={dialogOpen}
			/>
		</div>
	);
}
