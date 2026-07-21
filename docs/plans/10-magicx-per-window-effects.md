# Plan 10 — MagicX per-window effects
Status: **DRAFT — recommendation is KEEP WINDOWS-ONLY, DO NOT PORT** (see §10)
Depends on: 00 (capability layer), 06 (foreground identity)
Parity ref: FEATURE-PARITY.md F9.1, F9.2, F9.3, F9.4, F9.7

---

## 1. What this feature is

Apply a **Dark** (colour-invert) or **Gray** (grayscale) effect to **one other application's
window** — not the whole screen. Hovering the top-centre of any window pops a small floating toolbar
with Dark / Gray / Close buttons; Close restores the window (F9.1–F9.2). The toolbar's colour,
alignment (centre/left/right + offset) and hover delay are configurable (F9.3), and hotkeys toggle
each effect on the active window (F9.4). MagicX ships **disabled by default** (F9.7).

This is the single most platform-specific feature in CareUEyes. It requires reaching into another
process's window and changing how the compositor draws it. Windows permits that. **macOS forbids it
at the WindowServer level. Wayland forbids it by design.** Only X11 — the display server on its way
out — permits a partial version.

**This plan exists to be honest about that, and to make an explicit ship/cancel recommendation
rather than leaving a permanently-red feature row on the parity matrix.**

## 2. Current state

Fully implemented and working on Windows.

`src-tauri/src/magicx/engine.rs` (300 lines) owns the authoritative in-memory `HWND -> Effect` map:

```rust
pub enum Effect { Dark, Gray }
pub fn toggle_effect(hwnd: Hwnd, effect: Effect)   // mutually exclusive per window
pub fn clear(hwnd: Hwnd)
pub fn clear_all()
pub fn state_of(hwnd: Hwnd) -> (bool, bool)        // (dark, gray)
```

`Hwnd = isize` (`magicx/mod.rs` line 46) — deliberately a raw integer so the seam signatures stay
platform-neutral. `toggle_effect` decides *and* dispatches under one lock so racing toggles cannot
desync the map from the on-screen host (engine.rs lines 82–91).

`src-tauri/src/magicx/engine_win.rs` (506 lines) is the real backend: a dedicated thread hosting one
**Windowed Magnification API** overlay per target — a layered, click-through host window pinned over
the target's DWM frame bounds, with a `WC_MAGNIFIER` child at 1.0× carrying a 5×5 `MAGCOLOREFFECT`
colour matrix. It runs a message pump + refresh loop, tracks each target's rect and z-order, hides
while minimized, and auto-clears when the target dies.

The colour matrices are already platform-neutral pure data (engine.rs lines 140–157): `INVERT_MATRIX`
(diagonal −1 with +1 offsets) and `GRAYSCALE_MATRIX` (Rec. 601 weights broadcast across R/G/B).

Off-Windows the backend is an inert no-op (engine.rs lines 183–190) so the crate builds everywhere
and state bookkeeping stays deterministic:

```rust
#[cfg(not(all(windows, not(test))))]
mod backend {
    pub fn apply(_hwnd: Hwnd, _effect: Option<Effect>) {}
    pub fn clear_all() {}
}
```

`src-tauri/src/magicx/toolbar.rs` (543 lines): a ~150 ms hover tracker (`POLL_MS: u64 = 150`)
sampling `GetForegroundWindow` + `GetCursorPos`, with the alignment/offset/hover-zone maths already
extracted into a pure `geometry` module (lines 70–160) that is unit-tested on every platform.
`init` is inert off Windows (line 47).

`src-tauri/src/windows/mod.rs` carries the `magic-toolbar` window spec (132×36, transparent,
always-on-top, **`non_activating`** — clickable but never steals focus).

Settings: `MagicxSettings { enabled: false, toolbar_enabled: true, toolbar_color, toolbar_align,
toolbar_offset, toolbar_delay_ms: 400 }` (`settings/mod.rs` line 333).
Hotkeys: `magic_dark`, `magic_gray` (`settings/mod.rs` lines 95–97).
Renderer: `src/views/magic-toolbar/ui/MagicToolbarPage.tsx`; feature slice `src/features/magicx/`.

## 3. Per-platform verdict table

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | Windowed Magnification API host per target + `MAGCOLOREFFECT` matrix | Works today. Unchanged by this plan. |
| macOS (Intel) | **BLOCKED** | None. Every candidate eliminated — see §3.1 | Not "hard". **Architecturally impossible** without disabling SIP. Two independent lines of proof. |
| macOS (Apple Silicon) | **BLOCKED** | None | Strictly worse: the yabai escape additionally needs `-arm64e_preview_abi` and NVRAM Protection off. |
| Linux X11 | **PARTIAL** | `_NET_WM_WINDOW_OPACITY` (any client may set it on any window — no ACLs) gives **dim only**; picom `window-shader-fg-rule` GLSL gives real grayscale/invert **but only if the user runs picom** | Delivers *opacity*, not the Dark/Gray effects F9.1 actually specifies. See §3.2 for why that is a different feature wearing the same name. |
| Linux Wayland — KDE | **BLOCKED** | None client-side. Compositor escape hatch: KWin window rules (per-window opacity) — runtime third-party installation **UNVERIFIED** (linux.md §8) | |
| Linux Wayland — GNOME | **BLOCKED** | *"no mechanism at all"* (linux.md §8) | |
| Linux Wayland — wlroots | **BLOCKED** | None client-side. Hyprland: `hyprctl keyword windowrulev2 opacity 0.8,class:^(foo)$` — **syntax UNVERIFIED** (linux.md §8) | Opacity only, and compositor-specific. |

### 3.1 macOS — BLOCKED, with two independent proofs

**Proof 1 — WindowServer enforces per-connection ownership (macos.md §8, §H).**

The private API *appears* to allow it. `CGSCIFilter.h` exposes `CGSNewCIFilterByName`,
`CGSAddWindowFilter(cid, wid, filter, flags)`, `CGSSetCIFilterValuesFromDictionary`,
`CGSRemoveWindowFilter` — signatures that *look* cross-process, taking an explicit connection ID and
an arbitrary window ID. But `CGSWindow.h` states the rule: **"Only the owner can change most
properties of the window."** Keen Security Lab's WindowServer analysis confirms the model:
*"Only the window owner's process is allowed to perform operations on windows, or some special
entitlement is needed."* Every relevant CGS/SkyLight function takes a **`CGSConnectionID` as its
first argument — the connection ID *is* the access-control token.**

**The clean proof, from reading yabai's source** (macos.md §H):
- *Reads* on foreign windows work from your own connection: `SLSGetWindowAlpha(g_connection, wid, …)`,
  `SLSGetWindowBounds`, `SLSGetWindowLevel` (`src/window.c:865-869`).
- *Writes* are **all proxied**: `window_manager_set_opacity` → `scripting_addition_set_opacity` →
  socket → payload **injected into Dock.app** → `SLSSetWindowAlpha(SLSMainConnectionID(), …)`
  (`src/osax/payload.m:670`). Dock.app *"owns the sole connection to the macOS window server."*
- **The clincher:** the only `SLSSetWindow*` calls yabai makes from its own process are on windows
  **it created itself** (`src/window_manager.c:472-477`).

> **If it were possible, yabai would do it, and would not need SIP disabled.**

The cost of the escape: `CSR_ALLOW_UNRESTRICTED_FS (0x02)` **and** `CSR_ALLOW_TASK_FOR_PID (0x04)`
cleared; on Apple Silicon 13+ also boot-arg `-arm64e_preview_abi`; install to
`/Library/ScriptingAdditions/` as root; injection via `task_for_pid` + a remote thread. It breaks on
most point releases. macos.md's own rating: **"disqualifying. Do not pursue."**
**Asking a consumer eye-comfort app's users to disable System Integrity Protection is not a
trade-off. It is a non-starter.**

**Proof 2 — client-side filters never reach the WindowServer compositing stage (macos.md §C).**

Even the "just draw a filtered overlay on top" idea fails, and this is the more fundamental
argument because it kills every workaround at once:

- **`CALayer.backgroundFilters` / `compositingFilter`**: Apple's own wording scopes these to **your
  own in-process layer tree**. WindowServer composites windows source-over **in a different
  process**; client-side filters never enter that stage. **An overlay cannot grayscale what is
  behind it.**
- **`NSVisualEffectView`**: fixed `material` enum, no CIFilter injection.
- **`CGSAddWindowFilter` underlay**: the sole extant demonstration is from **2008** and uses only
  `CIGaussianBlur`. **No working grayscale/invert example exists in 18 years of reverse
  engineering.** Treat as blur-only.
- **`CGSSetWindowBackgroundBlurRadius`**: alive (wezterm, iTerm2) but blur-only, and has caused
  **actual App Store rejection**.
- **`CABackdropLayer` + `CAFilter` (`colorMonochrome`, `invertColors`)**: the one **untested** lead —
  but that vocabulary comes from *iOS/UIKit* reverse engineering, and whether macOS WindowServer
  honours non-blur filter types in the behind-window path is exactly the undocumented boundary.
  macos.md: *"Cheap to falsify; spike it before designing around it."* See §9 S1 — but note that a
  positive result would still be an undocumented private path with App Store and stability
  consequences, so it changes the verdict from "impossible" to "inadvisable", not to "ship it".
- **ScreenCaptureKit + Metal** is the only public arbitrary-filter path, and it fails on five counts
  (macos.md §H): needs Screen Recording; to show the re-render you must cover the original (eating
  clicks, or click-through onto an invisible window); ≥1 frame latency makes typing unusable; SCK
  gives the window's own content, not the composited result, so **any overlap destroys the
  illusion**; and continuous full-screen GPU/encode cost is hostile in a passive-comfort app.
  Plus Sequoia's recurring screen-recording consent prompt. **A heavy UX tax for an always-on
  eye-comfort utility.**

> **macos.md's summary, verbatim: "Nobody has shipped window-scoped grayscale on macOS."**
> HazeOver — the closest shipping analogue — uses plain alpha overlays.

**Verdict: BLOCKED. Not "needs research". Not "hard". Blocked, with the mechanism named.**

### 3.2 Linux X11 — POSSIBLE, but it is not this feature

linux.md §8 [VERIFIED] gives three genuinely working mechanisms:

1. **`_NET_WM_WINDOW_OPACITY`** — a 32-bit CARDINAL property. **X11 has no property ACLs, so any
   client can set it on any other client's window.** Honoured by picom / KWin / Mutter. This is how
   `transset` and `picom-trans` work. **One `ChangeProperty` call to dim a foreign window.**
2. **picom per-window shaders** — `window-shader-fg` + `window-shader-fg-rule` (GLX backend). A GLSL
   grayscale shader per window is a documented working feature. **Requires the user runs picom** —
   which excludes GNOME and KDE X11 sessions, i.e. most X11 desktops.
3. A translucent click-through override-redirect window tracking the target's geometry — the same
   cutout-tracking approach, with the same overlap problems plan 09 documents.

**Mechanism 1 is trivially implementable and delivers the wrong thing.** F9.1 specifies *"per-window
dark (color-invert) or grayscale effect"*. `_NET_WM_WINDOW_OPACITY` delivers **translucency**. A
translucent window is not a dark window and is definitely not a grayscale window — it is a window
you can see the desktop through, which for a reading-comfort feature is arguably worse than nothing.

**Mechanism 2 delivers the right thing** but only for users running picom, and requires us to write
into another program's configuration and ask it to reload — a fragile, unsupported integration with
a compositor we do not control.

So the honest X11 verdict is: *"we could ship a per-window dimmer that is not the advertised
feature, or a real per-window grayscale that works for a minority of a shrinking platform."*

### 3.3 Linux Wayland — BLOCKED by design

linux.md §8: *"**Wayland — NO. Impossible by design.** There is no global surface namespace; a client
cannot obtain a handle to, name, read, or modify another client's surface, and there is no
cross-client property mechanism at all. Only the compositor can apply per-window effects."*

This is the same security boundary plan 09 hits, applied one level harder: not only can we not
*read* another window's geometry, we cannot *name* another window at all.

Compositor escape hatches, all outside our process and all per-compositor:
- **Hyprland**: `hyprctl keyword windowrulev2 opacity 0.8,class:^(foo)$` — **syntax UNVERIFIED**.
- **KWin**: window rules support per-window opacity; runtime third-party installation **UNVERIFIED**.
- **GNOME**: *"no mechanism at all."*

All three deliver **opacity only** — the same wrong-feature problem as X11 mechanism 1, minus the
one route (picom shaders) that produced the right one.

And recall the platform trajectory (linux.md §0): **GNOME 50 removed X11 entirely** (~27,540 lines
deleted, 2026-03); **KDE Plasma 6.8 (~2026-11) is Wayland-exclusive**; Fedora, Ubuntu and RHEL have
already dropped or removed X11 sessions. **Building an X11-only feature in 2026 is building on a
platform with a published end date.**

## 4. Design

**No new abstraction is proposed, because the recommendation (§10) is not to port.**

If the recommendation is overridden, the design is constrained by what the seam already is. The
existing `engine.rs` shape is genuinely good and already platform-neutral: an authoritative state
map plus a `backend::apply(hwnd, Option<Effect>)` dispatch. A port would add
`engine_x11.rs` alongside `engine_win.rs` under the same `#[path]`-selected `backend` module, and
`Hwnd = isize` already accommodates an X11 `Window` XID.

The two changes that would be genuinely required:

1. **`Effect` must gain a fidelity discriminant**, because X11's realistic mechanism cannot express
   `Dark`/`Gray`:
   ```rust
   pub enum EffectFidelity {
       /// Real colour matrix (Windows Magnification; picom GLSL shader).
       Matrix,
       /// Opacity only — `_NET_WM_WINDOW_OPACITY`. Dark and Gray both degrade
       /// to "dimmed", which is NOT what F9.1 specifies.
       OpacityOnly,
   }
   ```
   **This is the data-model consequence of the weakest platform, and it is a bad one**: it forces
   the UI to either lie (call opacity "Dark") or expose a second-class mode. Both are worse than
   not shipping the feature there.

2. **`MagicxCapability` reported to the UI**, so `settings.magicx.enabled` cannot be turned on where
   nothing will happen. Today the off-Windows backend is a silent no-op: `toggle_effect` updates the
   map, `state_of` reports the effect as active, the toolbar shows it as applied, and **nothing
   changes on screen.** That is the exact silent-no-op failure class the other plans exist to
   eliminate — and fixing *that* is worth doing regardless of the port decision (§5).

The **Magic Toolbar** (F9.2–F9.4) is a separate question from the effects and has a much better
story: it needs the foreground window's rectangle and the cursor position — the same inputs as plans
08 and 09. It would work on Windows and X11, and be BLOCKED on Wayland (no geometry, no global
cursor). **But a toolbar whose buttons apply effects that cannot exist is pointless**, so its fate
follows the effects'.

## 5. Implementation steps

**Under the recommended path (do not port), there is exactly one step, and it should be done:**

1. **Make the off-Windows no-op honest.** Add `magicx_capability() -> MagicxCapability`; when the
   backend is inert, the MagicX panel shows the feature as unavailable-on-this-platform with a short
   reason, and `settings.magicx.enabled` cannot be switched on. Keep the state map exactly as it is.
   Files: `magicx/mod.rs`, `commands_registry.rs`, `src/bindings.ts` (generated),
   `src/views/main/ui/panels/` (the MagicX panel), `messages/en.json`.
   Size: **XS.** Value: removes a feature that silently pretends to work on two of three platforms.

**If the recommendation is overridden and X11 is attempted, the additional steps would be:**

2. `engine_x11.rs` implementing `apply` via `_NET_WM_WINDOW_OPACITY` (`x11rb` `ChangeProperty`),
   plus `EffectFidelity::OpacityOnly` plumbed to the UI so the user is told what they are getting.
3. picom detection (is it running? does it expose the GLX backend?) and, if present, a
   `window-shader-fg-rule` integration — **including a decision about writing to and reloading
   another program's config**, which is a support-burden question, not a coding one.
4. The Magic Toolbar hover tracker on X11 — reusing plan 08's cursor source and plan 09's X11
   foreground-window target rather than a third implementation.

## 6. Permissions, packaging, distribution

- **Windows:** none. The Magnification API needs no elevation. (Note: it cannot magnify/affect
  windows of elevated processes from a non-elevated one — same constraint as plan 09.)
- **macOS:** not applicable — blocked. **For the record, the SIP-disabled route would foreclose
  everything**: no App Store, no notarization value, an install step requiring root, and a support
  burden that breaks on point releases.
- **Linux X11:** none for `_NET_WM_WINDOW_OPACITY` (unprivileged property write). picom integration
  requires read/write access to the user's picom config and a way to signal a reload — **inside a
  Flatpak sandbox that is a real problem**, and it is a cross-application configuration write, which
  is poor citizenship regardless of packaging.
- **Linux Wayland:** not applicable — blocked.

## 7. Failure modes & degradation

**Today, off Windows, this feature fails in the worst possible way:** `toggle_effect` succeeds,
`state_of` reports the effect as active, the toolbar renders it as applied, and **the screen does not
change**. Every layer above the backend believes it worked. This is the textbook silent no-op.

| Condition | Today | After step 1 |
|---|---|---|
| macOS / Wayland, MagicX enabled | Toolbar appears, buttons toggle state, nothing happens on screen | Feature reported unavailable with a reason; the master switch cannot be enabled |
| X11 without picom, if ported | Would silently do nothing (shaders) or silently do the wrong thing (opacity) | `EffectFidelity::OpacityOnly` shown explicitly, or unavailable |
| Windows, elevated target window | Magnification host cannot cover it | Unchanged (same class as plan 09's elevated-window limit) |
| App exits with effects applied | `clear_all()` on the enabled→disabled edge (`magicx/mod.rs::watch_enabled`, line 63) and on exit | Unchanged — and **this is important**: unlike the macOS accessibility grayscale APIs (macos.md §4, *"system-wide global state that persists after our app quits"*), the Magnification host dies with the process, so a crash leaves nothing behind. Preserve that property in any port. |

## 8. Testing

**Unit-testable (CI, every platform) — already exists and should be kept regardless of the
decision:**
- `Effect::from_wire` parsing (engine.rs line 201).
- Mutual-exclusion and clear semantics (lines 209–248) — Dark replaces Gray, toggling the active
  effect clears, `clear_all` resets. These run under `STATE_TEST_LOCK` because the map is process-global.
- Zero-handle rejection (line 251).
- Matrix shape assertions (lines 259–283) — invert diagonal/offsets, Rec. 601 weights.
- `rect_xywh` / `rect_is_valid` clamping (lines 286–298).
- The toolbar `geometry` module — alignment, offset clamping, hover-zone containment. Pure and
  already platform-independent.

**Manual only:** everything about whether pixels actually change. On Windows this needs a real
desktop with a real target window; there is no CI path.

**Cannot be tested in CI at all:** the entire pixel-level behaviour, on every platform.

## 9. Open questions / spikes needed

**S1 — `CABackdropLayer` + `CAFilter` (`colorMonochrome`, `invertColors`) on macOS.
NON-BLOCKING. 30 minutes. Run it to close the question, not to open a design.**
macos.md §C names this as *"the one untested lead"* while noting the vocabulary comes from
**iOS/UIKit** reverse engineering, and that whether macOS WindowServer honours non-blur filter types
in the behind-window path is *"exactly the undocumented boundary."*
**Action:** minimal Swift/objc2 harness — a `CABackdropLayer` with a `colorMonochrome` `CAFilter`
over a foreign window; observe whether anything behind it desaturates.
**Frame the outcome correctly before running it:** a negative result closes the question. A
**positive** result does *not* unblock the feature — it would be an undocumented private path with
App Store consequences (`CGSSetWindowBackgroundBlurRadius` has caused *actual* rejection), unknown
stability across point releases, and no precedent in 18 years of shipping software. It would move
macOS from **BLOCKED** to **INADVISABLE**, which is not a green light. Do the spike so the answer is
recorded; do not do it hoping to be rescued.

**S2 — Hyprland `windowrulev2 opacity` syntax; KWin runtime rule installation. NON-BLOCKING.**
Both marked **UNVERIFIED** in linux.md §8. Only worth resolving if the X11/compositor path is
pursued — and both deliver opacity only, so neither changes the F9.1 parity answer.

**Q1 — Does the Magic Toolbar have independent value?**
It is a nicely-decomposed hover-tracking widget whose geometry is already pure and tested. Could it
host something else on macOS/Linux — quick per-app rule creation (plan 06), say? **Possibly, but
that is a new feature with a new justification, not a port of F9.2.** Do not smuggle it in under
this plan's parity number.

**Q2 — What do we tell users who came from CareUEyes for MagicX specifically?**
A product/copy question, not an engineering one, but it needs an owner. The About/parity
documentation should state plainly that per-window effects are a Windows-only capability, and why —
users respect a clear technical reason far more than a permanently "coming soon" row.

## 10. Effort and recommendation

| Platform | Size | Notes |
|---|---|---|
| Windows | **none** | Already shipped. |
| Shared (step 1, honest no-op) | **XS** | Should be done regardless. |
| macOS | **∞** | Not an effort estimate. Blocked. |
| Linux X11 (opacity only) | **S** | One `ChangeProperty` call. Delivers the wrong feature. |
| Linux X11 (picom shaders) | **M** | Delivers the right feature, for picom users only, via config-file integration with a program we do not control. |
| Linux Wayland | **∞** | Blocked. |

### ★ Recommendation: **keep MagicX Windows-only. Do not attempt the X11 subset. Do step 1.**

Three reasons, in order of weight:

**1. The X11 subset delivers the wrong feature.** F9.1 specifies per-window *invert* and
*grayscale*. The mechanism that works everywhere on X11 (`_NET_WM_WINDOW_OPACITY`) delivers
*translucency*. Shipping "Dark" as "70% transparent" is not partial parity — it is a different
behaviour under a borrowed name, and for a reading-comfort tool a see-through window is a
degradation, not a compromise. The mechanism that *does* deliver the right effect (picom GLSL
shaders) requires the user to run picom, which excludes GNOME and KDE X11 sessions — most X11
desktops — and requires us to write into and reload another program's configuration.

**2. X11 has a published end date.** GNOME 50 (2026-03) removed the X11 backend outright; KDE Plasma
6.8 (~2026-11) is Wayland-exclusive; Fedora 43, Ubuntu 25.10/26.04 LTS and RHEL 10 have already
dropped or removed X11 sessions (linux.md §0, all [VERIFIED] with sources). Wayland — where this is
**impossible by design** — is the dominant Linux target *now* and will be the only one soon.
Building a new X11-only subsystem in 2026 means writing code with a known expiry, for a feature that
will never work on its successor.

**3. macOS is not a research gap; it is closed.** Two independent proofs (§3.1): WindowServer's
per-connection ownership model, demonstrated by reading yabai's source and observing that it proxies
*every* foreign write through an injected payload in Dock.app with SIP disabled; and Apple's own
scoping of `CALayer` filters to the in-process layer tree, which kills the overlay approach at the
architectural level. macos.md's summary is that **nobody has shipped window-scoped grayscale on
macOS** — in 18 years. That is not a gap waiting for a clever engineer.

**What this buys:** the effort that a half-working X11 port would consume is far better spent on
plans 07/08/09, where macOS and Linux can reach genuine parity, and on plan 01's tint engine, which
is the feature users actually install this class of app for.

**What to do instead of nothing:** ship step 1. Turning a silent no-op into an explicit
"Windows-only, because other platforms do not permit one application to change how another's window
is drawn" is a one-day change that makes the product honest on two platforms and gives support a
real answer. **A clearly-explained missing feature costs far less trust than a feature that appears
to work and does not.**

### Single biggest risk in this plan

**That the recommendation is read as defeatism and quietly overridden into "let's just do the X11
opacity bit — it's only one call."** It *is* only one call. That is precisely the trap: the cheapest
possible implementation produces the least honest result, wired into a UI that says "Dark" and a
settings schema that promises an effect the backend cannot produce. **If X11 is pursued anyway, the
`EffectFidelity::OpacityOnly` discriminant in §4 is not optional** — the UI must never call opacity
"Dark".
