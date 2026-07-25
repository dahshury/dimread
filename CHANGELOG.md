# Changelog

All notable changes to DimRead are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
