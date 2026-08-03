# Changelog

All notable changes to DimRead are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The day/night schedule now uses real sun times out of the box.** A fresh
  install defaults to location-based scheduling with the source set to automatic
  detection, so sunrise and sunset are resolved from the system timezone without
  entering anything. Previously the schedule defaulted to fixed 07:00/19:00 clock
  times, and the only way to say "here" was a coordinate pair — so switching to
  location mode on an untouched install landed on 0°, 0° (the Gulf of Guinea) and
  scheduled an equatorial day. The Rust default and the zod schema move together;
  a test asserts they cannot drift apart.
- **New brand mark — "the Dial".** The app and tray icons are redrawn from one
  invariant disc cut by straight seams into an identity body colour and an accent
  region showing the light being emitted. The display mode changes the accent's
  shape, the day/night phase changes only its hue, and the taskbar theme selects
  the palette. Pause is the only state with no seam, so "nothing is being applied"
  reads at a glance.

  The outline is now byte-identical across all 32 tray states, and no part of the
  mark comes near the taskbar's own luminance in either theme — the on-light
  palette separates body from accent by hue at matched lightness rather than by
  contrast. Both properties are asserted by the generator, because the previous
  mark encoded part of its state in the silhouette and could appear to change
  *shape* between day and night on a dark taskbar.

- The widened temperature range is documented accurately as 1000–10000 K: only
  the ceiling moves, the floor stays at 1000 K.

### Documentation

- The docs site gets a rebuilt landing page — hero, stat row, feature grid, an
  interactive Kelvin spectrum, a screenshot gallery and an honest per-platform
  support table — plus a vendored copy of Geist so the fonts survive the
  `/dimread/` sub-path, and section separators and per-page icons in the sidebar.
- `README.md` is rebuilt to mirror that landing page, with the mark at the top.
- The tray documentation now describes how to read the new mark.

## [0.0.4-alpha] - 2026-07-31

### Added

- **Settings backup.** The About tab can export every setting to a readable,
  versioned JSON file and restore one, plus reset everything to defaults. The
  import replaces the whole tree through the same revision-checked commit path a
  normal save uses, so every open window converges on the result.
- **Diagnostics, on the same tab.** Open the rolling log folder, save a support
  bundle (logs, system information, recent failures) as a ZIP, review the recent
  operational issues DimRead recorded locally, and stream live debug lines while
  the page is open. Streaming is off until started and stops when you leave.
- **Anonymous reporting is now an explicit opt-in**, off by default, and does
  nothing unless a reporting service is configured.
- **Hotkeys distinguish "saved" from "actually active".** A shortcut another
  application already owns is now reported as unavailable with the reason
  instead of sitting in the list looking bound and doing nothing. The roster is
  also validated as a desired end state before anything touches the OS, so
  swapping two shortcuts works and an exact duplicate disables both rows rather
  than half-applying.
- **"Use mode values" per monitor** — drop a per-monitor override and return
  that display to the active mode's preset, without clearing the others.
- **Focus Blur survives a restart.** Its enabled state is persisted and restored
  once the overlay renderer is ready, and reconciliation is edge-driven so an
  unrelated settings save cannot undo a runtime toggle made by the hotkey.
- The day/night scheduler caps its next wake at the next timezone offset change,
  so a DST boundary is re-evaluated when it happens rather than at the following
  schedule deadline.

### Changed

- **Start on login moved from General to About**, next to the privacy switch it
  belongs with.

### Fixed

- **The brightness and temperature sliders no longer stall during a day/night
  transition.** While the schedule ramps, the engine applies a blend of the day
  and night endpoints — but every surface (the Display tab, the tray flyout, and
  the ± hotkeys) treated "transition" as *day* and edited the day endpoint. Late
  in an evening ramp that endpoint carries almost none of the applied value, so
  dragging brightness to its 10 % floor moved the screen by a few percent and
  the control looked stuck well above its own minimum — then "fixed itself" an
  hour later when the ramp ended. Manual edits now land on the endpoint that
  dominates what is on screen, which bounds any edit's authority at half the
  slider's travel; a drag mid-ramp previews that endpoint directly instead of
  through the blend; a release commits to the endpoint the drag started on even
  if the ramp crosses over mid-gesture; and the Day/Night control unlocks
  mid-ramp with a line saying the screen is between the two profiles.

### Removed

DimRead began as a starter template extracted from WinSTT. It is not one any
more, and the scaffolding that served that role is gone — **236 files and about
33,000 lines, roughly half the renderer.** None of it was reachable from the
running app.

- **The component gallery** (window, entry, and view) and the 21 `shared/ui`
  components nothing else consumed: the data grid, calendar heatmap, charts,
  thinking indicator, toast, modal, sortable list, file drop zone, multi
  combobox, pending badge, pulse dot, scrolling text, stagger reveal, mode
  switch, item card, kbd, media seek bar, opt-in dialog, creatable combobox and
  editable-list combobox. The gallery had no way to open it from anywhere in the
  UI, yet it was pre-created at every launch.
- **The picker and overlay windows**, end to end. Nothing imported the picker's
  open/close API, and the notification pill's only producer in the entire
  codebase was the download manager.
- **The download manager** — the frontend feature, the progress UI, the Rust
  module and its seven commands, the `downloads` settings section on both sides,
  and the General tab's parallel-downloads control, which tuned an engine that
  nothing invoked.
- 14 unused `shared/lib` helpers, 465 message keys across 14 namespaces, and 11
  npm dependencies (`@dnd-kit/*`, `@tanstack/react-table`,
  `@tanstack/react-virtual`, `cmdk`, `virtua`, `class-variance-authority`,
  `double-metaphone`, `@tauri-apps/plugin-dialog`).
- `Select`'s drag-to-sort rows, which no caller enabled and which were the last
  thing importing the data grid's primitives.

The window roster went from seven to four — `settings`, `focus-overlay`,
`tray-menu`, `magic-toolbar` — which is four fewer WebView2 renderer processes
resident for the life of the app.

Worth recording *why* this went unnoticed: the gallery imported the unused half
of the design system, so `bun run check:deadcode` saw a real consumer for every
dead component and reported a clean tree. A showcase that imports otherwise
unreferenced code defeats dead-code detection.

## [0.0.3-alpha] - 2026-07-28

### Added

- **Location-aware day and night.** "Time based on location" now offers three
  sources: **Automatic**, which reads the system timezone and uses that zone's
  reference locality; **Timezone**, a searchable picker over the full IANA
  database; and **Coordinates**, the hand-entered pair. Sun times stay pure NOAA
  math computed offline, so nothing is sent anywhere and no OS location
  permission is requested. The panel shows which source actually produced the
  coordinates and today's sunrise and sunset, and says so plainly when a zone
  cannot be detected or has no known locality — instead of silently falling back
  to 0°, 0°.
- The zone table behind it, `src-tauri/src/display/timezones_data.rs`, generated
  from the IANA tzdb (`zone.tab` plus `backward` aliases) by
  `tools/timezones/generate-timezones.py`. Tests reject a table that is
  unsorted, implausible, or contains an alias resolving nowhere.
- **Per-monitor opt-out.** A display can now sit out filtering entirely. This is
  a separate axis from monitor sync: sync picks which *values* a screen gets,
  the opt-out picks whether it participates at all, so one untouched screen no
  longer means leaving sync mode. An excluded monitor has its original ramp
  restored while its neighbours keep filtering, and an unplugged display keeps
  its exclusion across a dock/undock cycle.
- **Smooth transitions.** Colour and brightness changes ease toward their target
  (about 360 ms for a mode switch) instead of snapping, including live slider
  drags. The ease is exponential rather than a fixed-duration ramp precisely
  because the target moves during a drag.
- **HDR support for MagicX.** On advanced-colour displays the Magnification API
  refuses colour effects outright — the same reason Windows Magnifier greys out
  "Invert colours" there. Those targets now run on a second backend built from
  Windows.Graphics.Capture, a half-float capture pool, a pixel shader, and a
  DirectComposition overlay, with the backend chosen per target from the
  monitor's DXGI colour space. SDR targets keep the cheap composition-time
  matrix.
- **The Windows theme schedule can follow the day and night schedule.** On by
  default, it takes its boundaries from the same sun times the colour filter
  runs on — including a resolved location's astronomy — so the two cannot
  disagree about when night starts. The separate HH:MM pair remains as the
  opt-out.
- **Check for updates** in the About tab. A manual button asks the GitHub
  releases API what the newest published version is, compares it with the
  running build, and offers the download asset for the current OS and
  architecture. It runs only when pressed — DimRead never contacts the network
  on its own — and there is no in-app installer, because the alpha builds are
  unsigned.
- A public documentation site at `docs-site/` (Fumadocs on React Router + Vite),
  published to GitHub Pages by `.github/workflows/docs.yml` and linked from the
  About tab. Twelve pages covering every settings tab plus troubleshooting, an
  FAQ, and diagnostics.
- `tools/docs/capture-screenshots.mjs`, which drives the real renderer with
  Playwright behind a mocked IPC bridge and writes the documentation
  screenshots. Settings values in the images come from the app's own zod schema
  and the version from `tauri.conf.json`, so they cannot drift from the code.
- `bun run check:rust:linux` — the Linux half of Rust CI (fmt, check, clippy
  with `-D warnings`, tests) reproduced locally in Docker, so the
  Windows-only-code-goes-dead-on-Linux class of failure is caught before a push
  instead of on a CI runner.

### Changed

- **The settings rail is grouped on one axis and has three fewer tabs.**
  *Screen* holds what changes your display — Display, Schedule, App rules,
  Window effects — and *App* holds what is about DimRead itself: Hotkeys,
  General, About. "Day & night" and "Auto dark" were one question answered on
  two tabs and are now **Schedule**; "Magic window" became a section of **Window
  effects**; "Appearance" became a section of **General**.
- The monitor strip and the monitor inventory were two controls describing the
  same hardware in two vocabularies ("Monitor 1" versus the display's real
  name). They are now one roster that does targeting, opt-out, and inventory
  together.
- Every global shortcut is bound on the **Hotkeys** tab. The Focus and MagicX
  tabs used to carry their own recorder rows, which split the roster across
  three places and made conflicts hard to see; those tabs now keep only their
  effect options.
- "Disable for full-screen apps" moved from the Display tab to **App rules**,
  where it belongs: it is driven by the same rules watcher as the user's own
  list, so it is that feature's zeroth rule rather than a display option.
- The About tab's links now point at the product: the repository, the
  documentation site, and the releases page — replacing the author profile,
  Tauri's documentation, and WinSTT.
- The brand mark generator was reworked, and the tray and application icons
  regenerated from it.

### Fixed

- Choosing "time based on location" on a fresh install no longer schedules sun
  times for the Gulf of Guinea. The stored coordinates defaulted to 0°, 0° and
  were used as-is, which produced an equatorial 06:00/18:00 day everywhere; the
  new default is detection. Settings files that predate the location source and
  carry real coordinates keep them.
- A slider drag no longer snaps. The animator now eases from what was last
  *written* to each device rather than from the previous apply's target — a
  value the screen never reached mid-drag.
- Focus Blur's "Include taskbar" option now takes effect immediately. The
  foreground tracker retains the window the shade is anchored to, so a settings
  edit, a taskbar move, or a display change is republished even while DimRead's
  own window holds focus — previously the shade kept the region set it was last
  emitted with, which left the taskbar tinted until another app was clicked or
  the app was restarted.
- A MagicX target the platform refuses to effect is now dropped rather than
  remembered, so the Magic Toolbar's button no longer stays lit for an effect
  that is not on screen.
- Windows that report an oversized frame (a maximized window's invisible resize
  border) are pinned to their DWM extended frame bounds, so the effect host, the
  capture overlay, and the toolbar tracker all agree on where a window is.

## [0.0.2-alpha] - 2026-07-25

### Added

- Native display control backends for macOS and Linux, including X11 and
  wlroots Wayland monitor and gamma support.
- A generated 32-state tray icon family covering every display mode, day/night
  phase, and light/dark taskbar combination, with a small-size contact sheet for
  visual review.
- More focused regression coverage for native-event subscriptions, scrolling,
  touch rubber-banding, data-grid toasts, overlays, and quick controls.
- A deterministic frontend dependency-cycle check in the local and CI gates.

### Changed

- Consolidated DimRead into one top-level settings window. Live monitor,
  temperature, brightness, schedule, and preset controls now sit at the top of
  the Display tab and remain available from the tray flyout.
- Reworked display scheduling, monitor discovery, gamma restoration, focus
  overlays, Magic Window behavior, picker placement, and window lifecycle for
  more predictable cross-platform behavior.
- Improved renderer event cleanup, settings synchronization, motion, scrolling,
  and data-grid interactions across auxiliary windows.
- Replaced the source-image icon pipeline with a fully procedural brand mark
  shared by application and tray assets.

### Removed

- The former standalone `main` window and its duplicate title/status chrome.
- The two generic tray icons superseded by mode- and phase-aware variants.

### Fixed

- Corrected target-specific Rust compilation for Linux and macOS by keeping
  Win32 listeners behind platform guards and using the native CoreGraphics
  display-ID type during macOS monitor resolution.

[0.0.2-alpha]: https://github.com/dahshury/dimread/compare/v0.0.1-alpha...v0.0.2-alpha
[0.0.3-alpha]: https://github.com/dahshury/dimread/compare/v0.0.2-alpha...v0.0.3-alpha
[0.0.4-alpha]: https://github.com/dahshury/dimread/compare/v0.0.3-alpha...v0.0.4-alpha
