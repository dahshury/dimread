# Plan 09 — Focus Blur
Status: DRAFT
Depends on: 07 (overlay window substrate), 06 (foreground identity / per-app rules), 00 (capability layer)
Parity ref: FEATURE-PARITY.md F8.2

---

## 1. What this feature is

Dim or tint everything except the window you are actually working in — the HazeOver effect. The
active window stays at full brightness while every background window and the desktop recede.
Settings are enable switch, hotkey, include-taskbar, only-current-monitor, transition animation,
shade transparency % and shade colour (FEATURE-PARITY F8.2; CareUEyes notes "may need admin
rights"). Mutually exclusive with Focus Read — they share one overlay.

The whole feature reduces to one question: **where is the active window, and how do we get a shade
everywhere except there?** Every platform answers both halves differently, and two environments
cannot answer the first half at all.

## 2. Current state

`src-tauri/src/focus/blur.rs` (571 lines), working on Windows. Frozen seam:
`toggle` / `is_active` / `start` / `stop`, plus `init` which restores the persisted `enabled` state
1500 ms after boot (`AUTOSTART_DELAY_MS`).

**The current architecture is a renderer-side cutout mask**, and the file's own doc comment explains
why it was chosen:

> *"We do NOT try to sandwich the overlay under the foreground window in the z-order (fragile) —
> instead a background foreground-window tracker polls `GetForegroundWindow` … and emits
> `focus:anchor`. The renderer masks a hole for that rect out of the shade."*

`windows_impl::tracker_loop` (line 265) polls at `POLL_INTERVAL_MS: u64 = 150`, computing:
- `window_bounds(hwnd)` — `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` with a
  `GetWindowRect` fallback (line 380). The DWM path is deliberate: it excludes the invisible
  resize-border shadow so the cutout hugs the window.
- `monitor_bounds(hwnd, include_taskbar)` — `MonitorFromWindow` + `GetMonitorInfoW`, choosing
  `rcWork` vs `rcMonitor` (line 405).
- `all_monitor_rects(include_taskbar)` — `EnumDisplayMonitors`, same work-area/full choice per
  monitor (line 343).

Skips: our own PID (line 304 — otherwise the shade flashes off whenever DimRead is focused), and
shell classes via `is_shell_class` (`Progman | WorkerW | Shell_TrayWnd | Shell_SecondaryTrayWnd |
Button`, line 175). Dedupe is on the whole `FocusAnchorEvent` (it derives `Eq`), so hot-plugging a
display re-emits.

Pure, well-tested geometry: `to_local_anchor(win, monitor, monitors, origin, taskbar)` (line 192)
rebases everything to window-local coordinates; seven unit tests at lines 439–570 covering negative
secondary origins, degenerate rects, per-monitor taskbar carve-outs and monitor-set changes.

Settings: `FocusBlurSettings { enabled, include_taskbar, only_current_monitor, animate,
transparency, color }` (`settings/mod.rs` line 301).
Events: `FocusAnchorEvent` + `AnchorRect` (`events.rs` lines 138–178).
Renderer: `src/views/focus-overlay/ui/FocusBlurShade.tsx`, geometry in
`src/features/focus-blur/lib/blur-geometry.ts` (+ `.test.ts`).
Panel: `src/views/main/ui/panels/focus/FocusBlurSection.tsx`.

### Tracked follow-up already open

`include_taskbar` currently **no-ops in full-virtual-screen mode** (task_10f603da). The backend does
compute per-monitor work areas correctly (`all_monitor_rects`, and the test
`local_anchor_keeps_per_monitor_taskbar_carve_outs_distinct` proves the maths), so the gap is on the
renderer side: the shade is drawn across the whole virtual screen rather than as the union of the
per-monitor regions the backend supplies. See §4.6 for how the cross-platform work subsumes it.

## 3. Per-platform verdict table

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | `GetForegroundWindow` + `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` @ 150 ms; renderer cutout | Works today. Elevated (admin) windows cannot be inspected by a non-elevated process — this is what CareUEyes' "may need admin rights" refers to. |
| macOS (Intel) | **FULL, with zero permissions** | **Z-order ordering, not a cutout**: one borderless `NSWindow` per `NSScreen` at `level = .normal`, `overlay.order(.below, relativeTo: CGWindowID)` (macos.md §GG) | ⚠️ **This SUPERSEDES the four-rect cutout in macos.md §E.** Focused-window identity from `CGWindowListCopyWindowInfo` — **no permission** (§F, §HH). AX optional, for latency only. |
| macOS (Apple Silicon) | **FULL, with zero permissions** | Same | Same. |
| Linux X11 | **FULL** | `_NET_ACTIVE_WINDOW` on the root + `XTranslateCoordinates` for geometry; XRes 1.2 `XResQueryClientIds` for process identity (linux.md §5–6) | Prefer XRes over `_NET_WM_PID` — the latter is voluntary and may carry a sandbox/remote PID; Metacity, Marco and wlroots all migrated. |
| Linux Wayland — KDE | **BLOCKED** via standard protocols | None. Two escape hatches: ★ **`org_kde_plasma_window_management`** — a **real protocol**, `geometry` event since **v6 (absolute coords)**, `pid_changed` since **v8**, plus an `active` flag (linux.md §NN); or **KWin scripting** (`/Scripting` `loadScript` + a JS shim calling back via `callDBus`) | **Prefer the protocol over the JS shim** — no script to install. ⚠️ But it **is** on KWin's `restrictedInterfaces` list, so **sandboxed (Flatpak) clients are blocked from it** — Flatpak would fall back to the shim or to nothing. |
| Linux Wayland — GNOME | **BLOCKED** | None. Escape hatch requires a **user-installed third-party GNOME extension** (window-calls / focused-window-dbus). `org.gnome.Shell.Eval` blocked since GNOME 41 | The overlay is *also* BLOCKED here (plan 07). Both are fixed only by `GDK_BACKEND=x11`. |
| Linux Wayland — wlroots | **BLOCKED** via standard protocols | Escape hatch: **sway `GET_TREE`** (`rect`, pid, `window` events) / **Hyprland `clients`**+`activewindow` (`at`, `size`, pid, push socket) — both full fidelity (linux.md §5–6) | The overlay itself works here via layer-shell, so wlroots is the one Wayland family where an escape hatch yields a complete feature. |

### 3.1 Why Wayland is BLOCKED — and this one is not arguable

linux.md §5–6 is a direct verification against upstream source trees, and the capability table is
unambiguous on the row that matters:

| Capability | X11 | Wayland std. protocols | Compositor IPC |
|---|---|---|---|
| **Geometry** | ✅ | ❌ **NEVER exposed** | ✅ |

*"Wayland — definitive: a normal client cannot learn the focused window, any window's geometry, or
even its own absolute position."* `ext_foreign_toplevel_handle_v1`'s events are exactly `title`,
`app_id`, `identifier`, `done`, `closed` — *"that is the entire surface."* linux.md §NN puts this
even more strongly: **`ext-foreign-toplevel-list-v1` has NO STATE AT ALL — it cannot even tell you
which window is focused.** The spec calls itself *"intentionally minimalistic"*. It is implemented by
wlroots/sway, Hyprland and COSMIC — **not Mutter, not KWin**.
`zwlr_foreign_toplevel_handle_v1` adds `output_enter/leave`, `state` (incl. `activated`) and
`parent`. **Neither carries PID or geometry.** The only rectangle anywhere in the protocol is the
`set_rectangle` **request** — you tell the compositor where you draw a thumbnail; it is not a getter.

And the two protocols that would at least give *focus* are not implemented where it counts:
**GNOME/mutter and KDE/KWin implement NEITHER `ext-foreign-toplevel-list-v1` NOR
`zwlr-foreign-toplevel-management-v1`** — verified directly against `GNOME/mutter@main` and
`KDE/kwin@master` (KDE Bug 502647 is the open request). Any strategy built on those covers
wlroots-family compositors only.

**Rationale, recorded so nobody relitigates it:** geometry is withheld *"because a global coordinate
space is the primitive enabling click-jacking and overlay phishing."* An app that knows exactly
where your banking window is, and can draw over the whole desktop, is the attack. **We are asking
for precisely the capability the security model exists to deny.** No portal offers it
(*"confirmed NO window-info portal … No proposal in flight"*), and none will.

## 4. Design

### 4.1 The architecture split — cutout vs z-order

There are exactly two ways to leave a hole in a shade, and **the right choice differs per platform**:

| | **Geometric cutout** | **Z-order ordering** |
|---|---|---|
| How | Compute the shade as (screen union − focused rect); draw the remainder | Put one plain shade per screen at normal level, then `order below` the focused window |
| Needs | The focused window's **rectangle** | The focused window's **handle/ID** |
| Overlap correctness | ⚠️ **Wrong when anything overlaps the active window** | ✅ Correct by construction |
| Platforms | Windows (today), Linux X11 | macOS |

macos.md §GG is explicit that the cutout is the inferior approach and names the failure:

> *"Nobody computes a mask or cutout — the z-order **is** the mask. 5 of 7 OSS dimmers use exactly
> this. The one that uses a cutout (EsDimKid) documents the reason it loses: **'the cutout is a
> rectangle, so anything overlapping the active window gets it wrong.'**"*

**Do not unify these into one abstraction.** The seam is `FocusMask`, and its two implementations
share almost nothing:

```rust
// src-tauri/src/focus/mask.rs

/// Identity of the focused window, in whatever form the platform can supply.
/// Every field the weakest backend cannot fill is `Option` — see §4.5.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FocusTarget {
    /// Native window handle: HWND (Windows), CGWindowID (macOS), XID (X11).
    /// `None` where the platform reports focus without a durable handle.
    pub window_id: Option<u64>,
    /// Visible rectangle in desktop coordinates. `None` on every Wayland
    /// backend without compositor IPC — geometry is NEVER exposed there.
    pub rect: Option<Rect>,
    /// Owning process. `None` under generic Wayland (app_id only, no PID).
    pub pid: Option<u32>,
    /// The one identifier available on every backend. Key the model on THIS.
    pub app_id: String,
}

pub enum MaskStrategy {
    /// Shade = screen union minus `rect`. Requires `rect`.
    Cutout,
    /// Shade sits at normal level, ordered below `window_id`. Requires `window_id`.
    ZOrder,
}
```

### 4.2 macOS — the canonical recipe (SUPERSEDES macos.md §E)

```
N screens → 1 (or 2, see below) borderless NSWindow per NSScreen
  level = .normal                     ← NOT elevated. LOAD-BEARING.
  isOpaque = false; backgroundColor = black
  ignoresMouseEvents = true; hasShadow = false
  collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
  canBecomeKey / canBecomeMain = false; animationBehavior = .none
  setAccessibilitySubrole(nil)        ← so window switchers filter us out

focus change → resolve the focused window's CGWindowID
            → overlay.order(.below, relativeTo: Int(windowID))
```

⚠️ **`level` must stay `.normal`, and this directly contradicts plan 07's level-101 guidance.**
macos.md §GG anticipates the confusion: *"Note this does NOT conflict with the level-101 guidance
elsewhere in this file — that applies to the full-screen TINT overlay, a different feature. Focus
Blur must be `.normal`."* Raising Focus Blur's level forces you back into the cutout architecture and
all its overlap bugs.

> **Do not let plan 07's level guidance leak into this plan.** They are different features with
> genuinely different requirements: the tint covers *everything* (so it must outrank the menu bar
> and Dock); Focus Blur covers *everything except one window* (so it must be orderable relative to
> that window, which only works at a shared normal level). Plan 07's `SurfaceRequest` needs a level
> policy field, and this plan's surfaces must set it to `Normal`.

**Multi-display (dimsum's rule, macos.md §II item 6):** the display holding the focused window gets
`order(.below:)`; **every other display gets `orderFront(nil)`** — fully dimmed. This is exactly
CareUEyes' `only_current_monitor` inverted, and it maps cleanly onto the existing setting.

**Two overlays per screen, or a `CATransition`.** macos.md §II item 4: *"Two overlays per screen
(or a `CATransition(.fade, 0.2s)` on the content layer) is required to avoid a full-screen flash
when re-ordering — independently discovered by `hw`, OpenHaze and BlurFocusPoC."* Three independent
discoveries is a strong signal. This is what `settings.focus_blur.animate` should drive on macOS.

**Blur (as opposed to dim) without private API** (macos.md §II item 7): public `NSVisualEffectView`
with `material = .fullScreenUI`, `blendingMode = .behindWindow`, modulating `alphaValue` as a
pseudo blur-radius. Optional; F8.2 as specified only requires dim/tint.

### 4.3 macOS focused-window identity — zero permissions

This is the finding that most changes the feature's cost. macos.md §HH:

> **HazeOver ships on the Mac App Store** (id430798174, since 2011) → sandboxed + no private APIs →
> **it cannot be using `_AXUIElementGetWindow`.**

Two public-API routes, both verified in shipping OSS:

| Approach | Source | Permissions |
|---|---|---|
| Read AX `kAXPosition`/`kAXSize`, then **geometrically match** against `CGWindowListCopyWindowInfo` at **2.0 pt tolerance** | **dimsum** | Accessibility (for the AX read) |
| Filter `CGWindowListCopyWindowInfo` for `kCGWindowLayer == 0 && kCGWindowOwnerName != "Window Server"`, take `.first` for the front app's PID, read `kCGWindowNumber` | **hw**, **BlurFocusPoC** | **NONE** |

★ **BlurFocusPoC uses no Accessibility at all** — `NSWorkspace.didActivateApplicationNotification`
+ `CGWindowListCopyWindowInfo` + a 0.5 s idempotent safety poll. macos.md calls it *"the purest
proof that the basic effect needs zero permissions."*

`CGWindowListCopyWindowInfo` gives, **with zero permissions and no prompt ever** (macos.md §F):
`kCGWindowNumber`, `kCGWindowOwnerPID`, `kCGWindowOwnerName`, `kCGWindowBounds`, `kCGWindowLayer`,
`kCGWindowAlpha`, `kCGWindowIsOnscreen` — **and the array order encodes full front-to-back z-order.**
Only `kCGWindowName` (titles) is redacted, and the key is **absent entirely** rather than empty.
Titles are cosmetic for a dimming app.

**→ Ship the zero-permission path. AX is a latency optimisation, not a data dependency.** This
upgrades macos.md §G's "AX is optional" and is exactly why HazeOver words it as *"react instantly …
and detect the focused window even more reliably."*

⚠️ **Do NOT use `SCShareableContent` for enumeration** (macos.md §F) — it always requires Screen
Recording, **prompts when ungranted**, and *"may either never invoke the completion handler, or take
3–10 seconds."*
⚠️ `CGWindowListCreateImage` is **OBSOLETED in macOS 15** (hard compile error). Apple killed the
*imaging* functions and left *enumeration* alone. We only need the half that survived.

**If we ever do enable the optional AX upgrade**, three things are mandatory rather than nice:
1. ★ **`AXUIElementSetMessagingTimeout`.** macos.md §II item 3 calls it *"the highest-leverage single
   line in this whole area."* **The OS default is 6 s.** AltTab sets 1 s; EsDimKid 0.5 s;
   **Hammerspoon and AeroSpace set nothing, and Hammerspoon's five worst open issues all trace to
   it** (5–10 s beachballs, 30 s first-subscribe delays, traced to `com.apple.WebKit.WebContent`).
   AeroSpace's alternative is more elegant: one dedicated `Thread` + `CFRunLoop` per application, so
   a hung app blocks only its own thread. **Treat this as a required step, not a nicety.**
2. **Never enumerate all apps synchronously on the main thread at startup** (§II item 5 —
   Hammerspoon's most-reported bug class).
3. `panic = "abort"` — glide sets it specifically so a Rust panic cannot unwind into the macOS
   CFRunLoop thread (macos.md §G). Adopt it if we take any AX/CFRunLoop callback.

**Permission sharp edges, if AX is ever used** (macos.md §G, §L) — all reasons to keep it optional:
restart-after-granting is effectively required (trusted state is cached per-process, no
`AXResetTrustedCache()`); macOS 13+ returns **stale values from `AXIsProcessTrusted` right after a
toggle**; TCC binds the grant to bundle ID **+ code-signing requirement**, so ad-hoc dev builds lose
it **every rebuild** while *still appearing checked in System Settings*.

### 4.4 The drift watchdog — the real problem

macos.md §II item 2: *"**Z-order drift is the real problem, not initial ordering.** Every mature
dimmer adds a 0.15–0.5 s poll on top of AX events."*

- **OpenHaze's `fixDriftIfNeeded()`** is the most refined: re-issue `order(.below:)` **only if the
  overlay drifted *above* its anchor**, deliberately tolerating benign drift to avoid churn.
- **BlurFocusPoC's** `lastTarget` idempotency guard is the simplest.

Our existing Windows tracker already has the right shape (a 150 ms poll with whole-event dedupe), so
this is convergent rather than novel — but the macOS version must compare **z-order position**, not
just the target identity.

⚠️ **The single load-bearing API has broken before.** macos.md §II item 1:
`godbout/OrderBelowVenturaBug` is a minimal repro filed as **FB10702287** — *"ordering below windows
of other apps doesn't work in Ventura. hopefully a bug, not a new restriction from Apple."* Whether
it was formally fixed is **UNVERIFIED**; it demonstrably works today (openhaze pushed 2026-07-15,
dimsum 2026-05-16). **Budget for it breaking** — see §7.

### 4.5 Data-model consequences of the weakest platform

linux.md's design imperative applies verbatim, and this plan is where it bites:

> *"Design the data model around the weakest backend. Make `pid` and `geometry` `Option<…>` in the
> Rust types **and in the tauri-specta bindings from day one**. The generic Wayland path can never
> fill them, and retrofitting optionality through `src/bindings.ts` and the frontend later is far
> more painful than accepting it now. Key the model on **`app_id`/`wm_class`, not PID** — it is the
> one identifier available on every backend."*

Concretely:
1. **`FocusTarget.rect: Option<Rect>`** — Wayland can never fill it. Any code path that unwraps it
   is a bug on the dominant Linux target.
2. **`FocusTarget.pid: Option<u32>`** — generic Wayland gives `app_id` only, no PID.
3. **`FocusTarget.app_id: String`** (not optional) — the one universal key. **Plan 06 must use the
   same type**; do not let Focus Blur and the Rules engine grow two different notions of window
   identity. This is a shared dependency, not a coincidence.
4. **`FocusAnchorEvent` becomes strategy-aware.** Today it always carries a rect. Under `ZOrder` the
   renderer draws a plain full-screen shade and the *native* side does the ordering — there is no
   anchor to send. Either add a `strategy` discriminant to the event, or (cleaner) stop emitting
   `focus:anchor` at all on `ZOrder` backends and let the shade be a static `SurfaceContent::Rects`
   fill. **Prefer the latter** — it keeps the renderer honest about what it does and does not know.
5. **Plan 07's `SurfaceRequest` needs a level policy** (`Normal` for Focus Blur, `Elevated` for the
   tint). Without it, the two features cannot coexist on macOS.
6. Regenerate `src/bindings.ts` via `cd src-tauri && cargo test export_bindings` — never hand-edit.

### 4.6 `include_taskbar` (task_10f603da) — subsumed, not preserved

The tracked follow-up says `include_taskbar` no-ops in full-virtual-screen mode. The backend is
already correct: `all_monitor_rects(include_taskbar)` returns per-monitor `rcWork` vs `rcMonitor`,
and `to_local_anchor` rebases every one of them, with two dedicated tests
(`local_anchor_maps_every_monitor_region_to_window_local_px`,
`local_anchor_keeps_per_monitor_taskbar_carve_outs_distinct`). The renderer simply is not using
`monitors[]`.

**The cross-platform work subsumes this rather than working around it**, because both platform
strategies force the fix:

- Under **`Cutout`** (Windows, X11), plan 07 replaces the single virtual-screen surface with a
  surface *set*. Each surface is one display, so its shade is naturally that display's dimmable
  rect — the work area or the full rect per `include_taskbar`. The bug cannot survive the refactor:
  there is no "full virtual screen" left to over-draw.
- Under **`ZOrder`** (macOS), the shade is a plain per-screen window. `include_taskbar` maps to
  whether that window uses `screen.frame` or `screen.visibleFrame`. `visibleFrame` already has the
  menu bar and Dock subtracted (macos.md §3), so the setting is a one-line choice with no geometry
  maths at all.

**Do not fix task_10f603da separately first.** Fixing it in the current architecture means writing
renderer code that plan 07 step 3 then deletes. **Do** keep its two backend tests — they are the
regression guard proving the per-monitor carve-outs stay distinct through the refactor. Reference
the task ID in the commit that lands plan 07 step 3 so it closes with the right evidence.

**Naming note for the cross-platform world:** `include_taskbar` is a Windows word. On macOS it means
menu bar + Dock; on Linux it means panels/docks/bars. Keep the settings key (breaking the schema is
not worth it) but the **UI label must be platform-appropriate** — this is a `messages/en.json`
concern with three variants, not a rename.

## 5. Implementation steps

1. **Introduce `FocusTarget` + `MaskStrategy`;** move the Windows tracker's `compute_anchor` output
   into `FocusTarget` with `rect: Some(..)`, `strategy: Cutout`. No behaviour change.
   Files: `focus/blur.rs`, new `focus/mask.rs`, `events.rs`.

2. **Report unavailability.** `focus_blur_available() -> Result<(), FocusUnavailable>` + a
   `focus:unavailable` event; the Focus Blur panel disables the toggle with a reason on backends
   that cannot supply a target. **Land this early** — it converts today's silent non-functioning on
   every non-Windows platform into an honest one.
   Files: `focus/mod.rs`, `commands_registry.rs`, `src/bindings.ts` (generated),
   `FocusBlurSection.tsx`, `messages/en.json`.

3. **Per-surface shade + `include_taskbar` fix** (rides on plan 07 step 3). Closes task_10f603da.
   Files: `focus/blur.rs`, `FocusBlurShade.tsx`, `src/features/focus-blur/lib/blur-geometry.ts`
   (+ `.test.ts`).

4. **X11 backend.** `_NET_ACTIVE_WINDOW` on the root with `PropertyChangeMask` + `PropertyNotify`
   for push-based tracking (no poll); geometry via `XTranslateCoordinates` (reparenting WMs insert
   frame windows — a bare `GetGeometry` is wrong); process identity via **XRes 1.2
   `XResQueryClientIds`**, not `_NET_WM_PID`. Strategy: `Cutout`.
   Files: new `focus/target_x11.rs`. Crate: `x11rb` (already added by plan 07 step 5).

5. **macOS backend — zero-permission path.** `NSWorkspace.didActivateApplicationNotification` (on
   **`NSWorkspace.shared.notificationCenter`**, never `NotificationCenter.default` — macos.md §G
   calls this *"a silent-no-events bug that catches nearly everyone"*) + `CGWindowListCopyWindowInfo`
   filtered on `kCGWindowLayer == 0`, plus a 0.5 s idempotent safety poll. Strategy: `ZOrder`.
   Files: new `focus/target_mac.rs`, `overlay_substrate/macos.rs`.
   Crates: `objc2-app-kit` (pinned per plan 07), `objc2-core-graphics`.

6. **macOS z-order ordering + drift watchdog.** `order(.below, relativeTo:)` on the focused-screen
   surface; `orderFront(nil)` on the others; OpenHaze-style `fixDriftIfNeeded` re-issuing **only on
   upward drift**. Two overlays per screen (or `CATransition`) behind `settings.focus_blur.animate`.

7. **Wayland: explicit block.** Return `FocusUnavailable::WaylandNoGeometry { compositor }` from the
   generic backend; point at `prefer_x11_backend`.
   ⚠️ If step 8 is ever done and a Wayland shade *is* shown, plan 07 §4.4.1 applies in full: the
   layer-shell surface **must** commit an empty `wl_region` input region, or it swallows every
   desktop click (linux.md §LL — the initial input region is **infinite**, and CSS
   `pointer-events: none` does not help). Focus Blur's shade covers whole outputs, so it is exactly
   the shape that triggers this.

8. *(Optional, defer)* **Compositor-IPC / KDE-protocol backends.** sway `GET_TREE`
   (`swayipc` **4.0.0**, stable 2025-10-26) / Hyprland `clients` + `activewindow`
   (⚠️ `hyprland` **0.4.0-beta.3** — *its only stable release is 0.3.13 from Feb 2024*, so Hyprland
   support means **shipping on a beta dependency**) / KDE `org_kde_plasma_window_management`.
   COSMIC has `zcosmic_toplevel_info_v1` but geometry is **output-relative** and there is no PID.
   **GNOME has no route at all — no protocol, no Mutter D-Bus window interface, at any price**
   (linux.md §NN). **Recommend deferring past v1** — see §10.

9. *(Optional, defer)* **Selective dimming on macOS.** Because `CGWindowListCopyWindowInfo` gives
   full z-order for free, we could compute each background window's *visible* region and dim
   per-region — macos.md §E notes this would **beat HazeOver**. Genuine differentiator, zero extra
   permissions, but strictly additive. Not v1.

## 6. Permissions, packaging, distribution

- **Windows:** none for normal windows. **Elevated (admin) windows cannot be inspected by a
  non-elevated process** — those never get a cutout. This is what CareUEyes means by "may need admin
  rights" (F8.2). `blur.rs`'s doc comment already notes it and the panel already surfaces a tooltip
  hint. **Do not ship a UAC-elevation prompt for this** — the cost/benefit is bad and it would make
  DimRead an elevated always-on process.
- **macOS: ZERO permissions on the shipping path.** `CGWindowListCopyWindowInfo` never prompts
  (macos.md §F); `NSWorkspace.frontmostApplication` needs *"no permission, no entitlement, no usage
  description"* (§G). **HazeOver ships sandboxed on the Mac App Store using this approach** (§HH) —
  proof it needs no private API and no injection. Accessibility stays **optional**, exactly as
  HazeOver does it, and must **never** gate the app behind a first-launch TCC prompt.
- **macOS MAS:** unlike plan 07's tint overlay, Focus Blur at `level = .normal` does not need
  fullscreen coverage and does not need `macOSPrivateApi` on the native path. **Focus Blur alone
  would be MAS-shippable.** The blocker is the *tint* feature, not this one — worth knowing if the
  product ever wants a reduced MAS SKU.
- **Linux X11:** none. Root-window property reads and XRes are unprivileged.
- **Linux Wayland:** not applicable. If step 8 is ever done: sway/Hyprland need only socket access
  (already inside a Flatpak sandbox's reach only with an explicit `--socket` hole — flag it);
  **KWin scripting requires installing a script into the user's session**, which is a real
  distribution burden and a Flatpak problem.
- **GNOME extension route: do not ship it.** linux.md is blunt — extensions *"break across GNOME
  majors. Real deployment burden."* Detect absence and degrade with a clear in-app explanation.

## 7. Failure modes & degradation

| Condition | Today | After this plan |
|---|---|---|
| Any non-Windows platform | Overlay shows, `focus:anchor` never arrives, **the whole screen stays shaded with no hole** — actively worse than doing nothing | `FocusUnavailable` → toggle disabled with a reason; overlay never shown |
| Wayland (any) | As above | `WaylandNoGeometry { compositor }` + the `prefer_x11_backend` pointer |
| Windows, elevated foreground window | No cutout for that window (already documented; tooltip hint exists) | Unchanged, but reported through the same `FocusUnavailable`-adjacent channel rather than only a tooltip |
| **macOS, `order(.below:)` stops working** (FB10702287 regression) | — | **This is the one that will hurt.** The overlay would cover the focused window and the feature would look completely broken. Detect it: after issuing the order, re-read z-order from `CGWindowListCopyWindowInfo` (free, no permission) and verify the overlay is actually below its anchor. On repeated failure, disable Focus Blur with an explicit "not supported on this macOS version" message rather than leaving the user's screen dark. **Wire this detection in step 6, not later** — it doubles as the drift watchdog. |
| macOS, z-order drift | — | `fixDriftIfNeeded` re-issues the order only on upward drift |
| macOS, full-screen flash on switch | — | Two overlays per screen / `CATransition`, behind `animate` |
| No window focused at all | — | HazeOver's documented behaviour: *"HazeOver dims everything because the front app has no focused window."* Copy it — dimming everything is the correct answer, not a bug |
| Crash while active | Overlay window dies with the process; screen returns to normal | Unchanged. **Focus Blur holds no global state** — a deliberate contrast with gamma, which macos.md's 11th pass confirms is **NOT** restored on process exit. Preserve this property. |

**Restoration:** none required. `stop()` hides the surfaces; process death does it implicitly.

## 8. Testing

**Unit-testable (CI, every platform):**
- The existing seven `to_local_anchor` tests (`blur.rs` lines 439–570) — **keep all of them** through
  the refactor. They encode the negative-origin and per-monitor-taskbar invariants and are the
  regression guard for task_10f603da.
- `is_shell_class` (line 444) — extend with the macOS and X11 equivalents (Dock, `Window Server`,
  desktop windows) so the "skip the shell" rule is one tested table rather than three ad-hoc filters.
- **Strategy selection**: given a `FocusTarget`, which `MaskStrategy` is legal. `rect: None` +
  `window_id: Some` → `ZOrder` only; `rect: Some` + `window_id: None` → `Cutout` only; both `None`
  → unavailable. This is the type-level guard that stops a backend silently doing the wrong thing.
- Cutout geometry — shared with plan 08's "tile a screen minus a hole" helper. Write it once.
- Multi-display rule: focused display gets `order(.below:)`, others get full dim; interaction with
  `only_current_monitor`.
- `FocusUnavailable` → UI message mapping (frontend + `bun run check:i18n`).

**Manual only:**
- macOS: overlapping windows — **the case the cutout gets wrong and z-order gets right.** Put a
  floating palette or a partially-overlapping window over the focused one and confirm it dims
  correctly. This is the acceptance test for choosing `ZOrder` at all.
- macOS: Spaces switching, `.fullScreenAuxiliary` behaviour, Stage Manager.
- macOS: `order(.below:)` on the current OS version — the FB10702287 check.
- macOS: measure the switch flash with and without the two-overlay/CATransition mitigation.
- Windows: elevated windows, per-monitor taskbars on different edges, mixed DPI.
- X11: reparenting WMs (frame-window offsets), compositor on/off.
- All: rapid alt-tabbing — does the shade keep up at the chosen poll rate.

**Cannot be tested in CI:** everything manual. Additionally, **macOS permission behaviour is
untestable under `tauri dev`** (no `.app`, no Info.plist, no bundle ID — macos.md §L), and a dev
binary launched from a terminal **inherits the terminal's grants**, so `AXIsProcessTrusted()` can
return true in dev and false in production. If the optional AX path is ever built, test it only
against a signed, bundled `.app`.

## 9. Open questions / spikes needed

**S1 — Does `order(.below, relativeTo:)` work across processes on our target macOS versions?
BLOCKING step 6.**
It is *the* load-bearing API for the whole macOS design, and macos.md §II item 1 records that it
**has broken before** (FB10702287, Ventura). Fixed status is **UNVERIFIED**; it demonstrably works
today in shipping code (openhaze 2026-07-15, dimsum 2026-05-16). **Action:** run
`godbout/OrderBelowVenturaBug`'s repro, or an equivalent, on the oldest and newest macOS we intend
to support. Also verify the *detection* strategy in §7 works — that re-reading z-order from
`CGWindowListCopyWindowInfo` reliably reveals a failed ordering. Estimated: 3 hours, fold into plan
07's hardware session.

**S2 — Does the zero-permission focused-window heuristic hold up in practice?
NON-BLOCKING but do it before committing to skipping AX.**
`hw`/BlurFocusPoC take *"`.first` of the front app's PID at `kCGWindowLayer == 0`"*. That is a
heuristic, and the failure cases are predictable: multi-window apps (which of five Finder windows?),
apps with helper windows at layer 0, and apps whose frontmost window is not first in the list.
dimsum's 2.0 pt AX-geometry match exists precisely because the simple filter is not always right.
**Action:** exercise the heuristic against Finder with several windows, Xcode, a browser with
multiple windows, and an Electron app; measure how often it picks the wrong window. **If the error
rate is material, the answer is not "require AX" — it is "make AX the optional upgrade HazeOver
advertises", which is the plan already.** The spike decides how loudly we recommend the upgrade.

**S3 — Compositor-IPC backends: worth it? NON-BLOCKING, decides step 8.**
sway, Hyprland and KWin scripting are each full-fidelity per linux.md §5–6. The question is not
capability but economics: three separate IPC clients, each with its own protocol and lifecycle, to
serve compositors whose combined share is small — and KWin's route requires **shipping and
installing a JS shim into the user's session**, which is its own support surface.
**Recommendation: defer past v1**, and revisit only if Linux telemetry or user demand justifies it.
`prefer_x11_backend` covers these users today at a known cost.

**Q1 — Should macOS ship selective (per-window) dimming?**
It is free of extra permissions and would beat HazeOver (macos.md §E). But it multiplies the surface
count and the drift-watchdog complexity. **Recommendation: no for v1**, revisit as a differentiator
once the basic z-order path is proven stable in the field.

**Q2 — HazeOver's default is single-window; app-level highlighting is opt-in** (macos.md §II item 9,
from its 2011 changelog). CareUEyes' F8.2 does not specify. **Recommendation: match HazeOver** —
single focused window by default, "highlight all windows of the active app" as a setting. It is the
behaviour a 15-year-old shipping product converged on.

## 10. Effort

| Platform | Size | Notes |
|---|---|---|
| Windows | **S** | Steps 1, 3. Refactor + the task_10f603da fix that falls out of it. |
| Linux X11 | **M** | Step 4. Push-based via `PropertyNotify` is *better* than the Windows poll — no 150 ms latency. |
| macOS | **M–L** | Steps 5–6. **Smaller than expected**: zero permissions, no cutout maths, and five OSS reference implementations to crib from. The cost is in the drift watchdog and the flash mitigation, not the core. |
| Linux Wayland | **XS** | Step 7 is a `const Err` plus UI copy. The work is honesty, not capability. |
| Linux Wayland + IPC | **L** | Step 8, deferred. Three backends, one of which ships a JS shim. |
| Shared / UI | **S** | Step 2, highest value per hour. |

**Single biggest risk: `order(.below, relativeTo:)` (spike S1).** The entire macOS design rests on
one cross-process API that Apple has never contractually blessed for foreign window numbers, that
broke once in Ventura, and whose fix status is unverified. If it regresses we do not degrade
gracefully — we cover the user's focused window in black. **Mitigation is not optional: build the
z-order verification read into step 6 from the first commit**, so the failure mode is "feature
disables itself with a clear message" rather than "screen goes dark".

**Second risk: the temptation to unify `Cutout` and `ZOrder` behind one abstraction.** They need
different inputs (`rect` vs `window_id`), produce different renderer contracts (anchored mask vs
plain fill), and require different window levels on the same OS. Forcing them together would
recreate exactly the overlap bug macos.md §GG says the cutout approach loses to. **Keep the seam
split, and keep the reason in the code comment.**
