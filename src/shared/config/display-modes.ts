import {
	BookOpen01Icon,
	Briefcase01Icon,
	FavouriteIcon,
	FilmRoll01Icon,
	GameController03Icon,
	PauseIcon,
	PencilEdit02Icon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";

/**
 * Presentation metadata for the eight display modes (parity F1.3). The `id`s
 * and their order mirror `DISPLAY_MODE_IDS` in the settings schema; `nameKey`
 * and `descKey` point at the `displayTab` i18n block the foundation seeded.
 *
 * Lives in `shared/` because TWO surfaces render the mode roster and they sit
 * in different FSD slices: the quick controls in Settings → Display
 * (`widgets/quick-controls`) and the tray flyout (`views/tray-menu`). Keeping
 * one table means a new mode shows up in both without a second edit.
 *
 * The ORDER is load-bearing beyond layout: it mirrors `DISPLAY_MODE_IDS` in
 * `src-tauri/src/settings/mod.rs`, which the tray's per-mode icon family is
 * asserted against.
 *
 * Declared `as const` so the message-key literals survive for use-intl's strict
 * key typing (a widened `string` would be rejected by `t(...)`).
 */
export const DISPLAY_MODES = [
	{
		id: "pause",
		icon: PauseIcon,
		nameKey: "modePauseName",
		descKey: "modePauseDesc",
	},
	{
		id: "health",
		icon: FavouriteIcon,
		nameKey: "modeHealthName",
		descKey: "modeHealthDesc",
	},
	{
		id: "game",
		icon: GameController03Icon,
		nameKey: "modeGameName",
		descKey: "modeGameDesc",
	},
	{
		id: "movie",
		icon: FilmRoll01Icon,
		nameKey: "modeMovieName",
		descKey: "modeMovieDesc",
	},
	{
		id: "office",
		icon: Briefcase01Icon,
		nameKey: "modeOfficeName",
		descKey: "modeOfficeDesc",
	},
	{
		id: "editing",
		icon: PencilEdit02Icon,
		nameKey: "modeEditingName",
		descKey: "modeEditingDesc",
	},
	{
		id: "reading",
		icon: BookOpen01Icon,
		nameKey: "modeReadingName",
		descKey: "modeReadingDesc",
	},
	{
		id: "custom",
		icon: SlidersHorizontalIcon,
		nameKey: "modeCustomName",
		descKey: "modeCustomDesc",
	},
] as const;
