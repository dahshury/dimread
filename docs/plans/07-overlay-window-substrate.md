# Plan 07 — Overlay window substrate
Status: DRAFT
Depends on: 00 (capability layer), 02 (monitor identity)
Parity ref: FEATURE-PARITY.md — enabling substrate for F8.1, F8.2, F6.1; on macOS also the
primary mechanism for F1/F2 (see `docs/platform-research/macos.md` §0 "Architectural
recommendation" #1)

---

## 1. What this feature is

Not a user-visible feature: the shared *foundation* every screen-covering visual in DimRead sits
on. A DimRead overlay is a transparent, always-on-top, click-through, never-focus-stealing surface
that covers one or more displays and is painted by a webview. Today it carries the notification
pill, the Focus Read band and the Focus Blur shade (`research/careueyes/images/` — the Focus tab
screenshots). On macOS it additionally becomes the **primary tint/dim mechanism**, because
`CGSetDisplayTransferByTable` is silently ignored on M5-class hardware and the readback lies
(macos.md §0). Getting this substrate right therefore decides whether plans 08, 09 and — on macOS —
01 can exist at all.

This is the highest-risk cross-platform plan in the set. Two of the seven target environments
cannot host it with standard protocols.

## 2. Current state

### The window roster
`src-tauri/src/windows/mod.rs` holds `WINDOW_SPECS: &[WindowSpec]` (lines 82–263). Three entries
are overlays:

| label | size seed | flags |
|---|---|---|
| `overlay` | 720×140 | `transparent`, `always_on_top`, `skip_taskbar`, `click_through`, `background: None` |
| `focus-overlay` | 1920×1080 (seed only) | same as above |
| `magic-toolbar` | 132×36 | `transparent`, `always_on_top`, `skip_taskbar`, **`non_activating`** (clickable, never focuses) |

`WindowSpec` (lines 46–74) is the whole abstraction: `click_through: bool` and
`non_activating: bool` are the only two overlay-ish knobs, and `build_window` (lines 411–512)
translates them into exactly two calls:

```rust
if spec.click_through || spec.non_activating {
    builder = builder.focusable(false);
}
// …
if spec.click_through {
    #[cfg(not(target_os = "linux"))]
    let _ = window.set_ignore_cursor_events(true);
}
```

Note the `#[cfg(not(target_os = "linux"))]` already present — a Linux-specific carve-out with the
comment "a hidden prewarmed window is not realized yet — so the show path re-asserts this after
`show()`". That is the only existing platform branch in the overlay path.

### Geometry
`src-tauri/src/windows/placement.rs`:

```rust
#[cfg(windows)]
pub fn virtual_screen_bounds() -> (i32, i32, i32, i32)   // SM_{X,Y,CX,CY}VIRTUALSCREEN
#[cfg(not(windows))]
pub fn virtual_screen_bounds() -> (i32, i32, i32, i32) { (0, 0, 1920, 1080) }
```

**The non-Windows arm is a hardcoded lie.** Every consumer of it (Focus Read, Focus Blur) is
therefore already silently wrong off Windows, not merely inert.

### The consumers
- `src-tauri/src/focus/read.rs::show_overlay` (lines 115–132): `ensure_window` → `set_position` →
  `set_size(virtual_screen_bounds())` → `set_ignore_cursor_events(true)` → `show()` →
  `set_always_on_top(true)`.
- `src-tauri/src/focus/blur.rs::show_overlay` (lines 133–154): identical shape.
- `src-tauri/src/overlay/` — the notification pill, top-center placement + sequence-guarded hide.
- Renderer: `src/views/focus-overlay/ui/FocusOverlayPage.tsx` (`useTransparentBody()`,
  routes on `focus:state`), `FocusReadShade.tsx`, `FocusBlurShade.tsx`.

### What is portable today
The Tauri-level calls (`ensure_window`, `set_position`, `set_size`, `show`, `hide`) compile
everywhere. **Compiling is not working**: on Wayland `set_position`, `set_always_on_top`,
`set_skip_taskbar` and `set_focusable(false)` all return `Ok(())` and do nothing
(linux.md §7 table, tauri#14913 / tauri#3117 / tao#1134 / tauri#9829). On macOS
`always_on_top` maps to `NSWindow.Level.floating` = 3, which is **below** the Dock (20) and the
menu bar (24) (macos.md §7 level table).

### Already-committed config
`src-tauri/tauri.conf.json` line 17: `"macOSPrivateApi": true`, and `Cargo.toml` enables the
`tauri/macos-private-api` feature. Bundle targets are `["nsis", "appimage", "deb", "rpm"]` — no
`.app`/`dmg` yet. See §6 for what the private-api flag already costs.

## 3. Per-platform verdict table

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | Current path: layered transparent `WS_EX_TRANSPARENT`-equivalent window via `set_ignore_cursor_events` + `always_on_top`, one window spanning `virtual_screen_bounds()` | Works today. Keep as the reference behaviour. |
| macOS (Intel) | **PARTIAL → FULL after work**; foreign-fullscreen coverage **UNVERIFIED** | **Native `NSWindow`/`NSPanel` we construct ourselves, NO webview** — `setOpaque(false)` + `setBackgroundColor(alpha)` (macos.md §S). Tauri's window API reaches **none** of level / `.nonactivatingPanel` / `collectionBehavior` (§7, §J) and its `always_on_top` sets level **3**, below the Dock (§T) | **One window per `NSScreen`** — "Displays have separate Spaces" is ON by default (§T). Window level **UNRESOLVED** (§9 S2). Screenshot capture **UNRESOLVED** (§9 S1). A transparent *Tauri* window would cost ~8× GPU permanently (§S) — hence no webview. |
| macOS (Apple Silicon) | **PARTIAL → FULL after work**, same caveats | Same as Intel | No Apple-Silicon-specific overlay difference. The M5 gamma bug (macos.md §0) is *why* the overlay matters here, not a constraint on it. ⚠️ arm64 binaries are always at least ad-hoc signed by the linker, so the code-signing treadmill (§6) is the **default** here. |
| Linux X11 | **FULL** | One window at the union origin: `_NET_WM_STATE_ABOVE`, `_NET_WM_WINDOW_TYPE_DOCK`, `_NET_WM_DESKTOP=0xFFFFFFFF`, click-through via XFixes `XFixesSetWindowShapeRegion(…, ShapeInput, empty)` (linux.md §7 "X11 recipe" [VERIFIED]) | `ShapeInput` = clickability, `ShapeBounding` = visibility — do not confuse. Crates: `x11rb::protocol::{shape, xfixes}`, `gdkx11` for `gdk_x11_window_get_xid()`. |
| Linux Wayland — KDE | **PARTIAL** | `wlr-layer-shell-unstable-v1` via `Window::gtk_window()` (or tao `new_from_gtk_window`, PR #938) + the **`gtk-layer-shell` 0.8.2 Rust crate** — frozen, correct GTK generation for Tauri 2.11's gtk-rs 0.18 pin (linux.md §MM) | ✅ **Shipped prior art**: `andre-lund/poe2-overlay` on KDE Plasma. One layer surface **per `wl_output`**. 🔴 **Must commit an empty input region or every desktop click is swallowed — §4.4.1.** KDE is the only environment supporting layer-shell *and* the shortcuts portal *and* the background portal. |
| Linux Wayland — GNOME | **BLOCKED** (workaround: force X11) | None. mutter#973 CLOSED without implementation, labelled *"Requests for a protocol which may not be implemented by Mutter"*; companion gnome-shell#1141. `ext-layer-shell` **does not exist** and is not coming — GNOME's veto blocks standardization (linux.md §7 [VERIFIED]) | The **only** overlay path is `GDK_BACKEND=x11` (XWayland). Must be a user-facing setting, not a hidden env hack. Cost: blurry HiDPI, no fractional scaling. |
| Linux Wayland — wlroots | **PARTIAL** | Same layer-shell path as KDE | Overlay works; hotkeys and autostart do not (plan 11). |

**Carried UNVERIFIED / unresolved tags:**
- macOS screenshot capture of the overlay: **UNRESOLVED**, two research passes contradicted each
  other (macos.md §7 gotcha 1). Adjudicated toward "the tint DOES appear in screenshots" but
  explicitly flagged *"VERIFY EMPIRICALLY on a real Mac before promising either behaviour."*
- macOS window level: four passes gave four readings; the 8th pass resolves most of the confusion
  and names one residual **UNVERIFIED** item:
  1. §7 — **≥ 101** to clear menu bar (24) and Dock (20);
  2. §D (4th pass) — MonitorControl ships `CGShieldingWindowLevel()`, and §D itself notes Apple
     cautions against relying on it for positioning;
  3. §J (6th pass) — Apple DTS: `NSPanel` + `.nonactivatingPanel`, `level = .screenSaver` **(1000)**;
  4. §T (8th pass) — **the namespace trap that explains the split**:
     **`NSWindow.Level.screenSaver` (101) ≠ `CGWindowLevelForKey(.screenSaverWindow)` (1000)**. The
     AppKit and CoreGraphics namespaces disagree despite the shared name. §T's guidance: **use 101**
     for a persistent full-screen tint, citing Electron's docs — *"Levels from `floating` to
     `status` place the window below the Dock on macOS. Levels from `pop-up-menu` and higher display
     above the Dock"* — which **contradicts the naive numeric reading** (statusBar 25 > dock 20).
  **Carried UNVERIFIED:** §T states plainly that *"the 25-vs-101 discrepancy was not empirically
  resolved. Spike it."* A counterexample exists (Ardent Swift uses `.statusBar` = 25 successfully)
  but for a *transient* panel, not a persistent tint. **Plan of record: level 101; confirm in S2.**
- macOS over a **foreign app's fullscreen window**: **UNVERIFIED (previously recorded as BLOCKED —
  now retracted).** §E cited Apple forum 26677 as ending with no working combination; §T establishes
  that thread is **El Capitan-era, outdated, and contradicted by current shipping code**, and gives a
  working recipe: `[CanJoinAllSpaces, Stationary, IgnoresCycle, FullScreenAuxiliary]` **plus
  `ActivationPolicy::Accessory`**. Independently, **MAS builds cannot overlay above fullscreen
  windows** (§J, §T) regardless of recipe — a distribution constraint, not an API one.
- macOS transparent-webview power cost: **VERIFIED and measured** (§S, tauri#15471) — ~620 mW / 36%
  GPU residency vs ~75 mW / 10% opaque, on a *static* page. Drives the no-webview design (§4.3).
- `didChangeScreenParametersNotification` coalescing/debounce guidance is marked
  "Practitioner knowledge; Apple's page could not be fetched" (macos.md §A).
- macOS monitor identity: the 7th pass **overturns** the earlier
  `CGDisplayCreateUUIDFromDisplayID` guidance — the system UUID *"will not work properly as the OS
  can change the assignment any time"* for fully identical panels (waydabber, m1ddc#41), with field
  reports of UUIDs swapping on sleep/wake (displayplacer#89, #77). This lands on plan 02 but
  determines whether `SurfaceId::Display(MonitorKey)` is durable — see spike S4.
- KDE `kscreen-doctor` D-Bus interface: **UNVERIFIED** (linux.md §3) — affects plan 02, noted here
  because surface↔monitor keying depends on it.

## 4. Design

### 4.1 The core shape change: an overlay is a SET of surfaces

Today an overlay is **one Tauri window** covering the virtual screen. macOS forbids that
(macos.md §7: "One window per `NSScreen`, not one spanning window — spanning is unreliable across
mixed scale factors and breaks on reconfiguration") and Wayland layer-shell makes it impossible
(linux.md §7: "layer-shell takes a single output, there is no spanning surface").

So the substrate's central abstraction is a **surface set**, and the spanning window becomes one
*backend strategy* rather than the model.

```rust
// src-tauri/src/overlay_substrate/mod.rs  (new module)

/// Stable identity of one overlay surface. On per-screen backends this is the
/// monitor key from plan 02; on spanning backends it is `Spanning`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SurfaceId {
    /// One surface covering the whole virtual screen (Windows, X11).
    Spanning,
    /// One surface per display, keyed by the plan-02 stable monitor id.
    Display(crate::display::monitors::MonitorKey),
}

/// A surface's placement in GLOBAL desktop coordinates (physical px).
/// `None` on backends that cannot report a global position (Wayland).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceGeometry {
    /// Global origin. `None` under Wayland — the compositor owns placement and
    /// a client can never learn its own absolute position (linux.md §5–6).
    pub origin: Option<(i32, i32)>,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

/// Which mechanism is actually carrying the overlay right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OverlayBackend {
    /// Windows layered click-through window spanning the virtual screen.
    WindowsSpanning,
    /// macOS raw NSPanel per NSScreen.
    MacPanelPerScreen,
    /// X11 EWMH dock window + XFixes ShapeInput, spanning.
    X11Spanning,
    /// wlr-layer-shell surface per wl_output.
    WaylandLayerShell,
    /// X11 path reached through XWayland because the native session cannot host
    /// an overlay (GNOME Wayland). Degraded: blurry HiDPI, no fractional scale.
    X11ViaXWayland,
    /// No overlay is possible in this session.
    Unavailable,
}

/// Why the overlay is unavailable / degraded — rendered verbatim in the UI.
/// NEVER let a backend fail silently; that is the dominant Linux failure mode
/// (linux.md "Design imperative").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OverlayLimitation {
    /// GNOME Wayland: layer-shell refused (mutter#973), no ext-layer-shell.
    CompositorRefusesLayerShell { compositor: String },
    /// Running under XWayland; overlay works but scaling is degraded.
    XWaylandFallback,
    /// gtk-layer-shell not present / failed to init.
    LayerShellUnavailable,
    /// macOS: could not reach the raw NSWindow.
    NativeHandleUnavailable,
}

/// The whole substrate's self-report. Surfaced to the UI via `overlay_capability`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCapability {
    pub backend: OverlayBackend,
    /// Empty when fully healthy.
    pub limitations: Vec<OverlayLimitation>,
    /// True when a per-screen backend is in use — the renderer must expect N
    /// surfaces and per-surface-local coordinates.
    pub per_screen: bool,
    /// True when the overlay is expected to appear in screenshots and screen
    /// recordings. On macOS this tracks the `exclude_from_screen_capture`
    /// setting (`sharingType = .none`); see §9 S1 — the question is RESOLVED:
    /// an overlay IS captured unless we opt out, gamma never is.
    /// `None` only where a backend genuinely cannot say.
    pub captured_in_screenshots: Option<bool>,
}
```

### 4.2 The backend trait

```rust
pub trait OverlayHost: Send + Sync {
    /// Bring the surface set up to match the current display topology.
    /// Idempotent; called on show, on display reconfiguration, and on
    /// settings changes that alter which displays are covered.
    fn reconcile(&self, app: &AppHandle, want: &[SurfaceRequest]) -> Result<(), OverlayError>;

    /// Show / hide every surface in the set.
    fn set_visible(&self, app: &AppHandle, visible: bool) -> Result<(), OverlayError>;

    /// Current surfaces and their geometry, for the renderer's coordinate maths.
    fn surfaces(&self) -> Vec<(SurfaceId, SurfaceGeometry)>;

    /// Self-report. Never returns an error — an unavailable backend reports
    /// `OverlayBackend::Unavailable` plus its reasons.
    fn capability(&self) -> OverlayCapability;
}

/// What a consumer (Focus Read / Focus Blur / macOS tint) asks for.
pub struct SurfaceRequest {
    /// Which displays to cover. `None` = all displays.
    pub displays: Option<Vec<crate::display::monitors::MonitorKey>>,
    /// Click-through (every current consumer wants `true`).
    pub click_through: bool,
    /// How the surface is painted. NOT every backend supports every kind —
    /// macOS deliberately refuses `Webview` for always-on surfaces (§4.3).
    pub content: SurfaceContent,
}

/// How a surface draws itself.
pub enum SurfaceContent {
    /// A webview entry (`windows/focus-overlay.html`, …). Windows / X11 /
    /// Wayland. **Not used on macOS for always-on surfaces** — a transparent
    /// Tauri webview costs ~8× GPU power there (macos.md §S).
    Webview { url: &'static str },
    /// Solid-colour rectangles, drawn natively. The only kind macOS uses for
    /// the tint / Focus shades. Every current F8 surface reduces to this.
    Rects { fill: Rgba, rects: Vec<Rect> },
}
```

**The `SurfaceContent` split is the single most consequential shape in this plan.** It is what lets
Windows/X11/Wayland keep reusing `src/views/focus-overlay/` while macOS draws natively, without
either side pretending to be the other. Resist collapsing it back into one variant.

The platform split lives entirely under `src-tauri/src/overlay_substrate/`:
`windows.rs`, `macos.rs`, `linux_x11.rs`, `linux_layer_shell.rs`, `unavailable.rs`, plus
`mod.rs` holding the trait, the pure geometry, and the backend selection.

Backend selection order (following linux.md "Recommended architecture" — **detect
`$WAYLAND_DISPLAY` FIRST**, because a Tauri app under XWayland also sees `$DISPLAY`):

```
cfg(windows)                       -> WindowsSpanning
cfg(target_os = "macos")           -> MacPanelPerScreen
cfg(target_os = "linux"):
    $WAYLAND_DISPLAY set:
        layer-shell advertised in the wl_registry  -> WaylandLayerShell
        else, user opted into the X11 setting      -> X11ViaXWayland (+ XWaylandFallback)
        else                                       -> Unavailable(CompositorRefusesLayerShell)
    else ($DISPLAY only)                           -> X11Spanning
```

This selection consumes the session/compositor identification produced by **plan 00**; it must not
re-detect independently.

### 4.3 macOS surface construction — **native `NSWindow`, no webview**

> 🔴 **This section was rewritten after macos.md §S/§T (8th pass). The earlier
> "Tauri transparent window + `ns_window()` fixups" design is withdrawn.** Two independent findings
> kill it, and together they also make the decision easy.

**Finding 1 — `transparent: true` costs ~8× GPU power on macOS, permanently (macos.md §S).**
Measured A/B on a **static** page (tauri#15471, `status: upstream`, Tauri 2.11.2 / wry 0.55.1 /
tao 0.35.3): transparent ≈ **620 mW / 36% GPU residency** vs opaque ≈ **75 mW / 10%**. On Intel the
WebKit GPU process pins a core. Cause: WebKit/WindowServer force alpha-compositing **every display
frame regardless of content change**.

> For an **always-on** eye-protection overlay this is disqualifying. And it is unnecessary: a tint
> overlay has no DOM. There is no reason for a WebView to be inside it at all.

**Finding 2 — Tauri's window API cannot express an overlay anyway (macos.md §T).**
Verified in tao source: `always_on_top` maps to `NSFloatingWindowLevel` = **3** — below the Dock
(20), menu bar (24) and status bar (25). Tauri exposes only a boolean, with no level parameter
(unlike Electron's `setAlwaysOnTop(flag, level)`); root cause of tauri#13413, feature request
tauri#9987. `set_visible_on_all_workspaces` toggles **only** `CanJoinAllSpaces` — **nothing in tao
ever sets `FullScreenAuxiliary`** (tauri#11488, closed *not planned*). ✅ The one primitive that
*does* work correctly is `set_ignore_cursor_events` → `setIgnoresMouseEvents`, dispatched to the
main thread.

**So the raw-`objc2` escape hatch is not polish — it is mandatory for basic correctness.** Given we
are dropping to `objc2` regardless, dropping the webview with it is nearly free.

#### The design

Build each macOS surface as a **native `NSWindow` we construct ourselves**, with **no webview and
`transparent: false` semantics**, and paint the tint with `setOpaque(false)` +
`setBackgroundColor(NSColor with alpha)`. The WebView stays where it earns its keep: the settings
UI, the main window, the tray flyout.

```
setOpaque(false)
setBackgroundColor(NSColor.colorWithRed:green:blue:alpha:)   // the tint itself
setStyleMask(.borderless)                                     // + .nonactivatingPanel if NSPanel
setLevel(…)                                                   // spike S2
setCollectionBehavior([CanJoinAllSpaces, Stationary, IgnoresCycle, FullScreenAuxiliary])
setIgnoresMouseEvents(true)
setHasShadow(false)
setHidesOnDeactivate(false)
orderFrontRegardless()
NSApplication.ActivationPolicy.accessory
```

All of those methods are **safe** in `objc2-app-kit` — no raw `msg_send!` needed (macos.md §T).
All must run on the main thread via `app.run_on_main_thread`.

⚠️ **Pin `objc2 0.6` / `objc2-app-kit 0.3` / `objc2-foundation 0.3` / `block2 0.6` /
`core-graphics 0.25` / `dispatch2 0.3` to match tao exactly** (macos.md §T). A version mismatch
makes the `NSWindow` from `ns_window()` a *different Rust type*, and the cast silently stops
compiling — or worse, a second objc2 version ends up linked.

#### What this decision buys, all at once

| Problem | How this dodges it |
|---|---|
| tauri#15471 — 8× GPU power, always-on | No transparent WebView exists |
| tauri#13415 — `transparent(true)` works in `tauri dev`, renders **solid white after DMG build** (open since May 2025; `macOSPrivateApi`, `TAURI_PRIVATE_API=1` and the Cargo feature **all failed to help**) | No transparent WebView exists |
| `macOSPrivateApi` App Store trap — the private bits are the KVC string keys `drawsBackground` / `fullScreenEnabled`, trivially found by a static string scan | Not needed for the overlay. Gate it behind a Cargo feature so an MAS build compiles it out |
| tao's level-3 / missing-`FullScreenAuxiliary` gaps | We set the window up ourselves |

#### Cost, stated honestly

Focus Read's clear band and Focus Blur's cutout shade are **currently WebView-rendered**
(`src/views/focus-overlay/ui/{FocusReadShade,FocusBlurShade}.tsx`). On macOS they must be expressed
natively instead. **This is a cross-plan consequence for plans 08 and 09** — flagged here because
this plan owns the substrate, but neither of those files is mine to change:
- **Focus Blur is nearly free**: plan 09's architecture (macos.md §E) is *four filled rectangles*
  tiling the screen union minus the focused window. Four opaque-colour `NSWindow`s (or one window
  with four `CALayer`s) express that directly. Arguably simpler than the DOM version.
- **Focus Read is also simple**: one shade above the band and one below — two rects.
- **Anything genuinely DOM-shaped** (rich content, animation curves, text) would need a webview.
  Nothing in F8.1/F8.2 is.

So the "second renderer" cost is real but small, and it is **bounded to solid-colour rectangles**.
Keep it that way: if a future overlay feature needs a DOM on macOS, that is a design review, not an
implementation detail.

#### The MAS fork

Alin Panaitiu (Lunar / Gamma Dimmer), speaking as a vendor in exactly this space:
**"App Store apps are not allowed to place dark overlays above fullscreen windows."** (macos.md §T.)
Combined with the `macOSPrivateApi` trap, **overlay tinting is a Developer-ID product, not an MAS
product.** HazeOver and GammaDimmer *do* ship sandboxed on the MAS (macos.md §E/§I) — proof the
approach uses no private APIs and no injection — but they ship without fullscreen coverage.
**Gate the private path behind a Cargo feature so an MAS build compiles it out**, and decide the
channel as a product question, not an engineering one.

**Design goal, stated explicitly: this substrate must need ZERO TCC permissions.**
macos.md §I is emphatic — Screen Recording gates *reading* the framebuffer, not *writing* to it;
there is no TCC check in the `NSWindow`/Core Animation draw path (Apple DTS thread/826308 gives a
full overlay recipe and never mentions a permission). HazeOver, GammaDimmer and `dimmer` all ship
with **no permissions**. Treat any future change that introduces a permission dependency into the
overlay path as a design regression requiring explicit sign-off.

### 4.3.1 Foreign fullscreen apps — the picture improved, but verify

The 6th pass told us to plan for permanent failure here. The 8th pass **partially retracts that**:

> macos.md §T: *"The widely-cited Apple Forums thread 26677 (El Capitan era) concluding
> `.fullScreenAuxiliary` 'does NOT help' is **outdated and contradicted by current shipping code**.
> Working recipe: `[CanJoinAllSpaces, Stationary, IgnoresCycle, FullScreenAuxiliary]` **plus
> `ActivationPolicy::Accessory`**"* — Electron documents that its fullscreen path *transforms the
> process type* (Regular↔Accessory), and a Tauri reporter confirms `ActivationPolicy::Accessory`
> works but hides the Dock icon. **For a tray utility that is a free win** — we want
> `.accessory`/LSUIElement anyway.

`collectionBehavior` has **mutual-exclusivity groups** — at most one from each:
`Primary`/`Auxiliary`/`CanJoinAllApplications` · `Managed`/`Transient`/`Stationary` ·
`ParticipatesInCycle`/`IgnoresCycle` · `FullScreenPrimary`/`FullScreenAuxiliary`/`FullScreenNone` ·
`FullScreenAllowsTiling`/`FullScreenDisallowsTiling`.
⚠️ **`FullScreenNone` opts OUT of fullscreen coverage — do not copy the slint recipe that uses it.**
⚠️ Note this constrains the §J set quoted earlier: `.canJoinAllApplications` and `.stationary` are in
*different* groups so they coexist, but `.canJoinAllApplications` conflicts with `Primary`/`Auxiliary`
— resolve empirically in spike S2 rather than merging recipes on paper.
⚠️ **Stage Manager "does not keep a window visible above a fullscreen app" — test explicitly.**

**Design consequence: keep the suspension machinery, but treat it as a fallback, not the plan.**

```rust
/// Emitted when the overlay suspends itself because it cannot cover the
/// current foreground content. Consumers must reflect this in the UI, not
/// silently appear broken.
pub enum SuspensionReason {
    /// macOS: a foreign app owns a fullscreen space we could not float above.
    ForeignFullscreen { app_name: Option<String> },
}
```

Detection is permission-free: `CGWindowListCopyWindowInfo` yields `kCGWindowBounds` and
`kCGWindowLayer` for every on-screen window with **zero permissions** (macos.md §F). Reuse the same
enumeration plan 09 needs — do not build a second one. **Wire the suspension path, then let spike S2
decide whether it ever fires.** If the corrected recipe works, this becomes dead-but-cheap
insurance; if it does not, the UI is already honest.

**Menu bar region — Tahoe changes the mechanism, not the outcome.** macos.md §T: Tahoe's menu bar is
**transparent by default** with a faint drop shadow, so an overlay *below* level 24 still visibly
tints the menu-bar region (wallpaper shows through), while at ≥ 101 we tint it directly. Same visual
result, different mechanism — **test both Tahoe menu-bar modes.** macos.md §E separately notes
HazeOver 1.9.7 shipping a fix for *"on Tahoe, the menu bar sometimes appears too dim"*, so budget for
menu-bar special-casing either way.

**Cannot be covered at any level** (macos.md §T): the screen saver (1000), the login window
(separate session — our app is not running), assistiveTechHigh (1500). **Mission Control composites
our overlay into its view rather than over it.** Do not chase these.

Additional macOS rules folded in from macos.md §A (4th pass), all load-bearing:
- **`NSScreen.main` is NOT the primary screen** — it follows keyboard focus. Use `CGMainDisplayID()`
  for "the display with the menu bar". This matters because we build one surface per `NSScreen`.
- **Debounce `didChangeScreenParametersNotification` ~500 ms and rebuild the surface set from
  scratch** — it is coalesced, late, and bursts with transient intermediate states during hot-plug.
  Do not diff.
- **Coordinate flip uses the MAIN display's height**, never a per-screen height:
  `y_cocoa = main_height - (y_quartz + height)`. Displays above/left of main produce **negative**
  coordinates in both spaces — **never clamp to ≥ 0**.
- Notch: `NSScreen.frame` includes the notch region; use `safeAreaInsets()` /
  `auxiliaryTopLeftArea()` when the surface must avoid it. For a full-bleed tint we *want* the whole
  frame, so this affects only content layout — expose the inset in the per-surface geometry rather
  than shrinking the window.
- **One window per `NSScreen` — the deciding reason, from macos.md §T:** System Settings → Desktop &
  Dock → **"Displays have separate Spaces" is ON by default**, and with it on *a single window
  cannot simultaneously be in display A's fullscreen Space and display B's desktop Space*. This is a
  stronger argument than the earlier "mixed scale factors are unreliable" reasoning and should be
  the one recorded in the code comment.
- ⚠️ **Use `Monitor::position()` + `size()`, NOT `work_area()`** (macos.md §T) — `work_area()`
  excludes the menu bar and Dock, which are exactly what we want to cover.
- Tahoe-specific Tauri bugs to watch even though we are leaving the webview out of the overlay:
  tauri#15517 (tao 0.35.3 panics in `did_finish_launching`, blank window), #15271, #15707
  (`setTheme` no longer repaints the title bar — relevant to plan 11).

### 4.4 Linux Wayland layer-shell construction

> ✅ **Downgraded from "unsolved dependency problem" by linux.md §MM (gap-closer pass): Tauri v2 +
> layer-shell has already been SHIPPED.** `andre-lund/poe2-overlay` (pushed 2026-07-12) runs on KDE
> Plasma doing exactly `gtk_window.init_layer_shell(); set_layer(Layer::Overlay);
> set_exclusive_zone(-1)`. This is prior art, not speculation.

**Simpler route than §7's `new_from_gtk_window`:** linux.md §MM — *"Raw FFI is unnecessary — Tauri v2
exposes `Window::gtk_window() -> gtk::ApplicationWindow` on Linux."* Both routes work; prefer
whichever the spike proves cleaner.

**Crate decision — CORRECTED.** The earlier reading (archived Rust crate ⇒ vendor a C shim) is
withdrawn. linux.md §MM: *"The archived Rust crate is the **CORRECT choice, not a compromise**.
`gtk-layer-shell` 0.8.2 is **frozen, not broken**, and Tauri 2.11 pins **gtk-rs 0.18**, which
`gtk-layer-shell` 0.8 binds. `gtk4-layer-shell` is maintained but the **wrong GTK generation**."*
The C library (`wmww/gtk-layer-shell`) is still maintained (last commit 2026-07-04) in declared
maintenance mode. **→ Depend on `gtk-layer-shell` 0.8.2 and pin it. Do not vendor a shim.**
RUSTSEC-2024-0423 is an unmaintained-advisory, not a vulnerability — document the acceptance in
`NOTES-rust.md` so the audit gate has a recorded reason.

Sequence:

1. Obtain the `gtk::ApplicationWindow` — either `Window::gtk_window()` on a Tauri window, or build
   one and hand it over via `WindowExtUnix::new_from_gtk_window`. Main thread only.
2. ⚠️ **Promotion must happen BEFORE the GTK window is mapped** (linux.md §MM gotcha 1, and the
   original reason tao PR #938 exists — tao maps immediately, tao#925).
   **→ Set `visible: false` in the window spec and show only after promoting.** Our
   `build_window` already builds every window with `.visible(false)` (`windows/mod.rs` line 432),
   so this is compatible with the existing creation path — but the *prewarm* path
   (`POST_STARTUP_PREWARM_LABELS`) must not race it.
3. `init_layer_shell` → `set_layer(OVERLAY)` → `set_anchor(all four, true)` → `set_exclusive_zone(-1)`
   → `set_keyboard_interactivity(NONE)` → `set_namespace("dimread-overlay")`.
   **Layer-shell v5 constants** (linux.md §MM): `layer` enum `background=0, bottom=1, top=2,
   **overlay=3**`; `anchor` is a **bitfield** `top=1, bottom=2, left=4, right=8` (all edges = **15**);
   `keyboard_interactivity` `none=0` (default), `exclusive=1`, `on_demand=2`. `set_exclusive_zone(-1)`
   verbatim from the XML: *"the compositor should extend it all the way to the edges it is anchored
   to"* — and the XML's own example is a wallpaper or lock screen, **i.e. our exact case**.
4. **The empty input region — see §4.4.1. This is a shipping blocker, not a detail.**
5. **One such window per `wl_output`.**
6. Show.

**KWin will not block us:** linux.md §MM — KWin's `restrictedInterfaces` holds exactly six entries
(plasma-window-management, fake_input, screencast, activation_feedback, lockscreen_overlay,
security_context); **layer-shell is not among them**, and that filter applies only to sandboxed
clients. `src/wayland/layershell_v1.cpp` registers it as an **unconditional global** at v5.

**GNOME will not change:** mutter#973 was opened *and closed the same day* (2019-12-14) by maintainer
Jonas Ådahl — *"we don't want to support arbitrary third party panels etc, as that is not how GNOME
is designed to work."* Thread active through 2026-04-19 **with no softening**. Extensions cannot
implement it. `ext-layer-shell-v1` MR !28 is still a **DRAFT open since 2020-04-16 with no branch
commits since 2023**. `wlr-` is the only shippable spelling.

### 4.4.1 🔴 THE TRAP: a Wayland overlay swallows EVERY desktop click by default

linux.md §LL, and it is the single most dangerous item in this plan:

> `wl_surface.set_input_region` — *"The initial value for an input region is **infinite**."*
> The layer-shell XML: *"If you do not want to receive them, set the input region on your surface to
> an empty region."*
>
> **A full-output layer-shell overlay therefore intercepts every click on the desktop unless we
> explicitly commit an EMPTY `wl_region`.**

Two things make this a shipping-blocker rather than a bug:

1. ⚠️ **CSS `pointer-events: none` will NOT save us.** It is the wrong layer entirely — the
   compositor never sees it. Any instinct to fix click-through in the renderer is wrong here.
2. **It is silent until a user tries to click their desktop.** Nothing errors. The overlay looks
   perfect. Every click on anything underneath simply vanishes. On a full-screen always-on tint
   surface, that means the user's desktop stops responding to the mouse.

**The fix:** on GTK3, `gtk_widget_input_shape_combine_region` with an **empty region** — GTK3's
Wayland backend plumbs it through to `wl_surface_set_input_region`. That is exactly what
`set_ignore_cursor_events(true)` maps to (linux.md §7 confirms it is the **one** overlay primitive
that works on Wayland), **but it must be asserted on the promoted GTK window, after mapping, on
every show path**, not merely requested at build time.

Note that `build_window` already carries a Linux carve-out for a related reason
(`#[cfg(not(target_os = "linux"))]` around `set_ignore_cursor_events`, `windows/mod.rs` line 489,
with the comment *"a hidden prewarmed window is not realized yet — so the show path re-asserts this
after `show()`"*). **That existing instinct is correct and must be preserved and strengthened:**
assert the empty input region after show, and verify it — do not assume it took.

**Add a startup self-check.** After bringing up a Wayland overlay, read back the input region (or,
failing that, log the assertion explicitly at info level) so a regression shows up in logs rather
than in a user's inability to click their desktop. This is cheap and the failure it guards is severe.

### 4.5 Data-model consequences of the weakest platform

These are the changes the substrate forces on **shared** code, and they must land in the Rust types
and in the generated `src/bindings.ts` **from day one** (regenerate with
`cd src-tauri && cargo test export_bindings`; never hand-edit).

1. **`SurfaceGeometry.origin` must be `Option<(i32, i32)>`.** Under Wayland a client can never learn
   its own absolute position (linux.md §5–6: *"a normal client cannot learn … even its own absolute
   position"*). Any code that assumes a global origin exists is wrong on the dominant Linux target.

2. **`virtual_screen_bounds()` must stop being the coordinate space.** Its non-Windows arm is
   currently a hardcoded `(0, 0, 1920, 1080)`. Replace with a per-surface model. Focus Blur's
   `to_local_anchor` (`src-tauri/src/focus/blur.rs` lines 192–222) already rebases to window-local
   coordinates by subtracting the origin — good instinct, wrong origin. It must rebase per-surface.

3. **`FocusAnchorEvent` / `FocusCursorEvent` become per-surface.** Add `surface: SurfaceId` to both
   payloads (`src-tauri/src/events.rs` lines 124–178). On per-screen backends the renderer receives
   N event streams; on spanning backends `SurfaceId::Spanning` preserves today's behaviour exactly.
   Existing tests in `blur.rs` (lines 439–570) stay valid for the spanning case.

4. **`OverlayCapability.captured_in_screenshots: Option<bool>`.** `None` is the honest value until
   spike S1 lands. Do **not** default it to `false` — CareUEyes markets "screenshots keep true
   colors" (F1.7), and shipping that claim on macOS unverified would be a user-visible lie.

5. **The renderer must handle N windows.** `src/views/focus-overlay/ui/FocusOverlayPage.tsx`
   currently assumes it is the single virtual-screen-spanning surface. It needs to read its own
   `SurfaceId` (from the window label suffix, e.g. `focus-overlay:display-<key>`) and filter the
   event stream. `WINDOW_SPECS` is a `const` array keyed by static labels — per-screen surfaces
   need **dynamically labelled** windows, which means `spec_for()` must gain a prefix-match path or
   the overlay surfaces must move out of `WINDOW_SPECS` into the substrate module. Prefer the
   latter: keep `WINDOW_SPECS` for the fixed roster, and let `overlay_substrate` own its own
   window construction (it already needs a non-standard build path on macOS and Wayland).

6. **IPC surface** (`src-tauri/src/commands_registry.rs`): add one command
   `overlay_capability() -> OverlayCapability` and one event `overlay:capability` re-emitted on
   display reconfiguration and on session change. Everything else stays behind the existing
   `focus_*` / `overlay_notify` commands.

7. **Settings schema** (`src-tauri/src/settings/mod.rs` + `src/shared/config/settings-schema/`):
   add a Linux-only `prefer_x11_backend: bool` (default `false`). Setting it writes
   `GDK_BACKEND=x11` for the next launch and requires a restart — linux.md is explicit that this is
   *"a legitimate product decision … Expose it as a user-facing setting rather than hiding it."*

## 5. Implementation steps

Each step leaves the repo green (`bun run lint`, `bun run typecheck`, `bun run test`,
`bun run check:fsd`, `cargo fmt --check && cargo clippy --all-targets && cargo test`).

1. **Extract the substrate module, Windows-only, behaviour-identical.**
   New `src-tauri/src/overlay_substrate/{mod.rs, windows.rs}`. Move the `show_overlay` /
   `hide_overlay` bodies out of `focus/read.rs` and `focus/blur.rs` behind `OverlayHost`. The
   `WindowsSpanning` backend reproduces exactly what those two functions do today.
   Files: `windows/mod.rs`, `focus/read.rs`, `focus/blur.rs`, `commands_registry.rs`, `lib.rs`.
   *No behaviour change. This is the reviewable seam.*

2. **Introduce `SurfaceId` / `SurfaceGeometry` / `OverlayCapability` + the `overlay_capability`
   command and the `overlay:capability` event.** Regenerate bindings. Wire a capability strip into
   the Focus panel (`src/views/main/ui/panels/focus/`) that renders nothing when
   `limitations.is_empty()`. Files: `events.rs`, `commands_registry.rs`, `src/bindings.ts`
   (generated), `messages/en.json`, the Focus panel.

3. **Add `surface: SurfaceId` to `FocusAnchorEvent` / `FocusCursorEvent`;** rebase geometry
   per-surface. On Windows every event carries `Spanning`, so the renderer is unchanged in
   practice. Extend the existing `to_local_anchor` tests.
   Files: `events.rs`, `focus/blur.rs`, `focus/read.rs`, `src/features/focus-blur/lib/blur-geometry.ts`
   (+ its `.test.ts`), `FocusBlurShade.tsx`, `FocusReadShade.tsx`.

4. **Replace `virtual_screen_bounds()` with a real per-platform display enumeration** sourced from
   plan 02. Delete the `(0, 0, 1920, 1080)` fallback — an unknown topology must produce
   `OverlayBackend::Unavailable`, not a fake 1080p screen.
   Files: `windows/placement.rs`, `overlay_substrate/mod.rs`, `display/monitors.rs`.

5. **X11 backend.** `linux_x11.rs`: `gdk_x11_window_get_xid()` → `x11rb` for `_NET_WM_STATE_ABOVE`,
   `_NET_WM_WINDOW_TYPE_DOCK`, `_NET_WM_DESKTOP=0xFFFFFFFF`, and
   `XFixesSetWindowShapeRegion(…, ShapeInput, empty)`. Spanning, one window at the union origin.
   New crate deps: `x11rb` (features `shape`, `xfixes`), `gdkx11`.

6. **macOS backend — native `NSWindow`, no webview.** `macos.rs`: construct the window ourselves per
   §4.3 (`setOpaque(false)` + `setBackgroundColor`, level, `collectionBehavior`,
   `setIgnoresMouseEvents`, `orderFrontRegardless`, `.accessory` policy); one surface per `NSScreen`;
   `CGMainDisplayID()` for primary; `Monitor::position()` + `size()` (**not** `work_area()`); observe
   `didChangeScreenParametersNotification` with a ~500 ms debounce and a full rebuild.
   Implement `SurfaceContent::Rects` only — reject `Webview` with a typed error rather than
   silently building an 8×-power window.
   ⚠️ **Blocked on spike S2** before it can be estimated.
   New crate deps, **version-pinned to match tao exactly** (macos.md §T): `objc2 0.6`,
   `objc2-app-kit 0.3`, `objc2-foundation 0.3`, `block2 0.6`, `core-graphics 0.25`, `dispatch2 0.3`,
   plus `objc2-core-graphics` for display enumeration.

6b. **Express the Focus shades as `Rects` on macOS.** Focus Blur is already four rectangles
   (plan 09 / macos.md §E); Focus Read is two. This step lives in plans 08/09 but **must not be
   discovered late** — the substrate refuses `Webview` on macOS, so those plans need the `Rects`
   path from their first macOS commit. Flagged here as the cross-plan dependency it is.

7. **Wayland layer-shell backend.** Depend on `gtk-layer-shell` 0.8.2 (pinned to gtk-rs 0.18, matching
   Tauri 2.11); promote **before mapping** (`visible: false`, show after); one surface per `wl_output`;
   **commit an empty `wl_region` input region and self-check it (§4.4.1)**. Prior art:
   `andre-lund/poe2-overlay`. ⚠️ Reduced from BLOCKED to **de-risked** by linux.md §MM — spike S3 is
   now a validation exercise rather than an open design question.

8. **`prefer_x11_backend` setting + the GNOME Wayland degraded path.** Detect GNOME Wayland, report
   `CompositorRefusesLayerShell`, and offer the setting inline in the warning with a restart prompt.
   Files: settings schema (Rust + Zod), `bootstrap/`, `messages/en.json`, Focus panel.

9. **Screenshot-capture disclosure.** Once S1 resolves, set `captured_in_screenshots` per backend
   and surface it in the Display panel next to the F1.7 "no yellow screenshots" claim. If macOS is
   `true`, the copy must say so on macOS rather than repeating CareUEyes' Windows-only promise.

## 6. Permissions, packaging, distribution

- **macOS TCC: none, and this is a design goal, not an accident.** macos.md §I: *"A translucent,
  click-through, always-on-top overlay + `RegisterEventHotKey` requires no TCC permission
  whatsoever. One of the very few system-wide-feeling macOS app shapes with zero prompts."*
  `CGWindowListCopyWindowInfo` — which §4.3.1 and plan 09 both use — **never triggers a permission
  prompt** (§F). Do not let any overlay work acquire a permission dependency.
- **macOS entitlements:** none required for Variant A beyond standard hardened runtime (which Tauri
  enables by default). Notarization is unaffected by `macOSPrivateApi` (macos.md §7).
- **Mac App Store — the constraint moved, and it is now a product question.** The native-window
  design (§4.3) means the *overlay* no longer needs `macOSPrivateApi` at all. What remains:
  - `tauri.conf.json` currently has `"macOSPrivateApi": true` and `Cargo.toml` enables
    `tauri/macos-private-api`. The private bits are the KVC string keys `drawsBackground` and
    `fullScreenEnabled` — **trivially found by a static string scan** (macos.md §S), so leaving the
    flag on is an MAS rejection risk even if nothing uses it. **Gate it behind a Cargo feature so an
    MAS build compiles it out** (macos.md §T).
  - Independently, **MAS builds cannot place dark overlays above fullscreen windows** — stated by
    Alin Panaitiu (Lunar / Gamma Dimmer) as a vendor in this exact space (§T), and documented by
    GammaDimmer (§J). HazeOver and GammaDimmer ship sandboxed on the MAS *without* that coverage.
  **Conclusion: overlay tinting is a Developer-ID + notarized product. An MAS SKU is possible but
  strictly less capable, and is a product decision — not something to design toward by default.**
  Also watch tauri#13415 (transparency lost after DMG build — windows render solid white; open since
  May 2025, and `macOSPrivateApi` / `TAURI_PRIVATE_API=1` / the Cargo feature **all failed to help**)
  and tauri#11142 (flag/feature consistency).
- **macOS bundle targets are missing.** `tauri.conf.json` lists only `nsis`, `appimage`, `deb`,
  `rpm`. Add `app` + `dmg` as part of step 6, not before.
- ⚠️ **Adopt one stable macOS code-signing identity NOW, before any macOS work starts.** macos.md §L:
  TCC keys grants to the **Designated Requirement**, not the path (TN3127); **arm64 binaries are
  always at least ad-hoc signed by the linker, so the "DR collapses to a `cdhash` that changes on
  every rebuild" treadmill is the DEFAULT on Apple Silicon.** We need zero TCC grants today, so this
  costs us nothing *today* — but plan 09's optional Accessibility upgrade and any future permission
  will be untestable without it, and the failure mode is nasty (the System Settings row still
  appears **enabled** while silently failing). Use a free Apple Development cert (Xcode Personal
  Team) or AltTab's self-signed cert carrying Apple's code-signing OID `1.2.840.113635.100.6.1.14`.
  Verify embedded helpers with `codesign -dvv` — a team-signed `.app` wrapping an ad-hoc helper
  still thrashes.
- **Linux runtime dependency:** the layer-shell backend needs `libgtk-layer-shell` on the host.
  Add it to `deb`/`rpm` `depends`. **AppImage must bundle it** or the Wayland backend silently
  degrades on every AppImage user — precisely the failure class linux.md warns about.
- **Flatpak:** the overlay itself is sandbox-compatible (layer-shell and X11 shaping both go through
  the compositor/X server the sandbox already talks to). No portal needed. Flatpak problems live in
  plan 11 (autostart) and plan 03 (DDC udev), not here.
- **Snap:** not evaluated. Do not claim support.
- **No polkit, no udev, no group membership** for this plan.

## 7. Failure modes & degradation

**Silent no-ops are the enemy, and this substrate is where they breed.** linux.md's design
imperative names six APIs that report success while doing nothing. The substrate's job is to make
every one of them loud.

| Condition | Today | After this plan |
|---|---|---|
| GNOME Wayland, overlay requested | `show()` returns `Ok`, `set_position` no-ops, `always_on_top` no-ops → an unpositioned, non-top window appears somewhere, or nothing visible happens | `OverlayBackend::Unavailable` + `CompositorRefusesLayerShell { compositor: "GNOME" }`; the Focus panel shows a persistent explanation with the "use X11 backend" setting inline; the Focus toggles are disabled with a reason tooltip |
| Running under XWayland | Indistinguishable from real X11 | `X11ViaXWayland` + `XWaylandFallback`; an informational (not alarming) note about scaling |
| macOS `ns_window()` returns null | Would silently produce a `.floating` window under the Dock | `NativeHandleUnavailable`; overlay features disabled with a reason |
| **macOS, a foreign app goes fullscreen** | Would silently stop covering anything — the worst kind of "is it broken?" | **Suspend the overlay deliberately** and emit `SuspensionReason::ForeignFullscreen`. The Focus/Display panel shows a transient, non-alarming "paused while <app> is fullscreen" state; the overlay resumes automatically on exit from fullscreen. macos.md §E is explicit that no window-level combination works here (Apple forum 26677) — this is a permanent platform limit, so the copy should read as *by design*, not *error*. |
| macOS, menu-bar region renders at the wrong intensity | — | Known upstream behaviour (the menu bar/notch composites separately; HazeOver 1.9.7 shipped a fix for it on Tahoe — macos.md §E). Special-case the menu-bar strip in per-surface geometry; do not treat as a bug report. |
| `init_layer_shell` fails, or promotion happens after mapping | — | `LayerShellUnavailable`; same treatment as GNOME. Promotion-after-mapping is silent, so gate it: build with `visible: false` and assert promotion succeeded before showing |
| 🔴 **Wayland overlay with a default (infinite) input region** | — | **Every desktop click is swallowed and nothing errors** (linux.md §LL). Commit an empty `wl_region`, assert it on every show path, and log the assertion so a regression is visible in logs rather than in a user's dead desktop. **This is the highest-severity failure in the plan: the app becomes indistinguishable from a frozen desktop.** |
| Display hot-plug | Windows: `virtual_screen_bounds()` re-read on next show. macOS/Wayland: stale surface set | Reconciliation on the platform's reconfiguration signal (macOS: debounced `didChangeScreenParametersNotification`; X11: RandR `ScreenChangeNotify`; Wayland: `wl_output` global add/remove) |
| A display is removed while an overlay covers it | — | The surface is destroyed; the remaining set is rebuilt from scratch |

**State restoration on crash/exit.** The overlay is a window: process death destroys it and the
screen returns to normal. There is **no persistent global state to leak** — a deliberate contrast
with gamma (macos.md §0: a crashed process leaves the display tinted) and with the macOS
accessibility grayscale APIs (macos.md §4: "system-wide global state that persists after our app
quits"). **This is the strongest argument for making the overlay the primary mechanism on macOS,
and it should be stated in the code comments so nobody "optimizes" it away.**

On graceful exit `app_exit.rs` must call `set_visible(false)` + destroy the surface set, mainly so
a hung webview cannot outlive the app on Wayland.

## 8. Testing

**Unit-testable pure logic (runs in CI on every platform, `bun test ./src` + `cargo test`):**
- Surface-set reconciliation: given a display list and a `SurfaceRequest`, which `SurfaceId`s should
  exist. Table-driven: 1 display, 2 displays, mixed scale factors, a display above/left of primary
  (negative coordinates), hot-plug add, hot-remove, remove-the-primary.
- Coordinate rebasing per surface — extend the existing `to_local_anchor` tests in
  `src-tauri/src/focus/blur.rs` (lines 439–570), which already cover negative secondary origins.
- The macOS Quartz↔Cocoa flip: `y_cocoa = main_height - (y_quartz + height)`, asserting negative
  results are preserved and never clamped (macos.md §A).
- Backend selection from an environment snapshot (`$WAYLAND_DISPLAY`, `$DISPLAY`,
  `$XDG_CURRENT_DESKTOP`, registry advertisement) → `OverlayBackend` + limitations. Pure function
  over a struct, so every one of the seven table rows in §3 is a test case.
- `OverlayCapability` → UI message mapping (frontend, `messages/en.json` key parity via
  `bun run check:i18n`).

⚠️ **macOS: `tauri dev` produces NO `.app`.** macos.md §L verifies this in Tauri's source — `dev.rs`
runs the bare Mach-O from `target/debug/` with no bundle, no Info.plist, no bundle identifier;
`src-tauri/Info.plist` is merged **only at bundle time**. Consequences for this plan's test loop:
bundle-identity-dependent behaviour (activation policy, LSUIElement, and anything TCC-adjacent that
plan 09 adds later) is **untestable under `tauri dev`**. Two attribution traps make dev results
actively misleading: a dev binary launched from a terminal **inherits the terminal's grants**, and a
disclaimed child process gets its own empty TCC identity. **Test the macOS overlay only against a
signed, bundled `.app`** — add a `just`/npm script that bundles and launches, and make it the
documented macOS workflow.

**Manual only, per platform:**
- Menu-bar and Dock coverage (macOS) — the level question (spike S2). Requires a real Mac.
- Foreign fullscreen: verify the overlay **suspends and announces** rather than silently failing,
  and resumes on fullscreen exit. Spaces switching with `.canJoinAllSpaces` + `.stationary`.
- Notch behaviour on a MacBook Pro.
- Click-through: verify clicks reach the window *underneath* on all five working backends.
- Focus-stealing: verify showing the overlay never moves keyboard focus (the current code is
  careful about this — `focus/read.rs` line 131 comment "Deliberately NO set_focus()").
- The screenshot question (spike S1).
- Layer-shell on KDE Plasma Wayland and on sway.
- 🔴 **Click-through on Wayland, tested as a user would hit it:** with the overlay up, click the
  desktop, click a window behind it, drag a window, right-click for a desktop menu. **An automated
  check cannot catch a swallowed click; a human clicking their desktop catches it in two seconds.**
  Make this an explicit item on the Wayland release checklist (§4.4.1).
- GNOME Wayland: confirm the *degraded* path reports correctly, and that `GDK_BACKEND=x11` restores
  full function.

**Cannot be tested in CI:** everything in the manual list. CI has no compositor, no Mac hardware
with a notch, and no multi-monitor rig. Budget for a physical test matrix; do not pretend
`ubuntu-latest` covers Linux here — a headless runner cannot distinguish a working overlay from a
silent no-op, which is the exact bug class this plan exists to prevent.

## 9. Open questions / spikes needed

**S1 — macOS screenshot capture. ✅ RESOLVED by macos.md 11th pass. No spike needed.**

> *"**Gamma is NOT captured. An overlay IS captured.** Pass A was right; Pass B was wrong."*

Decisive natural experiment (MonitorControl discussion #866): a user reported screenshots coming out
*"noticeably dimmer … as if a transparent black overlay was applied"*; maintainer waydabber's
diagnosis was *"This is normal if you use 'Avoid gamma table manipulation'"* — i.e. the shade-window
path — and switching back to gamma made screenshots normal. Mechanism: the LUT is applied at
**scanout**, downstream of the composited framebuffer that `screencapture` / ScreenCaptureKit read.

✅ **But a mitigation exists and it changes the product answer:** `NSWindow.sharingType = .none`
excludes an overlay from capture. **xdr-boost sets exactly that**; **Lunar leaves its shades at
`.readOnly`, which is why Lunar's shades DO show up in captures** — the two behaviours in the wild
are a deliberate configuration difference, not a platform limit.

> **Product consequence (quoting the research): CareUEyes' F1.7 "no yellow screenshots" property is
> achievable on macOS via the overlay path too, provided we set `sharingType = .none`. It is *not*
> automatically lost by choosing overlay-primary.**

**Design decisions this forces, and they belong in the settings schema, not in a spike:**
1. Set `sharingType = .none` on every overlay surface **by default**.
2. **Expose it.** The research is explicit that *"some users want the tint in a screen share"* — a
   person demonstrating their reading setup, or streaming with the shade visible. Add a Display-tab
   toggle (`exclude_from_screen_capture`, default `true`).
3. `OverlayCapability.captured_in_screenshots` becomes **`Some(false)` by default on macOS**, and
   tracks the setting. It is no longer `None`/unknown.
4. ⚠️ **Carry one caveat forward, do not silently drop it.** macos.md §7 gotcha 1 cited tauri#14200:
   `sharingType = .none` / `setContentProtection(true)` **ignored by ScreenCaptureKit on macOS 15+**,
   `status: upstream`, no workaround. The 11th pass asserts the mitigation works (citing xdr-boost)
   but does **not** address that report. Since we now construct the `NSWindow` ourselves rather than
   going through Tauri's `set_content_protected`, the Tauri-specific issue may not apply — but
   **verify `sharingType = .none` against ScreenCaptureKit specifically** (not just ⌘⇧4) during
   spike S2's hardware session. Cheap to check; embarrassing to ship wrong.
5. HazeOver, for reference, does **not** set it — macos.md §II item 10: *"Screenshots **do** capture
   its dim layer."* So shipping either way has precedent.

**S2 — macOS window type, level, and fullscreen coverage. BLOCKING step 6.**
Four passes produced four readings. The 8th pass resolves the arithmetic (the
`NSWindow.Level.screenSaver` 101 vs `CGWindowLevelForKey(.screenSaverWindow)` 1000 **namespace
trap**) and gives a plan of record — **level 101** — but explicitly leaves one item open:

> macos.md §T: *"**UNVERIFIED:** the 25-vs-101 discrepancy was not empirically resolved. Spike it."*

**Authoritative constants now exist** — macos.md §EE reads them straight out of `CGWindowLevel.h`
(SDK 26.4): `kCGMainMenuWindowLevel 24` · `kCGStatusWindowLevel 25` · **`kCGPopUpMenuWindowLevel
101`** · `kCGOverlayWindowLevel 102` · `kCGDraggingWindowLevel 500` · **`kCGScreenSaverWindowLevel
1000`** · `kCGAssistiveTechHighWindowLevel 1500`, plus `CGShieldingWindowLevel()` (the level of the
shield window used for captured displays). **That settles the arithmetic; what remains is which
level actually behaves correctly for a persistent tint.**

| Source | Type | Level | collectionBehavior |
|---|---|---|---|
| §7 | `NSPanel` + `.nonactivatingPanel` | ≥ 101 | `[CanJoinAllSpaces, Stationary, IgnoresCycle, FullScreenAuxiliary]` |
| §EE **MonitorControl** (shipping, verbatim) | `NSWindow`, `styleMask = []`, full `screen.frame` | `CGShieldingWindowLevel()` | `[Stationary, CanJoinAllSpaces, IgnoresCycle]` |
| §EE **Lunar** (shipping, verbatim) | `NSWindow`, `isOpaque = false`, `setAccessibilityRole(.popover)`, flips black↔white on `accessibilityDisplayShouldInvertColors` | `.hud` | `[Stationary, CanJoinAllSpaces, IgnoresCycle, FullScreenDisallowsTiling]`, `sharingType = .readOnly` |
| §EE **xdr-boost** (shipping, verbatim) | `NSWindow`, `hidesOnDeactivate = false`, `animationBehavior = .none`, **`sharingType = .none`**, `orderFrontRegardless()`, **+ a 3 s watchdog Timer that re-fronts the window if it ever stops being visible** | `.screenSaver` | `[CanJoinAllSpaces, Stationary, FullScreenAuxiliary, IgnoresCycle, CanJoinAllApplications]` |
| §J (Apple DTS) | `NSPanel` + `.nonactivatingPanel` | `.screenSaver` = 1000 | `[CanJoinAllSpaces, CanJoinAllApplications, FullScreenAuxiliary, Stationary]` |
| **§T (plan of record)** | **`NSWindow` or `NSPanel`** | **101** | **`[CanJoinAllSpaces, Stationary, IgnoresCycle, FullScreenAuxiliary]` + `ActivationPolicy::Accessory`** |

**xdr-boost is the closest match to our requirements** (persistent, click-through, capture-excluded,
covers fullscreen) and is the recipe to start the spike from. Note its **3-second watchdog that
re-fronts the window** — three shipping apps independently added drift/visibility watchdogs, which
is strong evidence that "set it once and trust it" is not sufficient on this platform. **Budget for
a watchdog in step 6 regardless of which level wins.** Lunar's `setAccessibilityRole(.popover)` is
also worth copying so assistive tech and window switchers ignore our surfaces.

Note §J's set and §T's set **conflict under the mutual-exclusivity groups** (§4.3.1):
`CanJoinAllApplications` is in the same group as `Primary`/`Auxiliary`. Do not merge them on paper.

**Action:** on a real Mac, against a **bundled, signed `.app`** (not `tauri dev` — §8), build one
window per candidate configuration and check, for each:
1. Menu-bar coverage **in both Tahoe menu-bar modes** (transparent-by-default vs opaque) and
   menu-bar *intensity* (the HazeOver 1.9.7 issue, §E);
2. Dock coverage;
3. Behaviour across a Spaces switch;
4. Behaviour when *our own* window goes fullscreen;
5. **Behaviour when a *foreign* app goes fullscreen** — this is the retracted-BLOCKED question
   (§4.3.1). Test with and without `ActivationPolicy::Accessory`, since §T identifies the process
   type transform as the missing ingredient;
6. **Stage Manager** — §T flags it as a known problem case;
7. Whether the window sits above or below other utilities' overlays (f.lux, Lunar);
8. `NSWindow` vs `NSPanel` + `.nonactivatingPanel`: does the plain window ever steal focus given
   `setIgnoresMouseEvents(true)` + `.accessory`? If not, skip `NSPanel` and skip the git-only
   `tauri-nspanel` dependency entirely.

**Pick the lowest configuration that passes 1–7.** Estimated: 1–1.5 days with hardware.

**S5 — confirm the native-window power win. Cheap, do it alongside S2.**
macos.md §S measured the *Tauri transparent webview* at ~620 mW / 36% GPU residency. The
native-`NSWindow` design should land near the ~75 mW opaque baseline, but that has **not been
measured** — §S infers it. Measure our actual overlay with `powermetrics` before and after, on both
Intel and Apple Silicon. If a native alpha window is *also* expensive, the whole macOS overlay
strategy needs re-examination against the gamma path — and that is far better learned in a spike
than after shipping an always-on feature. Estimated: 2 hours, folded into the S2 session.

**S3 — layer-shell validation. DE-RISKED; still BLOCKING step 7, but smaller.**
linux.md §MM removes the two biggest unknowns: **the approach has shipped** in a Tauri v2 app
(`andre-lund/poe2-overlay`, KDE Plasma, 2026-07-12), and **the crate question is settled** —
`gtk-layer-shell` 0.8.2 is frozen-not-broken and is the *correct* generation for Tauri 2.11's
gtk-rs 0.18 pin. No vendoring.
**What remains to validate:** does wry attach a webview cleanly to the promoted window; does
per-`wl_output` surface creation interact correctly with Tauri's window registry and our prewarm
path; and — **the one that must not be skipped** — does the **empty input region actually take
effect** (§4.4.1), verified by clicking the desktop through the overlay, not by reading code.
Estimated: **1–2 days** on a KDE Plasma Wayland box (down from 2–3).

**S4 — Wayland surface identity ↔ monitor identity (plan 02 dependency).**
Layer-shell binds a surface to a `wl_output`, but `wl_output.name` "may be reused after an output is
destroyed" (linux.md §3) and EDID is not exposed to Wayland clients. `SurfaceId::Display(MonitorKey)`
assumes plan 02 produces something durable. If plan 02's Wayland key is only make+model, two
identical monitors collapse — the same failure MonitorControl accepted on macOS (macos.md §A).
Resolve jointly with plan 02; do not invent a second keying scheme here.

**Q1 — Should `prefer_x11_backend` be auto-enabled on GNOME Wayland?**
Argument for: it is the only way the feature works, and a silently missing feature is worse than
blurry scaling. Argument against: silently forcing XWayland degrades the entire app's rendering for
a feature the user may never enable. **Recommendation: do not auto-enable.** Offer it inline in the
unavailability explanation, once, and remember the choice.

**Q2 — Does the notification pill (`overlay`) need the per-screen treatment?**
It is a single small strip docked top-center of one display, not a full-screen surface. It could
stay a single window on every backend. Under layer-shell it still needs a layer surface on *some*
output. Decide during step 7; the trait supports both.

## 10. Effort

| Platform | Size | Notes |
|---|---|---|
| Windows | **S** | Refactor only (steps 1–4). No behaviour change. |
| Linux X11 | **M** | Step 5. Well-trodden recipe, [VERIFIED] in the research. |
| macOS | **L** | Step 6, plus two blocking spikes (S2, S5) and a pinned `objc2` dependency surface. The no-webview decision **removes** work (no transparent-window bug-chasing) but **adds** a native `Rects` renderer that plans 08/09 must target. |
| Linux Wayland (KDE/wlroots) | **L** | Step 7. Downgraded from XL by linux.md §MM: shipped prior art exists, no vendoring, and the crate pin is settled. The surface-set model change is still mostly driven by this platform. |
| Linux Wayland (GNOME) | **M** | Step 8 — detecting and *explaining* the impossibility, plus the X11 opt-in. Most of the cost is UX copy, not code. |

**Single biggest risk: the surface-set model change (§4.5) touches every overlay consumer and the
renderer, and it is forced by the two platforms we cannot test in CI.** If macOS and Wayland
support were dropped, none of it would be needed. Land steps 1–4 early anyway — they are pure
refactoring with immediate legibility benefit — but treat the estimate for steps 6–7 as
**unreliable until S2 and S3 land.**

**Second risk: `captured_in_screenshots` is a product-claim risk, not an engineering one.** If S1
confirms the overlay appears in screenshots, macOS loses one of CareUEyes' four headline
differentiators, and that should influence how much macOS effort is worth spending — so **run S1
before committing to step 6**, even though it does not block the code.

**Third risk (new, from macos.md §S): the `SurfaceContent::Webview` / `Rects` split is a
one-way door for macOS.** Once plans 08/09 target `Rects` on macOS, any later overlay feature that
genuinely needs a DOM there has no cheap path — the measured cost of a transparent Tauri webview
(~8× GPU, on a static page) rules it out for anything always-on. That is the right trade for
F8.1/F8.2, which are literally rectangles. **Record it as a constraint on future overlay features,
not as an implementation detail**, so nobody discovers it while designing feature number three.
