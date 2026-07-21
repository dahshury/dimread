# Plan 01 — Display core: colour temperature + brightness
Status: DRAFT
Depends on: 00 (platform capability layer). Multi-monitor *identity* is plan 02; this plan assumes
an opaque per-monitor key and works with whatever plan 02 supplies.
Parity ref: FEATURE-PARITY.md F1.1, F1.2, F1.7, F1.8, F1.11, F2.1, F2.2, F2.4 (F1.5 invert and F1.6
grayscale are covered here only to the extent they constrain the engine; F2.3 multi-monitor identity
is plan 02)

---

## 1. What this feature is

The heart of the app: a colour-temperature slider (warm↔cool, live Kelvin badge) and a brightness
slider (dimmer↔brighter, 1 % precision) that tint and dim **the whole screen**, live, with smooth
transitions — see `research/careueyes/images/landing_display-912x625.png`. CareUEyes' headline
technical claim (F1.7) is that this happens at the **GPU gamma stage**, so screenshots keep true
colours, text stays sharp, and there is no overlay in the way.

That claim is achievable on Windows and Linux X11. **It is not achievable as the primary mechanism
on macOS, and not achievable at all on GNOME Wayland.** This plan's job is to build one engine that
serves all of them honestly, and to make the user aware of which one they are getting.

## 2. Current state

`src-tauri/src/display/` is a well-factored Windows implementation with the pure logic already
separated:

| File | What it owns | Portability |
|---|---|---|
| `gamma.rs:21` | `pub type GammaRamp = [[u16; 256]; 3]` | **Windows-shaped.** The `256` is a Win32 constant. |
| `gamma.rs:25-53` | `kelvin_to_rgb(f64) -> (f64,f64,f64)` (Tanner Helland) | Pure, portable, tested |
| `gamma.rs:57-71` | `compose(kelvin, brightness, invert) -> GammaRamp` | Pure, portable, tested |
| `gamma.rs:75-83` | `identity() -> GammaRamp` | Pure, portable |
| `gamma.rs:87-107` | `read_ramp(&str)` / `apply_ramp(&str, &GammaRamp)` | `#[cfg(windows)]`; **the non-Windows arms return `None` / `false` and every caller ignores the result** |
| `gamma.rs:109-161` | `mod windows_impl` — `CreateDCW` + `Get`/`SetDeviceGammaRamp` | Win32 only → moves to `platform/windows/gamma.rs` (plan 00 step 2) |
| `engine.rs` | The orchestrator + the four `display_*` IPC commands | Portable in shape, gamma-only in assumption |
| `scheduler.rs`, `suncalc.rs` | Day/night factor | Pure, portable |

The engine's contract, from `engine.rs:1-31`, is already the right shape:
`init` → `refresh` → `set_rule_override` / `set_fullscreen_suspend` / `preview` / `clear_preview` /
`restore_all`. Notable internals:

- `EngineState.originals: HashMap<String, GammaRamp>` (`engine.rs:81-82`) — the restore snapshot,
  keyed by GDI device name.
- `apply_targets(targets, smooth)` (`engine.rs:354-390`) — the ~400 ms / 24-step animation on a
  spawned thread, guarded by `TRANSITION_GEN: AtomicU64` so a superseded animation abandons itself.
  This generation guard is genuinely good and survives the port unchanged.
- `restore_ramps` (`engine.rs:345-351`) is called from `restore_all`, which
  `src-tauri/src/app_exit.rs:20` calls on every quit path.
- `DisplayOutput { kelvin, brightness, mode, phase }` (`engine.rs:51-58`) is emitted as the
  `display:state` event (`events.rs:102-110`) and consumed by
  `src/views/main/ui/panels/display/LiveReadout.tsx`.

**Three latent bugs this plan must fix, all present today on Windows:**

1. **`apply_ramp`'s return value is discarded everywhere.** `engine.rs:314`, `:360`, `:385`, `:348`
   all call it as a statement. A failed apply is indistinguishable from a successful one.
2. **Crash leaves a poisoned baseline.** `engine::init` (`engine.rs:141-147`) snapshots
   `gamma::read_ramp(&m.id)` as the monitor's "original". Gamma ramps set by a crashed process
   **persist on Windows and on X11**. Next launch therefore snapshots the *tinted* ramp as the
   original and the tint becomes permanently baked in, compounding on every crash. There is no
   restore-on-launch and no persisted baseline.
3. `engine::init` runs once at `lib.rs:106` and **nothing re-applies on display reconfiguration** —
   no `WM_DISPLAYCHANGE` handling, no hot-plug watch. Plug in a monitor and it stays untinted;
   change resolution and Windows resets the ramp.

## 3. Per-platform verdict table

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | GDI `SetDeviceGammaRamp` per GDI device (current impl) | Fixed 256-entry ramps. Screenshot-transparent (F1.7 holds). Per-monitor works. |
| macOS (Intel) | **PARTIAL** | **Primary: per-`NSScreen` overlay window.** Optional: `CGSetDisplayTransferByTable` gamma. | `macos.md` §"Architectural recommendation": overlay is "the defensible primary architecture on macOS". Overlay dims and tints but **cannot brighten, cannot invert, and (probably) appears in screenshots** — F1.7 does not hold. Gamma **disables HDR** and is last-writer-wins against f.lux/Lunar (`macos.md` §0). |
| macOS (Apple Silicon) | **PARTIAL** | same | ⚠️ `macos.md` §0: on M5 Pro / M5 Max / MacBook Neo under macOS 26.3.1–26.5.1, `CGSetDisplayTransferByTable` returns success, **readback is correct, screen does not change** (radars FB22273730 / FB22273782, reproduced by Apple DTS). **A write-then-read probe is NOT sufficient — the readback lies.** Gamma ships as an opt-in enhancement, never the default. |
| Linux X11 | **FULL** | RandR ≥1.3 `RRSetCrtcGamma` per CRTC (`x11rb`) | `linux.md` §1. ⚠️ **Ramp size varies per CRTC (256/1024/4096)** — always `RRGetCrtcGammaSize`. Single-slot global state: Night Light / `xrandr --gamma` / redshift overwrite us (jonls/redshift#759) — unavoidable. LUT often **not applied to the hardware cursor**. |
| Linux Wayland — KDE | **PARTIAL** | **Primary: per-output overlay via gtk-layer-shell.** Fallback: `org.kde.KWin.NightLight.preview()` on a heartbeat. | `linux.md` §1: KDE **explicitly refused** `wlr-gamma-control` (bugs.kde.org 479701). Every NightLight property is **read-only**; the only writable path is `preview(u temperature)`, which starts a **hardcoded 15 s `QTimer`** and auto-reverts, clamped to [1000, 6500] K. **Holding a tint therefore requires re-issuing `preview()` on a sub-15 s heartbeat. This is ugly and we should say so plainly** — it is a polling hack against an API explicitly designed to be temporary, it cannot do per-monitor, it cannot do brightness, and a missed heartbeat produces a visible 15 s snap-back. Prefer the overlay. |
| Linux Wayland — GNOME | **PARTIAL for temperature, BLOCKED for screen dimming** | `org.gnome.SettingsDaemon.Color` `Temperature` property (u, READWRITE, validated [1000,10000], `linux.md` §1) | No gamma protocol; **layer-shell permanently refused** (mutter#973 closed without implementation; `ext-layer-shell` does not exist and "standardization is not coming" — `linux.md` §7). So: no overlay ⇒ **no way to dim the screen at all** beyond the internal panel's own backlight via logind. Temperature is **global (not per-monitor)**, **transient** (gsd's night-light scheduler recomputes it), and gsd **smears transitions over ~5 s so read-back never matches**. F1.7, F2.1 dimming, F2.3 per-monitor: all blocked here. |
| Linux Wayland — wlroots | **FULL** | `zwlr_gamma_control_unstable_v1` (`wayland-protocols-wlr`) | `linux.md` §1, XML read directly: `get_gamma_control(id, wl_output)` → `gamma_size(size)` event → `set_gamma(fd)` where the fd holds **3 × size × u16**, R/G/B concatenated. **Exclusive** — a second client gets `failed`, so we lose to a running `gammastep`/`wlsunset`. Nice property: **destroying the object restores the original ramps**, so a crash auto-reverts. |

**Carried-through UNVERIFIED items — do not upgrade these:**

- **`GDK_BACKEND=x11` on GNOME Wayland: `linux.md` contradicts itself.** §0 states "Xwayland …
  gives no root window … and **no working XRandR gamma for the real outputs**". §7 and
  §"Recommended architecture" state that forcing `GDK_BACKEND=x11` "makes every capability work at
  once" and is "the *only* path to a working overlay" on GNOME Wayland. These cannot both be true
  for gamma. Most likely reading: the *overlay* works (an Xwayland window is composited by mutter as
  an ordinary window and EWMH hints are translated), while *gamma* does not (Xwayland exposes no
  real CRTCs). **UNVERIFIED — spike before promising GNOME users anything (§9 Q1).**
- **macOS overlay and screenshots.** `macos.md` §7 gotcha 1 is flagged **UNRESOLVED** across two
  contradicting research passes, adjudicated in favour of "the overlay WILL appear in screenshots"
  on mechanical grounds (overlay composites into the framebuffer before capture; gamma applies after)
  plus tauri#14200 (`sharingType = .none` ignored by ScreenCaptureKit on macOS 15+). **This decides
  whether CareUEyes' headline F1.7 selling point survives on macOS. VERIFY EMPIRICALLY.**
- **macOS MediaAccessibility matrix path** (`macos.md` §B): `MADisplayFilterPrefSetWarmthIntensity`,
  `MADisplayFilterPrefSetReduceWhitePointIntensity`, `MADisplayFilterSetMatrix`,
  `MADisplayFilterSetGain`. Because these are **matrix, not LUT, they suffer neither the gamma-table
  limits nor the Tahoe/M5 silent-failure bug** — genuinely on-point for us. But: private symbols,
  **system-wide with no per-display scoping**, intensity setters "reported inconsistent in community
  reverse-engineering", and **untested on macOS 26**. Treat as a **candidate third strategy worth a
  spike**, not a plan commitment. Requires the `_UniversalAccessDStart(0x8)` daemon kick.

## 4. Design

### 4.1 `GammaRamp` becomes size-agnostic

The single most invasive type change in the plan. `gamma.rs:21` today:

```rust
pub type GammaRamp = [[u16; 256]; 3];   // Windows-shaped
```

Becomes an owned, size-carrying struct in `src-tauri/src/display/gamma.rs` (still pure, still
platform-independent, still unit-tested in CI on any host):

```rust
/// Three channel LUTs of `size` entries each. `size` is 256 on Windows (a Win32
/// constant), whatever `RRGetCrtcGammaSize` reports per CRTC on X11 (256/1024/4096),
/// whatever the `gamma_size` event reports on wlroots, and
/// `CGDisplayGammaTableCapacity` on macOS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GammaRamp {
    size: u16,
    channels: [Vec<u16>; 3],
}

impl GammaRamp {
    pub fn compose(size: u16, kelvin: f64, brightness: f64, invert: bool) -> Self;
    pub fn identity(size: u16) -> Self;
    pub fn size(&self) -> u16;
    pub fn channel(&self, c: usize) -> &[u16];

    /// Resample to a different LUT size (linear interpolation). Needed when a
    /// persisted/captured baseline is a different size from the live CRTC after
    /// a mode change.
    pub fn resample(&self, size: u16) -> Self;

    /// macOS wants `CGGammaValue` = `f32` in 0.0..=1.0, NOT u16
    /// (`macos.md` §1). One conversion, one place.
    pub fn to_f32_tables(&self) -> [Vec<f32>; 3];

    /// wlroots wants a single fd holding 3 x size x u16, R/G/B concatenated
    /// (`linux.md` §1, read from the protocol XML).
    pub fn to_wlr_bytes(&self) -> Vec<u8>;

    /// Windows wants exactly `[[u16;256];3]`. Errors rather than truncating.
    pub fn to_win32_256(&self) -> Result<[[u16; 256]; 3], GammaError>;
}
```

The existing tests at `gamma.rs:163-196` port with a `size` argument and gain new cases for
`resample` round-tripping and `to_win32_256` rejecting a non-256 ramp.

`kelvin_to_rgb` is unchanged and stays the shared colour model across **all** backends, including
the overlay one — an overlay tint colour is derived from the same `(r, g, b)` white point, so the
two mechanisms agree on what "4000 K" looks like. That shared derivation is what makes the
mechanisms substitutable.

### 4.2 The multi-strategy engine

`display/engine.rs` keeps its public seam (`init` / `refresh` / `set_rule_override` /
`set_fullscreen_suspend` / `preview` / `clear_preview` / `restore_all` / `current_output`) and stops
calling `gamma::apply_ramp` directly. It gains a backend:

```rust
// src-tauri/src/display/backend.rs (new; implementations under src-tauri/src/platform/*)

/// Which family of mechanism is in play. Drives the capability report (plan 00)
/// and the UI's honesty copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TintMechanism {
    GammaWindowsGdi,
    GammaX11Randr,
    GammaWlrControl,
    GammaMacosCoreGraphics,
    OverlayMacosNsWindow,
    OverlayLinuxLayerShell,
    OverlayX11,
    DesktopDbusGnomeColor,
    DesktopDbusKdeNightLightPreview,
    MacosMediaAccessibility,   // spike only, §9 Q3
    None,
}

/// What a backend can express. This is the honest interface: a backend that
/// cannot invert says so, and the engine + UI adapt instead of silently no-opping.
#[derive(Clone, Copy, Debug)]
pub struct BackendTraits {
    pub per_monitor: bool,
    pub can_dim: bool,
    pub can_tint: bool,
    pub can_invert: bool,
    /// True when the effect happens after framebuffer composition, i.e. F1.7's
    /// "screenshots keep true colours" holds.
    pub screenshot_transparent: bool,
    /// Some(interval) when the backend's effect self-expires and must be
    /// re-asserted — KDE's `preview()` 15 s QTimer is the only known case.
    pub heartbeat: Option<Duration>,
}

pub trait TintBackend: Send {
    fn mechanism(&self) -> TintMechanism;
    fn traits(&self) -> BackendTraits;

    /// Capture whatever must be put back later. MUST be called before the first
    /// `apply`, and its result MUST be persisted (see §4.4).
    fn capture_baseline(&mut self, monitors: &[MonitorRef]) -> Result<Baseline, TintError>;

    /// Apply one target. Returns Err on real failure — callers MUST NOT discard it.
    fn apply(&mut self, target: &TintTarget) -> Result<(), TintError>;

    /// Put the captured baseline back. Idempotent; safe before `capture_baseline`.
    fn restore(&mut self, baseline: &Baseline) -> Result<(), TintError>;
}

pub struct TintTarget {
    pub monitor: MonitorKey,     // opaque; plan 02 owns its content
    pub kelvin: f64,
    pub brightness: f64,         // 0.0..=1.0
    pub invert: bool,
}
```

**Backend selection** happens once at `init`, from `crate::platform::capabilities()` (plan 00), in
this priority order — highest fidelity first, with the user able to override:

| Environment | Order |
|---|---|
| Windows | `GammaWindowsGdi` |
| macOS | `OverlayMacosNsWindow` → *(user opt-in)* `GammaMacosCoreGraphics` |
| Linux X11 | `GammaX11Randr` → `OverlayX11` |
| Linux wlroots | `GammaWlrControl` → `OverlayLinuxLayerShell` |
| Linux KDE Wayland | `OverlayLinuxLayerShell` → `DesktopDbusKdeNightLightPreview` |
| Linux GNOME Wayland | `DesktopDbusGnomeColor` *(temperature only)* |

Backends are **not** silently composed. Exactly one is active, its `TintMechanism` is reported, and
the UI names it. Composing gamma + overlay (macOS: true temperature shift *plus* dimming) is
attractive and is explicitly **deferred** — it doubles the state-restore surface and makes
"why is my screen this colour" unanswerable. Revisit after the single-backend path ships.

### 4.3 Data-model consequences of the weakest platform

Per TEMPLATE §4, these are forced by the worst backend and must be right in Rust **and** in the
generated `src/bindings.ts` from day one:

1. **`DisplayOutput` gains the mechanism and its traits.** `engine.rs:51-58` becomes:
   ```rust
   pub struct DisplayOutput {
       pub kelvin: u32,
       pub brightness: u32,
       pub mode: String,
       pub phase: String,
       pub mechanism: TintMechanism,      // NEW
       pub screenshot_transparent: bool,  // NEW — F1.7 holds or it doesn't
       pub per_monitor: bool,             // NEW — false on GNOME Wayland, KDE preview
   }
   ```
   Additive, so existing `LiveReadout.tsx` keeps compiling; the UI opts in.
2. **Brightness can only ever go DOWN.** Gamma scales the LUT by ≤1.0; an overlay only darkens.
   Nothing in this matrix can exceed the panel's native output. The existing 0–100 % range
   (`BRIGHTNESS_RANGE` in `src/features/display/model/display-values.ts`) is therefore correct and
   must not grow a >100 % mode. Hardware backlight (a *separate* capability, not this plan) is the
   only real "brighter".
3. **Invert (F1.5 Editing mode) is not universally expressible.** An overlay is an alpha composite;
   `out = 1 − in` is not reachable. So `can_invert` is false for every overlay backend, including
   the macOS primary. ⚠️ Interesting corollary from `macos.md` §B: because inversion *is*
   per-channel, a descending LUT gives **per-display Classic Invert using PUBLIC APIs** on macOS —
   better than the system's global invert — but only on hardware where gamma works at all, and
   `macos.md` §4 records that Lunar rejected gamma-invert for quantisation reasons. Editing mode on
   macOS is therefore `Unverified` at best.
4. **Grayscale (F1.6 Reading mode) can NEVER ride the gamma engine, on any platform.**
   `macos.md` §4 and `linux.md` §4 agree, and §B gives the clean proof: if per-channel LUTs achieved
   grayscale then `LUT_R(r) = LUT_G(g) = LUT_B(b)` for all inputs; holding `g,b` fixed and varying
   `r` forces `LUT_R` constant, and by symmetry all three — a flat uniform colour, not grayscale. ∎
   Grayscale needs a 3×3 matrix. **This is arithmetic, not policy.** It is why
   `display/grayscale.rs` uses the Magnification API's 5×5 matrix and not the gamma path, and it is
   why grayscale is a separate capability with its own per-platform verdict (not this plan).
5. **`MonitorKey` is opaque here.** Plan 02 owns its content and its confidence level. This plan
   must not assume it is unique — on generic Wayland two identical panels can collide
   (`linux.md` §3: EDID is not exposed to Wayland clients). When plan 02 reports an ambiguous key,
   this engine falls back to `sync_monitors` behaviour and the UI explains why.

### 4.4 State restore — the part that is currently broken

Three layers, in order of importance:

**(a) Persist the baseline, not just hold it in memory.** Fixes bug #2 from §2. Before the first
`apply`, write the captured `Baseline` + a `tint_active: true` marker through the existing durable
path (`settings/store.rs::atomic_write_json` — temp file + fsync + rename, already correct) to a
**separate file** `dimread-display-baseline.json`, *not* into `AppSettings` (it is machine-local
device state, not user preference, and must never sync or travel with a portable install's
settings). On `restore_all`, clear the marker.

At `init`: if the marker is set, we crashed while tinted ⇒ **restore the persisted baseline first,
then re-snapshot.** Never snapshot a live ramp while the marker is set.

**(b) Per-platform crash behaviour, stated honestly:**

| Backend | After a crash |
|---|---|
| Windows GDI | Ramp **persists**. Needs (a). |
| X11 RandR | Ramp **persists** until mode change / VT switch / X restart. Needs (a). |
| wlroots | **Auto-reverts** — destroying `zwlr_gamma_control_v1` restores original ramps (`linux.md` §1). Free correctness. |
| KDE `preview()` | **Auto-reverts in ≤15 s.** Free correctness, accidentally. |
| GNOME `Temperature` | Transient; gsd's scheduler recomputes. Effectively auto-reverts. |
| macOS gamma | **Persists.** `macos.md` §0: "A crashed process leaves the display tinted unless `CGDisplayRestoreColorSyncSettings()` ran" — f.lux's documented manual fix is "change the colour profile and change it back". Call `CGDisplayRestoreColorSyncSettings()` at launch when the marker is set. ⚠️ Worse case: with XDR + auto-brightness in EDR mode the LUT "can leave the display corrupted **after the process exits**". |
| macOS overlay | Window dies with the process. Free correctness — a further argument for the overlay primary. |

**(c) Keep the `TRANSITION_GEN` guard.** `engine.rs:354-390` already re-checks the generation
*immediately before each write* (`:379-381`) precisely so a stale animation frame cannot re-tint
after `restore_ramps` ran. That comment is correct and the behaviour must survive the refactor into
`TintBackend`.

### 4.5 Re-apply on display reconfiguration

Fixes bug #3. Per platform, all funnelling into one debounced `engine::reapply_after_reconfigure()`:

- **Windows**: `WM_DISPLAYCHANGE` on the main window's message loop.
- **macOS**: `CGDisplayRegisterReconfigurationCallback` (`macos.md` §0 lists the reset triggers:
  sleep/wake, hot-plug, resolution change, colour-profile change, fast user switching), plus
  `NSApplication.didChangeScreenParametersNotification`. ⚠️ `macos.md` §A: that notification is
  **coalesced and often late, arriving in bursts with transient intermediate states during
  hot-plug** → **debounce ~500 ms and re-enumerate from scratch rather than diffing.**
- **X11**: RandR `ScreenChangeNotify` (`linux.md` §1 — ramps are reset by mode change, output
  enable/disable, VT switch, X server restart, hotplug).
- **Wayland**: `wl_registry` global add/remove for `wl_output`.

**The Apple rule, adopted globally: never re-apply from inside the reconfiguration callback.**
Apple forbids display-configuration calls re-entering the callback. The engine copies
MonitorControl's guard pattern — two monotonic counters, `sleep_id` and `reconfigure_id`, captured
by value into a delayed task; the task compares the captured id against the current one and aborts
if a newer event superseded it. **Delays: 1 s after a reconfiguration, 3 s after a wake.** ⚠️ The
1 s / 3 s constants come from MonitorControl's implementation as given in the task brief;
`docs/platform-research/macos.md` documents the callback and the reset triggers but **not** these
delay values — **treat the exact numbers as UNVERIFIED and confirm against MonitorControl's source
during implementation.** The *pattern* (captured-id guard, deferred re-apply, abort-if-superseded)
is what matters and is what must be reviewed; the constants are tunable.

This is structurally identical to the existing `TRANSITION_GEN` guard, so it is a familiar shape in
this codebase rather than a new concept.

### 4.6 Settings + IPC surface

- **Settings schema.** One new field in `DisplaySettings` (`settings/mod.rs:171-191`) and its Zod
  mirror (`src/shared/config/settings-schema/index.ts:159-184`):
  ```rust
  /// User's chosen mechanism when more than one is viable. `"auto"` = engine picks.
  /// The macOS honesty valve (plan 00 §7) writes `"overlay"` here when the user
  /// reports gamma did nothing.
  pub tint_mechanism: String,   // "auto" | "gamma" | "overlay" | "desktop"
  ```
  Plus, Linux only, a `prefer_x11_backend: bool` surfacing `GDK_BACKEND=x11` as a user-facing
  setting rather than hiding it (`linux.md` §"Recommended architecture" calls this "a legitimate
  product decision"). It requires a restart; the UI must say so.
  Both are additive with `#[serde(default)]` / Zod `.catch().default()`, so **no settings migration
  is needed for this plan.** (Plan 02 does need one.)
- **IPC.** No new commands. `display_list_monitors` / `display_current` / `display_preview` /
  `display_preview_end` (`engine.rs:400-429`) keep their names and signatures.
  `DisplayOutput` gains three fields (§4.3). Regenerate with
  `cd src-tauri && cargo test export_bindings`.
- **Capability reporting.** The engine feeds plan 00's `FeatureId::ColourTemperature`,
  `Brightness`, `PerMonitorTint`, `ScreenshotPassthrough` and `Invert` from the active backend's
  `BackendTraits` — one source of truth, no duplicated per-platform tables.

## 5. Implementation steps

Each step leaves the repo green on Windows (the only platform with CI hardware today).

1. **`GammaRamp` → size-agnostic struct.** Pure refactor inside `display/gamma.rs` + the Win32 call
   sites. Extend the existing tests. *No behaviour change on Windows.*
2. **Introduce `TintBackend` + `BackendTraits` + `TintMechanism`;** wrap the existing Windows GDI
   code as `platform/windows/gamma.rs::WindowsGdiBackend`. Rewire `engine.rs` to call the trait.
   **Propagate `Result` — stop discarding apply failures (bug #1).**
3. **Baseline persistence + restore-on-launch (bug #2).** New
   `display/baseline.rs`, reusing `settings/store.rs`'s atomic-write helper. Add
   `CGDisplayRestoreColorSyncSettings()` to the macOS arm when it exists.
4. **Reconfiguration watch + captured-id guard (bug #3).** Windows `WM_DISPLAYCHANGE` first, since
   it is testable on the dev machine.
   *Steps 1–4 are pure Windows-side hardening and are worth doing regardless of the port.*
5. **macOS overlay backend** — per-`NSScreen` `NSPanel`, from the MonitorControl recipe
   (`macos.md` §D): level `CGShieldingWindowLevel()`, `collectionBehavior = [.stationary,
   .canJoinAllSpaces, .ignoresCycle]`, `ignoresMouseEvents = true`, `backgroundColor = .clear`,
   `orderFrontRegardless()`. ⚠️ Apple cautions against relying on `CGShieldingWindowLevel()` for
   positioning — cross-check against the `>= 101` level guidance in `macos.md` §7 (level ≥101 is
   what covers **both** menu bar and Dock; `.floating` = 3, which Tauri's `always_on_top` maps to,
   does **not**) and verify menu-bar + fullscreen coverage empirically. Build as a **raw `NSWindow`
   via `objc2`, not a Tauri transparent window** — `macos.md` §7: `transparent: true` requires
   `"macOSPrivateApi": true`, and the raw-`NSWindow` route is what keeps a Mac App Store SKU
   possible (MonitorControl *Lite* ships on MAS doing exactly this). *Needs a spike: §9 Q2.*
6. **macOS gamma backend** (`objc2-core-graphics`, `CGSetDisplayTransferByTable` with `f32` tables
   sized by `CGDisplayGammaTableCapacity`) as the **opt-in enhancement** behind `tint_mechanism`,
   reported `Unverified`, auto-disabled on HDR displays (`macos.md` §0: gamma and HDR are mutually
   exclusive).
7. **Linux X11 RandR backend** (`x11rb::protocol::randr`) — per-CRTC `RRGetCrtcGammaSize` +
   `RRSetCrtcGamma`, reference impl redshift `src/gamma-randr.c`. Reset on `--gamma 1:1:1` before
   applying so adjustments cannot stack (jonls/redshift#659).
8. **Linux wlroots backend** (`wayland-protocols-wlr`) — `zwlr_gamma_control_v1`, exclusive-access
   failure handled as a first-class `TintError::Exclusive` with a named-competitor message.
   *Blocked on plan 00's spike Q1 (is a registry bind-probe side-effect-free?).*
9. **Linux layer-shell overlay backend** — the `tao` `WindowExtUnix::new_from_gtk_window` route
   (PR #938), `gtk_layer_init_for_window` before mapping, **one window per `wl_output`**
   (`linux.md` §7). ⚠️ The Rust GTK3 wrapper is **unmaintained (RUSTSEC-2024-0423, repo archived)**
   while the C library is maintained (v0.10.1, 2026-04) — plan on **vendoring ~500 lines** of gir
   shim. *Needs a spike: §9 Q4.*
10. **Linux desktop-D-Bus backends** (`zbus`): GNOME `org.gnome.SettingsDaemon.Color.Temperature`;
    KDE `org.kde.KWin.NightLight` `preview()` + `inhibit()`/`uninhibit()`. **Introspect at runtime,
    do not hardcode signatures** — `linux.md` §1 records a real-world `d` vs `u` type-mismatch
    report. The KDE heartbeat is a `tokio` interval task at ~10 s (comfortably under 15 s) that
    stops the instant the mechanism changes.
11. **Wire capabilities → UI** (plan 00's `CapabilityGate`) and add the mechanism copy to
    `LiveReadout.tsx` / Options→Display.

## 6. Permissions, packaging, distribution

- **Windows**: nothing. GDI gamma needs no elevation.
- **macOS**: `CGSetDisplayTransferByTable` needs **no entitlement, no TCC prompt, is sandbox-safe
  and not deprecated** (`macos.md` §1). The overlay needs nothing either — **as long as it is a raw
  `NSWindow`**. Building it as a Tauri transparent window requires `"macOSPrivateApi": true`, which
  is **App Store rejection** (tauri-docs#463). Cargo already enables `tauri`'s
  `macos-private-api` feature (`src-tauri/Cargo.toml`) — ⚠️ tauri#11142 warns the Cargo feature and
  the JSON flag must be set consistently; audit this before shipping a macOS build, because leaving
  it on forecloses MAS for no benefit if we take the raw-`NSWindow` route. **The MediaAccessibility
  path (§3) is private → MAS reject (2.5.1)** if pursued.
  Watch tauri#13415 (transparency lost after DMG build).
- **Linux X11 / wlroots gamma**: no permission, no udev rule, no polkit. Works in Flatpak (it is
  display-server protocol traffic, not device access). ✅ The cleanest story in the matrix.
- **Linux D-Bus backends**: reachable from a Flatpak sandbox only with the corresponding
  `--talk-name` in the manifest (`org.gnome.SettingsDaemon.Color`, `org.kde.KWin`). Must be listed
  when the Flatpak manifest is written.
- **Nothing in this plan forecloses a distribution channel**, provided the macOS overlay is a raw
  `NSWindow` and the private-API tiers stay behind a build feature.
- **Hardware backlight (logind / DDC-CI) is deliberately NOT in this plan.** `linux.md` §2 makes it
  a udev-rule / polkit conversation and "a hard blocker for pure Flatpak"; `macos.md` §2 makes it an
  all-private-API conversation with a hand-port of `Arm64DDC.swift`. It is a separate capability
  with a separate plan, and folding it in here would let a packaging blocker contaminate the core
  feature.

## 7. Failure modes & degradation

**Every backend reports its own unavailability through plan 00's capability struct; no path may
silently no-op.** Concretely, what the user sees:

| Situation | User sees |
|---|---|
| GNOME Wayland | Temperature slider works. **Brightness slider is disabled** with `reasonWaylandNoGammaProtocol` + a pointer to the `prefer_x11_backend` setting. Monitor strip disabled with `reasonDesktopTintIsGlobalOnly`. |
| KDE Wayland on the D-Bus fallback | Works, with a persistent caption: the tint is re-asserted every ~10 s and a stall may show a brief snap-back; per-monitor unavailable. |
| wlroots, another gamma client running | Explicit error naming exclusivity, not a dead slider. Offer to retry. |
| macOS, gamma selected, M5 hardware | Slider moves, **screen does not change, and we cannot detect it.** This is why gamma is opt-in and `Unverified`, and why the honesty valve ("the screen didn't change" → switch to overlay) exists in plan 00 §7. |
| macOS overlay | Works. Persistent caption: screenshots and screen recordings **will** show the tint (pending §9 Q2 verification) — the one place we knowingly lose F1.7. |
| Any backend, apply fails at runtime | `TintError` → engine downgrades that feature to `Partial`, emits `platform:capabilities`, UI updates live. |
| Crash while tinted | Next launch restores the persisted baseline (§4.4a) before doing anything else. On macOS also `CGDisplayRestoreColorSyncSettings()`. |
| Another app fights us (f.lux, Night Light, redshift) | Unavoidable — single global slot on every gamma platform (`linux.md` §1, `macos.md` §0 "last-writer-wins"). Detect what we can (KDE: `inhibit()`; GNOME: read `NightLightActive`) and warn; do not attempt arbitration. |

## 8. Testing

**Unit-testable in CI, on any host** — this is where most of the confidence comes from:

- `kelvin_to_rgb` and `GammaRamp::compose` at multiple sizes (256 / 1024 / 4096): monotonicity per
  channel, endpoints, warm suppresses blue, brightness scales down, invert reverses endpoints
  (ports the existing `gamma.rs:167-195` cases).
- `GammaRamp::resample` round-trip error bounds; `to_win32_256` rejects non-256; `to_wlr_bytes`
  produces exactly `3 * size * 2` bytes in R,G,B order (assert against the protocol XML layout in
  `linux.md` §1); `to_f32_tables` clamps to 0.0..=1.0.
- Backend **selection** as a pure decision table: `(capabilities, tint_mechanism setting) ->
  TintMechanism`. Every row of §3's verdict table becomes a test case. Highest-value table in the
  plan.
- `BackendTraits` → capability projection (`can_invert=false` ⇒ `Invert` blocked, etc.).
- The reconfigure guard as pure logic: captured-id vs current-id abort semantics, driven by a fake
  clock. No display hardware needed.
- Day/night interpolation (`engine.rs:130-138`) unchanged, already covered.

**Manual only, on real hardware:**

- **macOS overlay in screenshots** — settles §3's UNRESOLVED item and F1.7 on macOS. Do this first;
  it is cheap and it changes the product story.
- macOS gamma on an M5-class machine vs an M3 (`macos.md` §0 names M5 Pro / M5 Max / MacBook Neo as
  affected, M5 non-Max and M3 Max as unaffected). Expect the affected machine to look identical in
  logs and different on screen — that is the whole point.
- macOS overlay covering menu bar, Dock, notch region, and a fullscreen app's Space.
- X11 with a CRTC whose gamma size is **not** 256 (some AMD/Intel report 1024 or 4096) — the single
  most likely place the size-agnostic refactor breaks in the field.
- KDE heartbeat: verify no visible flicker at ~10 s, and verify the 15 s snap-back on a killed
  heartbeat (confirm the failure mode is what we documented).
- Crash-restore: `kill -9` while tinted, on Windows, X11 and macOS-gamma; verify next launch is
  clean. Verify wlroots auto-reverts with no help from us.
- Hot-plug and sleep/wake re-apply on every platform.

**Cannot be tested in CI at all:** every non-Windows row. GitHub Actions has no Wayland session, no
Mac with a second display, and no way to observe "did the screen actually change". Budget a physical
matrix: one Windows box, one Apple-silicon Mac (ideally an affected M5 *and* an unaffected model),
one KDE Wayland, one GNOME Wayland, one sway, one X11 session.

## 9. Open questions / spikes needed

1. **Does `GDK_BACKEND=x11` give working gamma on GNOME Wayland, or only a working overlay?**
   `linux.md` §0 and §7 contradict each other (§3 above). This single answer decides whether GNOME
   Wayland users get a real product or a temperature-only one. **Cheap to test. Do it first.**
2. **Does the macOS overlay appear in screenshots and screen recordings?** `macos.md` §7 flags this
   UNRESOLVED across two passes and instructs "VERIFY EMPIRICALLY on a real Mac before promising
   either behaviour". Decides F1.7 on macOS. **Blocks step 5's user-facing copy, not its code.**
3. **Is the MediaAccessibility matrix path viable?** (`macos.md` §B) It is immune to the Tahoe/M5
   LUT bug *by construction*, which would be a major win — but it is private, **system-wide with no
   per-display scoping** (so it can never serve F2.3), its intensity setters are "reported
   inconsistent", and it is **untested on macOS 26**. Timebox a spike: does
   `MADisplayFilterPrefSetWarmthIntensity` + `_UniversalAccessDStart(0x8)` visibly warm the screen
   on macOS 26, and is the effect reversible? If yes, it becomes a third macOS strategy for the
   single-display case. If no, delete the option and stop thinking about it.
4. **gtk-layer-shell Rust binding.** `linux.md` §"Four things to resolve" resolves this "in
   principle" (vendor ~500 lines over the maintained C v0.10.1, use `tao`'s `new_from_gtk_window`)
   but explicitly says it "needs a spike". Blocks step 9.
5. **Is `zwlr_gamma_control_manager_v1` bind-exclusive, or only `get_gamma_control`?** Inherited
   from plan 00 §9 Q1. If binding the manager claims exclusivity, our *capability probe* would lock
   out `gammastep`/`wlsunset` at startup — a serious bug in a passive utility. Blocks step 8.
6. **MonitorControl's actual sleep/reconfigure delay constants.** §4.5 uses 1 s / 3 s from the task
   brief; the research file does not carry them. Confirm against source, or derive empirically.
7. **KDE: is the `kwinrc` `[NightColor] NightTemperature` + reconfigure route a better fallback than
   the `preview()` heartbeat?** `linux.md` §1 marks the **exact reconfigure D-Bus call as
   UNVERIFIED**. If it exists, it removes the heartbeat hack entirely. Worth 30 minutes.

## 10. Effort

| Platform | Size | |
|---|---|---|
| Size-agnostic `GammaRamp` + `TintBackend` refactor + Windows rewire (steps 1–2) | **M** | pure refactor, well-covered by tests |
| Windows hardening: baseline persistence, reconfigure watch, error propagation (steps 3–4) | **M** | fixes three live bugs; worth doing even if the port were cancelled |
| macOS overlay (step 5) | **L** | raw `NSWindow` via `objc2`, per-screen lifecycle, Spaces/fullscreen/notch edge cases |
| macOS gamma (step 6) | **S** | small, but permanently `Unverified` |
| Linux X11 RandR (step 7) | **M** | well-trodden; redshift is a working reference |
| Linux wlroots (step 8) | **M** | protocol is small and read directly; exclusivity handling is the work |
| Linux layer-shell overlay (step 9) | **L** | vendored binding + `new_from_gtk_window` + per-output windows |
| Linux D-Bus backends (step 10) | **M** | two desktops, runtime introspection, one heartbeat hack |

**Biggest risk: macOS is not one platform, it is a coin-flip.** `macos.md` §0 documents that on
M5-class hardware the gamma API returns success, reads back correct values, and does nothing — and
that **no programmatic probe can detect this**. The whole macOS architecture (overlay primary, gamma
demoted to an opt-in enhancement, a user-facing "did that work?" valve) exists to route around one
unfixed Apple bug. If Apple ships a fix, we have built an overlay we did not strictly need; if they
do not, and we had built gamma-first, the app would be silently broken for a growing share of new
Macs. **The overlay-primary decision is the correct bet under uncertainty, and it costs us
CareUEyes' headline F1.7 "no yellow screenshots" property on macOS — probably permanently. That
trade should be made consciously, at the product level, before step 5 starts.**
