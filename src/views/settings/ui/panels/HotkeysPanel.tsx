import { Delete02Icon, KeyboardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { commands, type HotkeyInfo } from "@/bindings";
import {
	patchSettingsSection,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import {
	buildHotkeyPatch,
	clearHotkeyPatch,
	collectOtherCombos,
	type HotkeyId,
	HOTKEY_ROW_ORDER,
	useHotkeyLabels,
} from "@/features/hotkey-actions";
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
import { hasNativeRuntime } from "@/shared/api";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";

function commitCombo(id: HotkeyId, combo: string): void {
	patchSettingsSection("hotkeys", buildHotkeyPatch(id, combo));
}

/** Options → Hotkeys: a capture row per binding (record → kbd chips → clear).
 *  This is the ONE place every global shortcut is bound — the display actions,
 *  the window toggle, Focus Read/Blur and the MagicX per-window effects — so the
 *  other tabs carry only their effect options.
 *
 *  The recorder validates + arms each combo through `hotkey_register`; the
 *  debounced save persists it and the backend re-applies the whole section, so
 *  every path converges on one live registration. */
export function HotkeysPanel() {
	const t = useTranslations("optionsTab");
	const tHotkeys = useTranslations("hotkeys");
	const hotkeys = useSettingsStore((s) => s.settings.hotkeys);
	const [runtimeById, setRuntimeById] = useState<
		Partial<Record<HotkeyId, HotkeyInfo>>
	>({});
	const [actionErrors, setActionErrors] = useState<
		Partial<Record<HotkeyId, string>>
	>({});

	const refreshRuntime = useCallback((): void => {
		if (!hasNativeRuntime()) {
			return;
		}
		void commands
			.hotkeyList()
			.then((rows) => {
				setRuntimeById(
					Object.fromEntries(rows.map((row) => [row.id, row])) as Partial<
						Record<HotkeyId, HotkeyInfo>
					>,
				);
			})
			.catch(() => undefined);
	}, []);

	const clearCombo = useCallback((id: HotkeyId): void => {
		const commitClear = () => {
			patchSettingsSection("hotkeys", clearHotkeyPatch(id));
			setRuntimeById((previous) => {
				const next = { ...previous };
				delete next[id];
				return next;
			});
			setActionErrors((previous) => {
				const next = { ...previous };
				delete next[id];
				return next;
			});
		};
		if (!hasNativeRuntime()) {
			commitClear();
			return;
		}
		void commands
			.hotkeyUnregister(id)
			.then((result) => {
				if (result.status === "error") {
					setActionErrors((previous) => ({
						...previous,
						[id]: result.error,
					}));
					return;
				}
				commitClear();
			})
			.catch((error: unknown) => {
				setActionErrors((previous) => ({
					...previous,
					[id]: error instanceof Error ? error.message : String(error),
				}));
			});
	}, []);

	useEffect(() => {
		refreshRuntime();
	}, [refreshRuntime]);

	// Shared full-roster label map — one wording per binding, reused by the
	// conflict errors the recorder raises.
	const labels = useHotkeyLabels();

	return (
		<SettingSection
			footer={t("hotkeysCaption")}
			icon={KeyboardIcon}
			title={tHotkeys("sectionTitle")}
		>
			{HOTKEY_ROW_ORDER.map((id) => {
				const current = hotkeys[id];
				const label = labels[id];
				const runtime = runtimeById[id];
				const caption = actionErrors[id]
					? tHotkeys("statusUnavailable", { reason: actionErrors[id] })
					: current.length === 0
						? tHotkeys("statusNotSet")
						: runtime?.active
							? tHotkeys("statusActive")
							: runtime?.error
								? tHotkeys("statusUnavailable", { reason: runtime.error })
								: tHotkeys("statusChecking");
				const forbidden: ForbiddenCombo[] = collectOtherCombos(hotkeys, id).map(
					(other) => ({ combo: other.combo, label: labels[other.id] }),
				);
				return (
					<FormControl
						caption={caption}
						key={id}
						label={label}
						labelAddon={
							<div className="flex items-center gap-1.5">
								<HotkeyRecorder
									currentKey={current}
									forbiddenCombos={forbidden}
									hotkeyId={id}
									label={label}
									onKeyRecorded={(combo) => {
										setActionErrors((previous) => {
											const next = { ...previous };
											delete next[id];
											return next;
										});
										commitCombo(id, combo);
										refreshRuntime();
									}}
								/>
								{current.length > 0 ? (
									<IconButton
										aria-label={tHotkeys("clearFor", { label })}
										icon={<HugeiconsIcon icon={Delete02Icon} size={15} />}
										onClick={() => {
											clearCombo(id);
										}}
										tooltip={tHotkeys("clearFor", { label })}
									/>
								) : (
									<span aria-hidden className="size-7 shrink-0" />
								)}
							</div>
						}
						layout="row"
					/>
				);
			})}
		</SettingSection>
	);
}
