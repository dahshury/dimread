# Frontend foundation — build notes

Extracted from WinSTT (`E:\DL\Projects\WinSTT`) per `TEMPLATE_SPEC.md`. This
file records decisions and deviations made while building the frontend
foundation; delete it once the notes are absorbed.

## What was copied (and from where)

- **Root configs** — `package.json` (WinSTT version pins, pruned scripts),
  `tsconfig{,.node,.all}.json` (maximal strictness, `@/*` + `@/bindings` +
  `@test/*` aliases), `biome.jsonc` (ultracite core+react, tabs, double
  quotes, assist sorting off, WinSTT rule relaxations), `vite.config.ts`
  (multi-page: main/settings/picker/gallery; React Compiler on build only;
  `Cache-Control: no-store` for WebView2; `resolve.tsconfigPaths`; the
  i18n full-reload plugin), `knip.json`, `bunfig.toml`, `.gitignore`.
- **HTML shells** — `index.html` + `windows/{settings,picker,gallery}.html`
  following WinSTT's startup-shell pattern. settings/picker are
  `background: transparent !important` (transparent windows); main/gallery
  paint an opaque `#09090b` substrate.
- **Design system** — `src/app/styles/globals.css` pruned from WinSTT's
  (see below), `fonts.css` + Geist/Geist Mono woff2 verbatim.
- **shared/lib** — cn, surface/, springs, fuzzy-{search,score,match},
  format-bytes, format-time, truncate, generate-id, public-asset,
  font-weight, scrollbar-autohide, use-proximity-hover, use-long-press,
  use-touch-activation, pointer-gesture, touch-rubber-band, is-record,
  errors, fire-and-forget, clipboard, download-progress-core,
  persisted-selector-state — plus `grid-cell-diff` and `tauri-runtime`
  (required by data-grid / the api layer; not in the spec list but hard
  dependencies of listed items).
- **shared/ui** — all 43 kept primitives from the spec list, verbatim incl.
  barrels and colocated tests (data-grid: 59 files; calendar-heatmap had no
  domain imports and needed no type inlining; thinking-indicator's
  `processing-start.ts` was already generic).
- **i18n** — config (LOCALES pruned to `["en"]`, multi-locale infra kept),
  messages (import.meta.glob lazy loading), locale-store (persist key
  renamed `winstt-locale` → `starter-locale`), global.d.ts type binding,
  `tools/i18n/check-i18n.ts` + `check-no-literal-string.ts` (allowlist
  trimmed to a placeholder).
- **app layer** — IntlProvider (system locale now read from
  `navigator.language` instead of a WinSTT IPC command), ErrorBoundary (+
  test), render-react-root (`__winsttReactRoots` → `__appReactRoots`),
  HtmlLang (catalog bootstrap and diag hooks stripped), RootLayout
  (IpcProvider/TitleBar/listen-mode logic stripped; now
  IntlProvider → MotionConfig → Tooltip.Provider → SurfaceProvider(1) →
  LazyMotion strict → noise-overlay shell, and it mounts `useSettingsSync`).
- **test harness** — `test/preload.ts` (happy-dom registration, Tauri
  internals stubs, IntlProvider module mock), `test/mocks/intl-provider.tsx`,
  `test/lib/cast.ts`.

## New (authored) code

- `src/bindings.ts` — initially a hand-authored placeholder; the Rust agent
  replaced it with real tauri-specta generated bindings mid-build, and all
  consumers were adapted to the generated `Result<T, E>` command shape and
  type names (`AppSettings`, `PartialSettings`, `SettingsSnapshot`,
  `DownloadSnapshot`, `PickerAnchorEvent`).
- `src/shared/api/` — `native-events.ts` (4 event name constants),
  `native-boundary.ts` (`on`/`ipcOn`/`onTyped`/`onCast`/`commandOrDefault`,
  ported from WinSTT minus the STT event reshaping), `index.ts` barrel.
- `src/shared/config/settings-schema/` — Zod schema for the demo settings
  (appearance/general/downloads, per-field `.catch()` healing).
- `src/entities/setting/` — settings store (zustand + persist
  `dimread-settings`, per-section patchers, normalizeSettings via Zod),
  hydration store (status + backend revision for optimistic concurrency),
  `useSettingsSync` (snapshot hydrate + `settings:changed` subscription) and
  `saveSettings` (revision-checked `settings_save`).
- `src/features/download-manager/` — `download-store` (Record<id,
  DownloadState>, monotonic merge via `download-progress-core`, terminal
  phase reset), `use-download-listener` (subscribe `download:update`, then
  hydrate from `download_list`; the monotonic merge makes the late list
  response harmless), `download-aggregate` (ported from WinSTT
  model-download, keyed by download id).
- `src/entries/{main,settings,picker,gallery}.tsx` + placeholder views in
  `src/views/*/`. main/gallery use RootLayout (opaque shell); settings and
  picker compose the provider stack WITHOUT RootLayout because their windows
  are transparent — the views paint their own card
  (`settings-window-shell` / `picker-content-substrate`).
- `messages/en.json` — `common` + `dataGrid` copied from WinSTT (the only
  namespaces the kept components consume), plus starter keys for the four
  placeholder views, demo settings labels, and download phase/action labels.

## globals.css pruning map

Kept: `@theme` token system (surfaces 1–8 + paired shadows, foreground,
overlay chrome, settings-shell material, accent/teal/orange/status, border/
divider, radii, type scale, generic animations, z-index), `@utility z-*`,
shadcn compat shim for data-grid, `@layer base` (resets, cursor, scrollbars,
selection, reduced-motion, noise-overlay, drag regions, select-popup panel
reveal), `@layer components` settings-window/sidebar shell classes,
transitions.dev recipes (t-dropdown, t-modal, t-page-slide, t-text-swap,
t-digit, t-icon-swap, t-secret-reveal, t-stagger, t-panel-slide-top,
t-resize) and their tuning vars, keyframes fade-in / slide-in-right /
pulse-glow / shimmer + `.shimmer-text`.

Stripped: domain aliases (`--color-model-family-*`, `--color-tts-engine-*`,
`--color-recording-mode-*`, `--color-cache-*`, `--color-model-free`,
`--color-capability-*`, `--color-performance-*`, `--color-history-*`,
`--color-favorite`, purple legacy aliases), subtitle/caption scrim tokens +
classes, tray-menu open animation, file-queue keyframes
(row-in/glyph-pop/hairline-pulse + `--animate-*` tokens), speaking-breathe
shadow, swap-sweep, `.touch-copy-transcript`, the legacy
`--color-bg-*`/`--color-text-*` alias block (no copied component uses them).
Renamed: `model-picker-content-substrate` → `picker-content-substrate`,
`--color-model-picker-group-header-surface` → `--color-picker-group-header-surface`,
`--shadow-model-picker-{popup,search,search-focus}` → `--shadow-picker-*`,
`model-picker-group-header-surface` → `picker-group-header-surface`.
A commented "semantic role tokens" section documents how an app re-adds
domain aliases. Header comment marks the re-skin entry point.
One in-component fix: data-grid's search-match highlight used
`bg-favorite/*` → now `bg-warning/*` (favorite was a stripped domain alias
of warning).

## Deviations from the spec

1. **`double-metaphone` added to deps** — the spec's dependency list omits
   it, but the spec-listed `shared/lib/fuzzy-match` imports it (WinSTT has
   it pinned; same pin copied).
2. **`@babel/parser` + `fast-check` added to devDeps** — `@babel/parser`
   powers the spec-required `check-no-literal-string.ts` tool; `fast-check`
   is used by two kept non-property test files (surface-classes,
   calendar-system). `*.property.test.ts` files were NOT copied.
3. **`@biomejs/biome` pinned exactly to `2.5.2` and `ultracite` to `7.9.2`**
   (WinSTT's installed versions). The caret ranges resolved to 2.5.4/7.9.4,
   which panic on two copied files (DynamicIsland, CalendarHeatmap) and add
   a new default-error rule; the pins keep lint green with byte-identical
   sources. Revisit when upgrading Biome.
4. **knip entries include the shared library barrels**
   (`src/shared/ui/*/index.ts`, `src/shared/lib/*`, entity/feature barrels):
   most primitives are intentionally unconsumed until the gallery view is
   built, and a starter's shared layer IS its public API. Spec-listed but
   currently JS-unreferenced deps (tauri plugins, virtua, tailwindcss) are
   in `ignoreDependencies`.
5. **`widgets/status-bar` not created** — the spec's layout mentions it, but
   the frontend-foundation scope ends at placeholder views; the widget
   belongs to the later views pass.
6. **`hooks:install` / lockfile / coverage scripts dropped** along with all
   WinSTT bench/docs/release scripts, per instructions.
7. **i18n locale-store test locales** rewritten to `"en"` (only advertised
   locale); the multi-locale behavior is still covered by config tests.
8. **`demo-preview` config genericized** — `DEMO_PREVIEW_BASE` now points at
   a placeholder host and `DemoName` is `string`.

## Verification results (all green)

- `bun install` — ok (287 packages)
- `bun run typecheck` (app + node) — clean
- `bun run typecheck:tests` (tsconfig.all) — clean
- `bun run lint` (biome + no-literal-string) — clean
- `bun run check:i18n` — key parity + coverage clean
- `bun run check:deadcode` (knip) — clean
- `bunx vite build` — all 4 HTML entries emitted (the
  INEFFECTIVE_DYNAMIC_IMPORT warning on `messages/en.json` is by design:
  the default bundle is intentionally static in IntlProvider)
- `bun test ./src` — 473 pass / 0 fail across 65 files
