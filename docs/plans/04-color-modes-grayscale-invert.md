# Plan 04 — Colour modes: Reading (grayscale) and Editing (invert)
Status: DRAFT
Depends on: 00 (capability layer), 02 (monitor identity)
Parity ref: FEATURE-PARITY.md F1.5 (Editing / invert), F1.6 (Reading / grayscale), F10.4 (hotkeys)

---

## 1. What this feature is

Two of the eight preset modes change the *colour transform* of the whole screen rather than its
temperature. **Reading mode** renders everything in grayscale, like e-ink
(`research/careueyes/images/docs_display_how-to-adjust-colortemperature-and-brightness_01_preset-modes.jpg`).
**Editing mode** inverts colours — black background, white text — for low-light editing
(FEATURE-PARITY F1.5, "docs, changelog 1.1.0.5"). Both are toggleable by hotkey (F10.4) and both
compose with the temperature/brightness the active mode already applies.

## 2. Current state

**Grayscale (Reading) — implemented, Windows-only, and architecturally correct.**
`src-tauri/src/display/grayscale.rs`: `pub fn set_enabled(enabled: bool)`. On Windows it calls
`MagInitialize()` once and `MagSetFullscreenColorEffect(&MAGCOLOREFFECT)` with a **5×5 colour
matrix** carrying Rec. 601 luminance weights (`0.299 / 0.587 / 0.114` broadcast across R/G/B), and
the identity matrix to clear. `#[cfg(not(windows))] pub fn set_enabled(_enabled: bool) {}` — a silent
no-op today, which is exactly the failure mode §7 has to kill.

**Invert (Editing) — implemented via the gamma LUT, and this is the weak part.**
`src-tauri/src/display/engine.rs` sets `let invert = mode == "editing";` then carries it as
`Target { …, invert }` into `gamma::compose(kelvin, brightness, invert) -> GammaRamp`, where
`GammaRamp = [[u16; 256]; 3]` (`src-tauri/src/display/gamma.rs`). So Editing mode is a descending
per-channel LUT written with `SetDeviceGammaRamp`.

The engine already sequences both correctly: `refresh()` computes `let grayscale_on = mode ==
"reading";`, calls `grayscale::set_enabled(grayscale_on)`, and `restore_all()` clears grayscale on
exit and on `pause`. **The orchestration is portable; only the two mechanisms are not.**

Frontend: mode selection lives in `src/features/display/` (`display-values.ts`, `persist-display.ts`,
`use-display-state.ts`); hotkeys `toggle_reading` / `toggle_editing` are already in
`HotkeysSettings` (`src-tauri/src/settings/mod.rs`) and wired through `src-tauri/src/hotkeys/actions.rs`.

## 3. Per-platform verdict table

### 3.0 First — the central fact: grayscale can never ride on the tint engine

Both research passes reached this independently.

`docs/platform-research/macos.md` §4: "**Gamma cannot do grayscale — proof.**
`CGSetDisplayTransferByTable` takes three independent 1-D LUTs: `out_R = f_R(in_R)` etc. Each output
channel depends only on its own input. Grayscale needs `out = 0.2126R + 0.7152G + 0.0722B` — a
cross-channel matrix multiply. A per-channel 1-D LUT cannot express it for any choice of tables.
**Impossible, not merely hard.**"

`docs/platform-research/linux.md` §4 [VERIFIED]: "A LUT is three independent 1-D per-channel curves;
grayscale requires channel *mixing* … a 3×3 matrix. This is arithmetic, not policy. Impossible via
`RRSetCrtcGamma`, `wlr-gamma-control`, or any LUT. → **Reading mode cannot ride on the gamma engine
on any platform.**"

The clean proof, from `macos.md` §B:

> Suppose per-channel LUTs achieved grayscale. Then for every input `(r,g,b)` the output is neutral:
> `LUT_R(r) = LUT_G(g) = LUT_B(b)`. Hold `g,b` fixed and vary `r`: the RHS is constant, so `LUT_R`
> is constant. By symmetry all three are constant → a flat uniform colour, not grayscale. ∎

Corroboration that Apple agrees: the OS implements grayscale with an actual colour matrix one layer
lower — `MADisplayFilterCreateGrayscale`, `MADisplayFilterSetMatrix` (`macos.md` §B).

**Consequence for the architecture: plan 01 (tint engine) can never carry Reading mode on any
platform.** Grayscale needs a separate mechanism per platform, always, and that mechanism is
whatever the OS exposes one layer below the LUT. Every "just add it to the ramp" instinct is wrong.
What a per-channel LUT *can* do is the whole envelope of plan 01 and nothing more: "brightness
scaling, per-channel gain (= colour temperature, f.lux's mechanism), contrast/black-point,
per-channel gamma curves" (`macos.md` §4).

Inversion is different: `out = 1 − in` **is** per-channel, so it *is* expressible as a descending
LUT (`macos.md` §B). Whether we should use that is §3.3.

### 3.1 Grayscale (Reading, F1.6)

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | Magnification API `MagSetFullscreenColorEffect` with a 5×5 matrix | Already shipping (`display/grayscale.rs`). Process-set, system-wide, applied at composition time, cleared by writing the identity matrix. Best-in-class of any platform here: it is a real matrix, it is public, and it is per-process so it dies with us. |
| macOS (Intel) | **PARTIAL** | `MADisplayFilterPrefSetType(0x1, 0x1)` + `MADisplayFilterPrefSetCategoryEnabled(0x1, true)` + `_UniversalAccessDStart(0x8)` | MediaAccessibility is a **PUBLIC framework with private symbols**, so no PrivateFrameworks link flag (`macos.md` §B). PARTIAL because: private symbols → no MAS; **system-wide with no per-display scoping**; and it is global accessibility state that outlives our process (§7). `CGDisplayForceToGray` (`macos.md` §4) also works on Intel and is the older route. |
| macOS (Apple Silicon) | **PARTIAL** | MediaAccessibility, as above — **this is the route that works here** | `macos.md` §B: the MA path "**works on Apple Silicon**, where `CGDisplayForceToGray` is unreliable". `macos.md` §4 independently: `CGDisplayForceToGray` is "degraded on Apple silicon" per displayutil's own source comment. ⚠️ **UNVERIFIED on macOS 26** — `macos.md` §B: "no breakage reports through 2025, but untested on macOS 26." Carry that tag. |
| Linux X11 | **UNVERIFIED** | DRM/KMS `CTM` property | `linux.md` §4: "The matrix primitive exists in DRM/KMS (`DEGAMMA_LUT → CTM → GAMMA_LUT`; amdgpu + i915 expose `CTM`). **X11 exposure of CTM via xrandr output properties is contested/UNVERIFIED** — assume not portable, no NVIDIA proprietary support." Do not design around it before a spike. |
| Linux Wayland — KDE | **UNVERIFIED** | KWin effects via `org.kde.KWin.Effects` `loadEffect`/`toggleEffect` | `linux.md` §4 lists this under "**UNVERIFIED (needs follow-up)**" — the effect IDs themselves are unconfirmed. Plausible but unproven. |
| Linux Wayland — GNOME | **UNVERIFIED** | `org.gnome.desktop.a11y.magnifier` (`color-saturation`, `invert-lightness`) | `linux.md` §4, also tagged **UNVERIFIED**. Note this would be routing through GNOME's *magnifier*, which has its own visible side effects — even if the keys work, the UX may be unacceptable. |
| Linux Wayland — wlroots | **PARTIAL (Hyprland only)** | `hyprland-ctm-control-v1`, or `decoration:screen_shader` GLSL | `linux.md` §4: "Hyprland has a real path". Sway, river, Wayfire, labwc: **BLOCKED** — no CTM protocol, no shader hook. |

**Cross-desktop bottom line, quoted from `linux.md` §4: "no cross-desktop standard. Implement
per-desktop or not at all."**

### 3.2 Invert (Editing, F1.5)

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | Magnification 5×5 matrix (recommended) — today: descending gamma LUT | We already own the Magnification seam for grayscale; an invert matrix is the same call with different constants and is strictly better than the LUT (see §3.3). |
| macOS (Intel) | **FULL** | Descending gamma LUT via `CGSetDisplayTransferByTable` | `macos.md` §B: "`out = 1 − in` **is** per-channel, so a descending LUT gives **per-display Classic Invert using PUBLIC APIs** — better than the system's, which is global." Public API, no TCC, sandbox-safe, MAS-compatible. |
| macOS (Apple Silicon) | **PARTIAL** | Descending gamma LUT — subject to the M5 bug | `macos.md` §0: `CGSetDisplayTransferByTable` is **silently ignored on M5 Pro / M5 Max / MacBook Neo** on macOS 26.3.1–26.5.1, and **the readback lies** (`CGGetDisplayTransferByTable` returns the values we wrote while nothing changes on screen). Radars FB22273730 / FB22273782 open with engineering. So invert-via-LUT is exactly as fragile as plan 01's tint on that hardware. Alternative: private `CGDisplaySetInvertedPolarity` (`macos.md` §4) — global, private, MAS-disqualifying. |
| Linux X11 | **FULL** | Descending ramp via RandR `RRSetCrtcGamma` | `linux.md` §1: RandR per-CRTC gamma is "solved" on X11. ⚠️ **Ramp size varies per CRTC (256/1024/4096)** — always query `RRGetCrtcGammaSize`. Our `GammaRamp = [[u16; 256]; 3]` must become size-agnostic (that work belongs to plan 01). |
| Linux Wayland — KDE | **BLOCKED** | — | `linux.md` §1: KWin **explicitly refused** `wlr-gamma-control` (bugs.kde.org 479701), and `org.kde.KWin.NightLight` has **no writable temperature and all-read-only properties** — it cannot express an inverted ramp at any temperature. No route. |
| Linux Wayland — GNOME | **BLOCKED** | — | `linux.md` §1: mutter implements no gamma protocol; the only handle is `org.gnome.SettingsDaemon.Color.Temperature` (`u`, validated to `[1000, 10000]`) — a temperature, not a transform. No route. |
| Linux Wayland — wlroots | **FULL** | `zwlr_gamma_control_v1.set_gamma(fd)` with a descending table | `linux.md` §1 [VERIFIED — read the XML]: fd holds `3 × gamma_size × uint16`, R/G/B concatenated; the protocol is **exclusive** (a second client gets `failed`); **destroying the object restores original ramps**, so a crash auto-reverts — a genuinely nice property for an invert mode. |

### 3.3 Should Editing mode use the LUT at all?

`macos.md` §4 records that **Lunar deliberately does not**: it "forces a white overlay instead"
because "gamma tables can't be inverted in a precise enough way" — LUT quantisation plus the panel's
own transfer curve make the result visibly wrong. `macos.md` §4 concludes bluntly: "Treat
gamma-invert as unusable."

`macos.md` §B pushes back with a real counter-argument: an LUT invert is **per-display and uses only
public APIs**, whereas every alternative (`CGDisplaySetInvertedPolarity`, macOS's own Classic Invert)
is global and/or private. For a multi-monitor eye-comfort app, per-display scoping is not a nicety.

**Both sides go in the plan; the decision is data, not taste.** Recommendation:

- **Windows: use the Magnification matrix, not the LUT.** We already pay for `MagInitialize`; a 5×5
  invert matrix has no quantisation problem, is per-composition rather than per-LUT-entry, and
  removes `invert` from `gamma::compose` entirely on the platform where quality is easiest to get
  right. This is a *change to existing behaviour* and needs a side-by-side screenshot comparison
  before it lands.
- **macOS / Linux: LUT invert, shipped behind a visible quality caveat**, because the alternatives
  are worse (global, private, or non-existent). Ship it, look at it on real panels, and be willing
  to demote it to "beta" in the UI if Lunar turns out to be right for our content too.
- **An overlay is not a substitute.** `macos.md` §C is now definitive: "`CALayer.backgroundFilters` /
  `compositingFilter`: Apple's own wording scopes these to **your own in-process layer tree** …
  An overlay **cannot** grayscale what is behind it." A white overlay can *approximate* an inverted
  look for dark content; it cannot actually invert. Lunar's choice is a cosmetic approximation, not
  a mechanism we can reuse for correctness.

### 3.4 A note on MediaAccessibility as a *tint* path

`macos.md` §B flags something outside this plan's scope but too important to bury:
`MADisplayFilterPrefSetReduceWhitePointIntensity`, `MADisplayFilterPrefSetWarmthIntensity`,
`MADisplayFilterCreateRedNightMode`, `MADisplayFilterSetMatrix`, `MADisplayFilterSetGain` are
**matrix-based**, so they "suffer neither the gamma-table limits nor the Tahoe/M5 silent-failure
bug. **Worth serious evaluation as a macOS tint path.**" Caveats: private, system-wide, intensity
setters "reported inconsistent in community reverse-engineering", untested on macOS 26.
**This belongs to plan 01 — flagged here because this plan is what puts the MA framework into the
build in the first place, so plan 01 gets it nearly for free.**

## 4. Design

### 4.1 Rename the seam

`display/grayscale.rs` is misnamed once invert moves off the LUT. Rename to
`src-tauri/src/display/color_filter.rs` with a filter enum rather than a boolean:

```rust
/// A whole-screen colour transform that is NOT expressible as a per-channel LUT
/// (grayscale), or that we choose not to express that way (invert).
/// Mutually exclusive by construction — CareUEyes' Reading and Editing are
/// separate modes, never both.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ColorFilter {
    #[default]
    None,
    /// Reading mode (F1.6) — luminance matrix.
    Grayscale,
    /// Editing mode (F1.5) — `out = 1 - in`.
    Invert,
}

/// Apply (or clear) the whole-screen filter. Idempotent. Returns whether the
/// request was actually honoured — the caller MUST surface a `false`.
pub fn set_filter(filter: ColorFilter) -> bool;

/// What this build/platform/session can actually do, for the capability layer
/// (plan 00) and the UI. Probed once, cached, invalidated on session change.
pub fn capability() -> ColorFilterCapability;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColorFilterCapability {
    pub grayscale: FilterSupport,
    pub invert: FilterSupport,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FilterSupport {
    /// Works, scoped to individual displays.
    PerDisplay,
    /// Works, but applies to every display at once (macOS MediaAccessibility).
    SystemWide,
    /// Works, but changes OS-global state that outlives our process (§7).
    SystemWidePersistent,
    /// Cannot be done here. `reason` is rendered verbatim in the UI.
    Unsupported { reason: String },
}
```

`SystemWide` vs `PerDisplay` is not decoration: `macos.md` §B states plainly that MA grayscale is
"system-wide (no per-display scoping)", which is a **real limitation for a multi-monitor app**. The
UI must grey out the per-monitor strip for Reading mode on macOS rather than pretend it applies.

### 4.2 Engine wiring

`engine::refresh()` in `src-tauri/src/display/engine.rs` currently does:

```rust
let invert = mode == "editing";
let grayscale_on = mode == "reading";
…
grayscale::set_enabled(grayscale_on);
```

Becomes a single resolution to a `ColorFilter`, plus a *conditional* pass-through of `invert` to
`gamma::compose` only on the platforms where the LUT is the chosen invert mechanism (§3.3). On
Windows, `Target::invert` goes away and `gamma::compose`'s third parameter becomes dead there —
keep the parameter (other platforms use it) but always pass `false` from the Windows arm.

`restore_all()` already calls `grayscale::set_enabled(false)`; it becomes `set_filter(ColorFilter::None)`.

### 4.3 Platform backends

```
src-tauri/src/display/color_filter/
  mod.rs        // enum, capability, dispatch, the restore ledger (§7)
  windows.rs    // MagSetFullscreenColorEffect — grayscale + invert matrices
  macos.rs      // MediaAccessibility (grayscale) + LUT invert delegated to gamma
  linux.rs      // per-desktop dispatch; mostly Unsupported for now
```

The Windows invert matrix is the standard 5×5 negate-with-offset form (negative diagonal plus a
`+1.0` translation row) — the same `MAGCOLOREFFECT` struct already imported in
`display/grayscale.rs`.

macOS symbols to `dlsym` (all from `macos.md` §B):

```c
// /System/Library/Frameworks/MediaAccessibility.framework — PUBLIC framework, private symbols
void MADisplayFilterPrefSetCategoryEnabled(int filter, bool enable);
bool MADisplayFilterPrefGetCategoryEnabled(int filter);
void MADisplayFilterPrefSetType(int filter, int type);
// /usr/lib/libUniversalAccess.dylib
void _UniversalAccessDStart(int magic);   // magic = 0x8 — REQUIRED
// SYSTEM_FILTER = 0x1, GRAYSCALE_TYPE = 0x1
```

**Call MediaAccessibility directly; do NOT go through UniversalAccess.framework.** `macos.md` §B:
"`UniversalAccess.framework` turns out to be **just a wrapper**: it calls `CGDisplayForceToGray`,
then the MediaAccessibility functions, then syncs the legacy pref." Direct MA is the same mechanism
with one fewer private framework and no PrivateFrameworks link flag. `macos.md` §4's earlier
`UAGrayscaleSetEnabled` recommendation is **superseded** by §B.

**`_UniversalAccessDStart(0x8)` is mandatory, not optional.** Architecture, from `macos.md` §B: the
`MADisplayFilterPref*` setters write `com.apple.mediaaccessibility` and post the Darwin notification
`com.apple.mediaaccessibility.displayFilterSettingsChanged`; `/usr/sbin/universalaccessd` listens and
performs the toggle — and **the daemon is not always running**. Without the kick, the write
succeeds and nothing happens. This is precisely the silent-no-op class §7 exists to prevent, and it
is *inside* our own call sequence.

**`defaults write com.apple.universalaccess grayscale` does NOT work — do not try it, and do not
accept a PR that adds it.** `macos.md` §B: it is "a legacy key written *by* the daemon as output,
never read as input; the real state lives in `com.apple.mediaaccessibility`; and the daemon acts on
the Darwin notification, which `defaults` does not post. The recipes circulating online are
Mojave-era and stale." (`macos.md` §4 said the weaker version of this — "does not apply live" —
which is easy to misread as "needs a nudge". It does not; it is the wrong key entirely.)

### 4.4 Settings + IPC

No new settings section: Reading and Editing are existing mode ids in
`DisplaySettings.modes` (`default_modes()` in `src-tauri/src/settings/mod.rs` already seeds
`"editing"` and `"reading"` presets) and the hotkeys already exist (`toggle_reading`,
`toggle_editing`).

New IPC: one command `display_color_filter_capability() -> ColorFilterCapability`, registered in
`commands_registry.rs` under `// ── display ──`. Regenerate with `cd src-tauri && cargo test
export_bindings`; never hand-edit `src/bindings.ts`.

**Data-model consequence of the weakest platform:** `FilterSupport::Unsupported { reason }` must be
a *variant of the same type* the supported cases use, not a nullable side-channel — because on
Linux, `Unsupported` is the expected value on four of the five environments in the table, and every
consumer has to handle it on the main path. `reason` is a message key, resolved through use-intl
(AGENTS.md: all user-visible strings go through `messages/en.json`).

Frontend: `src/features/display/` gains a capability read; the mode grid renders Reading/Editing as
disabled-with-reason where unsupported. Run `bun run check:fsd` and `bun run check:i18n`.

## 5. Implementation steps

1. **Rename + enum.** `display/grayscale.rs` → `display/color_filter/mod.rs`, `set_enabled(bool)` →
   `set_filter(ColorFilter) -> bool`, move the Windows impl into `color_filter/windows.rs`
   unchanged. Update the two call sites in `engine.rs`. No behaviour change; repo stays green.
2. **Capability type + command.** `ColorFilterCapability` / `FilterSupport`, the probe,
   `display_color_filter_capability`, registry entry, regenerate bindings. Every non-Windows arm
   returns `Unsupported` with a real reason string — **this alone converts the current silent
   cross-platform no-op into an honest one**, and is worth landing on its own.
3. **Frontend honesty pass.** Mode grid disables Reading/Editing with the reason tooltip; i18n keys
   per `FilterSupport::Unsupported` reason; `check:fsd` + `check:i18n` green.
4. **Windows invert via Magnification.** Add the invert matrix; stop passing `invert` into
   `gamma::compose` on Windows. *Gate on a side-by-side visual comparison (§8) before flipping the
   default.*
5. **macOS grayscale via MediaAccessibility.** `dlopen` + per-symbol `dlsym` of the four symbols,
   the `_UniversalAccessDStart(0x8)` kick, capability = `SystemWidePersistent`. **Ship together
   with step 6 — never before it.**
6. **macOS restore safety net** (§7): persisted "we enabled a global filter" ledger, restore on
   next launch, restore on clean exit, restore from the crash handler
   (`src-tauri/src/crash.rs`). This is the gating step for macOS grayscale, not a follow-up.
7. **macOS invert via LUT.** Falls out of plan 01's `CGSetDisplayTransferByTable` work; this plan
   only routes `ColorFilter::Invert` to it and sets capability `PerDisplay`. Auto-report
   `Unsupported` where plan 00's probe says the M5 gamma bug is present (`macos.md` §0 —
   ⚠️ note the probe **cannot** be write-then-readback, because the readback lies).
8. **Linux invert.** X11 RandR descending ramp + wlroots `zwlr_gamma_control_v1` descending table;
   `Unsupported` on KDE and GNOME Wayland with the specific reason. Depends on plan 01 owning the
   size-agnostic ramp (`linux.md` §1: query `RRGetCrtcGammaSize`, never assume 256).
9. **Linux grayscale — spike only, no implementation.** Land the three spikes in §9 first. If all
   three fail, Reading mode is honestly `Unsupported` on Linux and we ship that.

## 6. Permissions, packaging, distribution

**macOS — grayscale forecloses the Mac App Store; invert does not.**
- MediaAccessibility's `MADisplayFilterPref*` and `_UniversalAccessDStart` are **private symbols**.
  `macos.md` §7's tier table puts "UniversalAccess" firmly in "❌ private → MAS reject (2.5.1)", and
  MA-via-private-symbols is the same category. MediaAccessibility being a *public framework* removes
  the PrivateFrameworks **link flag**, not the App Review problem.
- **Invert via `CGSetDisplayTransferByTable` is fully public**, needs no entitlement, triggers no TCC
  prompt, and is sandbox-safe (`macos.md` §1). It is MAS-shippable.
- Therefore: if a MAS SKU is ever wanted, it ships **Editing mode and not Reading mode**, and the MA
  code sits behind the same Cargo feature flag plan 03 uses.
- No TCC prompt for either path. No entitlement. Notarization unaffected.

**Windows.** Nothing. `MagInitialize` needs no manifest change, no elevation. It can fail in session
0 / some remote-desktop contexts — already handled by the existing `ensure_initialized` log-and-bail,
which becomes a `FilterSupport::Unsupported` instead of a swallowed warning.

**Linux.** Nothing for invert (RandR/wlr-gamma-control are ordinary client protocols). Grayscale, if
it ever ships, would route through desktop D-Bus services or GSettings — no packaging implication,
but note that on GNOME the `org.gnome.desktop.a11y.magnifier` route writes **the user's accessibility
settings**, which raises the same persistence problem as macOS on a platform where we have no crash
handler story. Another reason step 9 is spike-first.

## 7. Failure modes & degradation

**The headline risk, and the reason this plan is HIGH RISK on macOS.**
`macos.md` §4: "This is the *accessibility* subsystem — **system-wide global state that persists
after our app quits**. Crash mid-toggle and the user's Mac is stuck in grayscale with no obvious
cause. If shipped: crash handler + restore-on-launch, mandatory."

That is not a caveat; it is a **shipping precondition**. A user whose Mac is stuck in grayscale has
no way to connect it to us — the state lives in `com.apple.mediaaccessibility`, not in our app, and
the System Settings toggle that would fix it is in Accessibility → Display, three levels deep. The
required machinery:

1. **A persisted ledger, written BEFORE the enabling call and cleared AFTER the disabling call** —
   not settings, a tiny separate marker file, so a corrupt settings blob cannot lose it.
2. **Restore-on-launch.** On every start, if the ledger says we left a global filter on, clear it,
   unconditionally, before doing anything else. Cheap and idempotent.
3. **Crash handler.** `src-tauri/src/crash.rs` exists (FEATURE-PARITY F10.6 — crash dumps). Clearing
   the MA filter from a crash path means one `dlsym`'d call plus the daemon kick; keep the function
   pointers resolved and cached at startup so the crash path allocates nothing.
4. **Clean-exit restore** via the existing `app_exit` seam, alongside `engine::restore_all()`.
5. **Never toggle the filter while a modal is open / during shutdown** — the window between "wrote
   the pref" and "daemon acted" is where a crash is unrecoverable.

Other failure modes:

| Failure | What the user sees |
|---|---|
| Platform has no grayscale mechanism (Linux, most) | Reading mode is visibly **disabled** in the mode grid with a per-desktop reason ("Reading mode needs a compositor colour-matrix; your desktop doesn't expose one"), not silently inert. This is the single biggest behavioural change in this plan. |
| `MagInitialize` fails (session 0, remote) | `FilterSupport::Unsupported` at probe time, so the mode is disabled before the user picks it — rather than today's log-once-and-no-op after they pick it. |
| MA pref written but daemon never ran | Indistinguishable from success at the API level. Mitigate with `MADisplayFilterPrefGetCategoryEnabled` read-back *and* the mandatory `_UniversalAccessDStart(0x8)`. If read-back disagrees, report failure. |
| M5 gamma bug swallows the invert LUT | **Readback cannot detect it** (`macos.md` §0: "the readback lies"). Plan 00's probe must use whatever heuristic it lands on; until then, invert on Apple Silicon carries a user-visible "if you see no change, your Mac has a known display-driver bug" affordance. Ugly, honest. |
| wlroots gamma control taken by another client | `zwlr_gamma_control_v1` is **exclusive** — a second client gets `failed` (`linux.md` §1). Report "another app (redshift/gammastep) owns the display ramp". |
| Crash with a wlroots ramp applied | Auto-reverts — "destroying the object restores original ramps" (`linux.md` §1). The one platform where this is free. |
| Crash with an X11 ramp applied | Ramp persists until a mode change / VT switch / X restart (`linux.md` §1). Restore-on-launch covers it. |

## 8. Testing

**Unit-testable in CI, any platform:**
- The `ColorFilter` resolution from a mode id — a 3-case table over `"reading"` / `"editing"` /
  everything else, plus the `pause` and `fullscreen_suspend` short-circuits that already exist in
  `engine::refresh`.
- Mutual exclusion: `set_filter(Grayscale)` then `set_filter(Invert)` must leave exactly one active
  (fake backend recording the call sequence).
- The restore ledger state machine: write-before-enable, clear-after-disable, and the
  "found a stale ledger on launch → clear" path. This is pure logic and is the most important test
  in the plan, because it is the thing standing between a crash and a user's Mac stuck in grayscale.
- Matrix constants: assert the grayscale matrix rows sum to 1.0 per output channel and the invert
  matrix maps 0→1 and 1→0.
- A regression test asserting the **impossibility claim** operationally: given any three per-channel
  LUTs, `compose` cannot map two distinct chromaticities with equal luminance to the same output.
  Cheap, and it documents §3 in code so nobody re-litigates it.

**Manual only:**
- macOS grayscale on **both** an Intel Mac and an Apple Silicon Mac (`macos.md` §4/§B disagree about
  `CGDisplayForceToGray` between them, and MA is claimed to fix exactly that).
- macOS grayscale on the **macOS 26 baseline** — `macos.md` §B: untested there, UNVERIFIED.
- **Kill -9 with grayscale on**, then relaunch, on macOS. The restore-on-launch path is the one
  that must be verified by hand because it is the one that matters.
- Windows invert: side-by-side Magnification-matrix vs gamma-LUT screenshots on at least one
  wide-gamut and one cheap TN panel, to settle §4.3 for our content rather than Lunar's.
- Multi-monitor macOS: confirm MA grayscale hits **all** displays (expected) and that our UI
  correctly refuses to offer per-monitor Reading mode there.
- Every Linux desktop in the table, for the *messaging* — the deliverable on Linux is honest
  disablement, and that has to be seen on each desktop.

**Not testable in CI at all:** anything touching the Magnification API, MediaAccessibility, the
universalaccess daemon, or a real compositor. CI can only cover the pure logic above.

## 9. Open questions / spikes needed

1. **macOS 26 behaviour of the MA path.** `macos.md` §B: "no breakage reports through 2025, but
   **untested on macOS 26**." Blocking for step 5. This is our baseline OS (`macos.md` header:
   Tahoe 26.5.2), so an untested claim on the baseline is a real gap.
2. **`MADisplayFilterPrefGetCategoryEnabled` as a truthful read-back** — does it reflect what the
   daemon actually did, or only what was written? Decides whether we can detect the daemon-not-running
   case at all.
3. **Linux X11 CTM exposure via xrandr output properties** — `linux.md` §4 calls it
   "contested/UNVERIFIED". Blocking for any Linux grayscale.
4. **KWin effect IDs + `org.kde.KWin.Effects` `loadEffect`/`toggleEffect`** — `linux.md` §4
   UNVERIFIED. Blocking for KDE grayscale.
5. **GNOME `org.gnome.desktop.a11y.magnifier` (`color-saturation`, `invert-lightness`)** —
   `linux.md` §4 UNVERIFIED, and even if it works, does it drag the magnifier's own UI in with it?
6. **Does the M5 gamma bug affect a descending (invert) LUT the same way as a tint LUT?** Almost
   certainly yes — it is ignored at the display-pipeline level per `macos.md` §0 — but it is worth
   one line of confirmation before we ship invert as macOS's "public API" win.
7. **`CABackdropLayer` + `CAFilter` (`colorMonochrome`, `invertColors`)** — `macos.md` §C: "the one
   **untested** lead — but that vocabulary comes from *iOS/UIKit* reverse engineering. **Cheap to
   falsify; spike it before designing around it.**" If it worked it would give per-window filters,
   which would change plan 06 and the MagicX feature too. Expected outcome: falsified.
8. Product: on macOS, is a **system-wide** Reading mode acceptable at all for a multi-monitor user,
   or should we simply not offer it there? Cheaper than any of the above and may moot §9.1.

## 10. Effort

| Platform | Size | Note |
|---|---|---|
| Shared (enum, capability, engine rewiring, UI honesty) | **M** | Step 2 alone is S and delivers real value. |
| Windows | **S** | The mechanism already ships; invert-via-matrix is constants plus a visual check. |
| macOS — invert | **S** | Rides entirely on plan 01's gamma work. |
| macOS — grayscale | **L** | Four private symbols is the easy half. The restore ledger + crash-path + launch-recovery machinery is the real work, and it is not optional. |
| Linux — invert | **M** | X11 and wlroots only; blocked by design on the two biggest desktops. |
| Linux — grayscale | **XL or CUT** | Three UNVERIFIED leads, no cross-desktop standard. Most likely honest outcome: `Unsupported` everywhere except Hyprland. |

**Single biggest risk:** macOS grayscale leaves the user's Mac in grayscale after a crash. It is not
a bug we can fix afterwards — the user has already lost trust and has no way to attribute the state
to us. The mitigation (ledger + restore-on-launch + crash handler) must ship *in the same commit* as
the enabling call, and if we are not confident in it, the correct decision is to report Reading mode
`Unsupported` on macOS and ship the rest of the plan.
