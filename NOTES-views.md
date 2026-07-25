# Demo views — build notes

Built on top of the completed frontend foundation + Rust shell (see
`NOTES-frontend.md`, `NOTES-rust.md`). Design language and patterns ported
from WinSTT (`E:\DL\Projects\WinSTT`). Delete once absorbed.

## What was built, per window

### ~~Main window~~ — REMOVED

> **Superseded.** There is no `main` window any more. DimRead is a tray app with
> ONE top-level window: the settings window (`windows::PRIMARY_WINDOW`, served
> from the ROOT `index.html`). The live controls this section describes now live
> in `src/widgets/quick-controls/` and render at the top of Settings → Display —
> the same components, just re-parented. A tray LEFT click, the `toggleMain`
> hotkey and the flyout's Settings row all surface that one window. The
> `widgets/status-bar/` and `widgets/title-bar/` slices below went with it.
>
> Everything from here to the picker section is kept only as a record of what
> the removed window contained.

- `views/main/ui/MainPage.tsx` — 480×180 frameless layout: a hero area
  (whole area is a `titlebar-drag` region) with the "DimRead" wordmark
  and a `GlassPill` carrying a `PulseDot` + `AnimatedValueText`. The pill
  shows a ticking session clock (`useSessionClock`, 1 Hz) and switches to
  the download aggregate percent while anything is streaming. Mounts
  `useDownloadListener` at the window root.
- `widgets/status-bar/` — port of WinSTT's StatusBar identity piece:
  - left: `PulseDot` + app-state label (Ready / Downloading — grayscale dot
    when idle, accent while downloading);
  - middle: `FooterPickerChip` (icon + `ScrollingText` name inside a pill +
    chevron) that opens the **detached picker** anchored at the chip rect —
    `lib/picker-trigger.ts` is the port of WinSTT's
    `footer-model-picker-trigger` (shared `data-slot`, capture-phase
    outside-click close, re-anchor on sibling triggers). While downloads are
    in flight the chip is replaced by `FooterDownloadChip` (count +
    averagePercent from the `features/download-manager` aggregate; click
    opens the settings window);
  - right: icon buttons opening the **gallery** and **settings** windows via
    `commands.openWindow`.
- New shared API: `src/shared/api/picker-window.ts`
  (`openPickerAtRect`/`closePicker`).
- `features/download-manager` addition: `useDownloadAggregate()` hook.
  While here, fixed a latent unit bug in `collectDownloadEntries` — it now
  passes the store's integer 0–100 `progress` through as `percent`
  **including `null`** (indeterminate) instead of feeding a raw value into
  `averagePercent`'s integer rounding. Covered by
  `download-aggregate.test.ts`.

### Detached picker window (`src/views/picker/`)

- `ui/PickerPage.tsx` — full-workarea transparent backdrop; a pointer-down
  on the backdrop itself (not the panel) calls `close_self_window` (which
  routes through the Rust animated close). Escape closes too
  (`useEscapeToClose` with an `ignoreLayer` for the always-open inline
  listbox). The panel is an absolutely-positioned `t-dropdown` box driven by:
- `model/use-panel-rect.ts` — simplified port of WinSTT's `usePanelRect`
  (no per-mode resize protocol; the starter's panel footprint is a
  Rust-side constant): `picker:anchor` positions + reveals behind a
  double-rAF compositor gate (+400ms failsafe), `picker:closing` plays the
  120ms fade (`PICKER_CLOSE_MS`, < the Rust 260ms hide grace) then drops to
  hidden, `openGeneration` remounts the warm body between opens so the
  search query never carries over. Duplicate anchors (Rust re-emits at
  75/250/700ms) are idempotent.
- `lib/panel-math.ts` — pure, tested helpers: `normalizePanelRect` (heals
  hostile/NaN payloads), `panelOrigin` (infers the t-dropdown scale origin
  from which screen edge the panel hugs — the trigger rect isn't reported),
  `dropdownStateClass`.
- `ui/PickerPanel.tsx` — `picker-content-substrate` card with a
  `ClearableTextField` search (fuzzy via `matchesFuzzySearch`, autofocused
  when the panel becomes interactive), grouped list (~30 demo "plugins"
  from `entities/picker-selection`, sticky `picker-group-header-surface`
  headers), per-row icon + name + version `Badge` + favorite star
  (persisted; favorited rows also collect into a pinned Favorites group) +
  selected checkmark. Rows are `role="option"` divs (they contain a nested
  button). Selecting persists + broadcasts + closes.

### Settings window (`src/views/settings/`)

- `ui/SettingsPage.tsx` — WinSTT shell reduced to 4 tabs: transparent
  window → `t-modal` `settings-window-shell` card → `SettingsSidebar` +
  `settings-content-frame`/`settings-content-card` (Elevated offset 2) with
  the floating close button, drag strips, edge-fade ScrollArea, and page
  header. `useTransparentBody`, `useEscapeToClose`, `useTouchActivation`
  all ported. Panels are statically imported (they're small — WinSTT's
  lazy/prefetch machinery intentionally not ported).
- `ui/SettingsSidebar.tsx` — near-verbatim WinSTT port: searchable
  (fuzzy over label + tooltip + per-tab setting-name keywords), collapsible
  (persisted via `persisted-selector-state`), grouped micro-labels,
  AnimatePresence rows.
- `model/use-settings-window-motion.ts` — simplified WinSTT port. The
  starter has no `settings window shown` backend event, so re-open replay
  is driven by `visibilitychange`/focus (WebView2 suspends the hidden
  webview; a re-show fires visible). Keeps: content-ready reveal gate with
  1.5s failsafe, `is-resetting` snap before replay, style-flush between
  the resetting→open frames, close-fade with the 40ms hide overlap.
- Saves: `model/settings-patcher.ts` — edits land in the zustand store
  instantly, then a **debounced (400ms), revision-checked** whole-section
  save via `lib/section-saver.ts` (`createSectionSaver`, fully tested).
  Pending edits are flushed when the window hides. Cross-window sync
  verified by design: `settings_save` → backend `settings:changed`
  broadcast → every window's `useSettingsSync` replaces its snapshot.
- Tabs:
  - **Appearance** — locale `Select` (single English entry; picking writes
    BOTH the use-intl locale store and `appearance.locale`) and the
    reduced-motion `Toggle`. The setting actually does something: a new
    `app/providers/AppMotionConfig` (used by RootLayout and the
    settings/picker entries) maps it to `MotionConfig reducedMotion="always"`.
  - **General** — autostart + minimizeToTray toggles (autostart reconciles
    OS registration Rust-side after the save lands).
  - **Downloads** — concurrency `NumberStepper` (1–4), "Open downloads
    folder" (`open_downloads_dir`), and the **download manager demo**: URL
    `ClearableTextField` (prefilled `https://proof.ovh.net/files/10Mb.dat`)
    + auto-derived (editable) file name + Start, and an `EntryCard` list of
    live downloads with `DownloadProgressBar` + tri-state `DownloadActions`
    (pause/resume/discard/restart) + remove. Form helpers
    (`lib/download-form.ts`: URL validation, file-name derivation/
    sanitization incl. control chars, stable id) are tested.
  - **About** — name/version/Tauri version via `@tauri-apps/api/app`
    (fallback identity in browser preview), links via the opener plugin,
    credits note pointing at the `@theme` re-skin entry point.
- Ported to `entities/setting/ui/`: a trimmed `SettingSection` (boxed /
  divided / toggle header variants) — the panels compose it with the
  existing shared `FormControl`.

### Gallery window (`src/views/gallery/`)

- `ui/GalleryPage.tsx` — draggable header, left rail with anchor links
  (scrollIntoView into the shared ScrollArea), 8 sections under
  `ui/sections/` (one file each) on `ElevatedSurface` cards via the shared
  `GallerySection`/`DemoRow` wrappers (demonstrating surface stepping):
  1. **Primitives** — Badge ×3, Spinner, PulseDot, GlassPill,
     ThinkingIndicator, Tooltip, InfoTooltip, Pending, PendingBadge (live on
     a Toggle).
  2. **Buttons** — accent/neutral/danger/disabled compositions of the
     unstyled Button, IconButtons (incl. disabled-with-tooltip), connected
     ButtonGroup.
  3. **Form controls** — TextField, ClearableTextField, PasswordField,
     StoredSecretField, InputGroup (addons), NumberStepper, Slider, Toggle,
     Switcher, CheckboxGroup/CheckboxItem — all inside FormControl rows.
  4. **Selects & comboboxes** — Select (flat + grouped), SearchableSelect,
     CreatableCombobox (live create/delete), EditableListCombobox.
  5. **Overlays & dialogs** — Dialog, ConfirmDialog, OptInDialog, free-form
     Modal, ToastShell + useAutoDismiss (button-triggered), DemoPreview
     (fails soft offline).
  6. **Motion & feedback** — ticking AnimatedValueText counter, IconSwap,
     ScrollingText, StaggerReveal (replay), DynamicIsland with a preset
     switcher, MediaSeekBar.
  7. **Data** — EditableRecordsGrid with 20 demo rows (select column,
     filters, undo/redo all live), CalendarHeatmap with deterministic
     generated activity (anchored one month back so the spread covers it),
     EntryCardShell/EntryCard with accent rail + meta shelf.
  8. **Download components** — DownloadProgressBar (active/paused/
     indeterminate) and an interactive DownloadActions phase machine.
- Two barrel exports added to shared/ui for the gallery's needs:
  `WeightedDateEntry` (calendar-heatmap) and `InputGroupInput`
  (input-group) — both existed, just weren't re-exported.

## Picker selection sync — mechanism chosen

`src/entities/picker-selection/`:

- zustand store persisted to localStorage (`starter-picker-selection`):
  `selectedId` + `favorites`.
- **Cross-window sync is a renderer-emitted Tauri event**: user actions
  (`select`, `toggleFavorite`) persist locally AND `emit("picker:selected",
  { selectedId, favorites })` via `@tauri-apps/api/event` (constant added
  to `shared/api/native-events.ts`). Every interested window mounts
  `usePickerSelectionSync()` (StatusBar in main, PickerPage in the picker),
  which applies the payload via `applyRemote` — which never re-emits, so
  the sender's own echo is an idempotent no-op, not a loop.
- Why not localStorage alone: webviews share the storage file but do not
  reliably observe each other's `storage` events, so a live window would
  only converge on restart. Why not the settings store: the selection is
  demo UI state, not a durable app setting — piggybacking `settings:changed`
  would put UI churn through the revision-checked settings pipeline.
- localStorage still makes the last selection win on next cold start.

## Deviations / decisions

1. **Settings motion without a backend "shown" event** — WinSTT replays the
   enter animation from an explicit Rust `settings-window-shown` event; the
   starter's IPC contract has no such event, so the hook falls back to
   `visibilitychange`/focus (documented in the hook). Good enough in
   practice; if a flicker ever shows on re-open, port the event.
2. **Download chip click opens the settings window without deep-linking**
   to the Downloads tab (the starter has no cross-window tab deep-link
   plumbing; WinSTT's uses `storage` events, which are unreliable across
   webviews). Small known gap.
3. **`DownloadActions` mapping in the demo**: Stop→`download_pause`,
   Discard→`download_remove` (drops the partial file + entry),
   Download→`download_start` (restart of a terminal entry),
   Resume→`download_resume`.
4. **Picker panel origin is inferred** (`panelOrigin`) from which screen
   edge the panel hugs, since the starter's `picker:anchor` payload carries
   no origin/trigger rect (WinSTT's does). Ties favour "bottom" because
   footer chips dominate.
5. **`collectDownloadEntries` fix** (existing feature file): `percent` now
   passes the store's nullable 0–100 progress straight through; before, a
   `null` (indeterminate) progress went in unhandled.
6. **`SettingSection` ported without** PendingBadge/togglePending and the
   disabled-tooltip variants — not needed by four demo tabs.
7. **Gallery panels are statically imported**; no lazy/prefetch (WinSTT
   needs it for 11 heavy tabs, the starter's 4+8 panels are small).
8. **knip**: removed `@tauri-apps/plugin-opener` from `ignoreDependencies`
   (now genuinely imported by the About tab).

## Verification (2026-07-16)

- `bun run typecheck` (app + node) — clean
- `bun run typecheck:tests` — clean
- `bun run lint` (biome + no-literal-string) — clean
- `bun run check:i18n` — key parity + coverage clean
- `bun run check:deadcode` (knip) — clean
- `bun test ./src` — **506 pass / 0 fail** (baseline was 473; +33 new tests:
  picker-selection store, panel math, section saver, download form,
  download aggregate)
- `bunx vite build` — all 4 entries emitted
- **Browser smoke test** (Vite on an alt port, Browser pane): main hero +
  ticking pill + footer render; gallery renders all 8 sections with zero
  console errors; settings shell renders, tab switching + Downloads panel
  verified interactively; picker warm-mounts its 30-row panel invisible
  (opacity 0) awaiting `picker:anchor`, no errors.
- **`bun run tauri dev` NOT run**: port 1420 (fixed by Tauri) was held the
  whole session by WinSTT's own dev server (foreign process with a live
  webview attached — not safe to kill). The later verification pass should
  smoke-test real window opening: footer chip → anchored picker,
  gear → settings modal, gallery button → gallery window, and a real
  10 MB download driving the footer chip.

## DnD, tables, charts port

Ported from WinSTT on top of the demo views above (parallel with the picker
and hotkey/overlay agents — this pass did not touch `src-tauri/`,
`src/bindings.ts`, `src/views/picker/`, or `src/widgets/status-bar/`).

### What was added

- **`shared/api/file-drag-drop.ts`** — port of WinSTT's native drag-drop
  bridge (`file-drag-drop.ts` + `adapter/drag-drop.ts` merged into one
  module): `wireFileDragDrop()` idempotently subscribes to the window's Tauri
  `onDragDropEvent` stream and re-broadcasts each phase as the
  `starter:file-drag-drop` DOM CustomEvent; `enter`/`drop` paths are stashed
  name-keyed so `droppedFilePath(file)` resolves a DOM `File` to its absolute
  native path synchronously inside a DOM drop handler. No-ops outside Tauri.
- **`shared/ui/file-drop-zone`** — generic dashed-border drop target
  (WinSTT's AudioDisplay drop + recording-sound `useSoundDrop` patterns):
  extension filter (`accept`), hover/drag-over accent states, DOM drops AND
  native window drag-drop (with the 500 ms `lastNativeDropAt` dedupe from
  AudioDisplay, since a platform may deliver both), click-to-browse through
  `@tauri-apps/plugin-dialog` falling back to a hidden `<input type=file>`
  in the browser. Rejected-extension notice via the error token. Native
  drag activation is window-scoped (Tauri reports no element geometry) —
  documented on the component.
- **`shared/ui/sortable-list`** — standalone drag-to-reorder vertical list on
  the vendored dice-ui `Sortable` primitives (the same machinery as WinSTT's
  mic-priority `SortableOptionRows`): lifted-surface rows, always-visible grab
  handles, pointer + keyboard sorting with SR announcements. The Select's own
  `sortable`/`onReorder` rows were verified and demoed separately (they're the
  in-popup variant; SortableList is the on-page variant).
- **`shared/ui/setting-field`** — WinSTT's `SettingField` + `SettingResetButton`
  ported into shared/ui (WinSTT keeps them in `entities/setting`; the starter's
  version has no settings-store coupling, so shared/ui is the honest layer).
  i18n: reuses `common.{resetToDefault,cancel,reset}`, new `settingsField.*`
  namespace for the reset-dialog copy + disabled reason.
- **`shared/ui/kbd`** — `Kbd`/`KbdCombo` keycap chips, ported from WinSTT's
  shortcuts-legend `Keycap`/`HotkeyPrefix` (surface-aware, emphasized variant).
  Purely presentational — WinSTT's uiohook `formatKeyName` mapping was left
  behind (the hotkey agent owns key naming). Gallery demo only, per the
  parallel-agent boundary (General tab untouched).
- **`shared/ui/charts`** — the three most reusable bespoke SVG charts from
  WinSTT's history dashboard, genericized with typed data props and
  theme-token colors: `LineChart` (Sparkline grown up: optional area fill +
  the shared-Tooltip hover pattern with per-point hit columns and a marker
  dot), `BarChart` (UsageBars/CostBars rank pills with the
  `color-mix`-toward-black rank fade), `StatRing` (CostPie donut: exact-share
  wedges, seam gap, center value/label, legend). Pure geometry lives in
  `chart-math.ts` (tested). NOT ported: WpmGauge (semicircle gauge),
  ContributionGraph (rolling-year heatmap), ModelAuthorRadar — listed in the
  sweep below.
- **CRUD grid demo** — the gallery Data section's `EditableRecordsGrid` demo
  now persists through `views/gallery/model/crud-records-store.ts` (zustand +
  localStorage `starter-gallery-crud`), with seed/reset helpers and a
  "Reset demo data" button. Add-row, inline edit, selection-bar delete,
  sort + filter menus were already part of EditableRecordsGrid; the demo now
  exercises the full surface against durable state. WinSTT has no `CrudTable`
  wrapper (grep confirmed) — EditableRecordsGrid IS that wrapper.
- **Gallery sections** — three new registry entries: "Setting rows"
  (SettingField reset/gated/error rows + the Kbd combo row), "Drag & drop"
  (FileDropZone appending name+size to a list, SortableList, drag-sortable
  Select), "Charts" (line, area, rank bars, stat ring with generated
  deterministic data; the calendar heatmap next door in Data is called out as
  the same family).

### Settings-tab refactor

`AppearancePanel` and `DownloadsPanel` rows now consume `SettingField` (the
same primitive the gallery showcases), with schema defaults
(`*SettingsSchema.parse({})`) driving per-setting reset buttons on locale,
reduced-motion, and concurrency. `GeneralPanel` was deliberately NOT touched —
the hotkey agent owns that tab. `AboutPanel` rows are identity display, not
settings; converting them would be churn with no reset semantics. The
download-demo form's URL/file-name fields stay `FormControl` (form inputs,
not persisted settings).

### i18n

New namespaces (per the parallel-agent key-partition): `dropZone.*`,
`sortable.*`, `crud.*`, `charts.*`, `settingsField.*` — component strings AND
their gallery-section chrome, so nothing new landed under the shared
`gallery.*` prefix.

### Sweep — remaining app-agnostic WinSTT pieces worth porting later

From `src/shared/ui` + `src/widgets` diff (not ported now; none trivial
enough to sneak in):

- **Sound-picker-with-preview** (`features/recording-sound` SoundLibrary +
  `useSoundDrop`): pick/preview/add short audio cues with duration
  validation via `AudioContext.decodeAudioData`. Generic "notification sound"
  UX; needs an asset-copy backend command.
- **StatTile / HeroCard** (`transcription-history-settings/ui/StatTile.tsx`,
  `HistoryHero.tsx`): the muted dashboard stat tile + hero card chrome
  (surface-stepped icon chip, stagger fade-in). Pairs with shared/ui/charts.
- **ContributionGraph** (GitHub-style rolling-year heatmap): distinct from
  the ported month-grid calendar-heatmap; pure once `DayBucket` is inlined.
- **WpmGauge** → generic semicircle `GaugeChart` (value/max/format) — ~50
  lines, natural fourth member of shared/ui/charts.
- **ModelAuthorRadar** → generic radar/spider chart (typed axes).
- **SwitchingTrigger** (`shared/ui/switching-trigger`): SwapSweepBar +
  SwitchingPill "swap in flight" trigger chrome; generic, but its
  `animate-swap-sweep` keyframes were stripped from globals.css — port both
  together.
- **EmptyState** (`model-picker/lib/EmptyState.tsx`): tiny icon+title+hint
  empty placeholder currently buried in the (dropped) model-picker; worth
  re-homing as `shared/ui/empty-state`.
- **shared/lib candidates**: `create-transient-notification-store` (generic
  auto-expiring toast-queue store factory), `host-platform` +
  `format-key-name` (hotkey display names — partially landed via the hotkey
  agent), `languages.ts` (BCP-47 display-name helpers).

### Baseline lint repair (pre-existing, not from any agent)

`bun run lint` failed at the base commit on three files that were never
touched by the parallel passes: `.claude/skills/feature-sliced-design/
check-fsd.mjs` (53 style violations — biome's basename globs like `*.mjs`
pull it into scope from any depth) and the tab-indented `fsd.config.json` /
`tools/tauri-dev-altport.conf.json` (ultracite formats JSON with 2-space).
Fix: `!!.claude` force-exclude added to `biome.jsonc` `files.includes`
(vendored skill tooling is not repo-authored code) and the two JSON configs
reformatted. No rule changes.

### Verification (this pass, 2026-07-16 — tree shared with the picker and
hotkey/overlay agents mid-flight)

- `bun run typecheck` (app + node) — clean
- `bun run typecheck:tests` — clean
- `bun run lint` (biome + no-literal-string) — clean (446 files)
- `bun run check:i18n` — key parity + coverage clean
- `bun run check:fsd` — 0 errors, 0 review flags (327 files)
- `bun test ./src` — 656 pass / 0 fail (91 files; +~60 tests from this pass:
  drop-zone lib/component + drag-drop codec, sortable list, setting field +
  reset confirm, kbd, chart-math + chart renders, crud store)
- `bunx vite build` — all entries emitted
- One mid-flight race repaired: a concurrent GalleryPage edit dropped the
  picker agent's `PickersSection`/`ModesSection` imports while keeping their
  section ids/labels/renders — imports restored, both agents' sections
  registered side by side.

## Picker components port

Genericized WinSTT's picker/selection UX into four shared components, then
rewired the demo surfaces onto them (this pass; tree shared with the
hotkey/overlay and dnd/tables/charts agents mid-flight).

### What was built

- **`shared/ui/item-picker`** — the core UX of WinSTT's model picker with the
  model domain stripped. `ItemPicker` = fuzzy search field (shared
  `matchesFuzzySearch`) over a **virtua**-virtualized grouped list of generic
  `{ id, title, subtitle?, icon?, badges?, group?, meta?, description? }`
  items: group headers, pinned Favorites group (star toggles, favorited items
  keep their home-group copy — the WinSTT convention), selected checkmark,
  full keyboard traversal, optional hover **spec card**. Decisions:
  - **Combobox keyboard pattern**: rows are `role="option"` divs (they nest a
    favorite `<button>`); ArrowUp/Down/Home/End/Enter live on the search
    input via `aria-activedescendant`, virtua `scrollToIndex` keeps the
    active row visible. Rows are `tabIndex={-1}` (programmatic focus only).
  - **Virtualization**: WinSTT's Virtualizer-inside-ScrollArea recipe
    (`scrollRef` at the viewport) incl. the floating pinned group-header
    overlay (a virtualized sticky header unmounts mid-scroll, so the active
    section's header re-renders as a click-through overlay). A
    `virtualized={false}` mode renders eagerly with real CSS-sticky headers —
    for small inline lists AND for DOM tests (virtua can't measure in
    happy-dom; WinSTT's own tests dodge row assertions for the same reason).
  - **Spec card** (`ItemSpecHoverCard`): Base UI PreviewCard port of WinSTT's
    model-spec hover card — 450ms deliberate-hover open, 120ms close grace,
    level-7 surface, hover-only (never click/focus). Genericized to render
    title/subtitle/badges/description + label/value `meta` facts.
  - **Controlled + uncontrolled** selection AND favorites via a new
    `shared/lib/use-controllable-state` hook (tested).
- **`shared/ui/item-card`** — WinSTT's universal ModelCard skeleton,
  slot-for-slot (actions/badges/description/favorite/shelf) with the model
  bits replaced: identity row (icon/title/selection check), a one-line
  **spec-chips** row, two-line description with reserved height (uniform
  card footprint), recessed bottom shelf, accent selected state, unavailable
  (error) state. Body-click select uses the full-bleed-button +
  pointer-events-shielded-content trick from the WinSTT `as="div"` card.
  `text-favorite` → `text-warning` (domain alias stripped per the theme
  contract). Card chrome exported as `CARD_*` constants.
- **`shared/ui/multi-combobox`** — WinSTT's `language-multi-combobox` was
  already generic internally; ported as `MultiCombobox` (chips/count summary
  in the closed input, checkbox option list, per-chip remove) and **added
  select-all / clear** bulk actions in the popup's sticky header
  (`mergeSelectAll` is additive over the current filter; logic split into
  `multi-combobox-logic.ts` and tested).
- **`shared/ui/mode-switch`** — `ModeSwitch` (segmented, 2–5 modes,
  icon+label) delegates to the existing shared `Switcher` engine (measured
  rects + spring tiers + ToggleGroup arrow keys) rather than duplicating its
  geometry; adds controlled/uncontrolled value. `ModeSwitchPill` is the
  compact footer/tray variant: one footer-chip-vocabulary pill showing the
  current mode, click cycles forward, arrow keys cycle both ways, fast-tier
  keyed swap animation (no `layout` prop). `cycleMode` skips disabled modes
  and wraps (tested).

### Integration

- **Detached picker window**: `views/picker/ui/PickerPanel.tsx` now wraps
  `ItemPicker` (bespoke list deleted): PICKER_ITEMS mapped to generic items
  (+ group/version spec-card facts), store-controlled selection/favorites
  (`views/picker/lib/favorite-diff.ts` converts the picker's whole-array
  favorites callback back to the store's per-id toggle; tested), select →
  persist + broadcast + `closeSelfWindow`. Anchor/backdrop/Escape behavior
  untouched — the `PICKER_INLINE_LIST_SLOT` marker moved from the old inline
  listbox to the panel substrate (the Escape ignore-layer checks
  `closest()`, so semantics hold).
- **Footer**: `widgets/status-bar` gained `FooterModeChip` — `ModeSwitchPill`
  demoing Focus/Casual/Away, persisted in localStorage
  (`starter-footer-mode`, healed by `coerceFooterMode`; deliberately NOT the
  settings pipeline — same reasoning as the picker selection). Sits in its
  own separator-delimited slot before the window launchers.
- **Gallery**: two new sections — **Pickers** (inline `ItemPicker` w/ spec
  cards, `ItemCard` grid incl. selected/favorite/actions/shelf/broken
  states, `MultiCombobox` w/ select-all/clear) and **Mode switches**
  (segmented 3-mode, compact 5-mode, pill). Registered in GalleryPage
  (surgical insertions after Selects).
- i18n: new `itemPicker.*` namespace holds the generic picker label bundle
  (used by both the picker window and the gallery); `picker.*` slimmed to
  its group labels + spec-fact labels (the old search/list keys moved);
  `statusBar.mode*`, `gallery.pickers*/modes*/multi*/card*/demoDesc*` added.
  Demo item names stay untranslated proper nouns (picker-items convention).

### Verification (this pass)

- Full gate suite green: `typecheck`, `typecheck:tests`, `lint` (biome +
  literal guard), `check:i18n`, `check:fsd`, `bun test ./src` (656 pass /
  0 fail; +~100 tests from this pass across item-picker logic/DOM,
  item-card, multi-combobox logic/DOM, mode-switch, controllable-state,
  favorite-diff, footer-mode), `bunx vite build`. `check:deadcode` clean for
  this pass's files (remaining hint belongs to the dnd agent's in-flight
  plugin-dialog usage).
- Browser smoke (vite dev, Browser pane): gallery renders both new sections
  (cards, segments, pill, combobox present, zero console errors); footer
  pill cycles Focus→Casual on click and persists to localStorage; picker
  window warm-mounts the ItemPicker panel awaiting `picker:anchor`.
- **Known verification gap**: the Browser pane never painted this session
  (`document.visibilityState === "hidden"`, rAF/ResizeObserver starved —
  even a bare `VList` renders zero rows there, and screenshots time out), so
  the *virtualized* row rendering could not be visually confirmed. It is the
  exact Virtualizer/ScrollArea/scrollRef recipe WinSTT ships (same react,
  virtua, vite versions), and the eager `virtualized={false}` path renders
  and interacts correctly. The later `tauri dev` smoke pass should confirm
  rows appear in the real picker window and gallery.

## react-doctor quality gate (2026-07-16)

react-doctor v0.7.8 was integrated as a repo gate (devDep + `check:react`
script + `.github/workflows/react-doctor.yml` + an advisory staged scan in
`.husky/pre-commit`). Baseline score was 63/100 (13 errors, 9 warnings);
after this pass the full scan reports **100/100, no issues**.

What was fixed (all verified against the rule recipes, tests stayed green):

- **effect-needs-cleanup ×4** (`use-settings-sync`, `use-download-listener`,
  `OverlayNotifySection`, `use-overlay-notifications`): the Tauri `listen()`
  unlisten was invoked through a `.then()` chain in cleanup, which the
  detector can't follow — and the old shape also dropped events racing an
  unmount-before-resolve. Replaced with `shared/api/subscribe-native-event.ts`
  (`subscribeNativeEvent`): registers the listener, returns a SYNCHRONOUS
  disposer, unlistens-on-resolve if disposed early, and gates the handler on
  the disposed flag.
- **react-hooks-js/purity** (`GalleryPage`): `Date.now()` deadline for the
  scrollspy click-suppression window → boolean suppress ref armed in `jumpTo`
  and reset by a `setTimeout` (re-click clears the pending timer; the
  scrollspy effect clears it on unmount).
- **no-layout-property-animation ×3** (`HotkeyRecorder`'s RecordingBadge):
  `width: 0 ↔ auto` keyframes → transform/opacity-only reveal (x + scale,
  origin at the toggle edge) on the same `springs.moderate` tier.
- **React Compiler bails ×5**: chart default formatters (`BarChart`,
  `LineChart`, `StatRing`) hoisted to module-scope constants (arrow-function
  prop defaults can't be reordered); `FileDropZone`'s dynamic
  `import("@tauri-apps/plugin-dialog")` hoisted into a module-scope
  `pickViaNativeDialog()` helper (the compiler can't lower `import()`
  expressions; the module stays lazy-loaded).
- **Warnings**: redundant `useCallback` deleted in `use-controllable-state`
  (React Compiler memoizes it; no test relies on referential stability);
  `EditableListCombobox` suggestion filtering now uses a `Set` of current
  values; `DownloadsPanel`'s handler-only `fileNameTouched` state → ref;
  `FormSection`'s `useState(t(...))` → lazy initializer; `GeneralPanel`'s
  `commitToggleMain`/`clearToggleMain` hoisted to module scope;
  `surface-context.tsx` split into `surface-context.ts` (context + hook) and
  `SurfaceProvider.tsx` (component only) for Fast Refresh.

Suppressions in `doctor.config.json` (JSON can't carry comments — reasons
live here):

- `src/bindings.ts` → `deslop/unused-file`: generated tauri-specta output;
  its exports are the IPC surface, partially consumed by design.
- `package.json` → `deslop/unused-dependency`: `@tauri-apps/plugin-autostart`
  is the JS side of the Rust-registered autostart plugin (see
  `src-tauri/Cargo.toml`), kept for template users who call it from the
  frontend; knip ignores it for the same reason (`knip.json`
  ignoreDependencies).
- `src/shared/ui/data-grid/primitives/popover.tsx` →
  `react-doctor/only-export-components`: false positive — `PopoverAnchor` IS
  a component, but it renders via `cloneElement` (attaching the anchor ref to
  its child) with no JSX literal, so the detector misclassifies it as a
  non-component export.
