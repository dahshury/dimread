# DimRead — Build Spec (contract for all contributors)

Generic Tauri v2 + React 19 starter kit extracted from WinSTT (`E:\DL\Projects\WinSTT`).
Keeps the design language, app shell, and download manager; strips all STT/TTS/LLM logic.

## Identity
- Repo dir: `E:\DL\Projects\dimread`
- npm package name: `dimread`
- Product name: `DimRead` / binary `dimread`
- Rust crate: `dimread` (bin), lib `dimread_lib`, crate-type rlib
- Bundle identifier: `com.dahshury.dimread`
- Version: `0.1.0` (lockstep across package.json, tauri.conf.json, Cargo.toml)
- Runtime: Bun for renderer, cargo for crate. Tabs + double quotes (Biome, ultracite presets), same as WinSTT.

## Window roster (all created programmatically in Rust; `"windows": []` in tauri.conf)
| Label | HTML | Purpose | Chrome |
|---|---|---|---|
| `main` | `index.html` | Compact main window: hero area + footer | 480×180, frameless, opaque, non-resizable, shadow |
| `settings` | `windows/settings.html` | Settings shell: sidebar tabs, transparent rounded card | 940×680, transparent, frameless, modal child of main, hide-on-close |
| `picker` | `windows/picker.html` | Detachable generic item picker (anchored panel over full-workarea transparent backdrop) | transparent, hide-on-close, prewarmed |
| `gallery` | `windows/gallery.html` | Component gallery demoing every shared/ui primitive | 1000×720, resizable, opaque, hide-on-close |

Gotchas carried from WinSTT: all webviews share ONE WebView2 user-data folder; transparent windows pin `background_color(0,0,0,0)`.

Roster addendum (hotkeys + overlay port): a fifth window `overlay` (`windows/overlay.html`, 720×140, transparent,
always-on-top, click-through + non-focusable, skip-taskbar, prewarmed hidden, top-center of the work area) hosts the
DynamicIsland notification pill. It is backend-owned: `overlay_notify(payload)` shows it + emits `overlay:notify`
(resolved `{ title?, message, tone, durationMs }`), a Rust timer hides it after `durationMs` + exit grace,
`overlay_dismiss()` retracts early via `overlay:dismiss`. New notifies REPLACE the visible one (no queue). New IPC:
`hotkey_register(id, accelerator)` / `hotkey_unregister(id)` / `hotkey_list()` + `hotkey:triggered` `{ id, accelerator }`,
backed by a fourth settings section `hotkeys: { toggleMain: string ("" = unbound) }` that is armed at startup and
hot-swapped on save (`toggleMain` natively toggles main-window visibility).

## IPC contract (tauri-specta → generated `src/bindings.ts`)
Commands (snake_case in Rust):
- `open_window(label, anchor_x?, anchor_y?, anchor_w?, anchor_h?)`, `close_window(label)`, `close_self_window()`, `show_main_window()`
- `settings_load_snapshot() -> { revision, settings }`
- `settings_save(patch: PartialSettings, revision) -> { revision, settings }` (optimistic concurrency: error on stale revision)
- `download_start(id, url, file_name)` (dest = app data downloads dir), `download_pause(id)`, `download_resume(id)`, `download_cancel(id)`, `download_remove(id)` (delete file + entry), `download_list() -> DownloadSnapshot[]`
- `open_downloads_dir()`

Events (specta-mounted, typed):
- `settings:changed` → `{ revision, settings }`
- `download:update` → `DownloadSnapshot` `{ id, url, fileName, phase: "queued"|"downloading"|"paused"|"completed"|"cancelled"|"failed", progress: number (0..1), downloadedBytes, totalBytes?, speedBps?, etaSeconds?, error? }`
- `picker:anchor` → `{ x, y, width, height }` (window-local panel rect)
- `picker:closing` → `{}`

## Settings schema (demo-sized; Zod on FE, serde on Rust; sections FLAT, no nesting beyond section)
```
appearance: { locale: string ("en"), reducedMotion: boolean }
general:    { autostart: boolean, minimizeToTray: boolean }
downloads:  { concurrency: number (1..4) }
```
Persist: tauri-plugin-store JSON file `dimread-settings.json` in app data dir (portable-aware). FE: zustand + localStorage cache, backend snapshot wins on hydrate. `settings:changed` broadcast keeps all windows in sync.

## Frontend layout (FSD)
- `src/app/` — styles (globals.css, fonts.css), providers (IntlProvider, ErrorBoundary), layouts (RootLayout)
- `src/shared/ui/*` — copied generic primitives (see list below)
- `src/shared/lib/*` — cn, surface, springs, fuzzy-*, format-*, truncate, generate-id, public-asset, font-weight, scrollbar-autohide, use-* hooks
- `src/shared/config/` — z-index.ts, settings-schema (Zod)
- `src/shared/i18n/` — config.ts, messages.ts (import.meta.glob lazy per-locale), locale-store
- `src/shared/api/` — thin: bindings re-export, event name constants, typed listen helpers
- `src/entities/setting/` — settings store + hydration store
- `src/features/download-manager/` — store, listener, aggregate (from WinSTT model-download, genericized)
- `src/widgets/status-bar/` — footer (genericized)
- `src/views/{main,settings,picker,gallery}/` + `src/entries/{main,settings,picker,gallery}.tsx`

Kept shared/ui primitives (copy + adapt imports, keep tests where they don't import app providers):
button, icon-button, button-group, badge, spinner, pulse-dot, glass-pill, text-field, form-control,
input-group, number-stepper, slider, toggle, checkbox-group, switcher, tooltip, info-tooltip, toast,
modal, dialog, dialog-shell, dialog-animation, confirm-dialog, opt-in-dialog, scroll-area,
stagger-reveal, animated-value, elevated-surface, scrolling-text, entry-card-list, select,
combobox-base, searchable-select, creatable-combobox, editable-list-combobox, menu-highlight,
dynamic-island, thinking-indicator (genericize processing-start), demo-preview, download (progress bar + actions),
media-seek-bar, pending, data-grid (vendored DiceUI, keep shadcn @theme shim), calendar-heatmap.

Dropped: model-picker (123 files — replaced by generic picker view), model-spec-card, context-app-combobox,
language-multi-combobox, resource-warning-dialog, transcript-diff, brand-logo.

## Theming (the re-skin story)
Single source of truth: `src/app/styles/globals.css` `@theme` blocks. Keep: surfaces 1–8 + paired shadows,
foreground scale, accent/teal/orange/status colors, radii, type scale, animations, z-index, shadcn shim for
data-grid. STRIP domain aliases: model-family-*, tts-engine-*, recording-mode-*, cache-*, model-free,
performance-*, history-*, favorite → replace with a small commented "semantic role" section
(`--color-role-a/b/c` demo aliases) showing HOW to add app semantics. Keep Geist fonts + fonts.css.
`README` documents: "re-skin = edit @theme in globals.css".

## Dependencies (package.json)
deps: @base-ui/react, @dnd-kit/{core,modifiers,sortable,utilities}, @hugeicons/core-free-icons, @hugeicons/react,
@tailwindcss/vite, @tanstack/react-table, @tanstack/react-virtual, @tauri-apps/api, plugins (autostart,
clipboard-manager, dialog, opener, os), class-variance-authority, clsx, cmdk, motion, react, react-dom,
tailwind-merge, tailwindcss, use-intl, virtua, zod, zustand.
devDeps: @biomejs/biome, @tauri-apps/cli, @types/{bun,node,react,react-dom}, @vitejs/plugin-react,
babel-plugin-react-compiler + @rolldown/plugin-babel + @babel/core, typescript, ultracite, vite, knip,
@happy-dom/global-registrator, @testing-library/react.
Match WinSTT versions (copy from its package.json).

## Rust crate keep-set (from WinSTT src-tauri)
Generic infra to port: bootstrap/plugins (log, store, os, dialog, opener, clipboard, single-instance,
autostart, global-shortcut), commands_registry (specta builder + TS export), window specs module
(pattern from winstt/commands/windows.rs, 4 labels above, placement for picker anchor), window_state
(show_main_window), tray (simple: left-click show, native menu Show/Settings/Quit), portable.rs
(portable data dir marker), settings core (settings/store.rs pattern + schema), downloads.rs VERBATIM
+ new ~200-line generic manager (worker pool, pause-park, resume, cancel, progress emit) + commands/download.rs.
Strip: everything STT/TTS/LLM/audio/context, ort, sidecar, DPAPI secret seal (keep plain values; note in docs).

## i18n
en.json only (all UI strings through use-intl; infra supports adding locales). Keep check-i18n.ts +
check-no-literal-string.ts tools.

## Packaging
bundle.targets nsis+appimage+deb+rpm (+dmg via macOS script). Custom portable-by-default NSIS template
(pruned: no AVX2 gate, no runtime DLLs, no sidecar). tools/windows/tauri-portable.ps1 (simplified),
tools/{linux,macos}/tauri-bundles.sh. CI: ci.yml (lint/typecheck/test/build), release.yml
(windows nsis+portable zip, linux appimage/deb/rpm, macos aarch64+x86_64 dmg). Icons: placeholder
geometric mark generated by tools/assets/generate-icons.py → icons/ + tray PNGs.
