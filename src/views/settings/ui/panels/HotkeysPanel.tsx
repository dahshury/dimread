import { Delete02Icon, KeyboardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
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

function clearCombo(id: HotkeyId): void {
	if (hasNativeRuntime()) {
		void commands.hotkeyUnregister(id).catch(() => undefined);
	}
	patchSettingsSection("hotkeys", clearHotkeyPatch(id));
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

	// Shared full-roster label map — one wording per binding, reused by the
	// conflict errors the recorder raises.
	const labels = useHotkeyLabels();

	return (
		<SettingSection
			divided
			footer={t("hotkeysCaption")}
			icon={KeyboardIcon}
			title={tHotkeys("sectionTitle")}
		>
			{HOTKEY_ROW_ORDER.map((id) => {
				const current = hotkeys[id];
				const forbidden: ForbiddenCombo[] = collectOtherCombos(hotkeys, id).map(
					(other) => ({ combo: other.combo, label: labels[other.id] }),
				);
				return (
					<FormControl
						key={id}
						label={labels[id]}
						labelAddon={
							<div className="flex items-center gap-1.5">
								<HotkeyRecorder
									currentKey={current}
									forbiddenCombos={forbidden}
									hotkeyId={id}
									onKeyRecorded={(combo) => commitCombo(id, combo)}
								/>
								{current.length > 0 ? (
									<IconButton
										aria-label={tHotkeys("clear")}
										icon={<HugeiconsIcon icon={Delete02Icon} size={15} />}
										onClick={() => clearCombo(id)}
										tooltip={tHotkeys("clear")}
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
