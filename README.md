<p align="center">
  <img src="src-tauri/icons/512x512.png" alt="DimRead" width="112" height="112">
</p>

<h1 align="center">DimRead</h1>

<p align="center">
  <b>A warmer screen, from sunset to sunrise.</b>
</p>

<p align="center">
  <sub>v0.0.4-alpha · Windows, macOS and Linux</sub>
</p>

<p align="center">
  DimRead is a tray app that controls your display's colour temperature and
  brightness in software — per monitor, on a schedule, and below the floor your
  monitor's own controls will go.
</p>

<p align="center">
  <a href="https://dahshury.github.io/dimread/docs"><b>Get started</b></a>
  ·
  <a href="https://github.com/dahshury/dimread/releases">Releases</a>
  ·
  <a href="#build-from-source">Build from source</a>
</p>

## Download

One click, straight to the file — no scrolling through the releases page.

<!-- DOWNLOAD_BADGES:START -->

<p align="center">
  <a href="https://github.com/dahshury/dimread/releases/download/v0.0.4-alpha/DimRead.exe"><img alt="Download DimRead for Windows" src="https://img.shields.io/badge/Download--Windows%20(portable)-0A66C2?style=for-the-badge&logo=windows11&logoColor=white&labelColor=0A66C2"></a>
  &nbsp;
  <a href="https://github.com/dahshury/dimread/releases/download/v0.0.4-alpha/DimRead_0.0.4-alpha_aarch64.dmg"><img alt="Download DimRead for macOS" src="https://img.shields.io/badge/Download--macOS-111111?style=for-the-badge&logo=apple&logoColor=white&labelColor=111111"></a>
  &nbsp;
  <a href="https://github.com/dahshury/dimread/releases/download/v0.0.4-alpha/DimRead_0.0.4-alpha_amd64.AppImage"><img alt="Download DimRead for Linux" src="https://img.shields.io/badge/Download--Linux-F5B700?style=for-the-badge&logo=linux&logoColor=black&labelColor=F5B700"></a>
</p>

<p align="center">
  <sub><a href="https://github.com/dahshury/dimread/releases/download/v0.0.4-alpha/DimRead-portable.zip">Windows portable (.zip)</a> · <a href="https://github.com/dahshury/dimread/releases/download/v0.0.4-alpha/DimRead_0.0.4-alpha_x64-x86_64.dmg">macOS (Intel)</a> · <a href="https://github.com/dahshury/dimread/releases/download/v0.0.4-alpha/DimRead_0.0.4-alpha_amd64.deb">Debian / Ubuntu (.deb)</a> · <a href="https://github.com/dahshury/dimread/releases/download/v0.0.4-alpha/DimRead-0.0.4-alpha-1.x86_64.rpm">Fedora / RHEL (.rpm)</a> · <a href="https://github.com/dahshury/dimread/releases/tag/v0.0.4-alpha">All v0.0.4-alpha assets</a></sub>
</p>

<!-- DOWNLOAD_BADGES:END -->

> **Windows is portable — no installer.** Download `DimRead.exe`, run it, and it
> keeps its data next to the executable (in a `Data/` folder) with no registry
> writes. The portable `.zip` needs the Microsoft Edge **WebView2** runtime,
> which ships with Windows 11 and most Windows 10 installs.
>
> This is a **0.0.4-alpha** pre-release. Builds are unsigned, so the OS may warn
> on first launch — see [First-run notes](#first-run-notes) below.

<!-- SCREENSHOTS:START -->

<p align="center">
  <img alt="The DimRead settings window on its Display tab: a two-monitor list, colour temperature and brightness sliders reading 5500K and 85%, and the eight preset modes with Reading selected." src="docs-site/public/screenshots/settings-display.webp" width="820">
</p>

<p align="center">
  <img alt="The tray flyout: a compact panel with brightness and temperature sliders, the eight modes, and Settings and Quit rows." src="docs-site/public/screenshots/tray-flyout.webp" width="240">
</p>

<p align="center">
  <sub>Every image is captured from the real renderer by
  <code>bun run docs:shots</code> — none are mock-ups.</sub>
</p>

<!-- SCREENSHOTS:END -->

<table align="center">
  <tr>
    <td align="center"><b>1000–6500 K</b><br><sub>colour temperature</sub></td>
    <td align="center"><b>8</b><br><sub>preset modes</sub></td>
    <td align="center"><b>12</b><br><sub>global hotkeys</sub></td>
    <td align="center"><b>418</b><br><sub>time zones, offline</sub></td>
  </tr>
</table>

## The filter

### 1000 K to 6500 K, in 50 K steps

One slider spans candle-warm to unfiltered daylight in 50 K steps, and a second
takes brightness from 100 % down to 10 %. Both are software gamma, applied at
scan-out — which is why a screenshot of a dimmed screen comes out clean.

## What it does

### Six surfaces, one seam

Eight editable presets, a scheduler that interpolates between a day and a night
endpoint on every axis, and a set of overlays for the times a whole-screen filter
is the wrong tool.

| | |
| --- | --- |
| **[Per-monitor targeting](https://dahshury.github.io/dimread/docs/display)** | Every display shares one setting, or each one carries its own override. Switch a monitor off entirely and it keeps the original ramp it booted with. |
| **[Sunrise to sunset](https://dahshury.github.io/dimread/docs/schedule)** | Sun times are computed offline from a 418-zone table compiled into the app. No location prompt, no geolocation API, no network request. |
| **[Rules per app](https://dahshury.github.io/dimread/docs/app-rules)** | Match on process name, window class or title and switch modes when that window takes the foreground. Full-screen games drop the filter automatically. |
| **[Window effects](https://dahshury.github.io/dimread/docs/window-effects)** | A clear band that follows your reading, a spotlight that dims every other window, and per-window invert or grayscale on top of the global filter. |
| **[Twelve hotkeys](https://dahshury.github.io/dimread/docs/hotkeys)** | Step temperature and brightness, toggle the filter, Reading, Editing and every window effect. Bindings arm on save — nothing needs a restart. |
| **[It lives in the tray](https://dahshury.github.io/dimread/docs/tray-and-overlay)** | Right-click gets you the flyout: the same two sliders and all eight modes, without opening a window. The icon itself reports the active mode and phase. |

## Support

### Where it runs, honestly

DimRead is alpha, and the three platforms are not at the same place. This is what
actually works on each one today.

| Platform | Version | State |
| --- | --- | --- |
| **Windows** | 10 and 11 | Everything works here. The default install is portable: settings and logs sit beside the app, with no Add/Remove entry and no shortcuts. |
| **macOS** | 10.15 and later | Temperature and brightness apply through public CoreGraphics calls, with no permission prompts at all. *Per-app rules and the window effects are not wired up yet.* |
| **Linux** | X11 and wlroots | X11 goes through RandR 1.2. On Wayland, sway, Hyprland, river and labwc expose the gamma protocol DimRead needs. *GNOME and KDE do not expose it, so the filter has no effect there.* |

## First-run notes

DimRead's alpha builds are not code-signed or notarized yet, so each OS shows a
one-time "unknown developer" prompt:

- **Windows** — SmartScreen may say "Windows protected your PC." Click **More
  info → Run anyway**.
- **macOS** — right-click the app → **Open**, then confirm, or run
  `xattr -dr com.apple.quarantine /Applications/DimRead.app`.
- **Linux (AppImage)** — mark it executable (`chmod +x DimRead_*.AppImage`) and
  run it. The `.deb`/`.rpm` install a normal desktop entry.

## Build from source

Prerequisites: [Bun](https://bun.sh), [Rust (stable)](https://rustup.rs), and the
[Tauri v2 platform prerequisites](https://v2.tauri.app/start/prerequisites/) for
your OS.

```sh
bun install      # installs deps + git hooks
bun run dev      # launch the desktop app (tauri dev)
```

### Package the app

All bundle scripts use the `tools/tauri-ci-artifacts.conf.json` overlay
(`bundle.createUpdaterArtifacts: false`), so no signing key is needed.

```powershell
# Windows — portable executable + zip (no installer is published)
tools\windows\tauri-build.ps1
tools\windows\tauri-portable.ps1     # → dist\DimRead.exe, dist\DimRead-portable.zip
```

```sh
# Linux — AppImage + deb + rpm  → dist/linux/
bash tools/linux/tauri-bundles.sh

# macOS — dmg + .app archive  → dist/macos/<arch>/
bash tools/macos/tauri-bundles.sh aarch64-apple-darwin aarch64
bash tools/macos/tauri-bundles.sh x86_64-apple-darwin x86_64
```

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds all three platforms and attaches the **portable** Windows binaries,
Linux AppImage/deb/rpm, and macOS dmg/app archives to a GitHub release. Versions
must stay in lockstep across `package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml`.

## Architecture

DimRead is a **Tauri v2 + React 19** binary — native, no Electron. Its only
visible surface is the settings window; the tray flyout drives the same values.

The frontend follows **[Feature-Sliced Design](https://feature-sliced.design/)
(FSD v2.1)** (`app → views → widgets → features → entities → shared`, imports
pointing strictly downward), enforced by a deterministic checker:

```sh
bun run check:fsd
```

The Rust backend is organized by infrastructure concern (`windows/`, `settings/`,
`display/`, `hotkeys/`, `focus/`, `magicx/`, `rules/`, `tray_menu/`, `bootstrap/`),
with typed IPC generated by tauri-specta — after changing commands or events,
regenerate `src/bindings.ts` with `cd src-tauri && cargo test export_bindings`.

The brand mark is **code**, not a raster export: `tools/assets/dimread_mark.py`
draws one geometry that renders into the app icons and the tray's 32-PNG state
family (8 modes × day/night × light/dark taskbar). Regenerate with
`python tools/assets/generate-icons.py`; never hand-edit `src-tauri/icons/`.

Re-skinning happens in the `@theme` blocks of `src/app/styles/globals.css`. See
[`AGENTS.md`](AGENTS.md) for the full contributor/agent guide.

## Documentation

The user-facing docs live in [`docs-site/`](docs-site/) — a
[Fumadocs](https://fumadocs.dev) site on React Router + Vite, published to
GitHub Pages by [`.github/workflows/docs.yml`](.github/workflows/docs.yml) and
linked from the app's **About** tab.

```sh
bun run docs:dev      # http://localhost:5173/dimread/docs
bun run docs:build    # static output → docs-site/build/client
```

Every screenshot on that site (and in this README) is a capture of the **real
renderer**. `tools/docs/capture-screenshots.mjs` injects a small mock of the
Tauri IPC bridge, drives the actual windows with Playwright, and reads the
settings defaults straight from the app's own zod schema — so the values in the
pictures cannot drift from the values in the code:

```sh
bun run dev:vite      # in one terminal
bun run docs:shots    # in another → docs-site/public/screenshots/*.webp
```

## Verification gates

```sh
bun run lint          # Biome + i18n literal guard
bun run typecheck     # app + node
bun run test          # bun test ./src
bun run check:fsd     # FSD structure
bun run check:i18n    # message-key parity
bun run check:deadcode
bun run check:react   # react-doctor (blocks on errors)
cd src-tauri && cargo fmt --check && cargo clippy --all-targets && cargo test
```

The docs site has its own gates, run by the Docs workflow:

```sh
cd docs-site && bun run typecheck && bun run build && bun run check:links
```

## Changelog

Release notes live in [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE)
