# NOTES — Rust shell (`src-tauri/`)

Decisions and deviations made while extracting the Rust shell from WinSTT
(`E:\DL\Projects\WinSTT\src-tauri`) per `TEMPLATE_SPEC.md`.

## Module layout

```
src-tauri/
  Cargo.toml               crate dimread, lib dimread_lib (rlib), edition 2024
  build.rs                 tauri_build::build() + Windows /DELAYLOAD list (see below)
  tauri.conf.json          "windows": [], tight CSP, nsis/appimage/deb/rpm targets
  capabilities/default.json  one shared capability for every window in WINDOW_SPECS
  icons/                   app + installer icons
                           + tray/<mode>-<day|night>-on-<dark|light>.png — the 8x2x2
                             tray family, all embedded via include_bytes! (tray.rs)
  src/
    main.rs                thin entry (no CLI parsing — clap dropped)
    lib.rs                 run(): plugins → setup (store init, app window, tray,
                           autostart sync, reveal) → window-event routing; bindings
                           export test + TS post-processing (ported from WinSTT)
    commands_registry.rs   make_specta_builder(): ALL commands + events
    events.rs              typed specta events; Event impls are MANUAL so wire
                           names can be "settings:changed" etc. (the derive macro
                           only kebab-cases the struct name)
    portable.rs            portable-marker data-dir resolution (magic string:
                           "DimRead Portable Mode")
    window_state.rs        app-window position persist/restore + show/hide/close
                           (close = hide-to-tray or quit, per general.minimizeToTray)
    tray.rs                tray icon + tooltip + click routing (left=show app window,
                           right=flyout). The icon is a FAMILY selected by
                           (display mode x day/night phase x taskbar theme); the
                           taskbar theme comes from the Windows SystemUsesLightTheme
                           registry value
    bootstrap/plugins.rs   plugin registration (single-instance release-only) + log plugin
    settings/              mod.rs (schema+merge), store.rs (atomic durable store,
                           revision, write lock), commands.rs (load_snapshot/save)
    windows/               mod.rs (PRIMARY_WINDOW, WINDOW_SPECS, ensure_window,
                           open/close commands, prewarm), placement.rs (work-area
                           math, picker anchor/close lifecycle)
    downloads/             transfer.rs (WinSTT downloads.rs, verbatim*), manager.rs
                           (new ~230-line generic manager), commands.rs, mod.rs (snapshot types)
```

## Decisions / deviations

- **Event names vs tauri-specta derive**: `#[derive(tauri_specta::Event)]`
  hard-codes kebab-case of the struct name with no rename attribute, so the
  four events implement `tauri_specta::Event` manually with the spec's
  `scope:action` names. The generated `bindings.ts` event map keys come out as
  `settingsChanged` / `downloadUpdate` / `pickerAnchor` / `pickerClosing`.
- **`transfer.rs` "verbatim"**: code is byte-identical to WinSTT's
  `downloads.rs`; only three DOC COMMENTS referencing WinSTT-specific managers
  (hf-hub fallback, STT/TTS catalog names) were reworded. `transfer_url_blocking`
  is kept although the starter manager uses the async path.
- **Revision is `u32`** (WinSTT uses `u64`) so the TS type is a plain `number`
  without relying on the bigint-as-number export behavior (which is still
  enabled for the `u64` byte counters in `DownloadSnapshot`).
- **Picker has no `resize_window`/`anchor_window` commands** (not in the spec's
  IPC contract). The panel footprint is a Rust-side constant (360×420, widened
  to the trigger width); WinSTT's renderer-driven ResizeObserver→resize loop was
  dropped. If the FE needs content-sized panels, port `resize_window` from
  WinSTT `windows.rs`.
- **`download_remove` emits no event** — removal isn't a phase; the renderer
  drops its row when the command resolves. A `removed: AtomicBool` on the handle
  prevents a still-running worker's final emit from resurrecting the entry.
- **Downloads restart semantics**: `download_start` on an id that is Paused /
  Failed / Cancelled / Completed re-registers it; on Queued/Downloading it errors.
  `download_resume` also accepts Failed/Cancelled (retry affordance).
- **Settings no-op save** keeps the revision stable and skips the disk write +
  broadcast.
- **Autostart** reconciles on save (when the flag flips) AND once at startup.
- **Single-instance** is release-only (like WinSTT) so a packaged install can
  run beside `tauri dev`.
- **No splash screen** (per spec) — noted in `lib.rs` docs; WinSTT is the
  reference if a heavy boot phase appears.
- **Updater plugin** is registered with no `plugins.updater` config in
  tauri.conf.json — the plugin's `Config` is `Default` (verified against
  tauri-plugin-updater 2.10 source); add `pubkey`/`endpoints` when releases exist.
- **Windows delay-load list in build.rs** (ported from WinSTT, minus the GPU
  DLLs): without it the lib TEST binary dies at load with
  `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` on Windows — reproduced on this
  machine before adding the list.
- **No custom linker config**: WinSTT pins `lld-link.exe` at its repo root
  `.cargo/config.toml` for link speed; this crate is small (no ort/audio), links
  fine and fast with stock MSVC `link.exe`, and a template shouldn't require
  LLVM. Add it back if link times grow.
- **`dist/` placeholder**: `cargo check/test` need `frontendDist` (`../dist`) to
  exist, so a minimal gitignored `dist/index.html` was created; the real FE
  build overwrites it.
- **Lib modules are `pub`** (`downloads`, `settings`, `windows`, …): the crate
  is an rlib consumed by the bin, and private modules would make the verbatim
  transfer engine's unused-but-public API trip `-D dead_code`.
- **`close_self_window` for the picker** routes through the animated close
  (emit `picker:closing` → 260 ms delayed hide), same as blur/`close_window`.

## Hotkeys + overlay port

Decisions made while porting global hotkeys and the overlay notification pill
from WinSTT (`src/shortcut/*`, `winstt/commands/overlay.rs`, reduced to
starter-sized generic modules `hotkeys/` and `overlay/`):

- **Accelerator vocabulary is Tauri-native end to end.** WinSTT records
  side-specific uiohook names (`LCtrl+LMeta`) and translates at a Rust
  chokepoint; the starter's DOM recorder emits Tauri tokens directly
  (`Ctrl+Shift+Space`, `Alt+ArrowUp`), so no translation layer was ported.
  Modifier-only combos are rejected (the plugin can't register them) — WinSTT
  needs a native Windows listener for those; port it only if you need
  modifier-only PTT-style bindings.
- **`hotkeys/` registry semantics**: id → accelerator map; re-registering an
  id REPLACES its combo (old one unregistered first, but only after the new
  one VALIDATES — an invalid replacement never disarms a working binding);
  a combo owned by another id errors `'X' is already in use by hotkey 'Y'`;
  same id + same combo is an idempotent repair (re-arms a lost OS
  registration). `hotkey_unregister` of an unknown id is a silent no-op so
  settings-driven disarms stay idempotent.
- **Hot-swap**: `settings_save` calls `apply_hotkey_settings` whenever the
  `hotkeys` section changed (same pattern as autostart); lib.rs applies once
  at startup. Registration failures are logged, never returned — a stale
  persisted combo must not fail the save correcting it.
- **`toggleMain` built-in runs Rust-side** (before the `hotkey:triggered`
  broadcast): hide when visible — closing the settings modal first, because
  it is an owner-child whose `set_enabled(false)` input lock on main would
  outlive a bare hide — else `show_main_window`.
- **Recorder suspend/restore**: the renderer unregisters the id when capture
  starts (so pressing the current combo doesn't toggle main mid-recording)
  and re-arms via `hotkey_register` on commit/cancel/reject. The settings
  save then re-applies the section — all paths converge on one registration
  because every step is idempotent.
- **Overlay window** is in `WINDOW_SPECS` via a new `click_through: bool`
  field (builder `.focusable(false)` + `set_ignore_cursor_events(true)`;
  Linux defers the cursor-ignore to after `show()` like WinSTT). It is
  BACKEND-owned: `open_window`/`close_window` reject it; `overlay_notify`
  shows it, a sequence-guarded thread timer hides it. Prewarmed alongside
  picker/settings (no compositor warm cycle — it's never focused, and the
  first notify's re-emits at 75/250 ms cover the listener race instead).
- **Timing contract**: the emitted `overlay:notify` payload is RESOLVED
  (tone defaulted, duration clamped to 1.2–30 s, default 4 s) so the
  renderer's exit timer (starts retract at `durationMs`) and the Rust hide
  (`durationMs + 400 ms` grace > the 160 ms CSS retract) agree. Same
  "composite the faded frame before hide" rationale as the picker. Rapid
  notifies REPLACE (no queue): each bumps the sequence, cancelling stale
  hides; byte-identical re-emits are deduped renderer-side.
- **Placement** is top-center of the work area of the display the MAIN
  window occupies (primary as fallback) — y = work-area top so the
  `flatTop` island hangs flush from the screen edge. WinSTT's cursor-monitor
  and stacked-overlay logic was not ported.
- **Download wiring**: the manager's worker notifies on Completed/Failed
  (skipping removed entries). The title strings ("Download complete"/
  "Download failed") are backend English — the overlay renderer displays
  payload text verbatim; emit message keys + translate in the overlay view
  if you need localized notifications.
- **`overlay_dismiss` gained an `overlay:dismiss` event** (not in the
  original contract) so the renderer can play its exit during the hide
  grace instead of being cut off by a bare window hide.

## Verification (2026-07-16, Windows 11, stable MSVC)

- `cargo fmt --check` — clean.
- `cargo check` — clean (warnings = deny).
- `cargo clippy --all-targets` — clean (clippy::all = deny via `[lints]`).
- `cargo test` — 34/34 pass (windows auth/geometry, settings merge/store/lock,
  downloads sanitization/snapshots, portable marker, tray theme mapping,
  bindings export).
- `src/bindings.ts` regenerated by the `export_bindings` test; command names,
  parameters, event names, and payload shapes verified against
  TEMPLATE_SPEC.md's IPC contract.

## Tray flyout (native menu → webview popup)

The tray's native context menu was replaced by a transparent webview popup
(`src-tauri/src/tray_menu/`, the `tray-menu` window, renderer in
`src/views/tray-menu/`). Ported from WinSTT's `tray_menu` module.

**Why.** A native tray menu can only host labels and check marks, so brightness
had to ship as a ten-row quick-set submenu — ten buttons shaped like a slider.
The popup renders the *same* gradient-variant `Slider`s as the app window's
quick controls, at 1 % precision with live preview.

**Consequences worth knowing:**

- `tray.rs` is now icon + tooltip + click routing only. Everything that used to
  mutate settings from Rust (`apply_display_change`, the mode/brightness/pause
  items) is gone; the popup writes through the renderer's ordinary
  `display_preview` → `settings_save` seam, so the tray and the app window
  share ONE persistence contract. The "dimming while paused redirects the edit
  into `custom`" rule now comes from `buildSliderCommitPatch` for free.
- `open_settings_window_internal` was deleted with it. The popup is a renderer,
  so it opens Settings via the ordinary `open_window("settings")` command;
  `is_window_operation_allowed` allow-lists `tray-menu` as a caller.
- **The popup window is never hidden — it is PARKED off-screen** at `-9999`.
  WebView2 re-presents its last composited frame when a hidden window is shown,
  so a real hide/show flashes the previous frame at the previous position, and
  the first cold-composite eats the open animation. Because of this, "is it
  open?" is a POSITION test (`is_on_screen`), never `is_visible()`.
- **Blur dismisses, except during a self-resize.** The renderer sizes the window
  to its content (`ResizeObserver` → `tray_menu_resize`); `set_size` bounces
  WebView2's focus, which would otherwise collapse the popup on every resize.
  `RESIZE_BLUR_GRACE` (500 ms) suppresses that. Self-sizing and blur-to-dismiss
  are mutually incompatible without it.
- `tray_menu_resize` no-ops an unchanged size. `ResizeObserver` fires on every
  reflow (hover, focus rings, subpixel rounding); unguarded, it loops
  resize → `Resized` → re-anchor → jitter.
- Placement is a pure clamp into the monitor work area. The tray sits at a
  screen corner, so clamping an anchor there naturally pulls the popup back
  on-screen — no explicit "flip above the anchor" branch needed.
- `tray-menu` is on `POST_STARTUP_PREWARM_LABELS` but warms differently from the
  picker: it is parked and left *shown* for the app's lifetime, so its
  composition surface and self-reported content size are ready before the first
  click.
