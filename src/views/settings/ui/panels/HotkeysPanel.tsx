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
	collectOtherCombos,
	DISPLAY_HOTKEY_ACTIONS,
	type DisplayHotkeyActionId,
	useHotkeyLabels,
} from "@/features/hotkey-actions";
import { type ForbiddenCombo, HotkeyRecorder } from "@/features/record-hotkey";
import { hasNativeRuntime } from "@/shared/api";
import { FormControl } from "@/shared/ui/form-control";
import { IconButton } from "@/shared/ui/icon-button";

/** Every capturable hotkey row: the seven display actions + the built-in
 *  window toggle. Each id is a `settings.hotkeys` field and a backend
 *  registration id. */
type HotkeyRowId = DisplayHotkeyActionId | "toggleMain";
const HOTKEY_ROWS: readonly HotkeyRowId[] = [
	...DISPLAY_HOTKEY_ACTIONS,
	"toggleMain",
];

function commitCombo(id: HotkeyRowId, combo: string): void {
	// The seven display actions route through the hotkey-actions patch builder;
	// the built-in window toggle keeps its own field.
	const patch =
		id === "toggleMain"
			? { toggleMain: combo.trim() }
			: buildHotkeyPatch(id, combo);
	patchSettingsSection("hotkeys", patch);
}

function clearCombo(id: HotkeyRowId): void {
	if (hasNativeRuntime()) {
		void commands.hotkeyUnregister(id).catch(() => undefined);
	}
	patchSettingsSection("hotkeys", { [id]: "" });
}

/** Options → Hotkeys: a capture row per action (record → kbd chips → clear).
 *  The recorder validates + arms each combo through `hotkey_register`; the
 *  debounced save persists it and the backend re-applies the whole section, so
 *  every path converges on one live registration. */
export function HotkeysPanel() {
	const t = useTranslations("optionsTab");
	const tHotkeys = useTranslations("hotkeys");
	const hotkeys = useSettingsStore((s) => s.settings.hotkeys);

	// Shared full-roster label map, so conflicts against bindings owned by
	// OTHER tabs (Focus Read/Blur, MagicX) are named too.
	const labels = useHotkeyLabels();

	return (
		<SettingSection
			divided
			footer={t("hotkeysCaption")}
			icon={KeyboardIcon}
			title={tHotkeys("sectionTitle")}
		>
			{HOTKEY_ROWS.map((id) => {
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
