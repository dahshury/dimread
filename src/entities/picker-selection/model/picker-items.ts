import {
	ApiIcon,
	BrushIcon,
	Calendar03Icon,
	ChartHistogramIcon,
	Clock01Icon,
	CodeIcon,
	ColorsIcon,
	Comment01Icon,
	Database01Icon,
	FlashIcon,
	GitBranchIcon,
	GlobeIcon,
	KeyboardIcon,
	Link01Icon,
	MagicWand01Icon,
	Mail01Icon,
	Moon01Icon,
	MusicNote01Icon,
	Notification01Icon,
	PaintBrush03Icon,
	PuzzleIcon,
	Rocket01Icon,
	Shield01Icon,
	Sun01Icon,
	Task01Icon,
	TerminalIcon,
	TestTube01Icon,
	Timer01Icon,
	TranslateIcon,
	Wifi01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * The demo dataset behind the detached picker: a neutral "plugin catalog"
 * standing in for whatever an app would actually pick (models, devices,
 * fonts, …). Names are product-style proper nouns (not translated); group
 * labels are localized at the render site via the `picker.group*` keys.
 */
export type PickerGroupId =
	| "productivity"
	| "development"
	| "appearance"
	| "integrations";

export interface PickerItem {
	/** Short trailing badge — the demo uses a version tag. */
	badge: string;
	group: PickerGroupId;
	icon: IconSvgElement;
	id: string;
	name: string;
}

export const PICKER_GROUP_ORDER: readonly PickerGroupId[] = [
	"productivity",
	"development",
	"appearance",
	"integrations",
];

export const PICKER_ITEMS: readonly PickerItem[] = [
	// Productivity
	{
		id: "task-forge",
		name: "Task Forge",
		badge: "v2.4",
		group: "productivity",
		icon: Task01Icon,
	},
	{
		id: "time-lens",
		name: "Time Lens",
		badge: "v1.1",
		group: "productivity",
		icon: Clock01Icon,
	},
	{
		id: "focus-timer",
		name: "Focus Timer",
		badge: "v3.0",
		group: "productivity",
		icon: Timer01Icon,
	},
	{
		id: "quick-notes",
		name: "Quick Notes",
		badge: "v0.9",
		group: "productivity",
		icon: Comment01Icon,
	},
	{
		id: "agenda-sync",
		name: "Agenda Sync",
		badge: "v1.6",
		group: "productivity",
		icon: Calendar03Icon,
	},
	{
		id: "inbox-zero",
		name: "Inbox Zero",
		badge: "v2.0",
		group: "productivity",
		icon: Mail01Icon,
	},
	{
		id: "stat-board",
		name: "Stat Board",
		badge: "v1.3",
		group: "productivity",
		icon: ChartHistogramIcon,
	},
	{
		id: "reminder-bell",
		name: "Reminder Bell",
		badge: "v1.0",
		group: "productivity",
		icon: Notification01Icon,
	},
	// Development
	{
		id: "code-prism",
		name: "Code Prism",
		badge: "v4.2",
		group: "development",
		icon: CodeIcon,
	},
	{
		id: "term-runner",
		name: "Term Runner",
		badge: "v2.8",
		group: "development",
		icon: TerminalIcon,
	},
	{
		id: "branch-pilot",
		name: "Branch Pilot",
		badge: "v1.9",
		group: "development",
		icon: GitBranchIcon,
	},
	{
		id: "query-bench",
		name: "Query Bench",
		badge: "v3.1",
		group: "development",
		icon: Database01Icon,
	},
	{
		id: "api-scout",
		name: "API Scout",
		badge: "v0.7",
		group: "development",
		icon: ApiIcon,
	},
	{
		id: "test-harbor",
		name: "Test Harbor",
		badge: "v2.2",
		group: "development",
		icon: TestTube01Icon,
	},
	{
		id: "macro-keys",
		name: "Macro Keys",
		badge: "v1.4",
		group: "development",
		icon: KeyboardIcon,
	},
	{
		id: "flash-deploy",
		name: "Flash Deploy",
		badge: "v5.0",
		group: "development",
		icon: FlashIcon,
	},
	{
		id: "launch-pad",
		name: "Launch Pad",
		badge: "v1.2",
		group: "development",
		icon: Rocket01Icon,
	},
	// Appearance
	{
		id: "theme-weaver",
		name: "Theme Weaver",
		badge: "v2.1",
		group: "appearance",
		icon: BrushIcon,
	},
	{
		id: "palette-lab",
		name: "Palette Lab",
		badge: "v1.5",
		group: "appearance",
		icon: ColorsIcon,
	},
	{
		id: "daylight",
		name: "Daylight",
		badge: "v1.0",
		group: "appearance",
		icon: Sun01Icon,
	},
	{
		id: "midnight",
		name: "Midnight",
		badge: "v1.0",
		group: "appearance",
		icon: Moon01Icon,
	},
	{
		id: "sketch-kit",
		name: "Sketch Kit",
		badge: "v0.8",
		group: "appearance",
		icon: PaintBrush03Icon,
	},
	{
		id: "motion-magic",
		name: "Motion Magic",
		badge: "v2.6",
		group: "appearance",
		icon: MagicWand01Icon,
	},
	// Integrations
	{
		id: "web-bridge",
		name: "Web Bridge",
		badge: "v3.3",
		group: "integrations",
		icon: GlobeIcon,
	},
	{
		id: "link-vault",
		name: "Link Vault",
		badge: "v1.7",
		group: "integrations",
		icon: Link01Icon,
	},
	{
		id: "guard-rail",
		name: "Guard Rail",
		badge: "v2.5",
		group: "integrations",
		icon: Shield01Icon,
	},
	{
		id: "air-relay",
		name: "Air Relay",
		badge: "v1.1",
		group: "integrations",
		icon: Wifi01Icon,
	},
	{
		id: "poly-glot",
		name: "Polyglot",
		badge: "v4.0",
		group: "integrations",
		icon: TranslateIcon,
	},
	{
		id: "sound-stage",
		name: "Sound Stage",
		badge: "v1.8",
		group: "integrations",
		icon: MusicNote01Icon,
	},
	{
		id: "puzzle-dock",
		name: "Puzzle Dock",
		badge: "v0.6",
		group: "integrations",
		icon: PuzzleIcon,
	},
];

export const DEFAULT_PICKER_ITEM_ID: string =
	PICKER_ITEMS[0]?.id ?? "task-forge";

export function getPickerItem(id: string): PickerItem | undefined {
	return PICKER_ITEMS.find((item) => item.id === id);
}
