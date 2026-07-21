import { CenterFocusIcon, MagicWand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/entities/setting";
import {
	patchFocusBlurSettings,
	useFocusBlurActive,
} from "@/features/focus-blur";
import { patchMagicxSettings } from "@/features/magicx";
import { hasNativeRuntime } from "@/shared/api";
import { Toggle } from "@/shared/ui/toggle";

function QuickToggleRow({
	checked,
	icon,
	label,
	onCheckedChange,
}: {
	checked: boolean;
	icon: IconSvgElement;
	label: string;
	onCheckedChange: (next: boolean) => void;
}): ReactNode {
	return (
		<div className="flex items-center gap-2.5 px-3 py-2.5">
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0 text-foreground-muted"
				icon={icon}
				size={17}
			/>
			<span className="min-w-0 flex-1 truncate font-medium text-body-sm text-foreground-secondary">
				{label}
			</span>
			<Toggle
				aria-label={label}
				checked={checked}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}

/**
 * The main window's feature switches — the two effects a user flips often
 * enough that reaching for the settings window would be friction.
 *
 * Only the top-level on/off lives here on purpose: every knob behind these
 * effects (transparency, colour, height, hotkeys, the toolbar, auto-dark
 * scheduling) is a settings-window concern. Focus Blur mirrors the settings
 * panel's wiring — persist the preference for the boot auto-start AND drive the
 * running effect, since `focus_blur_toggle` flips rather than sets.
 */
export function QuickToggles() {
	const tFocus = useTranslations("focusTab");
	const tMagic = useTranslations("magicxTab");
	const magicxEnabled = useSettingsStore((s) => s.settings.magicx.enabled);
	const blurActive = useFocusBlurActive();

	const handleBlur = (next: boolean) => {
		void patchFocusBlurSettings({ enabled: next });
		if (hasNativeRuntime() && next !== blurActive) {
			void commands.focusBlurToggle().catch(() => undefined);
		}
	};

	return (
		<div className="flex flex-col divide-y divide-divider rounded-xl border border-divider bg-surface-2">
			<QuickToggleRow
				checked={blurActive}
				icon={CenterFocusIcon}
				label={tFocus("subBlur")}
				onCheckedChange={handleBlur}
			/>
			<QuickToggleRow
				checked={magicxEnabled}
				icon={MagicWand01Icon}
				label={tMagic("subMagicWindow")}
				onCheckedChange={(enabled) => void patchMagicxSettings({ enabled })}
			/>
		</div>
	);
}
