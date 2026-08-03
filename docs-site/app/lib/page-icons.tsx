import type { ReactNode } from "react";
import {
	IconAbout,
	IconDiagnostics,
	IconDisplay,
	IconEffects,
	IconFaq,
	IconGeneral,
	IconHotkeys,
	IconRules,
	IconSchedule,
	IconStart,
	IconTray,
	IconTrouble,
} from "@/components/icons";

/**
 * Frontmatter `icon:` → the glyph the sidebar and the docs index draw.
 *
 * Fumadocs resolves this at page-tree build time and `serializePageTree`
 * renders the result to an HTML string, so these must be plain SVG with no
 * hooks, state or context — which the hand-drawn set in `components/icons`
 * already is.
 */
const ICONS = {
	about: IconAbout,
	diagnostics: IconDiagnostics,
	display: IconDisplay,
	effects: IconEffects,
	faq: IconFaq,
	general: IconGeneral,
	hotkeys: IconHotkeys,
	rules: IconRules,
	schedule: IconSchedule,
	start: IconStart,
	tray: IconTray,
	trouble: IconTrouble,
} as const;

export type PageIconName = keyof typeof ICONS;

export function isPageIconName(name: string): name is PageIconName {
	return name in ICONS;
}

/** Render by name, at the 1em size every call site sets from its own type. */
export function PageIcon({
	name,
	className,
}: {
	name: PageIconName;
	className?: string;
}) {
	const Glyph = ICONS[name];
	return <Glyph className={className} />;
}

/** The resolver handed to `loader({ icon })`. */
export function resolvePageIcon(name: string | undefined): ReactNode {
	if (!(name && isPageIconName(name))) {
		return;
	}
	return <PageIcon className="size-4 shrink-0" name={name} />;
}
