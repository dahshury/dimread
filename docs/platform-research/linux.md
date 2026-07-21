# Linux platform research (X11 + Wayland) — 2026-07

Research substrate for the cross-platform plans. Findings are tagged:
**[VERIFIED]** = primary source fetched this session (URL given) ·
**[UNVERIFIED]** = not confirmed, do NOT implement against it without re-research.

---

## 0. The premise correction that reframes everything

**Building X11-first and treating Wayland as a fallback is backwards in 2026.**

| Platform | X11 session status | [VERIFIED] |
|---|---|---|
| GNOME 49 (2025-09) | X11 session disabled at build time | blogs.gnome.org/alatiera/2025/06/08 |
| **GNOME 50 (2026-03)** | **X11 REMOVED** — mutter X11 backend, GDM X11, XDMCP gone; ~27,540 lines deleted | theregister.com/2026/03/19/gnome_50 |
| KDE Plasma 6.7 (2026-06) | **Last** release with an X11 session | blogs.kde.org/2025/11/26 |
| KDE Plasma 6.8 (~2026-11) | Wayland-exclusive | " |
| Fedora 43 (2025-10) | GNOME X11 packages removed from repos | fedoraproject.org/wiki/Changes/WaylandOnlyGNOME |
| Ubuntu 25.10 / 26.04 LTS | GNOME-on-Xorg removed / Wayland-only | discourse.ubuntu.com/t/62538 |
| RHEL 10 | Xorg server removed (Xwayland kept) | redhat.com/en/blog/rhel-10-plans-wayland-and-xorg-server |
| Debian 13 trixie | X.org sessions still shipped | wiki.debian.org/Wayland |
| openSUSE Tumbleweed | Still defaults KDE to X11 (Jan 2026) | medium confidence |

**Xwayland is not a fallback for us.** It gives no root window → no `_NET_ACTIVE_WINDOW`,
and no working XRandR gamma for the real outputs. An X11 *app* runs; X11 *capabilities* do not.

**Adoption share** — the only real longitudinal data is KDE's opt-in telemetry: 73% of Plasma 6
users on Wayland (2025-06) → 79% (2025-12) → **>95% of Plasma 6.6 users** (2026-06, all-versions
~76%). Self-selection caveats apply. **The Steam Hardware Survey does NOT report session type**
(verified — any article claiming a "Steam Wayland split" is not using Steam data;
ValveSoftware/steam-for-linux#8620 requesting it is still open). Mozilla's last figure is 2022 and
stale. A widely-quoted "Arch 2025 survey: 80% Wayland" appears only on SEO aggregators — do not cite.

**NVIDIA is no longer the blocker**: explicit sync (`linux-drm-syncobj-v1`) landed in 555.42.02
(2024-05), stable in 555.58; the 580 series (2025-08) fixed GTK4 Vulkan crashes on Wayland.

> **Planning consequence:** the dominant Linux target is **GNOME Wayland**, which is also the
> **most restrictive** environment in this document. Nearly every capability below degrades there.

---

## 1. Gamma / colour temperature + brightness [VERIFIED]

### X11 — solved
RandR ≥1.3 per-CRTC: `RRGetCrtcGammaSize`, `RRGetCrtcGamma`, `RRSetCrtcGamma`.
Rust: `x11rb::protocol::randr`. (Legacy `XF86VidModeSetGamma` is per-*screen* — unusable for
multi-monitor.) Reference impl: redshift `src/gamma-randr.c`.

- **Ramp size varies per CRTC** (256/1024/4096) — always query `GetCrtcGammaSize`, never assume 256.
  → *Our `GammaRamp = [[u16;256];3]` must become size-agnostic with resampling.*
- Temperature and brightness compose into **one ramp** (redshift's `colorramp_fill` model) — same as ours.
- **Ramps are global single-slot state per CRTC.** Night Light / KDE Night Color / `xrandr --gamma` /
  another redshift instance all *overwrite* us. Unavoidable clash (jonls/redshift#759).
- Adjustments **stack** unless reset first (`--gamma 1:1:1`) (jonls/redshift#659).
- Reset by: mode change, output enable/disable, VT switch, X server restart, hotplug.
  → *Must watch RandR `ScreenChangeNotify` and re-apply.*
- LUT often **not applied to the hardware cursor** — cursor stays untinted.

### Wayland — no standard gamma protocol

| Compositor | Mechanism | Status |
|---|---|---|
| wlroots (Sway, Wayfire, river, labwc) | `wlr-gamma-control-unstable-v1` | ✅ works |
| Hyprland | wlr-gamma-control + `hyprland-ctm-control-v1` | ✅ works |
| **KDE / KWin** | **explicitly refused** wlr-gamma-control | ❌ → D-Bus |
| **GNOME / Mutter** | none | ❌ → D-Bus |
| COSMIC | open request | ❌ |

**`wlr-gamma-control-unstable-v1`** [VERIFIED — read the XML]:
`zwlr_gamma_control_manager_v1.get_gamma_control(id, wl_output)` → `zwlr_gamma_control_v1`;
event `gamma_size(size)`; request `set_gamma(fd)` where the fd holds **3 × gamma_size × uint16**
(R,G,B concatenated). **Exclusive** — a second client gets `failed`. **Destroying the object
restores original ramps**, so a crash auto-reverts (nice property).
Rust: `wayland-protocols-wlr` → `wlr::unstable::gamma_control::v1::client`.

**KDE's refusal rationale** (bugs.kde.org 479701): client-set LUTs "proven to not work or cause
conflicts on X11 even within the KDE ecosystem"; wrong mechanism "for power efficiency,
performance and color management reasons."

**`wp_color_management_v1` is NOT a substitute** — it is colorimetry/HDR, not tinting.

### Driving the desktop's own night light over D-Bus

**GNOME — `org.gnome.SettingsDaemon.Color`** [VERIFIED against gsd-color-manager.c]
path `/org/gnome/SettingsDaemon/Color`:
- `Temperature` **u, READWRITE**, validated against `[1000, 10000]` (out-of-range → D-Bus error), default 6500
- `NightLightActive` (b, ro), `DisabledUntilTomorrow` (b, rw), `Sunrise`/`Sunset` (d, ro), `NightLightPreview(u duration)`
- **Transient**: the setter does not write GSettings; the night-light scheduler recomputes it.
  gsd smears transitions over ~5 s so read-back never matches exactly.
- Persistent alternative: `gsettings set org.gnome.settings-daemon.plugins.color
  night-light-{enabled,temperature,schedule-automatic,schedule-from,schedule-to}`
  ("always on" trick = from 0, to 24). Works on X11 and Wayland (gsd computes, Mutter applies).
- A real-world `d` vs `u` type-mismatch report exists → **introspect at runtime, don't hardcode.**

**KDE — `org.kde.KWin.NightLight`** [VERIFIED against KWin source] path `/org/kde/KWin/NightLight`:
- Methods: `inhibit() -> u`, `uninhibit(u)`, **`preview(u temperature)`**, `stopPreview()`
- **ALL properties are READ-ONLY** (`currentTemperature`, `targetTemperature`, `enabled`, `running`, …)
- ⚠️ **There is no writable temperature.** `preview()` starts a hardcoded **15 s `QTimer`**
  (`m_previewTimer->start(15000)`) that auto-reverts. Clamped to **[1000, 6500]**.
  → Holding a custom tint requires re-issuing `preview()` on a **<15 s heartbeat**.
- Alternative: write `kwinrc [NightColor] NightTemperature` + `Active true`, then reconfigure
  (**exact reconfigure D-Bus call UNVERIFIED**).
- `inhibit()`/`uninhibit()` is the clean way to suppress KDE's night light while we own the tint.

---

## 2. Hardware backlight [VERIFIED] — a *new* capability, better than gamma dimming

**Internal panel — prefer logind, not sysfs.**
`org.freedesktop.login1` → `org.freedesktop.login1.Session.SetBrightness(s subsystem, s name, u value)`
(subsystem = `"backlight"`/`"leds"`). Polkit-gated, normally granted to the active local session
**with no prompt**. Explicitly designed for this use case.
Rust: `zbus`, hand-rolled proxy (**no canonical example found — UNVERIFIED**).

Direct sysfs (`/sys/class/backlight/*/brightness`) works but: **udev `GROUP=`/`MODE=` keys do NOT
apply** (backlight has no `/dev` node; the attr is kernel-hardcoded 0644 root). Requires a `RUN+=`
chgrp/chmod rule — what `brightnessctl` ships.

**External monitors — DDC/CI.** `i2c-dev` → `/dev/i2c-N` → MCCS VCP `0x10` (luminance),
`0x12` (contrast), `0x14` (colour preset).
Rust: **`ddc-hi`** (multi-backend: i2c on Linux, `ddc-winapi` on Windows, `nvapi` for NVIDIA) —
the right choice for a cross-platform app; also `ddc` + `ddc-i2c`.
⚠️ **`ddc-hi` maintenance status in 2026 UNVERIFIED** — check last-publish before committing.

Permissions: ddcutil ships `/usr/lib/udev/rules.d/60-ddcutil-i2c.rules` using the **`uaccess` tag**
(grants the active local session user, no group, no re-login) — the modern correct approach.
→ **We must ship a udev rule or depend on ddcutil. This is a hard blocker for pure Flatpak.**

DDC is slow (10s–100s ms/write) and monitors vary in conformance. **KDE's PowerDevil stopped
animating DDC changes "to minimize monitor lifespan risk" and applies after a 0.5 s debounce —
copy that behaviour.** Escape hatch: `POWERDEVIL_NO_DDCUTIL=1`.

**Avoid i2c entirely on KDE ≥6.2**: `org.kde.Solid.PowerManagement` →
`/org/kde/Solid/PowerManagement/Actions/BrightnessControl.setBrightness` covers internal *and*
DDC external, with hotplug handling. **No GNOME equivalent for external monitors.**

---

## 3. Monitor enumeration + stable IDs [VERIFIED]

**X11:** `RRGetScreenResourcesCurrent` → `RRGetOutputInfo` → `RRGetCrtcInfo`; primary via
`RRGetOutputPrimary`; work area from `_NET_WORKAREA`.
**Stable ID = the `EDID` output property** (`RRGetOutputProperty`, atom `EDID`) — contains PNP
vendor + product + serial, stable across ports and reconnects.
⚠️ **Connector names (`HDMI-1`, `DP-2`) are NOT stable.**

**Wayland:** `wl_output` gives geometry (incl. **make**/**model**), mode, integer `scale`, and
(v4+) `name`/`description`. ⚠️ **`name` may be reused after an output is destroyed** — not durable.
`description` is free-form, do not parse. Fractional scale needs `wp_fractional_scale_v1` or
xdg-output logical-size math. **EDID is NOT exposed to Wayland clients** — the substitute is
make+model, which cannot distinguish two identical monitors.

**Best Wayland IDs come from the desktop:** GNOME `org.gnome.Mutter.DisplayConfig.GetCurrentState()`
returns monitor specs `(connector, vendor, product, serial)` plus logical monitors with a **double**
(fractional) scale and primary flag. KDE: `kscreen-doctor -j` (**D-Bus interface UNVERIFIED**).

**What Tauri/GTK give:** Tauri v2 `Monitor` = name/size/position/work_area/scale_factor — **no
stable ID, no EDID, no vendor/model, no primary flag**. GDK3 `GdkMonitor` adds
`get_manufacturer`/`get_model`/`is_primary` but **integer scale only**.
→ Use Tauri/GDK for geometry, RandR-EDID or Mutter DisplayConfig for the **settings key**.

---

## 4. Fullscreen grayscale / invert [PARTIAL]

**[VERIFIED] Gamma ramps CANNOT do grayscale.** A LUT is three independent 1-D per-channel curves;
grayscale requires channel *mixing* (`Y = 0.2126R + 0.7152G + 0.0722B`) — a 3×3 matrix. This is
arithmetic, not policy. Impossible via `RRSetCrtcGamma`, `wlr-gamma-control`, or any LUT.
→ **Reading mode cannot ride on the gamma engine on any platform.**

The matrix primitive exists in DRM/KMS (`DEGAMMA_LUT → CTM → GAMMA_LUT`; amdgpu + i915 expose `CTM`).
X11 exposure of CTM via xrandr output properties is **contested/UNVERIFIED** — assume not portable,
no NVIDIA proprietary support. Hyprland has a real path (`hyprland-ctm-control-v1`, plus
`decoration:screen_shader` GLSL).

**UNVERIFIED (needs follow-up):** GNOME `org.gnome.desktop.a11y.magnifier` (`color-saturation`,
`invert-lightness`) as a grayscale route; KWin effect IDs + `org.kde.KWin.Effects`
`loadEffect`/`toggleEffect`.

**Bottom line: no cross-desktop standard. Implement per-desktop or not at all.**

---

## 5–6. Foreground-window tracking + window enumeration [VERIFIED against source trees]

### The single most important architectural fact

**GNOME/mutter and KDE/KWin implement NEITHER `ext-foreign-toplevel-list-v1` NOR
`zwlr-foreign-toplevel-management-v1`** — verified directly against `GNOME/mutter@main` (only
`xdg-foreign`, an unrelated protocol) and `KDE/kwin@master` (only `plasmawindowmanagement`,
`xdgforeign_v2`; open request = KDE Bug 502647). Any strategy built on those protocols covers
wlroots-family compositors only — a minority of seats.

| Capability | X11 | Wayland std. protocols | Compositor IPC |
|---|---|---|---|
| Active window | ✅ `_NET_ACTIVE_WINDOW` | ⚠️ `activated` state only | ✅ |
| Title | ✅ `_NET_WM_NAME` | ✅ `title` | ✅ |
| Process identity | ✅ `_NET_WM_PID` + XRes | ⚠️ **`app_id` string only — NO PID** | ✅ real PID |
| **Geometry** | ✅ | ❌ **NEVER exposed** | ✅ |
| Enumerate all | ✅ `_NET_CLIENT_LIST` | ⚠️ where implemented | ✅ |

**X11:** `_NET_ACTIVE_WINDOW` on root; push-based tracking via `PropertyChangeMask` +
`PropertyNotify`. Geometry needs `XTranslateCoordinates` (reparenting WMs insert frame windows).
Enumerate via `_NET_CLIENT_LIST`; **prefer XRes 1.2 `XResQueryClientIds` over `_NET_WM_PID`**
(the latter is voluntary and may carry a sandbox/remote PID) — Metacity, Marco and wlroots all
migrated to XRes.

**Wayland — definitive: a normal client cannot learn the focused window, any window's geometry,
or even its own absolute position.** `ext_foreign_toplevel_handle_v1` events are exactly
`title`, `app_id`, `identifier`, `done`, `closed` — that is the entire surface.
`zwlr_foreign_toplevel_handle_v1` adds `output_enter/leave`, `state` (incl. **`activated`**),
`parent`. **Neither carries PID or geometry.** The only rectangle in the protocol is the
`set_rectangle` *request* (you tell the compositor where you draw a thumbnail) — not a getter.

Rationale: `app_id` is the chosen identity boundary (maps to a `.desktop` file, meaningful across
sandboxes where PIDs are not); geometry is withheld because a global coordinate space is the
primitive enabling click-jacking and overlay phishing. Focus-stealing is likewise gated behind
`xdg-activation-v1` single-use tokens.

**XDG portals: confirmed NO window-info portal.** Full interface list enumerated; the closest is
`ScreenCast` with `SelectSources(types=WINDOW)`, which is user-mediated and yields a PipeWire
stream, not a queryable model. No proposal in flight.

**GNOME Shell `org.gnome.Shell.Eval` is blocked** since GNOME 41 (allow-list + unsafe-mode, which
is a manual per-session developer toggle with a persistent top-bar indicator). **Unavailable for a
shipping app.**

### Backends that DO give full fidelity

| Source | Geometry | PID | Focus events | Transport |
|---|---|---|---|---|
| **sway** `GET_TREE` | ✅ `rect` | ✅ | ✅ `window` event | i3-IPC UNIX socket (`$SWAYSOCK`) |
| **Hyprland** `clients`/`activewindow` | ✅ `at`,`size` | ✅ | ✅ `.socket2.sock` push | UNIX socket JSON |
| **KWin scripting** | ✅ `x/y/width/height` | ✅ `pid` | ✅ `workspace.windowActivated` | D-Bus `org.kde.kwin.Scripting.loadScript` + injected JS calling back via `callDBus` |
| **GNOME Window Calls ext** | ✅ | ✅ | ✅ | D-Bus `org.gnome.Shell.Extensions.Windows` |

KWin scripting is a **supported third-party route**: `org.kde.KWin` `/Scripting`
`loadScript(path, name)` + `start()`; `workspace.activeWindow`/`windowList()`/`stackingOrder`;
`KWin::Window` exposes `x/y/width/height`, `pid`, `caption`, `resourceClass`, `desktopFileName`.

GNOME requires the user to install a **third-party extension** (ickyicky/window-calls or
flexagoon/focused-window-dbus). Extensions break across GNOME majors. Real deployment burden.

---

## 7. Overlay windows (click-through, always-on-top, all-monitor) [PARTIAL]

**[VERIFIED] Tauri on Wayland is broken for our overlay needs:**

| Issue | Finding |
|---|---|
| tauri#3117 | always-on-top **does not work** on Wayland (blocked upstream) |
| tao#1134 | `with_always_on_top(true)` fails on Wayland; works X11/XWayland |
| tauri#14913 | `set_position` + ordering **silently no-op** on the Wayland backend |
| tauri#13070 | click-through on transparent regions = **open feature request** |
| tauri#8308 | `window.transparent` reported broken on Linux in v2 |

Root cause is protocol, not a Tauri bug: Wayland has **no client-side global positioning and no
client-settable stacking order**. Only the compositor decides.

**[VERIFIED] Which Tauri primitives actually survive Wayland** (traced through tao/GTK3 source):

| Tauri API | tao/GTK3 call | Wayland |
|---|---|---|
| `set_ignore_cursor_events(true)` | `input_shape_combine_region(empty)` | ✅ **works** (GDK maps it to `wl_surface.set_input_region`) |
| `transparent: true` | `rgba_visual()` + `set_app_paintable` | ✅ works |
| `set_always_on_top` | `gtk_window_set_keep_above` → EWMH | ❌ silent no-op |
| `set_skip_taskbar` | `_NET_WM_STATE_SKIP_TASKBAR` | ❌ silent no-op (tauri#9829) |
| `set_position` | `gtk_window_move` | ❌ silent no-op (tauri#14913, tao#566) |
| `set_focusable(false)` | `gtk_window_set_accept_focus` | ❌ no-op |

Only `shadow` is *documented* as Linux-unsupported; **every other failure above is undocumented and
silent** — the dominant failure mode on this platform.

**[VERIFIED] GNOME refused layer-shell, definitively.** mutter#973, opened 2019-12-14, last touched
2024-02-20, **CLOSED without implementation**, labelled *"Requests for a protocol which may not be
implemented by Mutter, or exposed to all clients."* Companion gnome-shell#1141. GNOME's position:
this belongs in the Shell extension system, not a client protocol.

**[VERIFIED] `ext-layer-shell` DOES NOT EXIST.** Checked against the full `ext-*` set in
wayland-protocols staging: `ext-background-effect-v1`, `ext-data-control-v1`,
`ext-foreign-toplevel-list-v1`, `ext-idle-notify-v1`, `ext-image-capture-source-v1`,
`ext-image-copy-capture-v1`, `ext-session-lock-v1`, `ext-transient-seat-v1`, `ext-workspace-v1`.
The only layer-shells in the registry are `wlr-layer-shell-unstable-v1` and `river-layer-shell-v1`.
**Standardization is not coming** — GNOME's veto in the consensus model is the blocker.
*Plan around the fragmentation permanently, not as a transitional state.*

### ★ [VERIFIED] THE ESCAPE HATCH — tao already supports layer-shell integration

**`WindowExtUnix::new_from_gtk_window`, added by tao PR #938 (merged 2024-06-27)**, exists precisely
because gtk-layer-shell needs `gtk_layer_init_for_window()` *before* the window is mapped and tao
maps immediately (tao#925). Working pattern on Wayland:

1. Create a `gtk::ApplicationWindow` yourself
2. `gtk_layer_init_for_window` → `set_layer(OVERLAY)` → `set_anchor(×4, true)` →
   `set_exclusive_zone(-1)` → `set_keyboard_mode(NONE)` → `set_namespace("dimread-overlay")`
3. Hand it to tao via `new_from_gtk_window`; wry attaches the webview
4. **One such window per `wl_output`** — layer-shell takes a single output, there is no spanning
   surface (unlike X11, where one window at (0,0) sized to the union just works)

`Window::gtk_window()` / `default_vbox()` are re-exported on `tauri::Window` / `WebviewWindow`
(Linux/BSD, **main thread only**).

**Crate status:** the **C** library `gtk-layer-shell` is **v0.10.1 (2026-04-04), maintained**. The
**Rust** GTK3 wrapper is **unmaintained (RUSTSEC-2024-0423, repo archived)** — but it is a thin gir
shim over a stable C API, so **vendoring ~500 lines is reasonable**. `gtk4-layer-shell` is
maintained but wrong toolkit. Alternatives: `smithay-client-toolkit`
(`shell::wlr_layer::*`), `wayland-protocols-wlr` (`layer_shell::v1::client`), `layershellev` 0.19.1.

**X11 recipe [VERIFIED]:** `_NET_WM_STATE_ABOVE`, `_NET_WM_STATE_FULLSCREEN` +
`_NET_WM_FULLSCREEN_MONITORS` (span multiple monitors with ONE window), `_NET_WM_DESKTOP=0xFFFFFFFF`,
`_NET_WM_WINDOW_TYPE_DOCK`/`_NOTIFICATION`. Click-through via `XFixesSetWindowShapeRegion(…,
ShapeInput, empty)` or `XShapeCombineRectangles(…, ShapeInput, …, ShapeSet)` — **`ShapeInput`
controls clickability, `ShapeBounding` controls visibility**. Crates: `x11rb::protocol::{shape,
xfixes}` (feature-gated), `gdkx11` for `gdk_x11_window_get_xid()` to bridge GTK → x11rb.

**Conclusion:** overlay is straightforward on **X11**, achievable on **KDE + wlroots Wayland** via
the `new_from_gtk_window` + gtk-layer-shell path, and **impossible on GNOME Wayland** for a normal
app. GNOME's only realistic routes are the D-Bus night-light path (§1) or forcing
`GDK_BACKEND=x11`.

---

## 8. Per-window effects on *other* apps' windows [PARTIAL]

**X11 — YES, genuinely possible** [VERIFIED]:
1. **`_NET_WM_WINDOW_OPACITY`** — a 32-bit CARDINAL property. **X11 has no property ACLs, so any
   client can set it on any other client's window.** Honoured by picom/KWin/Mutter. This is how
   `transset`/`picom-trans` work. One `ChangeProperty` call to dim a foreign window.
2. **picom per-window shaders** — `window-shader-fg` + `window-shader-fg-rule` (GLX backend);
   a GLSL grayscale shader per window is a documented working feature. Requires the user runs picom
   (excludes GNOME/KDE X11 sessions).
3. Translucent click-through override-redirect window tracking the target's geometry.

**Wayland — NO. Impossible by design.** There is no global surface namespace; a client cannot
obtain a handle to, name, read, or modify another client's surface, and there is no cross-client
property mechanism at all. Only the compositor can apply per-window effects.

Escape hatches (asking the *compositor* to do it):
- **Hyprland**: `hyprctl keyword windowrulev2 opacity 0.8,class:^(foo)$` (**syntax UNVERIFIED**)
- **KWin**: window rules support per-window opacity; runtime third-party installation **UNVERIFIED**
- **GNOME**: no mechanism at all

---

## 9. System light/dark theme [UNVERIFIED — pending follow-up]

Believed but **not confirmed this session**: XDG portal `org.freedesktop.portal.Settings`
(`Read`/`ReadOne`, namespace `org.freedesktop.appearance`, key `color-scheme`:
0=no preference, 1=prefer-dark, 2=prefer-light; `SettingChanged` signal); read-only, no standard
cross-desktop *set*; `ashpd` crate binding; per-DE setters (`gsettings … color-scheme`,
`plasma-apply-colorscheme`, `xfconf-query`); what Tauri v2 `Window::theme()` resolves to on Linux.

---

## 10. Global hotkeys + autostart [VERIFIED]

### Hotkeys — our current implementation is broken on Wayland, silently

**`tauri-plugin-global-shortcut` → `global-hotkey` is X11-only; there is no Wayland code path.**
Worst-possible failure mode: under Wayland it connects to **XWayland** via `$DISPLAY`, `XGrabKey`
succeeds against the XWayland root, **`register()` returns `Ok(())`** — and the key never fires,
because native Wayland clients' input never traverses XWayland. The Tauri plugin docs list Linux ✓
with no display-server caveat.
(A widely-repeated claim that the plugin uses `zwp_keyboard_shortcuts_inhibit_manager_v1` is
**false** — on Linux it is `x11rb` + `xkeysym` + `keyboard_types`, nothing else.)

**`org.freedesktop.portal.GlobalShortcuts` — interface v2**, since xdg-desktop-portal **1.16.0
(2022-12-12)**; `ConfigureShortcuts` + `activation_token` in 1.21.0.
`CreateSession` / `BindShortcuts` / `ListShortcuts` / `ConfigureShortcuts`;
signals `Activated` / `Deactivated` / `ShortcutsChanged`.

| Backend | Status |
|---|---|
| KDE (xdg-desktop-portal-kde) | ✅ **Plasma 5.27, 2023-02** (built on KGlobalAccel) |
| Hyprland | ✅ 2023-09 |
| GNOME | ✅ **GNOME 48, 2025-03** (late) |
| **wlroots / sway / river / Wayfire** | ❌ **not implemented** — xdg-desktop-portal-wlr#240 open since 2022-09 |
| COSMIC, niri | ❌ |

Dashboard: areweglobalshortcutsyet.github.io

⚠️ **Two hard constraints that change our UX:**
1. **The app cannot choose or even know the key combination — the user does**, in the DE's settings
   UI. `preferred_trigger` is only a hint; we must render the returned **`trigger_description`** in
   our settings panel, with a "Change…" button wired to `ConfigureShortcuts`.
2. *"An application can only attempt to bind shortcuts of a session once"* — changing the set means
   tearing down and recreating the session.

⚠️ **The app-ID trap:** since portal 1.21.0 `CreateSession` **rejects connections with no app ID**.
A normally-installed (non-sandboxed) binary must first call
`org.freedesktop.host.portal.Registry.Register(app_id, …)` — once per D-Bus peer, **before any other
portal call** — with an `app_id` matching an *installed* `.desktop` basename (GNOME additionally
demands reverse-DNS). This is exactly what broke Chromium/Electron on GNOME 50.

**Route: use `ashpd` directly** (`features = ["global_shortcuts"]`) branching on `$WAYLAND_DISPLAY`;
do not wait for global-hotkey PR #172 (unmerged as of 2026-07).
⚠️ **`zbus`'s async-runtime feature is global and Tauri uses tokio** — either use ashpd's tokio
feature consistently or isolate with async-std as PR #172 does. **Do not mix.**

Fallbacks: `evdev` (universal, below the display server, but needs `input` group + udev rule, sees
every keystroke system-wide, and cannot consume the event); compositor config
(Hyprland `bind`, sway `bindsym --locked --to-code`, river `riverctl map`); KDE `kglobalaccel`
(inferior to the portal on KDE, since the portal backend *is* KGlobalAccel); GNOME
`org.gnome.settings-daemon.plugins.media-keys custom-keybindings` (⚠️ `set` **overwrites** the array
— read-modify-append, and use a namespaced path segment).

### Autostart

XDG `~/.config/autostart/*.desktop`. **`Hidden=true` is the correct disable mechanism**;
`NoDisplay` does NOT disable autostart (routinely confused). Honoured by GNOME/KDE/XFCE/
Cinnamon/MATE/LXQt/Budgie — **NOT by sway/Hyprland/river/bare wlroots** (need `dex --autostart`,
`systemd-xdg-autostart-generator` + `xdg-desktop-autostart.target`, or sway-systemd).

⚠️ **`tauri-plugin-autostart` (2.5.1) pins `auto-launch ^0.5`**, which:
- hardcodes `~/.config/autostart/` (**ignores `$XDG_CONFIG_HOME`**)
- **does no shell quoting** of the exec path — any space (common in AppImage paths) yields a
  malformed `Exec=`
- `is_enabled()` is an **existence check only** — it does not parse `Hidden=` or
  `X-GNOME-Autostart-enabled=false`, so an entry the user disabled via the GNOME/Cinnamon GUI still
  reports "enabled"
- emits no `TryExec=`, `Icon=`, or `X-GNOME-Autostart-*`

⚠️ **Flatpak autostart is broken** (plugins-workspace#3166, open): it writes `Exec=/app/bin/dimread`,
which the host cannot run. A Flatpak's `~/.config` is redirected to `~/.var/app/<id>/config/`, so
writing the file from inside the sandbox **silently succeeds and does nothing**.
Correct route: `org.freedesktop.portal.Background.RequestBackground{autostart:true, commandline:[…]}`
— the portal daemon runs on the host, writes the real `~/.config/autostart/<app-id>.desktop`, and
rewrites `Exec=flatpak run --command=… <APP_ID> …`. **Background portal backends: GNOME ✅, KDE ✅,
xdg-desktop-portal-wlr ❌ (not exported at all), xdg-desktop-portal-gtk ❌ in current versions.**

⚠️ **AppImage:** the plugin correctly special-cases `$APPIMAGE`, but the filename carries the
version, so **a version bump silently breaks the entry** while `is_enabled()` still returns true.
Re-validate and rewrite the entry on every launch.

---

## Recommended architecture

**Runtime backend detection + strategy pattern**, e.g. `src-tauri/src/platform/linux/`, one module
per backend. **Detect `$WAYLAND_DISPLAY` FIRST** — a Tauri app under Xwayland also sees `$DISPLAY`
set, and checking `$DISPLAY` first misroutes to a backend that sees only Xwayland clients.
Then identify the compositor via `$XDG_CURRENT_DESKTOP`, `$SWAYSOCK`, `$HYPRLAND_INSTANCE_SIGNATURE`.

Backends in descending data quality:
1. **X11** (`x11rb` + hand-rolled EWMH + XRes) — full fidelity
2. **sway** (`swayipc`) / **Hyprland** (`hyprland` crate) — full fidelity
3. **KWin** (`zbus` → `loadScript` + JS shim) — full fidelity, must ship the shim
4. **GNOME** (`zbus` → Window Calls extension) — full fidelity, requires user-installed extension;
   detect absence and degrade with a clear in-app explanation
5. **Generic Wayland** (`wayland-protocols{,-wlr}`) — title + app_id + activated only

> **Design the data model around the weakest backend.** Make `pid` and `geometry` `Option<…>` in
> the Rust types **and in the tauri-specta bindings from day one**. The generic Wayland path can
> never fill them, and retrofitting optionality through `src/bindings.ts` and the frontend later is
> far more painful than accepting it now. Key the model on **`app_id`/`wm_class`, not PID** — it is
> the one identifier available on every backend.

### Implementation matrix (verified material only)

| Target | Tint / temperature | Brightness |
|---|---|---|
| X11 (any DE) | `x11rb` RandR `set_crtc_gamma`, save+restore, re-apply on `ScreenChangeNotify` | same ramp + logind + `ddc-hi` |
| wlroots | `zwlr_gamma_control_v1` | same ramp + logind + `ddc-hi` |
| KDE Wayland | `org.kde.KWin.NightLight.preview()` on a **<15 s heartbeat**, or `kwinrc` write | `org.kde.Solid.PowerManagement…setBrightness` (**covers DDC — skip i2c**) |
| GNOME Wayland | `org.gnome.SettingsDaemon.Color.Temperature` (transient) or gsettings (persistent) | logind (internal only); **no external path** without our own DDC + udev rule |

### ★ The cross-cutting punchline: no single Wayland strategy covers everything

The three capability sets **disagree about which compositor to favour**:

| | Layer-shell (overlay) | GlobalShortcuts portal | Background portal (autostart) |
|---|---|---|---|
| **KDE Plasma ≥5.27** | ✅ | ✅ | ✅ |
| **GNOME** | ❌ refused | ✅ (48+) | ✅ |
| **wlroots** (sway/Hyprland/river) | ✅ | ❌ (Hyprland ✅) | ❌ not exported |

**Only KDE Plasma ≥ 5.27 supports all three natively.** GNOME cannot do the overlay; wlroots cannot
do hotkeys (except Hyprland) or the autostart portal.

**`GDK_BACKEND=x11` is therefore a legitimate product decision** — forcing XWayland makes every
capability work at once, at the cost of blurry HiDPI scaling and no fractional scaling. On GNOME
Wayland it is the *only* path to a working overlay. **Expose it as a user-facing setting rather than
hiding it.**

### Design imperative: silent no-ops are the dominant failure mode

`always_on_top`, `set_position`, `skip_taskbar`, `set_focusable`, hotkey `register()` under
XWayland, autostart `is_enabled()` after a GUI disable, and Flatpak autostart **all report success
while doing nothing**. The highest-value single addition is therefore a **Linux capability probe**
(session type → compositor identity → portal interface versions → packaging format) feeding
**explicit degraded-mode warnings into the UI**, rather than per-call guessing.

### Four things to resolve before writing code
1. **Layer-shell binding** — vendor the ~500-line Rust shim over the maintained C
   `gtk-layer-shell` v0.10.1, and use `tao`'s `new_from_gtk_window` (PR #938). *Resolved in
   principle; needs a spike.*
2. **Hotkeys** — adopt `ashpd` + the `Registry.Register` app-ID dance; watch the zbus/tokio
   runtime-feature conflict. Accept that **the user, not us, picks the key combo** on Wayland.
3. **DDC udev rule shipping** — blocks Flatpak; bundle a rule, depend on `ddcutil`, or prefer KDE's
   PowerManagement D-Bus where available.
4. **Autostart** — do not rely on `tauri-plugin-autostart` alone: detect packaging format
   (`/.flatpak-info`, `$SNAP`, `$APPIMAGE`), route Flatpak/Snap to the Background portal, rewrite the
   entry on every launch, and parse `Hidden=`/`X-GNOME-Autostart-enabled=` before reporting state.

---

# LATE ADDITIONS (10th pass) — grayscale, foreign-window effects, theme

Closes §4 (grayscale) and §9 (theme), and substantially upgrades §8 (per-window effects).

## X. Grayscale / invert — per-desktop, now concrete

### X11 `CTM` RandR output property — a real hardware matrix path (narrow)
Verified in X.Org `hw/xfree86/drivers/modesetting/drmmode_display.c`:
- Atom **`CTM`**, `XA_INTEGER`, format 32, **18 values** = 9 × 64-bit **S31.32 fixed point** (lo/hi
  word pairs). Identity diagonal = `1ULL << 32`. Sign is the **top bit**, not two's complement
  (`1ULL << 63` is negative zero).
- Registered **only** when `drmmode->use_ctm` — i.e. the kernel CRTC exposes `CTM` *and*
  `use_gamma_lut` is active. Drivers: `modesetting` and `amdgpu`. **NVIDIA proprietary does NOT
  expose it.** Absent → `xrandr --set CTM …` fails "Property key 'CTM' not found".
- Rust: `x11rb::protocol::randr::change_output_property` (+ `list_output_properties` to detect).
  Build the 18×u32 payload yourself; no crate wraps it.
- An X11 client **cannot** reach DRM/KMS directly (the X server is DRM master) — go through RandR.
> **Verdict: legitimate but hardware/driver-conditional and per-output. A bonus fast-path, never
> the primary mechanism.**

### GNOME — magnifier desaturation works, with a source-level gotcha
`org.gnome.desktop.a11y.magnifier` keys: `mag-factor` (1.0 = no magnification),
`screen-position` (`full-screen`), **`color-saturation`** (0.0 = grayscale), **`invert-lightness`**,
`brightness-*`, `contrast-*`, `lens-mode`. Applied by `gnome-shell/js/ui/magnifier.js` via
`Clutter.DesaturateEffect` + `Shell.InvertLightnessEffect` on a clone of the **entire UI group** —
a genuine full-screen filter, on both X11 and Wayland.

🔴 **Load-order gotcha (found in source, documented nowhere):** `_settingsInit` applies the initial
value behind a JS truthiness test — `aPref = get_double(COLOR_SATURATION_KEY); if (aPref) …`.
**`0.0` is falsy, so if `color-saturation` is already `0.0` when the magnifier starts, grayscale is
silently not applied.** The `changed::` handler applies unconditionally.
→ **Enable the magnifier FIRST, then write `0.0`** (or write `1.0` then `0.0` to force a signal).

⚠️ Cost: enabling the magnifier makes Shell composite through a full-screen clone — measurable
GPU/power cost, bad for an always-on eye-protection app. Also changes cursor rendering and can
interfere with screen capture.

### KDE KWin — `invert` yes, grayscale no
Plasma 6 effect ids are **bare names**, not the Plasma-5 `kwin4_effect_*` form:
**`invert`**, **`colorblindnesscorrection`**, `nightlight` (also `diminactive`, `dimscreen`,
`translucency`, `zoom`, `magnifier`).
D-Bus `org.kde.kwin.Effects` at `org.kde.KWin` `/Effects`:
`loadEffect(s)->b`, `unloadEffect(s)`, `toggleEffect(s)`, `isEffectLoaded(s)->b`,
`isEffectSupported(s)->b`, `reconfigureEffect(s)`; properties `activeEffects`, `loadedEffects`,
`listOfEffects`.
Persistent: `kwinrc [Plugins] invertEnabled=true` then `qdbus org.kde.KWin /KWin reconfigure`.
Default shortcuts: `Ctrl+Meta+I` (whole screen), `Ctrl+Meta+U` (active window only).
🔴 **There is no built-in KWin grayscale/desaturate effect** — colorblindness correction is a
daltonization matrix, not desaturation. Grayscale on KWin needs a custom effect or scripted effect.

### Hyprland — best full-screen filter hook on Wayland
`decoration:screen_shader` = arbitrary GLSL applied at end of rendering.
⚠️ **BREAKING: since Hyprland 0.55, hyprlang is deprecated in favour of Lua** —
`hl.config({ decoration = { screen_shader = "…" } })`. Old-syntax docs archived at
wiki.hyprland.org/0.54/.
⚠️ **`hyprctl setprop` has been REMOVED** from `main` (only `getprop` remains); `eval`/`repl` (Lua)
are the new runtime mutation path. `keyword` is still registered but its interaction with the Lua
config on 0.55+ **needs runtime verification** — do not hardcode.
`hyprshade` automates this and ships a `blue-light-filter` shader (v5.0.0, Jun 2026); caveat from its
README: *"Gradual color shifting currently unsupported."*

### Wayfire / sway
Wayfire core has an **`invert`** plugin (binding `invert.toggle`). **sway has no colour filter, no
grayscale, no LUT** — only colour management (`color_profile icc|gamma22|srgb`, `render_bit_depth`,
`hdr`) plus `zwlr_gamma_control_v1` for temperature.

### Strategy matrix
| Session | Grayscale | Invert | Blue-light |
|---|---|---|---|
| X11 + picom | ✅ `--window-shader-fg` | ✅ shader | ✅ gamma |
| X11 amdgpu/modesetting w/ CTM | ✅ RandR `CTM` | ✅ CTM | ✅ gamma or CTM |
| X11 other | ❌ | ❌ | ✅ `set_crtc_gamma` |
| GNOME | ⚠️ magnifier (see gotcha) | ⚠️ magnifier | ✅ `night-light-*` gsettings |
| KDE Plasma 6 | ❌ built-in | ✅ `invert` via D-Bus | ✅ Night Light config |
| Hyprland | ✅ `screen_shader` | ✅ shader | ✅ shader / hyprshade |
| Wayfire | ⚠️ `invert` only | ✅ `invert.toggle` | ❌ |
| sway/wlroots | ❌ | ❌ | ✅ `zwlr_gamma_control_v1` |

**There is no Wayland protocol, portal, or freedesktop spec for a screen colour filter.** The only
quasi-portable primitives are 1-D gamma ramps, which cannot express grayscale.

## Y. Per-window effects — UPGRADE to §8: KDE Wayland IS reachable

### X11 — `_NET_WM_WINDOW_OPACITY` is NOT in the EWMH spec
Grepped the current spec: **zero occurrences**. It is a de-facto convention originating with
xcompmgr. **X11 has no property ACLs**, so any client with the target XID can `XChangeProperty` —
the basis of `transset`. 32-bit CARDINAL, `0xffffffff` = opaque. Rust:
`x11rb::protocol::xproto::change_property`, format 32.
Confirmed honoured by all three majors: **picom** (man page), **KWin** (`atoms.h`
`net_wm_window_opacity`; `x11window.cpp` → `setOpacity(info->opacityF())`), **Mutter**
(`src/x11/window-props.c` → `meta_window_set_opacity`, with **`INCLUDE_OR`** so it applies to
override-redirect windows too — and therefore to **Xwayland clients under GNOME Wayland**).

**picom per-window shaders** are the real per-window grayscale on X11:
`--window-shader-fg-rule SHADER:CONDITION`, or modern config
`rules: ({ match = "class_g = 'Slack'"; shader = "/abs/gray.frag"; opacity = 0.85; })`.
Rec.709 luma fragment:
`color = vec4(vec3(0.2126*color.r + 0.7152*color.g + 0.0722*color.b) * opacity, color.a * opacity);`
Requires `--backend glx`. ⚠️ Requires the *user* to run picom and edit its config — not
self-contained.

### ★ KDE Plasma 6 Wayland — per-window dim IS achievable (upgrade from "BLOCKED")
Two verified facts combine:
1. `src/window.h:149` — `Q_PROPERTY(qreal opacity READ opacity **WRITE setOpacity** NOTIFY
   opacityChanged)`. `KWin::Window` is the base for **both X11 and native Wayland** windows.
2. `src/scripting/scripting.cpp` registers `/Scripting` on D-Bus with
   `loadScript(QString filePath, QString pluginName) -> int`, `unloadScript`, `isScriptLoaded`;
   each loaded script gets `/Scripting/Script<N>` implementing `org.kde.kwin.Script` with
   `run()` / `stop()`.

→ Write a `.js` to disk → `loadScript` → `run()` → the script iterates `workspace.windowList()` and
sets `w.opacity`. **This makes Focus-Blur-style per-window dimming reachable on KDE Wayland.**
Alternative: `kwinrulesrc` `opacityactive`/`opacityinactive` (0–100) + `/KWin reconfigure`.

### ★ Wayfire — the only true per-window grayscale IPC on Wayland
`obs` plugin registers: `wf/obs/set-view-opacity`, **`wf/obs/set-view-saturation`**,
`wf/obs/set-view-brightness` — each `{ view-id: uint64, value: double, duration: uint64 }`,
callable from an external process over Wayfire's IPC socket, **with an animation duration**.

### Hyprland — per-window opacity via window rules (Lua form on 0.55+)
`hl.window_rule({ match = { class = "kitty" }, opacity = "0.8 0.8" })`.
⚠️ Rules evaluate **top to bottom, last match wins**; **opacity is a PRODUCT of all opacities by
default** (active 0.5 × rule 0.5 = 0.25) — append ` override` to force an exact value.
Full-window *colour* (not just alpha) still needs the global `screen_shader`.

### Verdict table
| Platform | Dim foreign window | Grayscale foreign window |
|---|---|---|
| X11 (any WM + compositor) | ✅ `_NET_WM_WINDOW_OPACITY` | ❌ |
| X11 + picom | ✅ | ✅ shader rules |
| **Wayland generic client** | **❌** | **❌** |
| KDE Plasma 6 Wayland | ✅ `/Scripting loadScript` + `Window.opacity` | ⚠️ custom effect |
| Hyprland | ✅ window rules | ❌ (screen-global only) |
| **Wayfire** | ✅ | ✅ `wf/obs/set-view-saturation` |
| GNOME Wayland | ❌ (Shell extension only) | ❌ |
| sway / COSMIC | ⚠️ sway `opacity` cmd | ❌ |

## Z. System theme — READ-ONLY portal, and a Tauri version floor

`org.freedesktop.portal.Settings` at `org.freedesktop.portal.Desktop`
`/org/freedesktop/portal/desktop`: `ReadAll`, **`ReadOne`** (interface v2), `Read` (**deprecated** —
returns a *double*-wrapped variant), signal `SettingChanged`.
`org.freedesktop.appearance` keys: **`color-scheme`** `u` — ⚠️ **0 = no preference, 1 = prefer
DARK, 2 = prefer LIGHT** (counter-intuitive); plus `accent-color` `(ddd)`, `contrast` `u`,
`reduced-motion` `u`.
**There is NO write method at any version.** Confirmed against the XML.

🔴 **Backend coverage gaps:**
| Backend | Settings? |
|---|---|
| xdg-desktop-portal-gtk / -gnome / -kde / -xapp | ✅ |
| **-wlr, -hyprland, -cosmic, -lxqt** | ❌ **not implemented** |
→ On Hyprland/sway/wlroots/COSMIC/LXQt, reading works **only if `xdg-desktop-portal-gtk` is
installed** and selected for `Settings` in `portals.conf`. **Ship a fallback.**
KDE quirk: derives the value from the live Qt palette (`qGray(window) < 192 ? dark : light`), so
mid-tone custom schemes can be misclassified and **KDE never reports 0**.

### 🔴 Tauri Linux theme detection has a version floor AND a feature-flag trap
Portal support landed in **tao 0.35.0** (PR #1141, merged 2026-03-22) → **Tauri 2.11.0**
(2026-04-30). Before that, tao sniffed the GTK theme *name* for "dark", which breaks on GNOME 42+
(the toggle changes `color-scheme` and leaves `gtk-theme` at `Adwaita`).
⚠️ **The portal code is behind an optional `dbus` feature** chained
`tauri/dbus → tauri-runtime-wry?/dbus → tao/dbus`, and `tauri-runtime-wry` sets
`tao = { default-features = false }`. **Building `tauri` with `default-features = false` silently
degrades Linux theme detection to always-`Light`.** Also adds `libdbus-1-dev` as a Linux build dep.
⚠️ tao maps `_ => Theme::Light`, so **"no preference" is indistinguishable from "prefer light"
through Tauri**. Read via **ashpd** directly if we need to tell them apart.
⚠️ `set_theme(None)` ("follow system") evaluates `None == Some(Dark)` → false → **forces the GTK dark
hint OFF** rather than re-reading the portal.
⚠️ On Linux the theme is **app-wide** (a GtkSettings singleton), not per-window — relevant to our
multi-window shell.

**Rust:** use **`ashpd` 0.13.13** (`features = ["tokio"]`) —
`Settings::color_scheme()`, `receive_color_scheme_changed()`, `ColorScheme::{NoPreference,
PreferDark, PreferLight}`. ❌ **Do NOT use `dark-light` 2.0.0** — pulls **async-std** into a tokio
binary, is three `ashpd` majors stale, and is detect-only with no change stream.

### Setting the theme — branch on `$XDG_CURRENT_DESKTOP`
- **GNOME** (42+): `gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'`
  (+ `gtk-theme 'Adwaita-dark'` for legacy GTK3 apps)
- **KDE Plasma 6**: `plasma-apply-colorscheme BreezeDark` /
  `plasma-apply-lookandfeel -a org.kde.breezedark.desktop`
  ⚠️ **Pass `--keepAuto`** — by default, applying a global theme **turns OFF the user's day/night
  schedule.** Plasma **6.5** (2025-10-21) added automatic light↔dark switching
  (`lookandfeelautoswitcher` kded; `kdeglobals [KDE] AutomaticLookAndFeel`; schedule in
  `knighttimerc`). Clobbering it would be a real regression for the user.
- **XFCE**: `xfconf-query -c xsettings -p /Net/ThemeName -s "Adwaita-dark"` (no `color-scheme`
  concept — theme name is the only signal)
- **Cinnamon**: `gsettings set org.x.apps.portal color-scheme 'prefer-dark'` (+ cinnamon keys)
- **MATE**: `org.mate.interface gtk-theme`

**Note:** GTK3's `gtk-application-prefer-dark-theme` is deprecated **in GTK4**, but Tauri/wry on
Linux is **GTK3**, so it is current in our stack (the GTK4 tao port is only an open PR).

---

# LATE ADDITIONS II (gap-closer) — corrections, prior art, and one serious trap

Independently confirms the 7th/10th-pass findings. New material only below.

## LL. 🔴 THE TRAP: a Wayland overlay swallows EVERY desktop click by default

`wl_surface.set_input_region` — *"The initial value for an input region is **infinite**."*
The layer-shell XML says: *"If you do not want to receive them, set the input region on your surface
to an empty region."*

> **A full-output layer-shell overlay therefore intercepts every click on the desktop unless we
> explicitly commit an EMPTY `wl_region`.** CSS `pointer-events: none` will **not** save us — it is
> the wrong layer. On GTK3 this is `gtk_widget_input_shape_combine_region` with an empty region
> (GTK3's Wayland backend does plumb it through to `wl_surface_set_input_region`).

This is a shipping-blocker-class bug if missed, and it is silent until a user tries to click their
desktop.

## MM. ★ Prior art exists: Tauri v2 + layer-shell has been shipped

**`andre-lund/poe2-overlay`** (pushed 2026-07-12) runs on KDE Plasma doing exactly:
`gtk_window.init_layer_shell(); set_layer(Layer::Overlay); set_exclusive_zone(-1)`.

Two documented gotchas from it:
1. **Promotion must happen BEFORE the GTK window is mapped** → set `visible: false` in
   `tauri.conf.json` and show it after promoting.
2. Full-output click-through needs the empty input region (§LL).

✅ **Raw FFI is unnecessary** — Tauri v2 exposes **`Window::gtk_window() -> gtk::ApplicationWindow`**
on Linux. (This is a *simpler* route than the `new_from_gtk_window` path in §7; both work — prefer
whichever the spike proves cleaner.)

✅ **The archived Rust crate is the CORRECT choice, not a compromise.** `gtk-layer-shell` 0.8.2 is
**frozen, not broken**, and Tauri 2.11 pins **gtk-rs 0.18**, which `gtk-layer-shell` 0.8 binds.
`gtk4-layer-shell` is maintained but the **wrong GTK generation**. The C library
(`wmww/gtk-layer-shell`) is still maintained (last commit 2026-07-04) in declared maintenance mode.
→ *This downgrades the "genuine unsolved dependency problem" in §7 to a manageable pin.*

**Layer-shell v5 details:** `layer` enum `background=0, bottom=1, top=2, **overlay=3**`;
`anchor` **bitfield** `top=1, bottom=2, left=4, right=8` (all edges = **15**);
`set_keyboard_interactivity` `none=0` (default), `exclusive=1`, `on_demand=2`;
`set_exclusive_zone(-1)` verbatim: *"the compositor should extend it all the way to the edges it is
anchored to"* — the XML's own example is a wallpaper or lock screen, i.e. our exact case.

**KWin allowlist evidence:** KWin's `restrictedInterfaces` holds exactly six entries
(plasma-window-management, fake_input, screencast, activation_feedback, lockscreen_overlay,
security_context). **layer-shell is NOT among them**, and that filter only applies to sandboxed
clients anyway. `src/wayland/layershell_v1.cpp` registers it as an **unconditional global** at v5.

**GNOME's refusal, verbatim** (mutter#973, opened *and closed the same day*, 2019-12-14, by
maintainer Jonas Ådahl): *"we don't want to support arbitrary third party panels etc, as that is not
how GNOME is designed to work."* Earlier gnome-shell#1141 (2019-04-04): *"we don't intend to support
third party panels, lock screens, notification UI's etc."* Thread active through 2026-04-19 with **no
softening**. Extensions cannot implement it.
**`ext-layer-shell-v1`: MR !28 is still a DRAFT, open since 2020-04-16**, no branch commits since
2023. `wlr-` is the only shippable spelling.

## NN. Foreground tracking — refinements

⚠️ **`ext-foreign-toplevel-list-v1` has NO STATE AT ALL** — events are exhaustively `closed`, `done`,
`title`, `app_id`, `identifier`. **It cannot even tell you which window is focused.** The spec calls
itself "intentionally minimalistic". (Stronger than previously recorded.)
Implemented by wlroots/sway, Hyprland, COSMIC — **not** Mutter, **not** KWin.

★ **KDE Wayland has a cleaner geometry route than KWin scripting:**
`org_kde_plasma_window_management` exposes a **`geometry` event since v6 (absolute coords)**,
**`pid_changed` since v8**, and an `active` flag. That is a real protocol, not an injected JS shim.
⚠️ But note it **is** on KWin's `restrictedInterfaces` list, so sandboxed (Flatpak) clients are
blocked from it.
COSMIC has `zcosmic_toplevel_info_v1` — geometry **output-relative**, no PID.
**GNOME has no route at all** — no protocol, no Mutter D-Bus window interface, at any price.

**Crate versions to pin:** `swayipc` **4.0.0** stable (2025-10-26). `hyprland` **0.4.0-beta.3** —
⚠️ its only *stable* release is **0.3.13 from Feb 2024**, so Hyprland support means shipping on a
beta dependency.

**Why wlroots will not get the shortcuts portal:** emersion **closed sway#8062** refusing
`hyprland_global_shortcuts_v1` — *"I'd rather not foster the proliferation of non-standard
protocols"* — in favour of wayland-protocols **MR !216 "action binder protocol", open and unmerged
since 2023-06-19**. sway's own PR #7774 is still **draft** after ~3 years. This is a blocked-upstream
decision, not a backlog item.

## OO. Global shortcuts — trigger grammar and KDE fallback specifics

Portal binding shape: `(shortcut_id, {description: s, preferred_trigger: s})`.
**Trigger grammar** (freedesktop shortcuts spec): modifiers `CTRL, ALT, SHIFT, NUM, LOGO` joined by
`+`, keyname from **xkbcommon minus the `XKB_KEY_` prefix** — e.g. `CTRL+SHIFT+a`,
`CTRL+ALT+Return`. We need this to render `preferred_trigger` correctly.

**KDE fallback specifics:** `org.kde.KGlobalAccel` → `doRegister(actionId as)` then
`setShortcutKeys(actionId as, keys a(ai), flags u)`. `actionId` is a **4-element list**:
`[ComponentUnique, ActionUnique, ComponentFriendly, ActionFriendly]`. Activation arrives as
`globalShortcutPressed(componentUnique, actionUnique, timestamp)` on
`org.kde.kglobalaccel.Component`. ⚠️ The v1 methods (`setShortcut`, `unRegister`) carry
`org.freedesktop.DBus.Deprecated` — use the v2 `*Keys` variants.

**Hyprland bind syntax:** `bind = MODS, KEY, exec, <cmd>` — **exactly 3 commas; a trailing comma
silently corrupts the argument.**

## PP. Theme — two corrections

⚠️ **XFCE portal caveat:** `xdg-desktop-portal-gtk` derives `color-scheme` **solely** from the GNOME
gsettings key `org.gnome.desktop.interface color-scheme` — it does **not** read xfconf. **On XFCE the
portal will usually report `0` (no preference) no matter what theme is applied**, unless the user
separately set the gsettings key. So "read the portal" is not sufficient on XFCE.

**GNOME enum alignment (nice to know):** `GDesktopColorScheme` is `DEFAULT=0, PREFER_DARK=1,
PREFER_LIGHT=2` — an exact match to the portal integers, which is why xdg-desktop-portal-gtk can pass
`g_settings_get_enum` straight through.

**KDE `plasma-apply-colorscheme`** writes kdeglobals via `KConfig::Notify` **and** makes a D-Bus call
to `org.kde.KWin` — it **requires a running Plasma session** for full effect.

⚠️ **tao's portal fallback is indistinguishable from a real answer:** a **missing portal silently
reports `Theme::Light`** rather than erroring. So through Tauri we cannot tell "light" from "no
portal" — read via `ashpd` directly if that distinction matters.
