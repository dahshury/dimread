# NOTES — packaging + CI

Decisions and deviations made while building the packaging/CI layer from
WinSTT (`E:\DL\Projects\WinSTT`) per `TEMPLATE_SPEC.md`. Delete once absorbed.

## File inventory

```
src-tauri/nsis/installer.nsi        portable-by-default NSIS template (pruned WinSTT fork)
src-tauri/tauri.conf.json           + mainBinaryName, bundle.macOS/linux/windows blocks
src-tauri/icons/*                   regenerated placeholder icons (neutral diamond mark)
tools/tauri-ci-artifacts.conf.json  {bundle.createUpdaterArtifacts:false} overlay
tools/windows/tauri-build.ps1       vcvars64 + optional LLVM + `bun run tauri build`
tools/windows/tauri-portable.ps1    dist/DimRead.exe + DimRead-portable{,.zip}
tools/linux/tauri-bundles.sh        appimage,deb,rpm → dist/linux/
tools/macos/tauri-bundles.sh        app,dmg (+ .app.tar.gz) → dist/macos/<arch>/
tools/assets/dimread_mark.py        the brand mark, drawn procedurally (Pillow)
tools/assets/generate-icons.py      mark → app icons + the 32-PNG tray state family
.github/workflows/ci.yml            frontend gate
.github/workflows/rust-ci.yml       rust gate + cross-platform matrix + linux bundle gate
.github/workflows/release.yml       tag/dispatch release pipeline + publish job
README.md
```

## Decisions

- **`mainBinaryName: "dimread"`** added to tauri.conf.json so the shipped
  binary matches the spec's identity (`dimread`) without touching the
  Rust crate (cargo bin stays `dimread`; the Tauri CLI renames the built
  binary). `tauri-portable.ps1` accepts either exe name defensively.
- **Updater artifacts default OFF in the base config** (`createUpdaterArtifacts`
  unset = false) so `bun run tauri build` works out of the box with no
  minisign key — the right default for a template. The
  `tools/tauri-ci-artifacts.conf.json` overlay is still threaded through every
  script/workflow, so flipping the base config to `true` for signed releases
  keeps CI-only builds key-free (WinSTT's pattern). Enablement steps are
  documented in release.yml's header. The updater *plugin* is registered in
  Rust with default (empty) config — add `plugins.updater.pubkey/endpoints`
  when enabling.
- **No `tauri.windows.conf.json` overlay**: WinSTT's existed only to remap
  runtime DLLs/sidecar into the bundle; this template ships no resources at
  all, so the base config's array form suffices. Add a per-platform overlay
  only when a platform needs a different resource map.
- **Linux depends pruned** to `libayatana-appindicator3-1` (deb) /
  `libayatana-appindicator-gtk3` (rpm) — required at runtime by the tray icon;
  webkit/gtk deps are added by the bundler automatically. Dropped WinSTT's
  espeak-ng/wtype/ydotool/xdotool/wl-clipboard/libgtk-layer-shell0 and the rpm
  `compression: none` override (payload is small).
- **NSIS template pruning** (diffed against WinSTT's — see below): removed the
  AVX2 `.onInit` gate + its `PF_AVX2_INSTRUCTIONS_AVAILABLE` define, and the
  WinSTT legacy empty-marker/scoop update-detection branch. Parametrized the
  portable marker to `"${PRODUCTNAME} Portable Mode"` (matches
  `PORTABLE_MARKER_MAGIC` in portable.rs while `productName` is
  "DimRead"). Kept: install-type radio page, /PORTABLE flag,
  portable-by-default `.onInit`, marker + `Data/` creation, all portable skip
  guards, 64 MiB LZMA dict (comment de-branded), update-mode marker
  auto-detection. Fork base: tauri-v2.9.1 upstream (same as WinSTT); the
  installed CLI is 2.11.x — diff against upstream on Tauri upgrades.
- **tauri-build.ps1**: kept vcvars64 import (predictable MSVC env on any
  machine/runner); LLVM lld-link is now *optional* (used when present, never
  required — the crate links fine with stock link.exe, per NOTES-rust). All
  sidecar builds, DLL staging (DirectML/CRT), and bundle-boundary file
  assertions removed. Default action is `--bundles nsis` (WinSTT defaulted to
  `--no-bundle`).
- **tauri-portable.ps1**: pruned resources/models/sidecar/DLL mirroring —
  packages exe + marker + empty `Data/` only, with a comment telling adopters
  to mirror `bundle.resources` there if they add any. Marker written with the
  exact magic string portable.rs validates (content-checked, not just
  existence). Also copies the NSIS exe to `dist/DimRead.exe` (it IS the
  portable installer) like WinSTT does.
- **Linux/macOS scripts**: removed sherpa/ort native-cache scrubbing, sidecar
  cargo build + resource-map JSON injection, and the macOS `--features coreml`
  flag. Kept: CI overlay default with `TAURI_BUNDLE_CONFIG` override ("none"
  supported), stale-bundle-dir clearing, `.app.tar.gz` creation, arch-suffixed
  artifact names, `APPIMAGE_EXTRACT_AND_RUN=1`.
- **rust-ci.yml**: the Windows job creates a stub `dist/index.html` before
  cargo (frontendDist must exist for the tauri context macro; dist/ is
  gitignored so a bare checkout lacks it — WinSTT never hit this because its
  jobs run heavier steps first). Cross-platform jobs build the real renderer
  first instead. Dropped: sherpa/ort cache scrubbing, LLVM PATH step, startup
  bundle budget, package audits, cargo-deny (no deny.toml in this repo),
  repo-slug check, Windows package gate (release covers it; keeps PR CI lean
  per spec).
- **release.yml**: replaced WinSTT's workflow_run chaining + alpha-only policy
  + README badge sync + custom upload script with a simple tag-push/dispatch
  trigger, version-lockstep + tag-match validation, and an inline
  `gh release create/upload` publish job (`--generate-notes`, draft input,
  auto `--prerelease` for versions with a pre-release segment). macOS x86_64
  cross-compiles on the arm64 `macos-latest` runner (`--target
  x86_64-apple-darwin`) instead of the deprecated Intel `macos-13` pool.
- **Icons**: `generate-icons.py` draws everything from the procedural mark in
  `tools/assets/dimread_mark.py` (Pillow only — no source image, no numpy).
  One geometry — the **temperature disc**: a circle split through its centre,
  brand indigo on the cool/identity half, the emitted light on the warm/state
  half, and the active mode's glyph KNOCKED OUT of the whole disc.
  - App icons get the mark on a dark squircle tile.
  - Tray icons get the bare mark on transparency — **no tile**. A tile costs
    ~30 % of a 16 px budget and is a dark smudge on a dark taskbar.
  - The tray set is 8 modes × day/night × light/dark taskbar = **32 PNGs** at
    64 px, written to the exact `include_bytes!` paths in tray.rs
    (`icons/tray/<mode>-<phase>-on-<theme>.png`). The warm half carries the
    day/night state (pale cool vs amber); the cool half only changes for
    taskbar contrast.
  - Every glyph is clipped to a centred circle of radius `0.40 D`, so the disc
    always keeps a ring of colour around it. This is asserted at render time:
    without it a wide glyph runs through the disc edge and the mark stops
    reading as a disc at all.
  - `contact-sheet.png` in `tools/assets/icon-preview/` renders every state at
    32/20/16 px over both taskbar tones. Look at it after touching a glyph —
    small-size legibility is the whole job and 512 px tells you nothing.

  This supersedes both the earlier `dimread-icon-master.png` pipeline (deleted)
  and the single-state-per-theme tray it fed. WinSTT's mascot-derived pipeline
  is still gone.

## Verification (2026-07-16)

- `generate-icons.py` ran clean (`uv run --with pillow --with numpy`); 7 files
  emitted; `icon.ico` verified multi-size (16/24/32/48/64/128/256); tray PNGs
  64×64 RGBA; 128px render visually inspected.
- `cargo check` clean and `cargo test` 34/34 after the icon swap + conf edits
  (includes the `embedded_tray_icons_decode` test against the new PNGs).
- All 3 workflows parsed with PyYAML; both JSON configs parsed.
- NSIS template diffed against WinSTT's: only the intended deltas (header,
  AVX2 removal, marker parametrization, legacy-marker branch removal,
  comment rewording).

## Known gaps

- **NSIS untested locally** (no makensis here) — first real validation is the
  release/`tauri build --bundles nsis` path on a Windows runner or dev box.
- **Portable zip requires WebView2** already installed (the installer exe
  bootstraps it; the raw zip cannot). Documented in README.
- `tauri-portable.ps1 -SkipBuild` was not dry-run (requires a prior release
  build); path assumptions were statically verified against tauri.conf
  (`mainBinaryName`, `target/release/bundle/nsis`).
- macOS builds are ad-hoc signed; notarization is left to adopters.
