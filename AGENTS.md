# DimRead — Agent & Contributor Instructions

Read this before changing code. It applies to human contributors and AI agents alike.

## What this project is

A generic Tauri v2 + React 19 desktop-app starter template. It ships a design system
(Tailwind v4 tokens + Base UI primitives), a multi-window app shell (the app window +
detachable picker + gallery + a click-through notification overlay + the tray flyout),
a settings pipeline with cross-window sync, a generic download manager, and
settings-driven global hotkeys — extracted from WinSTT with all speech/AI domain logic
removed.
`TEMPLATE_SPEC.md` records the extraction contract; `NOTES-*.md` record build decisions.

### There is ONE top-level window

DimRead is a tray app. Its only visible surface is the **settings window**
(`windows::PRIMARY_WINDOW`, label `settings`, served from the Vite ROOT entry
`index.html`): the live controls — monitor strip, K/% readout, temperature and
brightness sliders, auto day/night, the eight preset modes — render at the top of its
**Display** tab via `widgets/quick-controls`, and every configuration surface sits one
sidebar tab away. The tray flyout (`tray-menu`) is the only other control surface and
drives the same `features/display` seam.

There used to be a separate compact `main` window holding those live controls. It is
gone, deliberately. Do not add a second top-level window for "quick" controls — a test
in `src-tauri/src/windows/mod.rs` fails if one appears. A tray LEFT click, the
`toggleMain` hotkey (the id is a persisted settings field; it toggles the app window)
and the flyout's Settings row all surface that one window.

## Architecture — do not erode these boundaries

### Frontend: Feature-Sliced Design (FSD) — ENFORCED

`src/` follows FSD v2.1 layers: `app → views (pages) → widgets → features → entities → shared`.
Imports must only point downward. `shared/` never imports from any other layer.

- The **feature-sliced-design skill is pre-installed** at `.claude/skills/feature-sliced-design/`
  (AI agents: invoke it when creating/moving frontend modules).
- Its deterministic checker gates the structure:

  ```sh
  bun run check:fsd
  ```

  Fix every ERROR before committing. REVIEW flags must either be resolved or acknowledged
  with a reason in `fsd.config.json` (see the existing `widgets/status-bar` entry for the format).

### Backend: preserve the Rust module structure

`src-tauri/src/` is organized by infrastructure concern — keep it that way:

- `windows/` — window roster (`WINDOW_SPECS`), placement, modal-child + picker-anchor logic
- `settings/` — schema, atomic store, revision-checked save commands
- `downloads/` — `transfer.rs` (generic streaming engine — treat as vendored; avoid editing),
  `manager.rs` (worker pool), `commands.rs`
- `hotkeys/` — global-shortcut registry (register/replace/unregister commands, settings-driven
  arming with hot-swap, the built-in `toggleMain` behavior, `hotkey:triggered` broadcast)
- `overlay/` — the notification pill: `overlay_notify`/`overlay_dismiss`, top-center placement,
  sequence-guarded hide timers (the `overlay` window itself lives in `WINDOW_SPECS`)
- `tray_menu/` — the tray FLYOUT (the `tray-menu` window): tray-anchored placement,
  park-off-screen dismissal, blur-to-dismiss with a resize grace, `tray_menu_hide` /
  `tray_menu_resize`. There is deliberately no native tray menu — the flyout is a
  renderer (`src/views/tray-menu/`) so the tray can host real sliders.
- `bootstrap/` — plugin registration; `commands_registry.rs` — the specta builder
- `tray.rs` (icon + tooltip + click routing only), `portable.rs`, `window_state.rs`, `events.rs`

New backend features get their own module + a command file registered in `commands_registry.rs`.
Do not put business logic in `lib.rs` (it is boot orchestration only).

### Icons are generated, not drawn

`src-tauri/icons/` is build output. The brand mark lives as code in
`tools/assets/dimread_mark.py`; `tools/assets/generate-icons.py` renders it into the app
icons AND the tray's **32-PNG state family** — 8 display modes × day/night phase ×
light/dark taskbar — which `tray.rs` embeds with `include_bytes!`.

```sh
python tools/assets/generate-icons.py     # or: uv run --with pillow ...
```

Adding a display mode therefore means adding its glyph to `MODE_GLYPHS`, its id to
`DISPLAY_MODE_IDS` (`settings/mod.rs`) and to `TRAY_ICON_VARIANTS` (`tray.rs`), then
re-running the generator. Rust tests fail if those rosters drift, if any of the 32 files
is missing or undecodable, or if two states share artwork. Never hand-edit a file under
`src-tauri/icons/`, and always eyeball
`tools/assets/icon-preview/contact-sheet.png` after a glyph change — a tray icon is
judged at 16 px, not at 512.

### Docs live in `docs-site/`, and its screenshots are generated

`docs-site/` is a **separate npm project** (Fumadocs + React Router + Vite, its own
`package.json` and lockfile) publishing to GitHub Pages at
`https://dahshury.github.io/dimread/`. The app's About tab links there
(`src/shared/config/product-links.ts`), so a broken docs build is a broken link inside
the product. Content is MDX under `docs-site/content/docs/`; the sidebar order is
`content/docs/meta.json`; the palette is the app's own tokens, re-declared in
`docs-site/app/app.css`.

Its screenshots are **build output, not artwork**. `tools/docs/capture-screenshots.mjs`
mocks the Tauri IPC bridge, drives the real renderer with Playwright, and takes the
settings defaults from `appSettingsSchema` — so a changed default changes the pictures.

```sh
bun run dev:vite      # serve the renderer
bun run docs:shots    # → docs-site/public/screenshots/*.webp
```

Run it with **Node**, not Bun (Playwright's CDP pipe does not survive Bun's
child-process plumbing on Windows) — `bun run docs:shots` already does.
Never hand-edit a file under `docs-site/public/screenshots/`. After changing a page,
run `cd docs-site && bun run typecheck && bun run build && bun run check:links`;
the link audit fails on invented slugs, dead anchors, missing screenshots, and a
download version that has drifted from `tauri.conf.json`.

### The timezone table is generated too

`src-tauri/src/display/timezones_data.rs` is generated from the IANA tzdb
(`zone.tab` + `backward`) — it maps every zone to its reference locality, which is
how "time based on location" gets coordinates offline with no permission prompt
(`display/timezones.rs`), and what the manual timezone picker lists. Never
hand-edit it; re-run the generator after a tzdb release:

```sh
python tools/timezones/generate-timezones.py
```

Rust tests fail if either table is unsorted, implausible, or contains an alias
that resolves nowhere.

### IPC: bindings are generated — never hand-edit

`src/bindings.ts` is generated by tauri-specta. After changing Rust commands/events:

```sh
cd src-tauri && cargo test export_bindings
```

Event names live in `src/shared/api/native-events.ts` and must match `src-tauri/src/events.rs`.

## Design system rules

- **Re-skin in ONE place**: the `@theme` blocks in `src/app/styles/globals.css` (marked
  "RE-SKIN HERE"). Never hardcode colors in components — use tokens/utilities.
- Surface elevation: components render at `useSurface()` level and provide `level + 1`
  to children (`ElevatedSurface` / `surfaceClasses`). Don't hardcode `bg-surface-N`.
- Motion: `m.*` components only (LazyMotion strict) with tiers from `@/shared/lib/springs`.
  Never the `layout` prop.
- Icons: HugeIcons via `<HugeiconsIcon icon={...} />`. Class merging via `cn()` from
  `@/shared/lib/cn`.
- All user-visible strings go through use-intl (`messages/en.json`); the lint gate rejects
  JSX string literals.

## Verification gates — run before committing

```sh
bun run lint          # Biome + i18n literal guard
bun run typecheck     # app + node (bun run typecheck:tests for test files)
bun run test          # bun test ./src
bun run check:fsd     # FSD structure checker
bun run check:i18n    # message-key parity
bun run check:deadcode
bun run check:react   # react-doctor full scan (--no-supply-chain, blocks on errors)
bun run check:rust    # host cargo fmt --check + clippy -D warnings + test
bun run check:rust:linux   # the SAME Rust gates on Linux, in Docker (see below)
```

CI runs the same gates (`.github/workflows/ci.yml`, `react-doctor.yml`, `rust-ci.yml`).
Releases are tag-triggered (`v*`, `release.yml`) and require version lockstep across
`package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` — plus
`docs-site/app/lib/shared.ts` and the version strings in `README.md` and
`docs-site/content/docs/`, which `cd docs-site && bun run check:links` verifies.

### Cross-platform Rust: check Linux locally, do not discover it in CI

`cargo clippy` on Windows never compiles the `#[cfg(not(windows))]` half of this
crate, so a helper that only the Windows build uses goes **dead** on macOS and
Linux, and clippy fires there with `-D warnings`. That has broken CI more than
once and it is invisible on the developer's machine.

```sh
bun run check:rust:linux         # fmt + check + clippy -D warnings + test, on Linux
bun run check:rust:linux:quick   # clippy only — fastest signal
```

It builds `tools/linux/Dockerfile.check` (the ubuntu CI job's toolchain and
system libraries) and runs the gates against the live work tree; the registry and
target directory live in named Docker volumes, so only the first run is slow and
`src-tauri/target` is never touched. It needs a running Docker engine.

macOS has no local equivalent — its gate is the `cross-platform (macos-latest)`
job. When touching `#[cfg]`-gated code, keep the pattern that survives both:
gate the *helpers* with the same `cfg` as their only caller (or `#[cfg(any(windows,
test))]` when a unit test needs them), rather than leaving them unconditional.

### Git hooks

Git hooks auto-install on `bun install` (the `postinstall` script runs
`bun run hooks:install`, pointing `core.hooksPath` at `.husky/`). Skip them for a
one-off command with `DIMREAD_SKIP_GIT_HOOKS=1` (or `HUSKY=0`).

- **pre-commit** — lockfile check, lint, typecheck, `check:fsd`, `check:cycles`,
  plus an advisory (non-blocking) react-doctor scan of the staged files.
- **pre-push** — lockfile check, tests, `check:deadcode`, `check:i18n`, the
  blocking `check:react` scan, and then `prepush:scoped`
  (`tools/git-hooks/prepush-scoped.mjs`): the gates the renderer checks do not
  cover, path-scoped exactly like the workflows are, so a renderer-only push
  pays nothing extra.
  - `src-tauri/**` in the push → host `cargo fmt`/`clippy -D warnings`/`test`,
    the generated-bindings assertion, then the Linux container gate
    (skipped with a warning if Docker is not running).
  - `docs-site/**` in the push → docs typecheck, build, and link audit.

Never bypass a failing hook with `--no-verify`; fix the cause instead.
False-positive react-doctor findings are suppressed per-file in
`doctor.config.json` — document the reason in the relevant `NOTES-*.md`.

## Conventions

- Formatting: tabs, double quotes (Biome; `bun run format`). Rust: `cargo fmt`.
- One component per folder under `src/shared/ui/` with an `index.ts` barrel and
  colocated `*.test.tsx`.
- `bun run dev` launches the full desktop app (`tauri dev`). `bun run dev:vite` is
  the frontend-only Vite server — it is what Tauri's `beforeDevCommand` calls, so
  never point `dev` back at `tauri dev`'s own entry point or it recurses.
- Windows dev: the dev server runs on port 1430 (HMR 1431). If 1430 is busy, use
  `bun run dev:altport` (port 1440).
- The updater plugin is opt-in — see `src-tauri/src/bootstrap/plugins.rs` and README
  before enabling.

## Renaming the template for a new app

Follow the checklist in `README.md` ("Re-skinning"): package.json name,
`tauri.conf.json` productName/identifier/mainBinaryName, Cargo crate name, icons via
`tools/assets/generate-icons.py`, and the NSIS `PORTABLE_MARKER_MAGIC` coupling.
