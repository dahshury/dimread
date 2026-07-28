import { z } from "zod";

/**
 * App settings schema — the single source of truth for the renderer's view of
 * persisted settings. Sections are FLAT (no nesting beyond the section) and
 * every field carries a default, so `appSettingsSchema.parse({})` yields the
 * canonical default tree and any partially-corrupt persisted payload heals
 * per-field instead of failing wholesale.
 *
 * Keep in lockstep with the Rust serde schema (`src-tauri/src/settings/mod.rs`)
 * and the `Settings` type in `src/bindings.ts`.
 */

export const appearanceSettingsSchema = z.object({
	/** UI locale (must be a member of shared/i18n LOCALES). */
	locale: z.string().catch("en").default("en"),
	/** Force-reduce motion regardless of the OS-level preference. */
	reducedMotion: z.boolean().catch(false).default(false),
});

export const generalSettingsSchema = z.object({
	/** Launch the app when the user logs in. */
	autostart: z.boolean().catch(false).default(false),
	/** Keep running in the tray when the app window closes. */
	minimizeToTray: z.boolean().catch(true).default(true),
});

export const downloadsSettingsSchema = z.object({
	/** Parallel download workers (1..4). */
	concurrency: z.number().int().min(1).max(4).catch(2).default(2),
});

/** A single global accelerator field (Tauri token format, "" = unbound). */
const accelerator = z
	.string()
	.transform((value) => value.trim())
	.catch("")
	.default("");

export const hotkeysSettingsSchema = z.object({
	/**
	 * Global accelerator (Tauri token format, e.g. "Ctrl+Shift+Space") that
	 * toggles the APP window's visibility. "" = unbound. Stored trimmed (the
	 * Rust side normalizes too). The key predates the removal of the separate
	 * `main` window and is kept so persisted bindings survive.
	 */
	toggleMain: accelerator,
	/** Raise brightness one step. Effect wired by the hotkeys-actions agent. */
	brightnessUp: accelerator,
	/** Lower brightness one step. */
	brightnessDown: accelerator,
	/** Warmer/cooler colour temperature one step (~55 K). */
	tempUp: accelerator,
	/** The opposite colour-temperature step. */
	tempDown: accelerator,
	/** Toggle the blue-light filter on/off. */
	toggleFilter: accelerator,
	/** Toggle Reading mode (full-screen grayscale). */
	toggleReading: accelerator,
	/** Toggle Editing mode (colour invert). */
	toggleEditing: accelerator,
	/** Toggle Focus Read (moving clear band). Effect wired by the focus-read slice. */
	focusRead: accelerator,
	/** Toggle Focus Blur (dim background windows). */
	focusBlur: accelerator,
	/** Toggle Magic Window dark (per-window colour invert) on the current target. */
	magicDark: accelerator,
	/** Toggle Magic Window grayscale on the current target. */
	magicGray: accelerator,
});

/**
 * One mode's colour-temperature + brightness endpoints. Day/night values are
 * interpolated by the display scheduler; `brightness*` are percentages
 * (0..=100), `kelvin*` absolute Kelvin. Mirrors Rust `ModePreset`.
 */
export const modePresetSchema = z.object({
	kelvinDay: z.number().int().catch(5500).default(5500),
	kelvinNight: z.number().int().catch(5500).default(5500),
	brightnessDay: z.number().int().catch(90).default(90),
	brightnessNight: z.number().int().catch(90).default(90),
});

/** A per-monitor override — same shape as a mode preset (Rust `MonitorOverride`). */
export const monitorOverrideSchema = z.object({
	kelvinDay: z.number().int().catch(5500).default(5500),
	kelvinNight: z.number().int().catch(5500).default(5500),
	brightnessDay: z.number().int().catch(90).default(90),
	brightnessNight: z.number().int().catch(90).default(90),
});

/** The eight CareUEyes preset modes, seeded from FEATURE-PARITY F1.3 (must
 *  stay byte-identical to `default_modes()` in the Rust settings schema). */
export const DEFAULT_MODES: Record<
	string,
	z.output<typeof modePresetSchema>
> = {
	pause: {
		kelvinDay: 6500,
		kelvinNight: 6500,
		brightnessDay: 100,
		brightnessNight: 100,
	},
	health: {
		kelvinDay: 5000,
		kelvinNight: 3700,
		brightnessDay: 90,
		brightnessNight: 80,
	},
	game: {
		kelvinDay: 6500,
		kelvinNight: 6000,
		brightnessDay: 90,
		brightnessNight: 90,
	},
	movie: {
		kelvinDay: 6000,
		kelvinNight: 5500,
		brightnessDay: 90,
		brightnessNight: 90,
	},
	office: {
		kelvinDay: 5500,
		kelvinNight: 5000,
		brightnessDay: 85,
		brightnessNight: 80,
	},
	editing: {
		kelvinDay: 6500,
		kelvinNight: 6500,
		brightnessDay: 85,
		brightnessNight: 85,
	},
	reading: {
		kelvinDay: 5500,
		kelvinNight: 5500,
		brightnessDay: 85,
		brightnessNight: 85,
	},
	custom: {
		kelvinDay: 5500,
		kelvinNight: 5500,
		brightnessDay: 90,
		brightnessNight: 90,
	},
};

/** Display mode ids the UI switches between. */
export const DISPLAY_MODE_IDS = [
	"pause",
	"health",
	"game",
	"movie",
	"office",
	"editing",
	"reading",
	"custom",
] as const;

export const displaySettingsSchema = z.object({
	/** Active mode id. */
	mode: z.string().catch("pause").default("pause"),
	/** Widen the temperature range to 0..=10000 K (default 1000..=6500 K). */
	wideRange: z.boolean().catch(false).default(false),
	/** Extend the brightness range down to 0 % (default floor 10 %), letting the
	 *  screen dim to fully black (FEATURE-PARITY F2.2). */
	brightnessWideRange: z.boolean().catch(false).default(false),
	/** Suspend filtering while a full-screen app (e.g. a game) is foreground
	 *  (FEATURE-PARITY F1.11). On by default. */
	disableOnFullscreen: z.boolean().catch(true).default(true),
	/** Animate colour/brightness changes over ~400 ms. */
	smoothTransition: z.boolean().catch(true).default(true),
	/** Apply one value to every monitor; when off, use `monitorOverrides`. */
	syncMonitors: z.boolean().catch(true).default(true),
	/** Per-monitor overrides keyed by the native backend's durable display id. */
	monitorOverrides: z
		.record(z.string(), monitorOverrideSchema)
		.catch({})
		.default({}),
	/** Monitor ids that opt OUT of filtering entirely. Independent of
	 *  `syncMonitors` — that picks which VALUES a display gets, this picks
	 *  whether it participates at all, so one screen can stay untouched without
	 *  leaving sync mode. */
	excludedMonitors: z.array(z.string()).catch([]).default([]),
	/** The eight editable preset modes keyed by mode id. */
	modes: z
		.record(z.string(), modePresetSchema)
		.catch(() => ({ ...DEFAULT_MODES }))
		.default(() => ({ ...DEFAULT_MODES })),
});

/**
 * The three ways `dayNight` can arrive at a latitude/longitude, in the order the
 * panel presents them. Mirrors `LOCATION_SOURCE_IDS` in
 * `src-tauri/src/settings/mod.rs`.
 */
export const LOCATION_SOURCE_IDS = ["auto", "timezone", "manual"] as const;

export type LocationSourceId = (typeof LOCATION_SOURCE_IDS)[number];

/** Narrow a persisted `locationSource` string, defaulting anything unrecognised
 *  to detection — the source that needs no stored input, and therefore the only
 *  safe fallback. */
export function asLocationSource(value: string): LocationSourceId {
	return (LOCATION_SOURCE_IDS as readonly string[]).includes(value)
		? (value as LocationSourceId)
		: "auto";
}

export const dayNightSettingsSchema = z.object({
	enabled: z.boolean().catch(true).default(true),
	/** Compute sun times from a location instead of manual strings. WHICH
	 *  location is `locationSource`'s job. */
	useLocation: z.boolean().catch(false).default(false),
	/**
	 * Where the coordinates come from — one of {@link LOCATION_SOURCE_IDS}.
	 * Typed as a plain string (not a Zod enum) so this section stays structurally
	 * interchangeable with the tauri-specta `DayNightSettings`, which types every
	 * roster field as `string`; narrow with {@link asLocationSource} at the point
	 * of use. The backend normalizes an unrecognised value back to `"auto"`, so
	 * it can never come to mean "use 0°, 0°".
	 */
	locationSource: z.string().catch("auto").default("auto"),
	/** IANA zone id for `locationSource: "timezone"`; empty falls back to auto. */
	timezone: z.string().catch("").default(""),
	latitude: z.number().catch(0).default(0),
	longitude: z.number().catch(0).default(0),
	/** Manual sunrise time, "HH:MM" (used when `useLocation` is off). */
	sunrise: z.string().catch("07:00").default("07:00"),
	/** Manual sunset time, "HH:MM". */
	sunset: z.string().catch("19:00").default("19:00"),
	/** Width of the day↔night ramp window, in minutes. */
	transitionMinutes: z.number().int().catch(60).default(60),
});

/** One custom per-app rule: switch to `mode` while a matching window is active. */
export const ruleSchema = z.object({
	id: z.string().catch("").default(""),
	/** `process` | `class` | `title`. */
	matchKind: z.string().catch("process").default("process"),
	pattern: z.string().catch("").default(""),
	/** Mode id to apply while the rule matches. */
	mode: z.string().catch("pause").default("pause"),
});

export const rulesSettingsSchema = z.object({
	enabled: z.boolean().catch(false).default(false),
	items: z.array(ruleSchema).catch([]).default([]),
});

/** Focus Read section (FEATURE-PARITY F8.1) — a moving clear band; the rest of
 *  the screen is dimmed. Mirrors Rust `FocusReadSettings`. */
export const focusReadSettingsSchema = z.object({
	/** Shade opacity as a percentage (0..=100). */
	transparency: z.number().int().min(0).max(100).catch(50).default(50),
	/** Shade colour, `#rrggbb`. */
	color: z.string().catch("#000000").default("#000000"),
	/** Height (px) of the transparent band that follows the cursor. */
	height: z.number().int().catch(300).default(300),
});

/** Focus Blur section (FEATURE-PARITY F8.2) — dim every background window while
 *  the active window stays highlighted. Mirrors Rust `FocusBlurSettings`. */
export const focusBlurSettingsSchema = z.object({
	enabled: z.boolean().catch(false).default(false),
	/** Include the taskbar in the dimmed area. */
	includeTaskbar: z.boolean().catch(false).default(false),
	/** Only dim the monitor the active window is on. */
	onlyCurrentMonitor: z.boolean().catch(false).default(false),
	/** Animate the shade following the active window. */
	animate: z.boolean().catch(true).default(true),
	/** Shade opacity as a percentage (0..=100). */
	transparency: z.number().int().min(0).max(100).catch(50).default(50),
	/** Shade colour, `#rrggbb`. */
	color: z.string().catch("#000000").default("#000000"),
});

/** MagicX section (FEATURE-PARITY F9) — per-window dark/grayscale + hover Magic
 *  Toolbar. Disabled by default. Mirrors Rust `MagicxSettings`. */
export const magicxSettingsSchema = z.object({
	/** Master switch for the whole MagicX feature (default off). */
	enabled: z.boolean().catch(false).default(false),
	/** Show the hover Magic Toolbar (Dark / Gray / Close). */
	toolbarEnabled: z.boolean().catch(true).default(true),
	/** Toolbar accent colour, `#rrggbb`. */
	toolbarColor: z.string().catch("#14b8a6").default("#14b8a6"),
	/** Toolbar alignment on the target window: `center` | `left` | `right`. */
	toolbarAlign: z
		.enum(["center", "left", "right"])
		.catch("center")
		.default("center"),
	/** Horizontal offset (px) applied to the aligned toolbar. */
	toolbarOffset: z.number().int().catch(0).default(0),
	/** Hover delay (ms) before the toolbar appears. */
	toolbarDelayMs: z.number().int().catch(400).default(400),
});

/** A single Auto Dark theme schedule value. */
const autoDarkTarget = z
	.enum(["light", "dark", "auto", "disable"])
	.catch("disable")
	.default("disable");

/** Auto Dark section (FEATURE-PARITY F9.5-F9.6) — schedule the Windows system
 *  theme and the taskbar transparency effect. Mirrors Rust `AutoDarkSettings`.
 *
 *  There is deliberately no app-theme field: DimRead's own UI is permanently
 *  dark, and the removed `appTheme` wrote `AppsUseLightTheme`, which re-themed
 *  every OTHER Windows app rather than this one. */
export const autoDarkSettingsSchema = z.object({
	/** Windows system-theme schedule: `light` | `dark` | `auto` | `disable`. */
	systemTheme: autoDarkTarget,
	/** Take the `auto` schedule's boundaries from the `dayNight` section — the same
	 *  sun times the colour filter runs on — instead of the pair below. On by
	 *  default; the manual pair is the opt-out. */
	useDayNightSchedule: z.boolean().catch(true).default(true),
	/** Sunrise for the SYSTEM theme's `auto` schedule, "HH:MM". Used only when
	 *  `useDayNightSchedule` is off. */
	systemSunrise: z.string().catch("07:00").default("07:00"),
	/** Sunset for the SYSTEM theme's `auto` schedule, "HH:MM". */
	systemSunset: z.string().catch("19:00").default("19:00"),
	/** Apply the transparent-taskbar effect. */
	taskbarTransparent: z.boolean().catch(false).default(false),
});

export const appSettingsSchema = z.object({
	appearance: appearanceSettingsSchema
		.catch(() => appearanceSettingsSchema.parse({}))
		.default(() => appearanceSettingsSchema.parse({})),
	general: generalSettingsSchema
		.catch(() => generalSettingsSchema.parse({}))
		.default(() => generalSettingsSchema.parse({})),
	downloads: downloadsSettingsSchema
		.catch(() => downloadsSettingsSchema.parse({}))
		.default(() => downloadsSettingsSchema.parse({})),
	hotkeys: hotkeysSettingsSchema
		.catch(() => hotkeysSettingsSchema.parse({}))
		.default(() => hotkeysSettingsSchema.parse({})),
	display: displaySettingsSchema
		.catch(() => displaySettingsSchema.parse({}))
		.default(() => displaySettingsSchema.parse({})),
	dayNight: dayNightSettingsSchema
		.catch(() => dayNightSettingsSchema.parse({}))
		.default(() => dayNightSettingsSchema.parse({})),
	rules: rulesSettingsSchema
		.catch(() => rulesSettingsSchema.parse({}))
		.default(() => rulesSettingsSchema.parse({})),
	focusRead: focusReadSettingsSchema
		.catch(() => focusReadSettingsSchema.parse({}))
		.default(() => focusReadSettingsSchema.parse({})),
	focusBlur: focusBlurSettingsSchema
		.catch(() => focusBlurSettingsSchema.parse({}))
		.default(() => focusBlurSettingsSchema.parse({})),
	magicx: magicxSettingsSchema
		.catch(() => magicxSettingsSchema.parse({}))
		.default(() => magicxSettingsSchema.parse({})),
	autoDark: autoDarkSettingsSchema
		.catch(() => autoDarkSettingsSchema.parse({}))
		.default(() => autoDarkSettingsSchema.parse({})),
});

export type AppSettingsInput = z.input<typeof appSettingsSchema>;
export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
