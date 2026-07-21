# Plan 11 — Shell integration (tray, hotkeys, autostart, Auto Dark, packaging)
Status: DRAFT
Depends on: 00 (capability layer), 05 (day-night, for Auto Dark's schedule)
Parity ref: FEATURE-PARITY.md F10.5 (tray), F10.4 (hotkeys), F10.1 (autostart),
F9.5–F9.6 (Auto Dark + taskbar transparency), F10.7 (updater), F10.2 (installer language detect)

---

## 1. What this feature is

Everything that makes DimRead feel like part of the desktop rather than a window: a tray icon whose
click opens the quick-controls flyout (F10.5), global hotkeys that work with no app window focused
(F10.4), launch-at-login (F10.1), and the Auto Dark scheduler that flips the *system's* light/dark
theme on a day/night schedule plus the transparent-taskbar effect (F9.5–F9.6). Plus the packaging
that ships all of it.

These are grouped because they share one property: **each is a thin API on Windows and a
per-desktop negotiation everywhere else**, and each has a well-documented way to fail silently.

## 2. Current state

### Tray — `src-tauri/src/tray.rs` (234 lines)
Deliberately **no native context menu**. The icon opens a transparent webview flyout
(`crate::tray_menu`, the `tray-menu` window) hosting the real Display controls — the same gradient
brightness/temperature sliders as the main window — because *"a native tray menu can only host
labels and check marks, so brightness had to ship as a ten-row quick-set submenu — which is not a
brightness control, it is ten buttons shaped like one."* Either mouse button toggles it.

The icon is theme-aware: on Windows the `SystemUsesLightTheme` registry value (the file explicitly
warns that `AppsUseLightTheme` is *"the WRONG one for the tray"*), elsewhere the main window's
reported theme. Repainted on `WindowEvent::ThemeChanged`. Tooltip follows the `display:state` event
(e.g. `DimRead — 5000K · 85%`).

### Hotkeys — `src-tauri/src/hotkeys/mod.rs` (343 lines) + `actions.rs` (428 lines)
A registry over `tauri-plugin-global-shortcut`: `REGISTERED: Mutex<BTreeMap<String, String>>` maps
id → accelerator, so re-registering an id **replaces** its accelerator, and duplicate accelerators
across different ids are rejected with a typed error (line 151). Validation happens **before**
touching the live registration (line 145), so an invalid replacement never disarms a working
binding. `validate_accelerator` (line 65) rejects empty, `fn`, and modifier-only combos.

`apply_hotkey_settings` (line 234) arms the whole persisted set at startup **and after every
hotkeys-section save** — hot-swap, no restart. Twelve bindings: `toggle_main` plus seven display
actions, `focus_read`, `focus_blur`, `magic_dark`, `magic_gray`.

**The trigger path already filters on `event.state == ShortcutState::Pressed` (line 197).** §4.2
explains why that line is load-bearing rather than defensive.

### Autostart
`tauri-plugin-autostart` 2.5.1, registered in `src-tauri/src/bootstrap/plugins.rs`:
```rust
.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))
```
No wrapper module; the renderer calls the plugin's commands directly.

### Auto Dark — `src-tauri/src/magicx/theme.rs` (608 lines)
Windows-complete. `apply_now()` resolves `system_theme` (`light|dark|auto|disable`) against
`system_sunrise`/`system_sunset` (`AutoDarkSettings`, `settings/mod.rs`), writes
`HKCU\...\Themes\Personalize\SystemUsesLightTheme` (`1` = light), broadcasts
`WM_SETTINGCHANGE("ImmersiveColorSet")`, and emits `AutoDarkChangedEvent`.

The write is gated on the **live registry value** (`read_theme_key`), not on `LAST_THEME`. Gating on
our own cached decision meant that once the user changed the theme themselves, cache and registry
disagreed permanently and the ticker never re-asserted — the setting silently stopped controlling
anything. `LAST_THEME` now only dedupes the emitted event.

There is deliberately **no app-theme target**. It used to write `AppsUseLightTheme`, which re-themes
every *other* Windows app while leaving DimRead untouched (DimRead is permanently dark via
`color-scheme: dark`), so a control labelled "App theme" in our own settings window read as a bug.

A 60 s `ticker_loop` follows day/night flips and re-asserts the taskbar effect (the taskbar restarts
with Explorer). Settings changes are handled by a **coalesced** worker (`APPLY_BUSY` /
`APPLY_PENDING`) so a held brightness hotkey firing many saves/second never spawns a thread per
keypress. `SHUTTING_DOWN` latches first in `restore_on_exit` so a late tick cannot re-assert the
taskbar effect after it is restored.

**Taskbar restore.** Setting an accent policy on `Shell_TrayWnd` cannot be undone by writing
`ACCENT_DISABLED` — that pins the taskbar to an opaque bar painted with `gradient_color` (black when
zeroed), and it outlives the process because the attribute lives on the shell's window. The original
policy is therefore captured via `GetWindowCompositionAttribute` before the first override
(`ORIGINAL_ACCENT`) and replayed verbatim on the off-edge and at exit; when the capture fails the
taskbar is left alone rather than guessed at.

Taskbar transparency (F9.6) uses the undocumented `SetWindowCompositionAttribute` accent policy on
`Shell_TrayWnd`, best-effort, re-asserted on the ticker and cleanly restored on exit.

Everything Win32 is `cfg(windows)`-gated; off-Windows the seam compiles and is inert.

### Packaging — `src-tauri/tauri.conf.json`
`productName: "DimRead"`, `identifier: "com.dahshury.dimread"`,
`bundle.targets: ["nsis", "appimage", "deb", "rpm"]` — **no macOS targets**.
`macOSPrivateApi: true` (see plan 07 §6). Updater plugin is present in `Cargo.toml` but
**deliberately not registered** (`plugins.rs` comment: needs endpoints + a minisign pubkey a starter
template cannot ship).

## 3. Per-platform verdict table

### 3a. Global hotkeys (F10.4)

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | `RegisterHotKey` via the plugin | Works today. |
| macOS (Intel / Apple Silicon) | **FULL for normal keys**, **PARTIAL for media keys** | Carbon `RegisterEventHotKey` — **the only public global-hotkey API needing no permission** (macos.md §K). Media keys go through `CGEventTapCreate(SystemDefined)` → **Input Monitoring** (§U) | ⚠️ **Reserved combos fail SILENTLY** — see §4.2. ⚠️ Double-fire per press. ⚠️ Avoid Option-only / Option+Shift defaults (macOS 15 regression, since fixed). |
| Linux X11 | **FULL** | `global-hotkey` → `x11rb` `XGrabKey` | Works. |
| Linux Wayland — KDE | **PARTIAL** | Portal `org.freedesktop.portal.GlobalShortcuts` v2 — **KDE ✅ since Plasma 5.27 (2023-02)**, built on KGlobalAccel | ⚠️ **The user picks the combo, not us** — a real UX change (§4.3). |
| Linux Wayland — GNOME | **PARTIAL** | Portal — **GNOME ✅ since GNOME 48 (2025-03)**, late | Same UX change. |
| Linux Wayland — wlroots/sway | **BLOCKED UPSTREAM** (not backlog) | Portal ❌ *not implemented* — xdg-desktop-portal-wlr#240 open since 2022-09 | Hyprland ✅ (2023-09) is the exception. COSMIC ❌, niri ❌. **This will not arrive**: emersion **closed sway#8062** refusing `hyprland_global_shortcuts_v1` — *"I'd rather not foster the proliferation of non-standard protocols"* — in favour of wayland-protocols **MR !216, open and unmerged since 2023-06-19**; sway's own PR #7774 is still **draft after ~3 years** (linux.md §NN). Say so plainly in the UI; do not imply "coming soon". |
| **Any Wayland, today** | 🔴 **BROKEN, SILENTLY** | Our current plugin is X11-only; under Wayland it grabs against **XWayland**, `register()` returns `Ok(())`, **and the key never fires** | linux.md §10 [VERIFIED]: *"Worst-possible failure mode."* The plugin docs list Linux ✓ with no display-server caveat. |

### 3b. Autostart (F10.1)

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | Plugin → registry Run key | Works. |
| macOS | **PARTIAL** | Plugin writes a LaunchAgent plist. **`SMAppService` is UNREACHABLE from the plugin** — it pins `auto-launch ^0.5`; SMAppService landed in 0.6.0, semver-incompatible (macos.md §V) | Lands in *"Allow in the Background"*, not *"Open at Login"*; **displays the signing certificate's org name instead of the app name** (no `AssociatedBundleIdentifiers`); two background-item notifications instead of one. |
| Linux X11/Wayland — GNOME/KDE/XFCE/Cinnamon/MATE/LXQt/Budgie | **PARTIAL** | XDG `~/.config/autostart/*.desktop` | Plugin bugs (§4.4) make it wrong in several common cases. |
| Linux — sway/Hyprland/river/bare wlroots | **BLOCKED** by default | XDG autostart **not honoured** — needs `dex --autostart`, `systemd-xdg-autostart-generator`, or sway-systemd (linux.md §10) | |
| **Flatpak (any desktop)** | 🔴 **BROKEN** | Plugin writes `Exec=/app/bin/dimread`, which the host cannot run; and a Flatpak's `~/.config` is redirected to `~/.var/app/<id>/config/`, so the write **silently succeeds and does nothing** (plugins-workspace#3166) | Correct route: `org.freedesktop.portal.Background.RequestBackground`. Backends: **GNOME ✅, KDE ✅, xdg-desktop-portal-wlr ❌, xdg-desktop-portal-gtk ❌**. |
| **AppImage** | **PARTIAL** | Plugin special-cases `$APPIMAGE` correctly, but the filename carries the version, so **a version bump silently breaks the entry** while `is_enabled()` still returns true | |

### 3c. Auto Dark — system theme (F9.5)

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | Registry + `WM_SETTINGCHANGE` | Works today. |
| macOS — **read** | **FULL** | `NSApp.effectiveAppearance` (KVO), public, zero permissions | ⚠️ Prefer KVO over the notification — documented read-after-notify race. ⚠️ `effectiveAppearance` is 10.14 on `NSApplication` — probe `respondsToSelector:` as tao does. |
| macOS — **set** | **PARTIAL, private API** | SkyLight `SLSSetAppearanceThemeNotifying` — **symbols verified present in the macOS 26.5 SDK stub** (macos.md §W); `SLSSetAppearanceThemeSwitchesAutomatically` is **the only route to setting Auto** | Risk LOW-MEDIUM; App Store fatal. `Window::set_theme` does **NOT** do this — tao calls `NSApp.setAppearance:`, overriding **our app only**. |
| Linux — **read** | **UNVERIFIED** | XDG portal `org.freedesktop.portal.Settings`, namespace `org.freedesktop.appearance`, key `color-scheme` | linux.md §9 is explicitly *"[UNVERIFIED — pending follow-up]"*. Carried as such. |
| Linux — **set** | **BLOCKED cross-desktop**; PARTIAL per-DE | No standard setter. Per-DE: `gsettings … color-scheme`, `plasma-apply-colorscheme`, `xfconf-query` (all **UNVERIFIED** in linux.md §9) | |

### 3d. Taskbar transparency (F9.6)

| Platform | Verdict | Notes |
|---|---|---|
| Windows | **FULL** | Undocumented `SetWindowCompositionAttribute` on `Shell_TrayWnd`; works today. |
| macOS | **BLOCKED** | No equivalent. The menu bar is Tahoe-transparent by default anyway (macos.md §T). |
| Linux | **BLOCKED** | Panel appearance is per-DE configuration, not a client capability. |

### 3e. Tray icon (F10.5) — **coverage gap, flagged**

Tauri's `tray-icon` feature is enabled and the flyout works on Windows. **Neither research document
covers Linux tray/StatusNotifierItem or macOS `NSStatusItem` behaviour**, so this plan makes **no
verdict claim** for the tray beyond Windows. Known-unknowns that must be resolved before estimating:
Linux tray requires a StatusNotifierItem host (`libayatana-appindicator` / `libappindicator3`) as a
runtime dependency; GNOME's handling of tray icons; and whether a *transparent webview flyout*
positioned relative to a tray icon is even placeable on Wayland (plan 07 establishes that
`set_position` silently no-ops there — **which strongly suggests the flyout architecture does not
survive Wayland**). See §9 S4. This is called out rather than guessed.

## 4. Design

### 4.1 One shell-integration capability report

Each sub-feature gets a verdict in one struct, consumed by the settings UI:

```rust
// src-tauri/src/shell/mod.rs (new)

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShellCapability {
    pub hotkeys: HotkeyCapability,
    pub autostart: AutostartCapability,
    pub system_theme_set: ThemeSetCapability,
    pub taskbar_effect: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyCapability {
    /// We choose the combo and register it (Windows, macOS, X11).
    AppChosen,
    /// The USER chooses the combo in the desktop's own settings UI; we can only
    /// request and then display `trigger_description` (Wayland portal).
    UserChosen { portal_version: u32 },
    /// No mechanism in this session.
    Unavailable { reason: String },
}
```

**`HotkeyCapability::UserChosen` is the load-bearing variant** and it changes the UI, not just the
backend — see §4.3.

### 4.2 macOS hotkeys — keep Carbon, add a denylist, keep the Pressed filter

**Keep `tauri-plugin-global-shortcut`.** macos.md §K: `RegisterEventHotKey` is *"the only public
global-hotkey API that is free"*; `NSEvent.addGlobalMonitorForEvents` needs **Accessibility**,
`CGEventTap` needs **Input Monitoring**. It is arm64-native, sandbox-safe, MAS-safe, and not
deprecated (32-bit Carbon the *app framework* died with Catalina; HIToolbox persists as a 64-bit
system framework). sindresorhus/KeyboardShortcuts: *"Does this package cause any permission dialogs?
No."*

**But `global-hotkey` 0.8.0 — which *is* our shipping code — carries four defects (macos.md §U):**

1. 🔴 **Reserved shortcuts fail SILENTLY.** The crate passes **`inOptions = 0`**, not
   `kEventHotKeyExclusive`. Per `CarbonEvents.h` the same hotkey **can be registered by multiple
   applications**, and `eventHotKeyExistsErr (-9878)` fires **only for collisions within our own
   process**. So binding Cmd+Space, Cmd+Tab, Cmd+Shift+3/4/5, Ctrl+arrows, Cmd+Q or Cmd+Option+Esc
   makes `register()` return `Ok(())` **and the callback never fires** — undetectable from the
   return value.
   > **→ We must ship our own denylist, validated in `validate_accelerator`** (`hotkeys/mod.rs`
   > line 65) so the settings UI rejects the combo at record time with a real explanation, rather
   > than accepting it and silently doing nothing. This is the single highest-value macOS hotkey
   > change in the plan.
   Conversely, when it *wins* it **consumes** the key with no pass-through (global-hotkey#87).

2. **Double-fire.** Handlers are installed for **both** `kEventHotKeyPressed` **and**
   `kEventHotKeyReleased` and emit for each — **every press delivers two callbacks.** Combined with
   plugins-workspace#1748 (per-shortcut *and* `with_handler` both registered) the multiplier reaches
   **4×**.
   > **→ Our existing `event.state == ShortcutState::Pressed` filter (`hotkeys/mod.rs` line 197 and
   > `focus/read.rs` line 159) is load-bearing, not defensive styling. Comment it as such** so
   > nobody "simplifies" it away. Also: register one handler path, never both.

3. **Misleading errors.** On Carbon `OSStatus` failure it returns `io::Error::last_os_error()`,
   which reads **`errno`** — unrelated to `OSStatus` — so it surfaces stale garbage. macos.md:
   *"Almost certainly the real explanation for plugins-workspace#2540's nonsensical 'os error 2'."*
   > **→ Never surface the raw plugin error string to users on macOS.** `register_hotkey_internal`
   > already wraps it (`format!("couldn't register '{canonical}': {e}")`, line 201) — replace the
   > `{e}` on macOS with a generic message plus our own diagnostics.

4. **Media-key event tap is never re-enabled.** `TapDisabledByTimeout` / `TapDisabledByUserInput`
   are defined but never handled and `CGEventTapEnable` is called once. macOS disables slow taps
   unilaterally → **media hotkeys die permanently for the process lifetime, silently.**
   > **→ Blocklist media keys in the settings UI.** It also keeps our zero-permission posture: the
   > moment a user binds a media key, the app silently requires Input Monitoring
   > (`kTCCServiceListenEvent`) — and `global-hotkey` never calls `CGPreflightListenEventAccess()`.
   > Real report: plugins-workspace#2868 — `register("MediaPlayPause")` fails *"even after enabling
   > Accessibility"*, because the right permission is Input Monitoring.

**Also not bindable on macOS** (§U): Globe/fn — *"there is no fn modifier bit in Carbon at all"*
(global-hotkey#111, open); Caps Lock; and `AudioVolumeUp/Down/Mute`, which map to legacy scancodes
`0x48/0x49/0x4a` that do **not** correspond to modern Mac volume keys (expect silent never-fire).
All belong in the same denylist.

**Secure input** (Apple TN2150) blocks HID seize, CoreGraphics event taps and `GetKeys()` — Carbon
hotkeys are **not** on that list, so normal hotkeys keep firing while a password field holds secure
input, while media-key hotkeys stop. Carried **UNVERIFIED**: *"Apple never states affirmatively that
Carbon hotkeys survive; TN2150's omission is strong negative evidence."*

⚠️ **Main-thread requirement is real.** `RegisterEventHotKey` is *"Not thread safe"*; the plugin's
`run_main_thread!` wrapper carries an `unsafe impl Send + Sync` justified **only** by that guarantee.
**Bypass the wrapper and you are in UB.**

### 4.3 Linux Wayland hotkeys — the portal, and the UX change it forces

Adopt **`ashpd` directly** (`features = ["global_shortcuts"]`), branching on `$WAYLAND_DISPLAY`.
linux.md §10: *"do not wait for global-hotkey PR #172 (unmerged as of 2026-07)."*

Portal interface **v2**, since xdg-desktop-portal **1.16.0 (2022-12-12)**:
`CreateSession` / `BindShortcuts` / `ListShortcuts` / `ConfigureShortcuts`; signals `Activated` /
`Deactivated` / `ShortcutsChanged`.

**Three hard constraints, all of which change code beyond the hotkey module:**

1. 🔴 **The app-ID dance must happen FIRST.** Since portal 1.21.0, `CreateSession` **rejects
   connections with no app ID**. A normally-installed (non-sandboxed) binary must first call
   `org.freedesktop.host.portal.Registry.Register(app_id, …)` — **once per D-Bus peer, before any
   other portal call** — with an `app_id` matching an **installed `.desktop` basename**, and GNOME
   additionally demands **reverse-DNS**. *"This is exactly what broke Chromium/Electron on
   GNOME 50."*
   > **→ Consequences: we must ship a `.desktop` file whose basename is `com.dahshury.dimread`
   > (matching `tauri.conf.json`'s identifier), and the registration must run before *any* portal
   > use — including the Background portal for autostart (§4.4) and the Settings portal for theme
   > reads (§4.5). This is a shared bootstrap step, not a hotkeys detail.** Put it in
   > `src-tauri/src/shell/portal.rs` and call it from `bootstrap/`.

2. ⚠️ **`zbus`'s async-runtime feature is global and Tauri uses tokio.** Either use `ashpd`'s tokio
   feature consistently, or isolate with async-std as PR #172 does. **Do not mix.** This is a
   build-graph constraint that can surface as a confusing runtime panic, so pin it deliberately and
   comment the choice in `Cargo.toml`.

3. 🔴 **On Wayland the USER picks the key combination, not us.** `preferred_trigger` is only a hint;
   the actual binding is chosen in the desktop's own settings UI. And *"an application can only
   attempt to bind shortcuts of a session once"* — changing the set means tearing down and
   recreating the session.

**Trigger grammar** (linux.md §OO, freedesktop shortcuts spec) — needed both to send a sensible
`preferred_trigger` and to render `trigger_description`:
binding shape is `(shortcut_id, {description: s, preferred_trigger: s})`; modifiers are
**`CTRL, ALT, SHIFT, NUM, LOGO`** joined by `+`; the keyname comes from **xkbcommon minus the
`XKB_KEY_` prefix**. Examples: `CTRL+SHIFT+a`, `CTRL+ALT+Return`.
**→ We need a translation layer between Tauri's accelerator vocabulary** (`"Ctrl+Shift+Space"`,
`"Alt+ArrowUp"`, `"F5"` — see `validate_accelerator`'s `MODIFIER_TOKENS`, `hotkeys/mod.rs` line 46)
**and this grammar.** It is a pure function and belongs in unit tests (§8).

**The UX consequence is real and must be designed, not patched.** Today the settings UI is a
capture field: `src/features/record-hotkey/` records a combo and writes the accelerator string. On
Wayland that interaction is **meaningless** — we cannot honour what the user types.

> **→ The hotkeys settings panel needs two modes, driven by `HotkeyCapability`:**
> - `AppChosen` → today's `HotkeyRecorder` field (unchanged).
> - `UserChosen` → render the portal's returned **`trigger_description`** as read-only text, with a
>   **"Change…"** button wired to `ConfigureShortcuts`, and an explanatory line that the desktop
>   owns these bindings.
>
> This is a genuine frontend change in `src/views/main/ui/panels/` and `src/features/record-hotkey/`,
> plus new `messages/en.json` keys. **Budget it as UI work, not as a backend flag.**

**Fallbacks (linux.md §10, §OO), none recommended for v1:**
- **`evdev`** — universal, below the display server, but needs `input` group + a udev rule,
  **sees every keystroke system-wide**, and cannot consume the event. A serious privacy-posture
  change for an eye-comfort app. **Do not ship.**
- **`org.kde.KGlobalAccel`** — inferior to the portal on KDE (the portal backend *is* KGlobalAccel),
  but documented if ever needed: `doRegister(actionId as)` then
  `setShortcutKeys(actionId as, keys a(ai), flags u)`, where **`actionId` is a 4-element list**
  `[ComponentUnique, ActionUnique, ComponentFriendly, ActionFriendly]`; activation arrives as
  `globalShortcutPressed(componentUnique, actionUnique, timestamp)` on
  `org.kde.kglobalaccel.Component`. ⚠️ **The v1 methods (`setShortcut`, `unRegister`) carry
  `org.freedesktop.DBus.Deprecated` — use the v2 `*Keys` variants.**
- **Compositor config files** — for the compositors the portal will never serve (Q1). ⚠️ **Hyprland's
  `bind` syntax takes exactly 3 commas** (`bind = MODS, KEY, exec, <cmd>`); **a trailing comma
  silently corrupts the argument**, so any generated snippet must be tested, not just formatted.
  sway: `bindsym --locked --to-code`; river: `riverctl map`.
- **GNOME `custom-keybindings`** — ⚠️ `set` **overwrites** the array; read-modify-append, and use a
  namespaced path segment.

### 4.4 Autostart — replace the plugin usage with our own module

The plugin is wrong on two of three platforms in ways `cargo update` cannot fix.

**macOS (macos.md §V).** `tauri-plugin-autostart` 2.5.1 pins `auto-launch = "0.5"` (`>=0.5.0,
<0.6.0`); **`SMAppService` support landed only in `auto-launch` 0.6.0**, which is semver-incompatible
and a breaking API change. **Cargo will never resolve into it — this needs a plugin PR, not a version
bump** (plugins-workspace#2720, open). Meanwhile the LaunchAgent path:
- lands in System Settings → *"Allow in the Background"* rather than *"Open at Login"* — semantically
  wrong for a GUI app;
- **displays the signing certificate's organization name instead of the app name**, because
  auto-launch 0.5 omits `AssociatedBundleIdentifiers` (Apple's documented behaviour; field reports
  show *"Software from 'SUNSTORY LLC' can run in the background"*);
- produces **two** background-item notifications instead of one;
- `is_enabled()` is **just `file.exists()`** — never asks launchd, so it reports `true` after the
  user disables the item in System Settings;
- `disable()` is `fs::remove_file` with no `launchctl unload`;
- is **broken under sandbox/MAS** (path outside the container).

✅ **`objc2-service-management` 0.3.2 is good and usable directly** — canonical objc2 family, maps
`NSError**` to `Result`:
```rust
let svc = SMAppService::mainAppService();
if enabled { svc.registerAndReturnError() } else { svc.unregisterAndReturnError() }
```
**No entitlement, no Info.plist key, no TCC prompt.** Needs a valid signature
(`kSMErrorInvalidSignature` otherwise — see plan 07 §6 on adopting a stable identity) and macOS 13+.
Handle `status() == RequiresApproval` by calling `openSystemSettingsLoginItems()` rather than
reporting failure; treat `kSMErrorAlreadyRegistered` as success.

**Linux (linux.md §10).** `auto-launch 0.5`:
- hardcodes `~/.config/autostart/` — **ignores `$XDG_CONFIG_HOME`**;
- does **no shell quoting** of the exec path — any space (common in AppImage paths) yields a
  malformed `Exec=`;
- `is_enabled()` is an existence check only — it does not parse `Hidden=` or
  `X-GNOME-Autostart-enabled=false`, **so an entry the user disabled via the GUI still reports
  enabled**;
- emits no `TryExec=`, `Icon=`, or `X-GNOME-Autostart-*`.

Also: **`Hidden=true` is the correct disable mechanism**; `NoDisplay` does **not** disable autostart
(routinely confused). And **Flatpak is outright broken** — route to
`org.freedesktop.portal.Background.RequestBackground{autostart: true, commandline: […]}`, which runs
on the host, writes the real `~/.config/autostart/<app-id>.desktop`, and rewrites
`Exec=flatpak run --command=… <APP_ID> …`. Backends: **GNOME ✅, KDE ✅, wlr ❌, gtk ❌**.

**→ Design: `src-tauri/src/shell/autostart.rs`**, owning platform routing:

```rust
pub enum AutostartBackend {
    WindowsRegistry,                       // keep the plugin here — it is correct
    MacSMAppService,                       // objc2-service-management
    LinuxXdgDesktop { config_home: PathBuf },
    LinuxBackgroundPortal,                 // Flatpak / Snap
    Unavailable { reason: String },        // bare wlroots without a session manager
}

/// NEVER an existence check. Parses `Hidden=` / `X-GNOME-Autostart-enabled=`
/// on Linux, asks SMAppService for real status on macOS.
pub fn is_enabled(app: &AppHandle) -> Result<bool, AutostartError>;
```

Plus, per linux.md's "Four things to resolve" item 4:
- detect the packaging format (`/.flatpak-info`, `$SNAP`, `$APPIMAGE`) and route accordingly;
- **rewrite the entry on every launch** (AppImage version bumps silently break it);
- a **one-time macOS migration deleting any legacy `~/Library/LaunchAgents/*.plist`**, or users get
  **double launches**;
- ⚠️ **do not rely on argv for autostart detection** — neither AppleScript mode nor
  `SMAppService.mainApp` can pass custom flags. **Persist a marker in the settings store instead.**

### 4.5 Auto Dark

**Windows: unchanged.** `theme.rs` is complete and its coalescing/shutdown-latch design is good.

**macOS.** Reading is public and free. Setting is not:
- ⚠️ **`Window::set_theme` does NOT set the system theme** — tao calls `NSApp.setAppearance:`, which
  overrides **our app only**, and afterwards `Window::theme()` returns *our own override*, not the
  system's (macos.md §W). Anything reading `window.theme()` to learn the system theme becomes wrong
  the moment we call the setter. **The tray-icon theme logic (`tray.rs`) reads the main window's
  theme off-Windows — audit it against this.**
- **Setting the system theme has no public API.** Apple FB5714667 has been open since 2018-07-12
  *"with zero Apple comments eight years later."* Preferred route is **SkyLight**:
  `SLSSetAppearanceThemeNotifying(BOOL mode, BOOL notifyListeners)` — use the `Notifying` variant so
  other apps repaint. Symbols **verified present in the macOS 26.5 (Tahoe) SDK stub**, and Tahoe now
  also exposes a Swift-mangled `SkyLight.SLSAppearanceTheme`, suggesting Apple consumes it
  internally. 94 GitHub references. **`SLSSetAppearanceThemeSwitchesAutomatically` is the only route
  to setting "Auto"** — AppleScript cannot. Harden with `dlopen`/`dlsym`.
  **Risk: LOW-MEDIUM. App Store fatal** — gate behind the same Cargo feature as plan 07's private path.
- ⚠️ **The `defaults` tri-state has an inversion** (§W): with `AppleInterfaceStyleSwitchesAutomatically
  = true`, `AppleInterfaceStyle` **absent** ⇒ rendering **Dark**; `"Dark"` ⇒ rendering **Light**. And
  if the transition passes while the Mac is asleep, the stored value is simply wrong.
  **Rule: AppKit for current state; `defaults` only to recover the tri-state preference. Never let
  `defaults` override AppKit.**
- ❌ `defaults write -g AppleInterfaceStyle Dark` **does not work**. The correct framing:
  *"`AppleInterfaceStyle` is a **cache of a decision made elsewhere**, not the control surface"* —
  causality runs SkyLight → defaults, not the reverse.
- **AppleScript fallback** still works but fails on **permission, not API removal**
  (`errAEEventNotPermitted -1743`, `errAEEventWouldRequireUserConsent -1744`); needs
  `NSAppleEventsUsageDescription` + Automation TCC; **does not work sandboxed**. Capture and classify
  stderr. **Not worth shipping** given it breaks our zero-permission posture for a secondary feature.
- **Graceful fallback for a restricted build:** deep-link
  `x-apple.systempreferences:com.apple.Appearance-Settings.extension` and let the user flip it.

**Linux.** Read via the XDG portal `org.freedesktop.portal.Settings` (`Read`/`ReadOne`, namespace
`org.freedesktop.appearance`, key `color-scheme`: 0 = no preference, 1 = prefer-dark,
2 = prefer-light; `SettingChanged` signal). ⚠️ **linux.md §9 marks that section
`[UNVERIFIED — pending follow-up]`** — but linux.md §PP (gap-closer) now confirms the enum mapping
and adds **two corrections that change the design**:

1. ⚠️ **XFCE: reading the portal is NOT sufficient.** `xdg-desktop-portal-gtk` derives
   `color-scheme` **solely** from the GNOME gsettings key `org.gnome.desktop.interface color-scheme`
   — it does **not** read xfconf. **On XFCE the portal will usually report `0` (no preference)
   regardless of the applied theme.** So a portal read must be treated as advisory, with a
   per-DE fallback where one exists.
2. ⚠️ **tao's portal fallback is indistinguishable from a real answer:** a **missing portal silently
   reports `Theme::Light`** rather than erroring. **Through Tauri we cannot tell "light" from "no
   portal".** → **Read via `ashpd` directly**, not `Window::theme()`, so "unknown" stays
   distinguishable from "light". This is the same silent-success failure class as the rest of the
   plan, and it is in a dependency we already ship.

✅ Nice-to-know: `GDesktopColorScheme` is `DEFAULT=0, PREFER_DARK=1, PREFER_LIGHT=2` — an exact match
to the portal integers, which is why xdg-desktop-portal-gtk passes `g_settings_get_enum` straight
through.

There is **no standard cross-desktop setter**. Per-DE setters remain largely UNVERIFIED; one
correction: **`plasma-apply-colorscheme` writes kdeglobals via `KConfig::Notify` *and* makes a D-Bus
call to `org.kde.KWin`, so it requires a running Plasma session for full effect** — it is not a
headless config write.

> **Recommendation: on Linux, ship Auto Dark as READ-ONLY for v1** — follow the system theme for our
> own UI, and report the *set* half as unavailable. A per-DE shell-out matrix is a large surface with
> no verified foundation, for a feature that is secondary to the tint engine.

### 4.6 System Settings deep links (macOS) — one URL, and kill the app first

Needed by the AX-optional flow (plan 09) and the SMAppService `RequiresApproval` path (§4.4).
macos.md §N + §VI:

- ✅ **`x-apple.systempreferences:`** works Ventura → Tahoe 26. ❌ **`x-apple.systemsettings:` has
  NO handler** — the user sees *"There is no application set to open the URL."*
- ⚠️ **`Privacy_ScreenRecording` is NOT a real anchor** — it is **`Privacy_ScreenCapture`** (2,668
  GitHub hits vs 47). Common copy-paste error.
- 🔴 **Fallback chains are DEAD CODE.** `NSWorkspace.openURL:` returns `YES` as soon as *the scheme*
  is handled and System Settings launches — **it never reports whether the anchor resolved.** The
  fallback branch is unreachable. **Pick one URL. Do not version-branch** (version gating in the wild
  is mutually contradictory for the same anchor, which is itself evidence both forms work).
- ★ **The real problem is System Settings already being open**, which makes the anchor get ignored —
  almost certainly the source of "it opens the wrong pane" reports. Karabiner runs
  `killall 'System Settings'` and **polls `pgrep -x` until the process is gone** before opening the
  URL; NetNewsWire uses a 0.2 s delay plus `NSWorkspace.OpenConfiguration(activates: true)`.
  ~250 repos match a `x-apple.systempreferences` + `killall` code search.
  **→ Adopt the killall-and-poll pattern.** Carried **UNVERIFIED**: whether the already-open bug is
  deterministic or timing-dependent.
- **Sandbox/App Store: fine, no entitlement** (Sequel Ace ships sandboxed on the MAS doing exactly
  this). No `LSApplicationQueriesSchemes` equivalent needed.
- **Verify permission state independently** — the URL open's return value is meaningless for that.
- ⚠️ **Undocumented but load-bearing.** Apple has never documented the scheme; TN3179 covers exactly
  the "user must visit Settings" scenario and offers **no programmatic deep link at all**. So no
  deprecation warning will ever be issued, and no compatibility guarantee exists.

## 5. Implementation steps

1. **`ShellCapability` + reporting.** New `src-tauri/src/shell/mod.rs`; command
   `shell_capability() -> ShellCapability`; regenerate bindings. Settings panels consume it.
   *Prerequisite for every honest degradation below.*

2. **macOS hotkey denylist.** Extend `validate_accelerator` (`hotkeys/mod.rs` line 65) with a
   `cfg(target_os = "macos")` denylist: Apple-reserved combos, media keys, Globe/fn, Caps Lock,
   `AudioVolume*`. Typed error strings surfaced by the recorder. Comment the
   `ShortcutState::Pressed` filter as load-bearing.
   Files: `hotkeys/mod.rs`, `src/features/record-hotkey/`, `messages/en.json`.
   *Highest value-per-hour item in the plan; no new dependencies.*

3. **Portal app-ID registration + `.desktop` shipping.** `shell/portal.rs` calling
   `org.freedesktop.host.portal.Registry.Register("com.dahshury.dimread", …)` **before any other
   portal call**, from `bootstrap/`. Ship a matching `.desktop` in the deb/rpm/AppImage bundles.
   Pin the `ashpd`/`zbus` runtime feature and comment the choice.
   *Blocks steps 4 and 6.*

4. **Wayland hotkeys via `ashpd`.** `CreateSession` / `BindShortcuts` / `Activated`; map portal
   activations onto the existing `on_hotkey_triggered` path so built-in behaviours and
   `hotkey:triggered` are unchanged. Report `HotkeyCapability::UserChosen`.

5. **Hotkeys UI: the `UserChosen` mode.** Render `trigger_description` read-only + a "Change…"
   button wired to `ConfigureShortcuts`, plus explanatory copy.
   Files: `src/views/main/ui/panels/`, `src/features/record-hotkey/`, `messages/en.json`.
   *Real UI work — do not fold into step 4.*

6. **`shell/autostart.rs`.** Backend routing, packaging-format detection, real `is_enabled()`
   (parse `Hidden=` / `X-GNOME-Autostart-enabled=`; ask SMAppService), rewrite-on-launch,
   Background portal for Flatpak/Snap, the one-time macOS legacy-plist migration, and the
   settings-store autostart marker. Keep the plugin **only** for the Windows registry path.
   New dep: `objc2-service-management 0.3.2` (macOS).

7. **macOS Auto Dark read.** `NSApp.effectiveAppearance` via KVO (not the notification);
   `respondsToSelector:` probe. **Audit `tray.rs`'s off-Windows theme source** against the
   `Window::set_theme` override trap (§4.5).

8. **macOS Auto Dark set (SkyLight), behind a Cargo feature.** `dlopen`/`dlsym`
   `SLSSetAppearanceThemeNotifying` + `SLSSetAppearanceThemeSwitchesAutomatically`. Compiled out of
   any MAS build.

9. **Linux Auto Dark read (portal Settings).** ⚠️ **Blocked on spike S3** (linux.md §9 is
   UNVERIFIED). Report the *set* half as unavailable.

10. **macOS packaging.** Add `app` + `dmg` to `bundle.targets`; adopt the stable signing identity
    (plan 07 §6); notarization in `release.yml`; version lockstep across `package.json`,
    `tauri.conf.json` and `Cargo.toml` as AGENTS.md requires.

11. **Linux packaging.** `.desktop` file (step 3), `libgtk-layer-shell` dependency for deb/rpm and
    bundled into AppImage (plan 07 §6), tray host dependency once S4 resolves.

## 6. Permissions, packaging, distribution

- **Windows:** none. The taskbar accent effect uses an undocumented API but no privilege.
- **macOS:**
  - Hotkeys (normal keys): **none** — this is why we keep Carbon.
  - Hotkeys (media keys): **Input Monitoring** → **blocklisted**, so effectively none.
  - Autostart via `SMAppService`: **no entitlement, no Info.plist key, no TCC prompt** — but
    **requires a valid signature** (`kSMErrorInvalidSignature`).
  - Auto Dark set via SkyLight: **private → App Store fatal**; notarization unaffected. Gate behind
    a Cargo feature.
  - AppleScript theme fallback: **Automation TCC + `NSAppleEventsUsageDescription`, blocked under
    App Sandbox** — recommended **not** to ship.
  - **No Info.plist key exists** for Accessibility, Screen Recording or Input Monitoring (macos.md
    §M, verified against Apple's protected-resources list). `NSInputMonitoringUsageDescription` is
    **undocumented folklore** — harmless, fixes nothing. Do not add it.
  - ❌ **Do NOT add `tauri-plugin-macos-permissions`** (macos.md §M): microphone check **panics**
    (issue #5); Screen Recording **broken on 15.5** (issue #12); pins `macos-accessibility-client
    ^0.0.1` published **Jan 2021** (caret on `0.0.x` is patch-exact, so 0.0.2 is excluded); and
    **non-macOS stubs return `Ok(true)` — cross-platform code gating on these reads "granted"
    everywhere else: fail-open by default.** Each binding is 5–20 lines; **vendor the 2–3 we need.**
- **Linux:**
  - Portal GlobalShortcuts: no permission, but **requires an installed `.desktop` matching the
    app_id**, reverse-DNS on GNOME. **This is a packaging requirement with a runtime failure mode.**
  - Background portal (Flatpak autostart): user-approved, no manifest permission.
  - `evdev` fallback (not recommended): `input` group + udev rule, and it **sees every keystroke
    system-wide**.
- **Forecloses:** the SkyLight theme setter forecloses the Mac App Store *for that feature*; behind
  a Cargo feature it forecloses nothing structurally. Plan 07's tint overlay is the actual MAS
  blocker.

## 7. Failure modes & degradation

| Condition | Today | After this plan |
|---|---|---|
| 🔴 **Wayland, any hotkey** | `register()` returns `Ok(())`, key **never fires**, nothing reported | Portal path where available; `HotkeyCapability::Unavailable { reason }` on wlroots/sway/COSMIC/niri, shown in the panel |
| 🔴 **macOS, user binds Cmd+Space** | `Ok(())`, never fires, no signal | Rejected at record time by the denylist with a real reason |
| **macOS, media key bound** | Fails with a misleading error, or works then silently dies when the tap is disabled | Blocklisted at record time |
| **macOS, any registration failure** | Surfaces `io::Error::last_os_error()` — **stale `errno` garbage** ("os error 2") | Generic message + our own diagnostics; never the raw plugin string |
| 🔴 **Flatpak autostart** | Write **silently succeeds and does nothing** | Background portal; `Unavailable` where no backend exists (wlr, gtk) |
| **Linux, user disabled autostart in the GUI** | `is_enabled()` returns **true** (existence check) | Parses `Hidden=` / `X-GNOME-Autostart-enabled=` |
| **AppImage version bump** | Entry silently breaks; `is_enabled()` still true | Rewritten on every launch |
| **macOS autostart** | Appears under "Allow in the Background" **as the signing org's name** | `SMAppService` → "Open at Login", correct app name, one notification |
| **macOS, legacy LaunchAgent + new SMAppService** | — | One-time migration deletes the plist, or the app **launches twice** |
| **Linux Auto Dark set** | Inert | Reported unavailable (read-only for v1) |
| **macOS, we set our own app appearance** | `Window::theme()` silently starts returning our override, not the system's | Read the system theme from `NSApp.effectiveAppearance` only; audit `tray.rs` |
| **System Settings already open on another pane** | Deep link may silently not navigate | killall + `pgrep -x` poll before opening |
| Crash while a taskbar effect is applied | `restore_on_exit` is graceful-only; a hard kill leaves the taskbar accent applied | **Accept and document.** Unlike gamma, the effect is cosmetic and Explorer restores it on restart. Note the contrast with plan 01, where macos.md's 11th pass confirms gamma is **NOT** restored on process exit and a **crash-safe out-of-band reset is mandatory**. |

## 8. Testing

**Unit-testable (CI, every platform):**
- `validate_accelerator` — already has five tests (`hotkeys/mod.rs` lines 303–342). **Extend with the
  macOS denylist**: every reserved combo rejected, every media key rejected, Globe/fn rejected,
  ordinary combos still accepted, and the denylist inert on non-macOS targets.
- The registry's replace/duplicate semantics (already exercised indirectly) — add direct tests for
  "re-registering an id replaces", "duplicate accelerator across ids is rejected", "idempotent
  re-register does not disarm".
- Auto Dark schedule resolution — `resolve(&settings, now_minutes)` is already pure; ensure
  coverage of both independent app/system schedules, `disable` leaving a target untouched, and
  midnight-crossing sunrise/sunset.
- Autostart backend selection from a packaging-format snapshot (`/.flatpak-info`, `$SNAP`,
  `$APPIMAGE`, plain) → `AutostartBackend`. Pure over a struct.
- **Accelerator ↔ portal trigger-grammar translation** (§4.3): `"Ctrl+Shift+Space"` ↔
  `CTRL+SHIFT+space`, `"Alt+ArrowUp"` ↔ `ALT+Up`, `"F5"` ↔ `F5`, `"Ctrl+Alt+Enter"` ↔
  `CTRL+ALT+Return`. Round-trip properties plus the xkbcommon keyname mapping. Pure, and the kind of
  thing that is silently wrong in production if untested.
- **Hyprland `bind` line generation** (Q1): exactly three commas, no trailing comma. A one-line
  assertion that prevents a silently corrupted user config.
- `.desktop` parsing: `Hidden=true` disables; `NoDisplay=true` does **not**; missing keys mean
  enabled. **This is the exact bug the plugin has — test it explicitly.**
- `ShellCapability` → UI message mapping (frontend + `bun run check:i18n`).

**Manual only:**
- Every hotkey on every desktop, **including verifying reserved combos are rejected rather than
  silently dead** — the failure being tested for is "nothing happens", which no automated harness in
  CI can observe.
- Portal flow on KDE Plasma, GNOME 48+, and Hyprland: `CreateSession` after `Registry.Register`,
  the user-chosen combo, `trigger_description` rendering, and `ConfigureShortcuts`.
- Autostart end-to-end: reboot on each platform and packaging format. **There is no substitute.**
- macOS: System Settings → Login Items shows the app name (not the org name), one entry, one
  notification.
- Tray on each desktop (pending S4).
- Auto Dark: watch a real sunset transition, and a sleep-across-transition.

**Cannot be tested in CI:** all of the above. Additionally **macOS behaviour is untestable under
`tauri dev`** — it produces no `.app`, no Info.plist, no bundle identifier (macos.md §L), which
means `SMAppService` (needs a bundle + signature) and the deep links cannot be exercised there at
all. **Test against a signed, bundled `.app`.**

## 9. Open questions / spikes needed

**S1 — Portal GlobalShortcuts end-to-end on KDE and GNOME. BLOCKING step 4.**
The interface is documented and the support matrix is [VERIFIED], but the sequencing is not: does
`Registry.Register` succeed for a non-sandboxed deb-installed binary; does GNOME accept our
reverse-DNS app_id; what does `trigger_description` actually look like (copy sizing); how does
session teardown/recreate behave when the user edits the hotkey set. Estimated: 2 days across two
desktops.

**S2 — `zbus` async-runtime feature vs Tauri's tokio. BLOCKING step 3.**
linux.md flags it as a hard constraint (*"Do not mix"*) without a verified resolution. Determine
whether `ashpd`'s tokio feature composes cleanly with Tauri 2.11.2's runtime, or whether isolation
(as PR #172 does with async-std) is required. Cheap to test, expensive to get wrong. Estimated:
half a day.

**S3 — Linux theme portal. PARTIALLY RESOLVED; still BLOCKING step 9, but smaller.**
linux.md §9 was wholly `[UNVERIFIED]`. §PP (gap-closer) now confirms the `color-scheme` integer
semantics (via the exact `GDesktopColorScheme` correspondence) and resolves the two questions that
most affect the design: **the XFCE portal blind spot** and **tao's silent `Theme::Light` fallback**
(both in §4.5). **What remains unverified:** the precise `Read`/`ReadOne` call shape and
`SettingChanged` signal handling through `ashpd`, and the per-DE setters. Since the recommendation
is **read-only for v1**, the setter half can stay unresolved indefinitely.
Estimated: **half a day** (down from 1 day + spike).

**S4 — Tray on macOS and Linux. BLOCKING steps 10–11 and any tray verdict.**
Neither research document covers it (§3e). Open: does Linux need `libayatana-appindicator` as a
runtime dependency, and for which packaging formats; how does GNOME handle tray icons; does macOS
`NSStatusItem` behave with our `.accessory` activation policy (plan 07 sets it); and **critically,
can the transparent webview flyout be positioned relative to a tray icon on Wayland at all**, given
that plan 07 establishes `set_position` silently no-ops there. **The likely answer is no**, which
would mean the flyout architecture — the deliberate design decision recorded at the top of
`tray.rs` — needs a Wayland fallback (a native menu, accepting the "ten buttons shaped like a
slider" compromise it was created to avoid). Estimated: 2 days. **Treat this as the plan's biggest
unknown.**

**Q1 — Should Wayland users without a shortcuts portal (sway, river, COSMIC, niri) get instructions
instead of a feature?**
Their compositors all have first-class config-file keybinding (`sway bindsym --locked --to-code`,
`riverctl map`, Hyprland `bind`). We could expose a copy-pasteable line invoking a DimRead CLI
command. **Recommendation: yes, and it is cheap** — a "your compositor manages shortcuts; add this
to your config" panel is more useful and more honest than a disabled control, and linux.md §NN makes
clear the portal is **never** coming to wlroots, so this is the permanent answer for those users,
not a stopgap. Requires a CLI entry point, which the single-instance plugin already makes plausible.
⚠️ Generate Hyprland lines carefully — **exactly three commas** (§4.3).

**Q2 — Is Auto Dark worth shipping on macOS at all, given it needs a private API?**
It is F9.5 parity, but it is the *only* thing in this plan that touches a private API, and it flips
a global user preference. **Recommendation: ship it behind the Cargo feature, default OFF, with the
deep-link fallback** — and if the feature-gating turns out to complicate the build, drop it. It is
not why anyone installs this app.

## 10. Effort

| Area | Size | Notes |
|---|---|---|
| `ShellCapability` + reporting (step 1) | **S** | Prerequisite for everything honest. |
| macOS hotkey denylist (step 2) | **S** | No new deps; fixes a silent-failure class. **Best value in the plan.** |
| Portal app-ID + `.desktop` (step 3) | **M** | Shared by hotkeys, autostart and theme. Blocked on S2. |
| Wayland hotkeys via `ashpd` (step 4) | **L** | Blocked on S1 + S2. |
| Hotkeys `UserChosen` UI (step 5) | **M** | Real frontend work; new i18n keys. |
| `shell/autostart.rs` (step 6) | **L** | Four backends, a migration, and packaging detection. |
| macOS Auto Dark (steps 7–8) | **M** | Read is easy; set is a gated private call. |
| Linux Auto Dark (step 9) | **S** | Read-only, and blocked on S3. |
| Packaging (steps 10–11) | **M** | macOS signing/notarization is the long pole. |
| Tray | **UNKNOWN** | Blocked on S4. Could be XS or could invalidate the flyout on Wayland. |

**Single biggest risk: S4 — the tray flyout may not survive Wayland.** `tray.rs`'s opening comment
records a deliberate architectural choice (a webview flyout instead of a native menu, because a
native menu cannot host a brightness slider). Plan 07 establishes that `set_position` silently
no-ops on Wayland, and the flyout must be positioned relative to the tray icon. If that cannot be
done, the Wayland fallback is the native menu the design was written to avoid — a visible product
regression on the platform that is becoming the Linux default. **Resolve S4 before committing to any
tray work.**

**Second risk: the Wayland hotkey UX change (§4.3) is easy to under-scope.** "Use the portal" sounds
like a backend swap; it is actually a different interaction model in which **the user, not the app,
owns the binding.** The settings panel needs a second mode, new copy, and a "Change…" affordance
that hands off to the desktop. Budget it as UI work from the start rather than discovering it in
step 4.

**Third risk: silent success is this plan's signature failure.** Hotkey `register()` under XWayland,
Flatpak autostart writes, `is_enabled()` after a GUI disable, macOS reserved combos, and the macOS
event tap dying mid-session **all report success while doing nothing**. Every step above that
converts one of those into a reported state is worth more than it looks on the estimate.
