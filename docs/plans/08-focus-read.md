# Plan 08 — Focus Read
Status: DRAFT
Depends on: 07 (overlay window substrate), 00 (capability layer)
Parity ref: FEATURE-PARITY.md F8.1; hotkey plumbing F10.4

---

## 1. What this feature is

A horizontal **clear band follows the mouse cursor** while the rest of every screen is shaded, so
the user's eye is drawn to the line they are reading. Settings are shade transparency %, shade
colour, band height in px, a toggle hotkey, and a Preview mode that ESC quits (FEATURE-PARITY F8.1;
the Focus tab in `research/careueyes/images/`). It stacks with Reading/Editing modes and is
multi-monitor aware. It is mutually exclusive with Focus Blur — they share one overlay.

The feature is three things bolted together: **an overlay** (plan 07), **the global cursor
position**, and **a global ESC**. Plan 07 covers the first. This plan is mostly about the second,
which is where the platform story falls apart.

## 2. Current state

`src-tauri/src/focus/read.rs` (257 lines) is complete and working on Windows. The frozen seam is
`toggle` / `is_active` / `start` / `stop`, documented at the top of the file.

`start()` does three things (lines 77–90):
1. `show_overlay(&app)` — `ensure_window("focus-overlay")`, size/position to
   `crate::windows::virtual_screen_bounds()`, `set_ignore_cursor_events(true)`, `show()`,
   `set_always_on_top(true)`, and **deliberately no `set_focus()`** (line 131 comment).
2. `register_escape(&app)` — parses `"Escape"` into a `Shortcut` and calls
   `app.global_shortcut().on_shortcut(...)`. Guarded by `ESC_ARMED: AtomicBool` so `stop()` only
   unregisters an Escape this slice actually armed, and skipped entirely if something already owns
   Escape (lines 146–168).
3. `spawn_cursor_poll(app, generation)` — a detached thread sampling at ~30 Hz
   (`POLL_INTERVAL: Duration = Duration::from_millis(33)`), emitting `FocusCursorEvent { x, y }`
   only when the position actually changed, and exiting when `ACTIVE` clears or `GENERATION`
   moves past its captured value.

The platform seam is exactly one function pair:

```rust
#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_ok() { Some((point.x, point.y)) } else { None }
}

/// Off-Windows the cursor sampler is inert (the seam stays a no-op).
#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> { None }
```

**That `None` is the entire non-Windows story today**, and the file's own doc comment is honest
about it: *"Off-Windows the cursor sampling is a no-op, so the crate still builds and the seam stays
inert (no band motion) rather than wrong."*

Pure logic already extracted and unit-tested: `cursor_moved(last, current) -> bool` (lines 210–212,
tests at 236–257).

Settings: `FocusReadSettings { transparency: u32, color: String, height: u32 }` in
`src-tauri/src/settings/mod.rs` (line 276), defaults `50 / "#000000" / 300`.
Hotkey: `HotkeysSettings::focus_read` (line 91), armed by `apply_hotkey_settings` (line 240).
Renderer: `src/views/focus-overlay/ui/FocusReadShade.tsx`, routed by `FocusOverlayPage.tsx` on
`focus:state`; feature slice `src/features/focus-read/`.

## 3. Per-platform verdict table

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | `GetCursorPos` @ 30 Hz + spanning overlay + `RegisterHotKey` via the plugin | Works today. No change beyond plan 07's surface-set refactor. |
| macOS (Intel) | **PARTIAL → likely FULL** | `NSEvent.mouseLocation` (a *poll*, not an event tap) + per-`NSScreen` native overlay (plan 07 §4.3) | ⚠️ **UNVERIFIED whether `mouseLocation` needs a permission** — the research never addresses position-only reads. See spike S1. **Do NOT use `CGEventTap`** — that requires Input Monitoring (macos.md §K, §U). Shade must be `SurfaceContent::Rects`, not a webview (plan 07 §4.3). |
| macOS (Apple Silicon) | **PARTIAL → likely FULL** | Same | Same. |
| Linux X11 | **FULL** | `XQueryPointer` on the root window (`x11rb`), same 30 Hz poll shape | Straightforward. Root-window query works regardless of pointer focus. |
| Linux Wayland — KDE | **BLOCKED** | None via standard protocols | See §3.1. Escape hatch: KWin scripting — **UNVERIFIED for cursor position** (linux.md §5–6 lists geometry/PID/focus for KWin scripting, **not** pointer position). |
| Linux Wayland — GNOME | **BLOCKED** | None | Overlay is already BLOCKED here (plan 07); cursor position is independently BLOCKED. Both are fixed only by `GDK_BACKEND=x11`. |
| Linux Wayland — wlroots | **BLOCKED** | None via standard protocols | Escape hatch: Hyprland/sway IPC — **UNVERIFIED**, not covered by linux.md. |

### 3.1 Why Wayland is BLOCKED, definitively

This is not a missing feature, a Tauri gap, or something a future protocol will fix. **Two
independent mechanisms block it, and the second one is self-inflicted by our own requirements.**

**Mechanism 1 — Wayland has no global coordinate space for clients.**
linux.md §5–6 states it flatly: *"a normal client cannot learn the focused window, any window's
geometry, or even its own absolute position."* The rationale is recorded in the same section:
*"geometry is withheld because a global coordinate space is the primitive enabling click-jacking and
overlay phishing."* A client that knew where the pointer was on the global desktop could position
deceptive UI under it — exactly the attack the design forecloses. Pointer coordinates in Wayland are
delivered **surface-local**, to the surface that currently has pointer focus, and never as desktop
coordinates.

**Mechanism 2 — our overlay has an empty input region, by requirement.**
The overlay must be click-through, which plan 07 implements as
`set_ignore_cursor_events(true)` → `gtk_widget_input_shape_combine_region(empty)` →
`wl_surface.set_input_region(empty)` (linux.md §7, the one overlay primitive that **works** on
Wayland). A surface with an empty input region **never receives pointer focus and therefore never
receives `wl_pointer.motion` events at all**.

⚠️ And this is **not optional**: linux.md §LL establishes that the initial input region is
**infinite**, so a full-output overlay that does *not* commit an empty region **swallows every click
on the desktop** — a shipping-blocker documented in plan 07 §4.4.1. So the click-through requirement
cannot be relaxed to buy pointer events; relaxing it breaks the user's desktop.

> **The two requirements are mutually exclusive on Wayland: a surface can be click-through, or it
> can see the pointer, but not both.** Even if mechanism 1 were somehow worked around, mechanism 2
> would still apply. This is worth stating in the code comment, because it is the kind of
> constraint an engineer will otherwise try to "fix" three separate times.

**No portal exists.** linux.md §5–6: *"XDG portals: confirmed NO window-info portal. Full interface
list enumerated… No proposal in flight."* There is likewise no pointer-position portal.

**Compositor IPC is the only conceivable escape, and the research does not establish it.**
linux.md's backend table (§5–6) covers geometry, PID and focus events for sway `GET_TREE`, Hyprland
`clients`/`activewindow`, KWin scripting and the GNOME Window Calls extension. **None of those rows
is about pointer position.** Do not assume `hyprctl cursorpos` or a sway pointer query exists and
is pollable at 30 Hz — mark it **UNVERIFIED** and see spike S2. Even if it exists, it would cover
only Hyprland and sway, which is a minority of a minority of seats, at the cost of a per-compositor
IPC client polled 30 times a second.

**Verdict: Focus Read is BLOCKED on Wayland. The supported answer for Wayland users is plan 07's
`prefer_x11_backend` setting.** This must be said in the UI, once, clearly — not discovered by a
user wondering why the band never moves.

## 4. Design

### 4.1 The cursor-position seam

Widen the existing `cursor_position()` into a small trait so the platform split is explicit and the
unavailable case is a value rather than a `None` that means three different things.

```rust
// src-tauri/src/focus/cursor.rs  (new)

/// Global pointer position in physical desktop pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CursorPos { pub x: i32, pub y: i32 }

/// Why global cursor tracking is unavailable. Carried to the UI verbatim —
/// `None` from a sampler must never be the only signal (that is indistinguishable
/// from "the pointer did not move").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CursorUnavailable {
    /// Wayland: no global coordinate space for clients, and a click-through
    /// surface receives no pointer events. See plan 08 §3.1.
    WaylandNoGlobalPointer { compositor: String },
    /// macOS: the position API returned nothing (unexpected; log + report).
    PlatformQueryFailed,
    /// No sampler compiled for this target.
    Unsupported,
}

pub trait CursorSource: Send + Sync {
    /// Sample the pointer. `Ok(None)` = momentarily unavailable (retry);
    /// `Err(..)` = structurally unavailable (stop polling, tell the user).
    fn sample(&self) -> Result<Option<CursorPos>, CursorUnavailable>;
}
```

**The `Result` vs `Option` distinction is the whole point.** Today `None` conflates "no movement",
"query failed" and "this platform can never do it". The poll loop must stop and report on `Err`,
and keep going on `Ok(None)`.

`spawn_cursor_poll` (read.rs line 186) changes shape: on the first `Err` it stops the loop, calls
`stop()`, and emits the unavailability so the UI can explain itself. It must **not** spin at 30 Hz
against a source that will never work.

### 4.2 Per-platform samplers

| Target | Implementation | File |
|---|---|---|
| Windows | `GetCursorPos` (unchanged) | `focus/cursor_win.rs` |
| macOS | `NSEvent::mouseLocation()` (class method, `objc2-app-kit`), then the **Cocoa→Quartz flip using the MAIN display's height**: `y_quartz = main_height - y_cocoa`. Negative coordinates are legitimate for displays above/left of main — **never clamp to ≥ 0** (macos.md §A) | `focus/cursor_mac.rs` |
| Linux X11 | `x11rb` `QueryPointer` against the root window; `root_x`/`root_y` are desktop coordinates | `focus/cursor_x11.rs` |
| Linux Wayland | Always `Err(WaylandNoGlobalPointer)` | `focus/cursor_none.rs` |

⚠️ **macOS: use `NSEvent.mouseLocation`, never `CGEventTapCreate`.** macos.md §K is unambiguous —
`CGEventTap` requires **Input Monitoring**, and `NSEvent.addGlobalMonitorForEvents` requires
**Accessibility**. Both would destroy plan 07's zero-permission posture for a feature that only
needs a coordinate. `mouseLocation` is a *poll of current state*, not an event subscription, which
is why it is the right primitive — but see spike S1, because the research does not confirm its
permission status.

⚠️ **macOS polling cost.** A 30 Hz `mouseLocation` poll on the main thread is cheap, but the
overlay redraw it drives is not free. Since the macOS shade is `SurfaceContent::Rects` (plan 07
§4.3), each sample resizes two native rectangles. Coalesce to the display refresh with a
`CVDisplayLink` or a simple 60 Hz cap rather than issuing a `setFrame:` per sample, and skip
entirely when the band has not moved by ≥ 1 px — the existing `cursor_moved` guard already gives us
that for free.

### 4.3 macOS band geometry — two rects, not a DOM

Plan 07 §4.3 forbids a transparent Tauri webview for always-on macOS surfaces (measured ~8× GPU,
macos.md §S). Focus Read reduces to two filled rectangles per screen:

```
shade_top    = { x: screen.x, y: screen.y,             w: screen.w, h: band_top - screen.y }
shade_bottom = { x: screen.x, y: band_top + band_h,    w: screen.w, h: screen.bottom - (band_top + band_h) }
```

Both filled with `settings.focus_read.color` at `transparency`%. The band itself is simply the gap —
**nothing is drawn there**, which is also why it is genuinely clear rather than "less tinted".
Degenerate cases (band above/below a screen entirely) collapse one rect to zero height; the geometry
function must clamp rather than emit negative extents — mirror the existing
`to_local_anchor` clamping convention in `focus/blur.rs`.

**This is exactly the same rect-tiling shape plan 09 needs** (macos.md §E, four rects around the
focused window). Factor the "tile a screen minus a hole" helper once, in shared pure code, and let
both plans use it. Focus Read's hole is a full-width horizontal strip; Focus Blur's is an arbitrary
rectangle.

### 4.4 The global Escape

`register_escape` (read.rs line 146) uses `tauri-plugin-global-shortcut`. Three platform problems,
none of which the current code can see:

1. **Wayland: `register()` returns `Ok(())` and the key never fires.** linux.md §10 [VERIFIED]:
   the plugin connects to **XWayland** via `$DISPLAY`, `XGrabKey` succeeds against the XWayland
   root, and native Wayland clients' input never traverses XWayland. *"Worst-possible failure
   mode."* Moot for this plan while Focus Read is BLOCKED on Wayland — but it becomes live the
   moment `prefer_x11_backend` is on, where it then works correctly.
2. **macOS: reserved combos also fail silently.** macos.md §U [VERIFIED against `global-hotkey`
   0.8.0, which *is* our shipping code]: the crate passes `inOptions = 0` rather than
   `kEventHotKeyExclusive`, so per `CarbonEvents.h` the same hotkey can be registered by multiple
   applications and `eventHotKeyExistsErr` fires **only for same-process collisions**. Bare
   `Escape` is not on Apple's reserved list, so this is low-risk *for Escape specifically* — but it
   is exactly why the user-configurable `hotkeys.focus_read` binding needs the denylist plan 11
   specifies.
3. **macOS: every press delivers two callbacks.** macos.md §U: handlers are installed for **both**
   `kEventHotKeyPressed` and `kEventHotKeyReleased`. Our code already filters
   (`event.state == ShortcutState::Pressed`, read.rs line 159) — **keep that filter; it is
   load-bearing, not defensive styling.** Combined with plugins-workspace#1748 the multiplier can
   reach 4×.

The existing `ESC_ARMED` guard (only unregister an Escape we armed) stays exactly as-is. It is the
right behaviour on every platform.

### 4.5 Data-model consequences

- `FocusCursorEvent { x, y }` (`src-tauri/src/events.rs` line 126) gains `surface: SurfaceId` from
  plan 07, and its coordinates become **surface-local** rather than virtual-screen-local. On
  Windows/X11 (`SurfaceId::Spanning`) the values are byte-identical to today.
- A new event `focus:unavailable` carrying `CursorUnavailable`, so the UI can explain a
  BLOCKED platform instead of showing a toggle that does nothing.
- `focus_active_state()` (`focus/mod.rs` line 108) gains an availability field, or a sibling command
  `focus_read_available() -> Result<(), CursorUnavailable>` — prefer the latter, so `FocusState`
  stays the small `{ read, blur }` value it is.
- **No settings-schema change.** `FocusReadSettings` is already platform-neutral.

## 5. Implementation steps

1. **Extract `CursorSource` + `CursorUnavailable`;** move the Windows `GetCursorPos` body into
   `focus/cursor_win.rs` behind it; make `spawn_cursor_poll` stop-and-report on `Err`.
   Files: `focus/read.rs`, new `focus/cursor.rs` + `focus/cursor_win.rs`, `events.rs`.
   *Windows behaviour unchanged; the non-Windows arm now returns `Err(Unsupported)` instead of a
   silent `None`.*

2. **Surface unavailability in the UI.** `focus_read_available()` command + `focus:unavailable`
   event; the Focus panel disables the Focus Read toggle with an explanatory reason.
   Files: `focus/mod.rs`, `commands_registry.rs`, `src/bindings.ts` (generated),
   `src/views/main/ui/panels/focus/`, `messages/en.json`.
   *This step alone makes the current silent no-op honest on every non-Windows platform — land it
   early, independent of any other platform work.*

3. **X11 sampler.** `focus/cursor_x11.rs` — `x11rb` `QueryPointer` on the root window. Reuse the
   connection plan 07's X11 backend already opens; do not open a second one.

4. **macOS sampler.** `focus/cursor_mac.rs` — `NSEvent::mouseLocation()` + the main-display-height
   flip. ⚠️ **Blocked on spike S1** (permission status).

5. **macOS `Rects` band geometry.** Implement the shared "tile a screen minus a hole" helper as pure
   code; wire Focus Read's two-rect case into plan 07's `SurfaceContent::Rects`.
   Files: new `focus/geometry.rs` (pure, unit-tested), `focus/read.rs`,
   `overlay_substrate/macos.rs`. Coordinate with plan 09 so the helper is written once.

6. **Wayland: explicit block + the X11 opt-in path.** Return `Err(WaylandNoGlobalPointer)`; verify
   Focus Read works end-to-end once `prefer_x11_backend` is enabled (plan 07 step 8).

7. **Per-surface `focus:cursor`.** Add `surface: SurfaceId`; the renderer filters to its own
   surface. Files: `events.rs`, `focus/read.rs`, `FocusReadShade.tsx`,
   `src/features/focus-read/`.

## 6. Permissions, packaging, distribution

- **Windows:** none.
- **macOS:** **target is zero TCC** — `NSEvent.mouseLocation` is chosen precisely to stay off the
  `CGEventTap` (Input Monitoring) and `addGlobalMonitorForEvents` (Accessibility) paths
  (macos.md §K). ⚠️ **If spike S1 finds `mouseLocation` requires a permission, that changes the
  feature's cost profile substantially** — Focus Read would become the *only* feature demanding a
  grant, and the right response is probably to make it opt-in with an explanation rather than to
  request the permission at launch. Do not pre-commit to requesting anything.
  Global Escape via Carbon `RegisterEventHotKey` needs **no permission** (macos.md §K, §U).
- **Linux X11:** none. `XQueryPointer` on the root window is unprivileged.
- **Linux Wayland:** not applicable — the feature is unavailable.
- **Flatpak / Snap:** X11 socket access is already required by the overlay; no additional portal.
- **Forecloses nothing.** No distribution channel is affected by this plan beyond what plan 07
  already establishes.

## 7. Failure modes & degradation

| Condition | Today | After this plan |
|---|---|---|
| Any non-Windows platform | The overlay shows, the band **never moves**, no error anywhere. The user sees a static dark stripe and assumes the app is broken | `Err(CursorUnavailable)` → the toggle is disabled with a reason; the overlay is never shown |
| Wayland (KDE/GNOME/wlroots) | As above | `WaylandNoGlobalPointer { compositor }` + a pointer to `prefer_x11_backend`, stated once, in the panel |
| macOS, `mouseLocation` returns nothing | — | `PlatformQueryFailed`, logged; stop the poll rather than spin |
| Escape already owned by another app | Already handled — `register_escape` skips arming (line 152) so a user-bound Escape is never clobbered. **The preview then cannot be quit with ESC** | Keep the skip, but *report* it: the Preview UI should show the actual escape route (the toggle, or the configured hotkey) rather than promising ESC |
| Wayland + `prefer_x11_backend` off, user enables Focus Read from the tray/hotkey | Overlay shows, band frozen | The hotkey action checks availability first and surfaces the same explanation via the notification overlay |
| Crash while active | The overlay window dies with the process; screen returns to normal. **No persistent state** | Unchanged — and worth preserving. Focus Read leaks nothing on crash. |

**Restoration:** none needed. Unlike gamma (macos.md §0) or the macOS accessibility grayscale APIs
(macos.md §4), Focus Read holds no global system state. `stop()` unregisters Escape and hides the
overlay; process death does both implicitly.

## 8. Testing

**Unit-testable (CI, every platform):**
- `cursor_moved` — already covered (`read.rs` lines 236–257). Keep.
- **The band geometry helper** — the highest-value new tests. Table-driven over: band fully inside a
  screen; band clipped at the top edge; at the bottom edge; band taller than the screen; band
  entirely off-screen (both rects full-height / zero-height); a screen with a negative origin
  (secondary display above/left of primary); multi-screen with the band crossing a seam.
- The Cocoa↔Quartz flip, asserting negative results survive unclamped.
- `CursorSource` error routing: an `Err` sampler must stop the loop after exactly one sample and
  emit unavailability once, not per tick.
- `CursorUnavailable` → UI message mapping (frontend + `bun run check:i18n`).

**Manual only:**
- Band tracking smoothness at 30 Hz on each platform; whether 30 Hz is enough on a 120 Hz display.
- macOS: menu-bar and Dock region behaviour as the band passes over them (plan 07 spike S2 territory).
- macOS: measure the actual power draw of a moving band with `powermetrics` — a 30 Hz native rect
  resize is the closest thing this app has to an animation, and plan 07 §S makes power a first-class
  concern on this platform.
- Multi-monitor with mixed DPI: does the band land at the right height on the secondary display.
- X11: behaviour with a reparenting WM and with a compositor running.
- ESC while another app has keyboard focus (the whole point of a *global* Escape).

**Cannot be tested in CI:** everything manual. Note additionally that **macOS permission behaviour
is untestable under `tauri dev`** — it produces no `.app`, no Info.plist, no bundle ID (macos.md
§L), and a dev binary launched from a terminal *inherits the terminal's grants*. Spike S1 must be
run against a signed, bundled `.app`.

## 9. Open questions / spikes needed

**S1 — Does `NSEvent.mouseLocation` require any TCC permission? BLOCKING step 4.**
The research is silent on position-only reads. It is explicit that **event taps** need Input
Monitoring (macos.md §K, §U) and that **global event monitors** need Accessibility (§K), but
`mouseLocation` is neither — it is a synchronous read of current state, in the same family as
`CGWindowListCopyWindowInfo`, which macos.md §F confirms *"never triggers a permission prompt."*
The mechanical expectation is therefore "no permission", but **that is an inference, not a finding,
and this plan must not upgrade it to a claim.**
**Action:** on a signed, bundled `.app` on a Mac with **no** grants (and ideally a fresh TCC state),
poll `NSEvent.mouseLocation` and check: does it return real coordinates or `(0,0)`; does any prompt
appear; does `log stream` show a TCC denial. Repeat under the App Sandbox. Estimated: 2 hours,
foldable into plan 07's S2 session. **If it does require a permission, escalate — it changes the
product posture, not just this plan.**

**S2 — Is there any compositor IPC that exposes pointer position? NON-BLOCKING; decides whether
Wayland stays BLOCKED or becomes PARTIAL on two compositors.**
linux.md's compositor-IPC table covers geometry, PID and focus — **not pointer position**. Verify
whether Hyprland (`hyprctl cursorpos`?) and sway (i3-IPC seat/input?) expose it, and if so whether
it is pollable at 30 Hz without unreasonable cost.
**Recommendation regardless of outcome: do not build it for v1.** Even a positive result covers
only Hyprland and sway; KDE and GNOME Wayland — the seats that matter — would remain BLOCKED, so
the UI still needs the unavailability path, and `prefer_x11_backend` still needs to exist. Record
the answer; defer the work.

**S3 — Is 30 Hz the right rate on macOS given the native-rect redraw? NON-BLOCKING.**
The current 33 ms poll was tuned against a Windows webview. With `SurfaceContent::Rects` each sample
is a native `setFrame:`. Measure; consider driving from `CVDisplayLink` instead of a sleep loop.

**Q1 — Should Focus Read be hidden entirely on platforms where it can never work, or shown
disabled with an explanation?**
**Recommendation: shown, disabled, explained.** A missing feature reads as a missing feature; a
disabled one with "not available on Wayland — see Display backend setting" both explains itself and
advertises the fix. This matches plan 07's stance on silent no-ops.

**Q2 — What does Preview mode do when ESC could not be armed?**
Currently: nothing tells the user. Small, cheap fix (§7) — but it needs a copy decision, and it is
the one place where the existing careful `ESC_ARMED` logic produces a silently degraded UX.

## 10. Effort

| Platform | Size | Notes |
|---|---|---|
| Windows | **XS** | Refactor only (steps 1, 7). Behaviour identical. |
| Linux X11 | **S** | Step 3 is a single `QueryPointer` call against a connection plan 07 already owns. |
| macOS | **M** | Steps 4–5. Small if S1 comes back clean; the `Rects` geometry is shared with plan 09. |
| Linux Wayland | **XS** | Step 6 is a `const Err` plus UI copy. **The work here is honesty, not capability.** |
| Shared / UI | **S** | Step 2 — and it is the highest value-per-hour item in the plan. |

**Single biggest risk: spike S1.** If `NSEvent.mouseLocation` turns out to be permission-gated,
Focus Read becomes the only DimRead feature that requires a TCC grant, which conflicts directly with
the zero-permission posture plan 07 establishes as a design goal. The fallback would be to ship
Focus Read on macOS as explicitly opt-in with an in-context explanation — acceptable, but a product
decision that should be made deliberately rather than discovered during implementation.

**Second risk, worth naming: this feature is small and the temptation is to treat Wayland as
"TODO".** It is not TODO — it is BLOCKED for structural reasons that will not change (§3.1). Writing
it down as unavailable, with the reason, *is* the deliverable for that platform.
