# macOS platform research — 2026-07

Baseline: **macOS Tahoe 26.5.2** (2026-06-29), the last Intel-supporting release; macOS Golden Gate
(late 2026) is Apple-silicon-only.

**Crate policy:** `cocoa` / `cocoa-foundation` are **deprecated** in favour of `objc2-*`
(servo/core-foundation-rs#729). The legacy `core-graphics` crate is fine for display enumeration but
**has no gamma bindings at all** — use **`objc2-core-graphics`** (v0.3.2, 2026-05-29).

---

## 0. HEADLINE: gamma tinting is degrading on macOS

**`CGSetDisplayTransferByTable` is silently ignored on M5-class hardware.**
Apple Developer Forums thread 819331, reproduced by Apple DTS:

- On macOS **26.3.1 / 26.4 RC / 26.5.1**, on **M5 Pro, M5 Max, MacBook Neo**: the call returns
  `kCGErrorSuccess`, `CGGetDisplayTransferByTable` **reads the values back correctly**, and
  **nothing changes on screen**. Ignored at the display-pipeline level.
- M5 (non-Max) and M3 Max unaffected. Radars **FB22273730** / **FB22273782** with engineering as of
  2026-06. Apple believes it is GPU driver / display-controller firmware, not CoreGraphics.
- **Every app in this category is affected**: f.lux, Lunar, BetterDisplay, MonitorControl.
- XDR + auto-brightness in EDR mode: the LUT now multiplies across the **entire EDR range** and can
  leave the display corrupted **after the process exits**.
- DTS's only suggested workaround: `ColorSyncDeviceSetCustomProfiles()` (different pipeline path).

> **Consequence for us: a capability probe that writes-then-reads-back is NOT sufficient on macOS —
> the readback lies.** Gamma must be a user-visible, disableable *enhancement*, not the primary
> mechanism. **Overlay windows are the defensible primary architecture on macOS.**

Other gamma constraints (Lunar FAQ, primary source):
- **HDR is mutually exclusive with gamma** — macOS *disables HDR* when a gamma table is applied.
- **Single global resource, last-writer-wins.** We will fight f.lux/Lunar with no arbitration.
- Known macOS bug: gamma API "will sometimes set all RGB Gamma tables to 0" → black screen + flicker.
- macOS 26.3 put XDR preset validation **under SIP**.
- A crashed process leaves the display tinted unless `CGDisplayRestoreColorSyncSettings()` ran
  (f.lux's documented manual fix is "change the colour profile and change it back").

**Reset triggers:** register `CGDisplayRegisterReconfigurationCallback` and re-apply on sleep/wake,
hot-plug, resolution change, colour-profile change, fast user switching.

---

## 1. Gamma API (if we use it as an enhancement)

```rust
// objc2-core-graphics, features: CGDirectDisplay, CGError
pub unsafe extern "C-unwind" fn CGSetDisplayTransferByTable(
    display: CGDirectDisplayID, table_size: u32,
    red_table: *const CGGammaValue, green_table: *const CGGammaValue, blue_table: *const CGGammaValue,
) -> CGError
```
Also `CGGetDisplayTransferByTable`, `CGSetDisplayTransferByFormula`, `CGDisplayGammaTableCapacity`,
`CGDisplayRestoreColorSyncSettings`. **No entitlement, no TCC prompt, sandbox-safe, not deprecated.**

⚠️ Tables are **`f32` (`CGGammaValue`) 0.0–1.0**, not `u16`. Our `GammaRamp = [[u16;256];3]` needs
conversion + a queryable size (`CGDisplayGammaTableCapacity`).

**`CGDisplayFade` is NOT viable** for steady-state tint — a fade reservation is time-limited
(~15 s max) and designed for transitions.

### Night Shift — the least-bad private API here
`CBBlueLightClient` in **CoreBrightness.framework** (header verified via Shifty):
`+supportsBlueLightReduction`, `-setStrength:commit:` (0.0–1.0), `-setEnabled:`,
`-setMode:` (0=off, 1=sunset-sunrise, 2=custom), `-setSchedule:`, `-getStrength:`,
`-getBlueLightStatus:`, `-setStatusNotificationBlock:`.
Driven in production by srirangav/displayutil. **Risk: MEDIUM** — private (App Store out),
notarization unaffected, but stable since 10.12.4 across Shifty/NightOwl/displayutil. No Rust crate;
call via `objc2` `msg_send!`.

---

## 2. Hardware brightness — all private

**Built-in** (from displayutil `displayutil_brightness.m`):
- **CoreDisplay.framework**: `CoreDisplay_Display_GetUserBrightness(CGDirectDisplayID) -> double`,
  `CoreDisplay_Display_SetUserBrightness` (declared `__attribute__((weak_import))`)
- **DisplayServices.framework**: `DisplayServicesGet/SetBrightness` — "necessary on Apple
  Silicon/macOS 11"
- `IODisplaySetFloatParameter` + `kIODisplayBrightnessKey` — **no-op on Apple Silicon**, displayutil
  deliberately does not use it

Rust: raw FFI + `dlopen` of the PrivateFrameworks. No crate. **Risk: MEDIUM-HIGH.**

**External — DDC/CI.** Reference: MonitorControl `Arm64DDC.swift`.
Apple Silicon uses `IOAVServiceCreateWithService` / `IOAVServiceWriteI2C` / `IOAVServiceReadI2C`
(private); `ARM64_DDC_7BIT_ADDRESS = 0x37`, `ARM64_DDC_DATA_ADDRESS = 0x51`; packet
`[0x80|(len+1), len] + data + [0]` with XOR checksum. Intel uses `IOFramebufferPortFromCGDisplayID`
+ `IOI2CSendRequest`. VCP `0x10` brightness, `0x12` contrast, `0x16/18/1A` RGB gain.

⚠️ **`ddc-hi` does NOT cover the Apple-silicon `IOAVService` path.** Expect to port
`Arm64DDC.swift` to raw FFI. **Budget real time.**

⚠️ **IOAVService↔display matching is heuristic**, not authoritative: MonitorControl scores EDID UUID
segments (vendor/product/manufacture date/image size) + up to 10 points for location, then does
greedy allocation with taken-sets to prevent double-assignment.

**Field failures** (Lunar FAQ): 2018 Mac mini HDMI blocks DDC; many HDMI→USB-C cables block it
(DisplayPort more reliable); Samsung M7/M9/G7/G9 accept DDC only over HDMI; some TB hubs forward to
only one monitor. Monitor settings that break it: Samsung Input Signal Plus / Magic Bright / Eye
Saver, LG Uniformity / Auto Brightness, BenQ B.I.+.

---

## 3. Display enumeration + stable ID

`objc2-core-graphics`: `CGGetActiveDisplayList`, `CGGetOnlineDisplayList`, `CGMainDisplayID`,
`CGDisplayBounds`, `CGDisplayIsBuiltin`, `CGDisplayIsMain`, `CGDisplayModelNumber`,
`CGDisplayVendorNumber`, `CGDisplaySerialNumber`, `CGDisplayScreenSize`, `CGDisplayUnitNumber`,
`CGDisplayRegisterReconfigurationCallback`.

`objc2-app-kit` `NSScreen`: `frame()`, **`visibleFrame()` = work area** (menu bar + Dock already
subtracted), `backingScaleFactor()`, `localizedName()`, `deviceDescription()["NSScreenNumber"]` to
bridge to `CGDirectDisplayID`, **`safeAreaInsets()` / `auxiliaryTopLeftArea()` for notch handling**.
`screens(mtm)` / `mainScreen(mtm)` are **main-thread-only** (`MainThreadMarker`).

**Stable ID: `CGDisplayCreateUUIDFromDisplayID`.** `CGDirectDisplayID` is NOT stable across
reboot/hot-plug (Lunar's own code says so). Lunar persists settings keyed on this UUID plus
`edidName` + transport metadata to disambiguate identical panels.
⚠️ **No crate binds it** — declare by hand, as winit does:
```rust
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    pub fn CGDisplayCreateUUIDFromDisplayID(display: CGDirectDisplayID) -> *mut CFUUID;
    pub fn CGDisplayGetDisplayIDFromUUID(uuid: &CFUUID) -> CGDirectDisplayID;
}
```
Link **ApplicationServices**, not ColorSync.

**Tauri's `Monitor` is insufficient** — name/size/position/work_area/scale_factor only, no stable ID,
and `name()` goes `None` on disconnect.

**Coordinates:** Quartz = top-left origin, y-down. Cocoa/NSScreen = bottom-left origin, y-up,
relative to the *primary* screen. Convert `y_cocoa = primary_height - y_quartz - height`.
**Secondary displays above/left of primary produce negative coordinates in both.**

---

## 4. Grayscale / invert

### Gamma cannot do grayscale — proof
`CGSetDisplayTransferByTable` takes **three independent 1-D LUTs**: `out_R = f_R(in_R)` etc. Each
output channel depends only on its own input. Grayscale needs
`out = 0.2126R + 0.7152G + 0.0722B` — a **cross-channel matrix multiply**. A per-channel 1-D LUT
cannot express it for any choice of tables. **Impossible, not merely hard.**
(Identical conclusion to Linux — this is a universal constraint, not a platform quirk.)

Inversion *is* per-channel and therefore expressible as a descending LUT — **but Lunar forces a
white overlay instead** because "gamma tables can't be inverted in a precise enough way"
(quantisation + panel transfer curve). Treat gamma-invert as unusable.

**What a per-channel LUT CAN do:** brightness scaling, per-channel gain (= colour temperature,
f.lux's mechanism), contrast/black-point, per-channel gamma curves. That is the whole envelope.

### The private APIs that do work
`CGSAccessibility.h`: `CGDisplayForceToGray(bool)`, `CGDisplayUsesForceToGray()`,
`CGDisplaySetInvertedPolarity(bool)`, `CGDisplayUsesInvertedPolarity()`, `CGSSetDisplayContrast()`.
Present in the shipped `CoreGraphics.tbd`, so dynamically linkable.

⚠️ **`CGDisplayForceToGray` degraded on Apple silicon** — displayutil's source comment: *"use
universal access instead of core graphics on M1."* UniversalAccess.framework:
`UAGrayscaleSetEnabled(int)`, `UAGrayscaleIsEnabled()`, `UAGrayscaleSynchronizeLegacyPref()`
— then **restart the universalaccess daemon** so it applies immediately.
(Note: `UAGrayscaleEnabled`/`UAWhitePointEnabled` return zero GitHub hits — wrong symbol names.)
`defaults write com.apple.universalaccess grayscale -bool true` alone does **not** apply live.

**Risk: HIGH.** This is the *accessibility* subsystem — **system-wide global state that persists
after our app quits**. Crash mid-toggle and the user's Mac is stuck in grayscale with no obvious
cause. If shipped: crash handler + restore-on-launch, mandatory.

**No colour-matrix API exists** at the CGS level either (`CGSDisplays.h` has nothing
grayscale/invert/filter/matrix related).

**An overlay cannot grayscale what is behind it** — only additive/multiplicative tint. See §8.

---

## 5. Foreground window tracking

**Free, no permission:** `NSWorkspace.frontmostApplication` / `menuBarOwningApplication` +
`NSWorkspaceDidActivateApplicationNotification` → PID, bundle ID, name, icon of the frontmost **app**.

**Window geometry needs Accessibility (TCC `kTCCServiceAccessibility`):**
`AXUIElementCreateApplication(pid)` → `kAXFocusedWindowAttribute` → `kAXPositionAttribute` /
`kAXSizeAttribute` (unwrap with `AXValueGetValue`, `kAXValueCGPointType`/`kAXValueCGSizeType`).
Push updates via `AXObserverCreate` + `kAXFocusedWindowChangedNotification` /
`kAXWindowMovedNotification` / `kAXWindowResizedNotification`.

**Rust: `accessibility-sys` v0.2.0 (2026-06-09), actively maintained and complete.** (The
higher-level `accessibility` crate self-describes as "spotty" — use `-sys`.)

**Permission UX:** `AXIsProcessTrustedWithOptions` + `kAXTrustedCheckOptionPrompt` shows a system
alert deep-linking to Privacy & Security → Accessibility. ⚠️ **The grant is keyed to the code
signature** — every re-signed dev build is a new identity, so we re-prompt constantly in development
and users may re-grant after updates.

**Precedent — HazeOver (our direct analogue) makes Accessibility OPTIONAL**: it works without it
(NSWorkspace-based); with it, it "react[s] instantly when you switch between windows and detect[s]
the focused window even more reliably." **Copy this — never gate the app behind a first-launch TCC
prompt.**

---

## 6. Window enumeration

`CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
kCGNullWindowID)` → `kCGWindowNumber`, `kCGWindowOwnerPID`, `kCGWindowOwnerName`, `kCGWindowName`,
`kCGWindowBounds`, `kCGWindowLayer`, `kCGWindowAlpha`, `kCGWindowIsOnscreen`.

**Permission split: everything works EXCEPT `kCGWindowName`**, which is redacted without Screen
Recording (`kTCCServiceScreenCapture`). Window number, PID, **owner app name**, bounds, layer, alpha
all come through unpermissioned.

> **For our Rules feature the unpermissioned subset is sufficient** (we match on process/app name).
> **Do NOT request Screen Recording** — it is the highest-friction macOS permission and Sequoia's
> periodic re-prompting made users hostile to it.

Gates: `CGPreflightScreenCaptureAccess()` / `CGRequestScreenCaptureAccess()` — available as safe
wrappers in `core-graphics` (`ScreenCaptureAccess::preflight()/request()`).
`CGWindowListCopyWindowInfo` is **not** deprecated (the *capture* functions are — irrelevant to us).

---

## 7. Overlay windows

### Window levels (verified)
| Level | Value | | Level | Value |
|---|---|---|---|---|
| normal | 0 | | status | 25 |
| floating | 3 | | **popUpMenu / screenSaver** | **101** |
| modalPanel | 8 | | overlayWindow | 102 |
| utility | 19 | | help | 200 |
| **dock** | **20** | | dragging | 500 |
| **mainMenu** | **24** | | assistiveTechHigh | 1500 |

> **To cover both menu bar and Dock you need level ≥ 101.** Level 25 is not enough.

### Recipe
`ignoresMouseEvents = true`; `styleMask = .borderless`; `isOpaque = false`; `hasShadow = false`;
`collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]`
(`.fullScreenAuxiliary` is what allows sitting over a fullscreen app's space);
`NSPanel` + `.nonactivatingPanel` so it never steals focus;
`NSApplication.ActivationPolicy.accessory` (LSUIElement).

**One window per `NSScreen`, not one spanning window** — spanning is unreliable across mixed scale
factors and breaks on reconfiguration. Observe
`NSApplication.didChangeScreenParametersNotification` and rebuild.

### Tauri v2 gaps — must reach the raw `NSWindow` via `ns_window()` + `objc2 msg_send!`
Tauri exposes `always_on_top`, `decorations`, `transparent`, `shadow`,
`visible_on_all_workspaces`, `focus(false)`, `set_ignore_cursor_events`, `content_protected`.
**Not exposed:** the numeric window **level** (Tauri's `always_on_top` maps to `.floating` = 3,
which will **not** cover menu bar or Dock), `.nonactivatingPanel`, full `collectionBehavior`.

⚠️ **`transparent: true` requires `"macOSPrivateApi": true`** → **App Store rejection**
(tauri-docs#463). Notarization is unaffected.

**CORRECTED — App Store is not automatically off the table.** A second research pass found
**MonitorControl *Lite* ships on the Mac App Store** (id1595464182), deliberately stripping DDC and
Apple-display control while **keeping "advanced gammatable based control or overlay dimming"**.
So the real fork is:

| Tier | Sandbox / App Store |
|---|---|
| Gamma + **native `NSWindow`** overlay | ✅ clean, sandboxable, MAS-shippable |
| Overlay as a **Tauri transparent window** | ❌ needs `macOSPrivateApi` |
| DDC, DisplayServices, CoreBrightness, UniversalAccess | ❌ private → MAS reject (2.5.1) |

→ *If a MAS SKU ever matters, build the overlay as a raw `NSWindow` via `objc2` rather than a Tauri
window, and keep the private-API tiers behind a build feature.* Otherwise Developer ID + notarized.

Watch: tauri#13415 (transparency lost after DMG build — windows render solid white),
tauri#11142 (Cargo feature `macos-private-api` vs the JSON flag must be set consistently).

### Two overlay gotchas
1. ⚠️ **UNRESOLVED — screenshot capture. Two research passes contradicted each other.**
   - Pass A: "the tint WILL appear in screenshots and recordings; gamma does not, overlays do",
     citing tauri#14200 (`NSWindow.sharingType = .none` / `setContentProtection(true)` **ignored by
     ScreenCaptureKit on macOS 15+**, `status: upstream`, no workaround) and Lunar's mitigation of
     watching for screencapture events and temporarily removing the overlay.
   - Pass B: asserted the overlay "unlike gamma, **is not** captured in screenshots" — but its own
     coverage-gaps section then admitted it *could not source* the screenshot question.
   - **Adjudication: Pass A is more likely correct** — it is mechanically consistent (an overlay is
     composited into the framebuffer *before* capture; gamma is applied by the display pipeline
     *after*), and it cites a specific live Tauri issue. Pass B contradicts itself.
   - **Action: VERIFY EMPIRICALLY on a real Mac before promising either behaviour.** This decides
     whether CareUEyes' "no yellow screenshots" selling point survives on macOS, and it is the
     single most user-visible difference between the gamma and overlay paths.
2. **Notch:** `NSScreen.frame` includes the notch region — use `safeAreaInsets` /
   `auxiliaryTopLeftArea`.

---

## 8. Per-window effects on other apps' windows — **NO**

Windows' Magnification API has no macOS equivalent.

The private API exists but is **owner-restricted**. `CGSCIFilter.h` has `CGSNewCIFilterByName`,
`CGSAddWindowFilter(cid, wid, filter, flags)`, `CGSSetCIFilterValuesFromDictionary`,
`CGSRemoveWindowFilter` — signatures *look* cross-process (explicit connection ID + arbitrary window
ID), but `CGSWindow.h` states the rule: **"Only the owner can change most properties of the
window."** WindowServer enforces ownership at the connection level; passing a foreign `CGWindowID`
fails.

**yabai proves the exception and its cost:** it gets cross-process transparency only via a scripting
addition that **injects into Dock.app** (which "owns the sole connection to the macOS window
server"), requiring **SIP partially disabled** — on Apple silicon macOS 13+ that means Filesystem
Protections, Debugging Restrictions **and** NVRAM Protection off. Non-starter for a consumer app.

`NSWindow.order(_:relativeTo:)` does **not** work cross-process.

### What HazeOver actually does — and this is our Focus Blur architecture
It "adds a translucent dark layer **behind** the window you're using": **one overlay per screen,
ordered just below the frontmost window.** Everything below the layer dims; the front window sits
above and does not. ~90% of the perceived benefit, zero private API, zero SIP.

Screen-record-and-re-render is impractical: Screen Recording TCC, ≥1 frame latency, cannot occlude
the original, breaks on every Space/fullscreen transition.

---

## 9. System light/dark theme

**Read — fully public, zero permissions:** `NSApp.effectiveAppearance` (KVO-observable),
`NSAppearance.currentDrawing`, `defaults read -g AppleInterfaceStyle` (absent = light),
`AppleInterfaceStyleSwitchesAutomatically`, distributed notification
`AppleInterfaceThemeChangedNotification`. Tauri v2 gives `window.theme()` + `ThemeChanged`.

**Set — no public API.** Preferred route, **SkyLight** (from displayutil `displayutil_darkmode.m`):
```c
extern BOOL SLSGetAppearanceThemeLegacy(void);
extern BOOL SLSSetAppearanceThemeLegacy(BOOL mode);
extern BOOL SLSSetAppearanceThemeNotifying(BOOL mode, BOOL notifyListeners);
```
Plain `extern` — resolved by dynamic linking, no `dlopen` needed. Use the `Notifying` variant so
other apps repaint. Same mechanism as Nightfall, DarkModeBuddy, DarkMenuBar, zigcli's `dark-mode`
(94 repos reference the symbol). **Risk: LOW-MEDIUM.**

AppleScript alternative triggers an **Automation TCC prompt**, needs `NSAppleEventsUsageDescription`,
blocked under App Sandbox. Slower, more fragile.
`defaults write -g AppleInterfaceStyle Dark` **does not apply live** — skip.

---

## 10. Global hotkeys + login item

**Hotkeys — no permission needed if we avoid media keys.** `global-hotkey` (under
`tauri-plugin-global-shortcut`) uses Carbon `RegisterEventHotKey` +
`InstallEventHandler(kEventHotKeyPressed/Released)` — **no TCC**. Carbon is ancient but
`RegisterEventHotKey` remains the supported path; Apple never shipped a replacement.
**Media keys** go through `CGEventTapCreate(SystemDefined)` → **requires Accessibility**.
→ *Bind only ordinary combos and we need zero permissions.*
macOS reserves Cmd-Tab, Cmd-Space, Ctrl-arrows, F11/F12 — registration fails rather than overrides.

**Login item — the plugin is behind current macOS.** `tauri-plugin-autostart` delegates to the
`auto-launch` crate: `MacosLauncher::LaunchAgent` (writes `~/Library/LaunchAgents/*.plist`) or
`AppleScript`. **It does not use `SMAppService`**, which since macOS 13 is the sanctioned API and the
one that populates **System Settings → General → Login Items** with a proper entry. A hand-written
LaunchAgent still works on Tahoe but surfaces as a less-integrated "background item".
→ *Use the plugin for expedience; plan to call `SMAppService` via `objc2` for polish.*

---

## Architectural recommendation (from the researcher, endorsed)

1. **Primary: per-screen overlay windows** at level 101, click-through,
   `.canJoinAllSpaces + .fullScreenAuxiliary`, one per `NSScreen`, keyed by
   `CGDisplayCreateUUIDFromDisplayID`. Public API, no permissions, works on every Mac, survives the
   M5 bug. Delivers tint + dim.
2. **Optional: gamma** (`objc2-core-graphics`) for true colour-temperature shift, behind a
   user-visible toggle with a runtime probe. ⚠️ **Readback cannot be trusted on M5** — needs a
   heuristic or user confirmation. Auto-disable on HDR displays.
3. **Optional: Night Shift** via `CBBlueLightClient` — lowest-risk private API, composes with the
   system instead of fighting it.
4. **Skip entirely:** per-window foreign effects (§8, impossible without SIP off); gamma-based
   grayscale (§4, mathematically impossible).
5. **Accept: no Mac App Store** — `macOSPrivateApi` is required for transparent windows alone.
   Ship Developer ID + notarized.
6. **Permissions posture: ship needing ZERO TCC grants.** Accessibility optional (better focus
   tracking); never request Screen Recording.

### Research caveats
Apple's doc pages are JS-rendered and could not be fetched; deprecation status was verified via the
Rust bindings (which mirror Apple's availability macros) and the developer forums. The search budget
ran out partway; the latter half was verified via direct source fetches and the GitHub code-search
API — arguably stronger evidence. Claims are backed by quoted source from Lunar, MonitorControl,
Shifty, displayutil, yabai, winit, servo/core-foundation-rs and the CGSInternal headers.

---

# LATE ADDITIONS (4th research pass) — corrections and new options

## A. Stable monitor ID — corrections to §3

- **Linkage:** `CGDisplayCreateUUIDFromDisplayID` / `GetDisplayIDFromUUID` are exported by
  **`ColorSync.tbd`, NOT `CoreGraphics.tbd`** (verified by grepping SDK stub libraries). Link
  `ColorSync` **or** `ApplicationServices` (which re-exports it). Linking CoreGraphics fails.
- **Apple does not promise UUID stability.** The docs page carries no discussion text; the claim
  rests on third-party consensus. Treat as *empirically reliable, contractually unpromised*.
- ⚠️ **Tauri cannot distinguish two identical monitors on macOS at all.** tao implements
  `Monitor::name()` as `format!("Monitor #{}", CGDisplay::new(id).model_number())` — the **model
  number**, not `NSScreen.localizedName`. Two identical panels get **byte-identical names**.
- ⚠️ **MonitorControl deliberately keys prefs on the TRANSIENT display ID**:
  `"(name + vendor + model + @ + (isVirtual ? serial : identifier))"`. They accepted orphaned prefs
  on reordering rather than risk two identical monitors colliding onto one settings blob. That is an
  informed trade-off by the people who know this API best — **calibrate expectations accordingly:
  there is no perfect answer, only a sensible degradation ladder.**
- **Recommended ladder:** UUID → on collision append `CGDisplayBounds().origin` (position — what
  users actually think in, and survives reboots better than the display ID) → `CGDisplayUnitNumber`
  → store `localizedName` for UI/heuristic rematch. **Never hard-fail on a miss**; fall back to
  defaults and re-learn.
- **EDID sentinels are common:** vendor/model `0xFFFF_FFFF` and **serial `0x0000_0000`** mean
  "absent". Many panels ship no EDID serial — the mechanical root of the identical-monitors problem.
- Use **`CGGetOnlineDisplayList`**, not `CGGetActiveDisplayList` — a tinting app wants hardware
  presence, not drawability (Active excludes mirrored secondaries).
- ⚠️ **`NSScreen.main` is NOT the primary screen** — it is the screen with the keyboard-focused
  window, so it changes as the user moves windows. For "the display with the menu bar" use
  `CGMainDisplayID()`. Very common bug.
- `NSScreen.screens[0]` is conventionally the menu-bar screen but is not guaranteed.
- `didChangeScreenParametersNotification` is **coalesced and often late**, arriving in bursts with
  transient intermediate states during hot-plug → **debounce ~500 ms and re-enumerate from scratch**
  rather than diffing. (Practitioner knowledge; Apple's page could not be fetched.)
- Coordinate flip must use the **main display's** height, never a per-screen height:
  `y_cocoa = mainHeight - (y_quartz + height)`. Displays above/left of main give **negative**
  coordinates — never clamp to >= 0.

## B. ★ Grayscale — a better path than §4 described: MediaAccessibility

`UniversalAccess.framework` turns out to be **just a wrapper**: it calls `CGDisplayForceToGray`,
then the MediaAccessibility functions, then syncs the legacy pref. **Call MediaAccessibility
directly** — same mechanism, one less private framework, no PrivateFrameworks link flag.

```c
// /System/Library/Frameworks/MediaAccessibility.framework  (PUBLIC framework, private symbols)
void MADisplayFilterPrefSetCategoryEnabled(int filter, bool enable);
bool MADisplayFilterPrefGetCategoryEnabled(int filter);
void MADisplayFilterPrefSetType(int filter, int type);
// /usr/lib/libUniversalAccess.dylib
void _UniversalAccessDStart(int magic);   // magic = 0x8 — REQUIRED, kicks the daemon
// SYSTEM_FILTER = 0x1, GRAYSCALE_TYPE = 0x1
```

**Architecture:** `MADisplayFilterPref*` writes `com.apple.mediaaccessibility` and posts the Darwin
notification `com.apple.mediaaccessibility.displayFilterSettingsChanged`;
`/usr/sbin/universalaccessd` listens and performs the toggle. **The daemon is not always running** —
hence the `_UniversalAccessDStart` kick. This path **works on Apple Silicon**, where
`CGDisplayForceToGray` is unreliable.

### ★★ Directly on-point for an eye-protection app, and immune to the Tahoe gamma bug

MediaAccessibility also exposes **matrix-based** filters:
`MADisplayFilterPrefSetReduceWhitePointIntensity`, `MADisplayFilterPrefSetWarmthIntensity`,
`MADisplayFilterCreateRedNightMode`, `MADisplayFilterSetMatrix`, `MADisplayFilterSetGain`.
Because these are **matrix**, not LUT, they suffer neither the gamma-table limits nor the
Tahoe/M5 silent-failure bug. **Worth serious evaluation as a macOS tint path.**
⚠️ Private; system-wide (no per-display scoping); intensity setters reported inconsistent in
community reverse-engineering; **untested on macOS 26** (no breakage reports through 2025).

### Grayscale impossibility — the clean proof (confirms §4)

> Suppose per-channel LUTs achieved grayscale. Then for every input `(r,g,b)` the output is neutral:
> `LUT_R(r) = LUT_G(g) = LUT_B(b)`. Hold `g,b` fixed and vary `r`: the RHS is constant, so `LUT_R`
> is constant. By symmetry all three are constant → a flat uniform colour, not grayscale. ∎

Corroboration that Apple agrees: the OS implements grayscale with an actual colour matrix one layer
lower (`MADisplayFilterCreateGrayscale`, `MADisplayFilterSetMatrix`).

### Inversion — a genuine differentiator

`out = 1 − in` **is** per-channel, so a descending LUT gives **per-display Classic Invert using
PUBLIC APIs** — better than the system's, which is global. (Weigh against the earlier note that
Lunar avoids gamma-invert due to LUT quantisation; per-display scoping may justify it anyway.)

### `defaults write com.apple.universalaccess grayscale` — **does not work**

Legacy key written *by* the daemon as output, never read as input; the real state lives in
`com.apple.mediaaccessibility`; and the daemon acts on the **Darwin notification**, which `defaults`
does not post. The recipes circulating online are Mojave-era and stale.

## C. Backdrop filtering — definitively impossible (hardens §8)

- `NSVisualEffectView`: fixed `material` enum, no CIFilter injection.
- `CALayer.backgroundFilters` / `compositingFilter`: Apple's own wording scopes these to **your own
  in-process layer tree**. WindowServer composites windows source-over in a different process;
  client-side filters never enter that stage. An overlay **cannot** grayscale what is behind it.
- `CGSAddWindowFilter` underlay: the sole extant demo is from **2008** and uses only
  `CIGaussianBlur`; no working grayscale/invert example in 18 years. Treat as blur-only.
- `CGSSetWindowBackgroundBlurRadius`: alive (wezterm/iTerm2) but blur only, and has caused **actual
  App Store rejection**.
- `CABackdropLayer` + `CAFilter` (`colorMonochrome`, `invertColors`): the one **untested** lead — but
  that vocabulary comes from *iOS/UIKit* reverse engineering. **Cheap to falsify; spike it before
  designing around it.**
- ScreenCaptureKit + Metal is the only public arbitrary-filter path, but costs continuous
  full-screen GPU load, >=1 frame latency, and **Sequoia's recurring (roughly monthly)
  screen-recording consent prompt** — a heavy UX tax for an always-on eye-comfort utility.

**Nobody has shipped window-scoped grayscale on macOS.** HazeOver uses plain alpha overlays; f.lux /
Shifty / Gamma Dimmer use gamma ramps.

## D. Overlay recipe (battle-tested, from MonitorControl)

```swift
shade.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
shade.collectionBehavior = [.stationary, .canJoinAllSpaces, .ignoresCycle]
shade.ignoresMouseEvents = true
shade.backgroundColor = .clear
shade.setFrame(screen.frame, display: true)
shade.orderFrontRegardless()
```

`CGShieldingWindowLevel()` + `.canJoinAllSpaces` + `.stationary` is the combination that survives
Spaces switching and full-screen apps. **Per-display** — a genuine advantage over the global
grayscale APIs, and it composes with per-display warm-tint gamma.
(Note: Apple cautions against relying on `CGShieldingWindowLevel()` for positioning; verify menu-bar
and fullscreen coverage empirically, and cross-check against the level >= 101 guidance in §7.)

---

# LATE ADDITIONS II (5th pass) — window tracking, and the Focus Blur architecture

## E. ★★ THE ARCHITECTURE FOR FOCUS BLUR: the geometric cutout overlay

**This is the answer, and it is verified against two independent shipping implementations.**

Do **not** dim per-window. Draw **four filled rectangles** tiling the union of all screens **minus
the focused window's frame** — punching a hole. From Hammerspoon `hs.window.highlight`
(`extensions/window/window_highlight.lua`), whose docstring describes exactly our product
(*"highlights the currently focused window by covering other windows and the desktop"*):

```lua
rt:setFrame{x=sf.x,     y=sf.y,     w=f.x+f.w-sf.x, h=f.y-sf.y}          -- top
rl:setFrame{x=sf.x,     y=f.y,      w=f.x-sf.x,     h=sf.h-f.y+sf.y}     -- left
rb:setFrame{x=f.x,      y=f.y+f.h,  w=sf.w-f.x,     h=sf.h-f.y-f.h+sf.y} -- bottom
rr:setFrame{x=f.x+f.w,  y=sf.y,     w=sf.w-f.x-f.w, h=f.y+f.h-sf.y}      -- right
```
Defaults: `isolateColor={0,0,0,0.95}`, `overlayColor={0.2,0.05,0,0.25}`,
`collectionBehavior = 9` (`canJoinAllSpaces | transient`). Multi-monitor via union of
`screen.allScreens()`.

> **Why this dissolves the entire z-order problem:** because the overlay never covers the focused
> window's rect, its stacking order *relative to that window is irrelevant*. Put it at a high level
> above all normal windows and it dims everything else. **We never need to insert a window between
> two windows of another app.** That is what makes the whole approach possible with ZERO private APIs.

**HazeOver proves it is clean: it ships on the Mac App Store** (id430798174, v1.9.7, macOS 12+,
1.5 MB). MAS has mandated App Sandbox since 2012, so HazeOver **provably uses no private CGS APIs
and no code injection**. Its help text confirms the geometric model with a revealing edge case:
*"HazeOver dims everything because the front app has no focused window"* when all windows are closed.
Accessibility is optional there and only improves focus-detection latency.

**Selective dimming (we can beat HazeOver):** `CGWindowListCopyWindowInfo` gives every window's
bounds + layer in front-to-back z-order with **no permission**. Compute each background window's
*visible* region (subtract the union of rects above it) and draw one overlay rect per region.

### Limits — be precise
- Dimming is **geometric, not z-ordered**. A window above our overlay in z-order cannot be dimmed.
- ⚠️ **Foreign fullscreen apps are the hard wall.** `NSWindowCollectionBehavior.fullScreenAuxiliary`
  does **NOT** put us above another app's fullscreen window — it lets a window share a space with
  *our own* fullscreen window (Apple forum 26677 ends with no working combination).
  **Plan to disable dimming when a foreign app goes fullscreen.**
- A high level (screensaver/1000) + `canJoinAllSpaces` + `stationary` does float above everything
  including the Dock — but the menu-bar/notch region composites separately. HazeOver 1.9.7's notes
  fix *"on Tahoe, the menu bar sometimes appears too dim"* — budget for menu-bar special-casing.
- `order(_:relativeTo:)` cross-process: **do not rely on it.** Apple bounds it to "all other windows
  in its level"; no documented contract for foreign window numbers. The cutout design means we never
  need it.
- Prefer **one overlay per `NSScreen`** over a union-spanning window (mixed HiDPI / refresh rates).
- Click-through is mandatory: `setIgnoresMouseEvents(true)` / Tauri `set_ignore_cursor_events(true)`.

## F. Window enumeration — the permission split, confirmed precisely

**Works with NO Screen Recording permission:** `kCGWindowNumber`, `kCGWindowOwnerPID`,
**`kCGWindowOwnerName`**, `kCGWindowBounds`, `kCGWindowLayer`, `kCGWindowAlpha`,
`kCGWindowIsOnscreen`, `kCGWindowMemoryUsage`, `kCGWindowStoreType`. **Array order encodes
front-to-back z-order** — valuable for selective dimming.

**Redacted without permission:** `kCGWindowName` — the key is **absent entirely** (not empty string).

> **Decisive for us: every window's pid, owner app name, bounds, layer, alpha, on-screen flag and
> full z-order come free with ZERO permissions. We only lose window *titles*, which are cosmetic for
> a dimming app.** `CGWindowListCopyWindowInfo` **never triggers a permission prompt.**

- `CGWindowListCopyWindowInfo` is **NOT deprecated** (Apple docs JSON: macOS 10.5+, `deprecated:false`).
- ⚠️ But `CGWindowListCreateImage` is **OBSOLETED in macOS 15** — hard compile error. Apple killed the
  *imaging* functions and left *enumeration* alone. We only need the half that survived.
- **Do NOT use `SCShareableContent` for enumeration** — it always requires Screen Recording and
  **prompts when ungranted** (AltTab uses it *as* the permission probe), and it "may either never
  invoke the completion handler, or take 3–10 seconds" (nonstrict repro repo); AltTab wraps every
  call in a timeout + semaphore.
- ⚠️ `CGPreflightScreenCaptureAccess()` is **frozen per-process** — cached at first call, blind to a
  mid-session grant. AltTab recovers only by restarting.
- Sequoia's screen-recording re-prompt settled at ~30 days (15.1 reduced it), plus a persistent
  orange menu-bar indicator while capturing. **All of that applies to *capture*, not metadata reads.
  If we never capture, we never see it.** Strong argument for staying off the capture path.
- Tahoe 26.1 regression: screen-recording permission now **requires an app bundle**; plain
  executables can capture but never appear in System Settings. TCC also evaluates the **responsible
  process**, breaking LaunchAgent/wrapper setups.

## G. Foreground tracking — permission-free baseline + optional upgrade

`NSWorkspace.shared.frontmostApplication` and `menuBarOwningApplication` (both 10.7+, not deprecated,
KVO-compliant) need **no permission, no entitlement, no usage description**. They diverge when a
non-activating accessory app holds key focus — **track both**.
⚠️ **`NSWorkspaceDidActivateApplicationNotification` posts on `NSWorkspace.shared.notificationCenter`,
NOT `NotificationCenter.default`** — a silent-no-events bug that catches nearly everyone.

Geometry needs Accessibility (public API, TCC-gated). One `AXObserver` **per PID** — there is no
global window-change notification; create observers on `NSWorkspaceDidLaunchApplicationNotification`
and tear down on termination. `AXUIElementCreateSystemWide()` **does not support notifications**.

⚠️ **AX permission realities (from AltTab's production source):**
- **Restart after granting is effectively required** — trusted state is cached per-process and Apple
  exposes no `AXResetTrustedCache()`. AltTab literally calls `App.restart()`.
- **macOS 13+ has a known bug where `AXIsProcessTrusted` returns stale values right after a toggle** —
  re-run the API, don't cache.
- Revocation detectable via the undocumented distributed notification `com.apple.accessibility.api`,
  but "since macOS 15 [DistributedNotificationCenter] silently fails for unsigned binaries" — AltTab
  keeps a **60 s backstop poll**.
- **Dev-build churn:** TCC binds the grant to bundle ID **+ code-signing requirement**. Same
  Developer ID survives updates; ad-hoc/unsigned dev builds lose it **every rebuild**, and the
  failure mode is nasty — the entry still *appears* checked while being non-functional, needing a
  manual uncheck/recheck. Mitigate with a stable self-signed cert + fixed bundle ID, or design so AX
  is strictly optional (HazeOver's model).

**Rust:** `objc2-app-kit` 0.3.2 (maintained) for NSWorkspace; `accessibility-sys` 0.2.0 (complete but
0% documented) + `core-foundation` 0.10.1 for the runloop. Reference impl: **tmandry/glide**
(`src/sys/observer.rs`) — canonical `declare_TCFType!`-wrapped AXObserver.
⭐ **glide sets `panic = "abort"` specifically so a Rust panic cannot unwind into the macOS CFRunLoop
thread — adopt this.** One private call is unavoidable if mapping AX elements to `CGWindowID`:
`_AXUIElementGetWindow` (both glide and AeroSpace hand-declare it).
⚠️ **Rectangle's workaround worth stealing:** read `AXEnhancedUserInterface`, **disable it before
resizing, then restore** — otherwise Electron/Java/Chrome window geometry corrupts.

## H. Per-window effects on foreign windows — EMPIRICAL PROOF of impossibility

Every relevant CGS/SkyLight function takes a **`CGSConnectionID` as its first argument** — the
connection ID *is* the access-control token. Keen Security Lab's WindowServer analysis states the
model: *"Only the window owner's process is allowed to perform operations on windows, or some special
entitlement is needed."*

**The clean proof, from reading yabai's source:**
- *Reads* on foreign windows work from your own connection: `SLSGetWindowAlpha(g_connection, wid, …)`,
  `SLSGetWindowBounds`, `SLSGetWindowLevel` (`src/window.c:865-869`).
- *Writes* are **all proxied**: `window_manager_set_opacity` → `scripting_addition_set_opacity` →
  socket → payload **injected into Dock.app** → `SLSSetWindowAlpha(SLSMainConnectionID(), …)`
  (`src/osax/payload.m:670`).
- **The clincher:** the only `SLSSetWindow*` calls yabai makes from its own process are on windows it
  created itself (`src/window_manager.c:472-477`). It never mutates a foreign window from its own
  connection. **If it were possible, yabai would do it and would not need SIP disabled.**

SIP cost: `CSR_ALLOW_UNRESTRICTED_FS (0x02)` **and** `CSR_ALLOW_TASK_FOR_PID (0x04)` cleared; on
Apple Silicon 13+ also boot-arg `-arm64e_preview_abi`; install to `/Library/ScriptingAdditions/` as
root; injection via `task_for_pid` + remote thread. Breaks on most point releases.
**Risk rating for us: disqualifying. Do not pursue.**

Capture-and-re-render fails on five counts: needs Screen Recording; to show the re-render you must
cover the original (eating clicks, or click-through onto an invisible window); ≥1 frame latency makes
typing unusable; SCK gives the window's own content, not the composited result, so any overlap
destroys the illusion; continuous GPU/encode cost on battery — hostile in a passive-comfort app.

---

# LATE ADDITIONS III (6th pass) — permissions, window levels, code signing

## I. ★ HEADLINE: our app shape needs ZERO TCC permissions

**A translucent, click-through, always-on-top overlay + `RegisterEventHotKey` requires no TCC
permission whatsoever.** One of the very few system-wide-feeling macOS app shapes with zero prompts.

**Why:** Screen Recording gates *reading* the framebuffer, not *writing* to it. The gated APIs are
`CGWindowListCreateImage`, `CGDisplayStream`, ScreenCaptureKit. There is **no TCC check in the
`NSWindow`/Core Animation draw path** (Apple DTS thread/826308 gives a full overlay recipe and never
mentions a permission). `ignoresMouseEvents = true` makes the window transparent to events rather
than intercepting them — so no Accessibility/Input Monitoring involvement either.

**Prior art confirms the clean split:**

| App | Mechanism | Permissions |
|---|---|---|
| **HazeOver, GammaDimmer, dimmer** | Overlay | **None** — HazeOver + GammaDimmer ship **sandboxed on the MAS** |
| **f.lux** | Gamma | **None for tinting** (historically prompted for Screen Recording only for an About-box brightness estimate; **removed in v40.1** because it alarmed users) |
| **Lunar** | DDC + gamma + XDR | Accessibility **optional**, only for Media Keys + App Presets — nothing for DDC/gamma/XDR |

Only frontmost-app *geometry*, media-key interception, or reading screen contents crosses into TCC.

## J. ⚠️ CORRECTION to §7 — window level and panel type

**`NSStatusWindowLevel` (25) sits BELOW fullscreen content.** The Apple-DTS-sourced recipe is:

- **`NSPanel`, not `NSWindow`**, with **`.nonactivatingPanel`**
- **`level = .screenSaver` (1000)** — not 25, and note this is higher than the ≥101 figure in §7;
  §7's 101 clears the menu bar (24) and Dock (20), but 1000 is what the DTS recipe uses
- `collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications, .fullScreenAuxiliary,
  .stationary]` — **`.canJoinAllApplications` is required and was missing from §7**
- `NSApplication.ActivationPolicy.accessory`

Tauri's cross-platform window API reaches **none** of this — expect to drop to `objc2` on the
`ns_window()` handle. Consider `tauri-nspanel` (branch `v2.1`, git-only) for a genuinely
non-activating panel.

⚠️ **MAS limitation, and it is directly relevant:** GammaDimmer documents that **App Store builds
cannot overlay above fullscreen windows.** So "ship on the MAS" and "tint fullscreen content" are
**mutually exclusive**. Combined with §8's finding that `.fullScreenAuxiliary` never floats above a
*foreign* app's fullscreen window, the honest conclusion is: **plan to disable dimming when a foreign
app goes fullscreen**, and treat MAS as incompatible with full coverage.

## K. Global hotkeys — Carbon is the only permission-free option

| API | Permission |
|---|---|
| **`RegisterEventHotKey`** (Carbon) | **NONE** — the only public global-hotkey API that is free |
| `NSEvent.addGlobalMonitorForEvents` | **Accessibility** (Apple docs: "Key-related events may only be monitored if accessibility is enabled") |
| `CGEventTap` | **Input Monitoring** (Apple DTS thread/735223) |

`RegisterEventHotKey` is not formally removed, works on Apple Silicon, works sandboxed;
sindresorhus/KeyboardShortcuts: *"Does this package cause any permission dialogs? No"* and is
"fully sandboxed and Mac App Store compatible". FB15168205 notes "thousands of App Store
applications" depend on it. **This is what `tauri-plugin-global-shortcut` already uses — keep it.**
⚠️ Avoid **Option-only / Option+Shift** defaults — macOS 15 had a since-fixed regression breaking
them in sandboxed apps.

## L. ⚠️ TCC + code signing — why permission logic is untestable in dev

TCC keys grants to the **Designated Requirement**, not the path (TN3127). Two failure modes:
- **Unsigned** → no DR; identity is the **absolute path** (`client_type = 1`) → moving/renaming breaks it
- **Ad-hoc** → DR collapses to a bare `cdhash`, which **changes on every rebuild**

⚠️ **arm64 binaries are always at least ad-hoc signed by the linker, so the ad-hoc treadmill is the
DEFAULT on Apple Silicon.** Characteristic symptom: the app still appears **enabled in System
Settings** while silently failing at runtime, because the DR check fails even though the UI row
persists.

⚠️ **`tauri dev` produces NO `.app`** — verified in Tauri source: it runs the bare Mach-O from
`target/debug/` with no bundle, no Info.plist, no bundle identifier (`dev.rs` has no bundle
handling). `src-tauri/Info.plist` is merged **only at bundle time**.
> **Net: permission logic is essentially untestable under `tauri dev`. Test only against a signed,
> bundled `.app`.** (tauri#11085, re-grant-after-every-update, was closed "not planned" as an OS
> signing consequence.)

Two attribution traps that look like API bugs:
- **Responsible-process inheritance:** a dev binary launched from a terminal inherits the *terminal's*
  grants → `AXIsProcessTrusted()` returns **true in dev, false in production**.
- **Disclaimed responsibility:** a host spawning children through a `disclaimer` helper makes each
  child its own TCC identity with no grants → `AXIsProcessTrusted()` always false even while the
  actual AX calls succeed via the host's grant.

**Fix: one stable signing identity now.** A free Apple Development cert (Xcode Personal Team), or
AltTab's approach — a self-signed cert carrying Apple's code-signing OID
`1.2.840.113635.100.6.1.14`, adopted explicitly to stop re-granting on every build.
Check embedded helpers with `codesign -dvv`: a team-signed `.app` wrapping an **ad-hoc helper** still
thrashes, because TCC checks whichever binary actually requests the permission.

## M. If we ever DO need permissions

**Do NOT add `tauri-plugin-macos-permissions`.** It is the only such plugin (175★, 2.3.0 May 2025)
but is effectively unmaintained with two open correctness bugs in exactly the paths most apps need:
- 🔴 **Microphone check panics** (issue #5, unfixed in the released version)
- 🔴 **Screen Recording broken on macOS 15.5** (issue #12, open)
- 🟠 Pins `macos-accessibility-client ^0.0.1` (published **Jan 2021**); caret on `0.0.x` is
  patch-exact so 0.0.2 is **excluded**
- 🟠 **Non-macOS stubs return `Ok(true)`** — cross-platform code gating on these reads "granted"
  everywhere else: **fail-open by default**

Each binding is 5–20 lines. **Vendor the 2–3 we need instead.**

API preferences:
- **Prefer `CGPreflightListenEventAccess()` / `CGRequestListenEventAccess()`** (CoreGraphics, 10.15+,
  documented, sandbox-friendly) **over `IOHIDCheckAccess`/`IOHIDRequestAccess`** (IOKit
  `hidsystem/IOHIDLib.h` — note **`hidsystem/`**, not `hid/` — and **undocumented**: they have no page
  in Apple's modern docs at all). Sharp edge in the IOKit header: *"If you do not call this API, it
  will be called on your behalf when the API are used"* — touching HID APIs triggers the prompt
  implicitly.
- `objc2-application-services` (features `AXUIElement` + `HIServices`) binds
  `AXIsProcessTrustedWithOptions` — no raw FFI needed. Note it lives in **HIServices**, not the
  `Accessibility` framework.
- `core_graphics::access::ScreenCaptureAccess` covers preflight/request.

**Restart semantics differ per permission — design onboarding around this:**
- **Screen Recording, Input Monitoring → restart REQUIRED.** Apple DTS (thread/732726): once
  `CGPreflightScreenCaptureAccess()` returns false it **latches false for the process lifetime**;
  polling is useless. Kap calls `app.quit()` immediately after opening the pane.
- **Accessibility → live in the good case** (confirmed on 26.5.1) but wrong values on rapid toggling,
  and can break post-sleep with only relaunch fixing it. **Poll, but offer a Restart button.**
- **Mic/Camera → genuinely live, no restart.** But `requestAccess` without a usage description
  **raises an exception / terminates the app** (Apple's own wording), and under Hardened Runtime —
  **which Tauri enables by default** — also needs `com.apple.security.device.{audio-input,camera}`.

**Nuance most write-ups miss:** Sequoia's recurring screen-recording alert targets **deprecated**
capture APIs (`CGDisplayStream`, `CGWindowListCreateImage`) per Apple's macOS 15 release notes.
**Using ScreenCaptureKit avoids the recurring alert.** 15.1 softened it further ("fewer dialogs if
users regularly use apps") plus MDM key `forceBypassScreenCaptureAlert`.

**No Info.plist key exists** for Accessibility, Screen Recording, or Input Monitoring (verified
against Apple's protected-resources list). `NSInputMonitoringUsageDescription` is undocumented
folklore — harmless, but fixes nothing.

## N. System Settings deep links — the scheme is the trap

✅ **`x-apple.systempreferences:` works on Ventura → Tahoe 26.**
❌ **`x-apple.systemsettings:` has NO handler** — the user sees *"There is no application set to open
the URL"*. Verified through Launch Services on macOS 26.4: System Settings.app still has bundle ID
`com.apple.systempreferences` and advertises only the legacy scheme.

| Pane | Anchor (all prefixed `x-apple.systempreferences:com.apple.preference.security?`) |
|---|---|
| Accessibility | `Privacy_Accessibility` |
| Input Monitoring | `Privacy_ListenEvent` |
| Screen Recording | `Privacy_ScreenCapture` |
| Full Disk Access | `Privacy_AllFiles` |
| Automation | `Privacy_Automation` |

Works sandboxed (Kap and MacPass ship sandboxed). `NSWorkspace.open` and `open(1)` both fine.

🔴 **Gotcha:** if System Settings is **already open on a different pane**, the deep link may not
navigate it (verified macOS 26.5.1). Mitigation: fire the native TCC prompt first (which registers
you with TCC and auto-adds your row), then deep-link, then fall back to opening System Settings bare,
and refresh permission status on app re-activation.

---

# LATE ADDITIONS IV (7th pass) — stable monitor identity, definitively

**This overturns the earlier "just use `CGDisplayCreateUUIDFromDisplayID`" guidance.**

## O. The system UUID is NOT reliable for identical panels — macOS reassigns it

waydabber (author of BetterDisplay), on the record in waydabber/m1ddc#41:

> *"If the displays are fully identical, the system UUIDs (not talking about the EDID UUID) **will
> not work properly as the OS can change the assignment any time**."*

Field-confirmed: displayplacer#89 — two identical Samsungs whose **UUIDs swap on every sleep/wake**.
displayplacer#77 — two BenQ PD2720Us with identical ManufacturerID, ProductID, YearOfManufacture,
WeekOfManufacture and numeric SerialNumber (21573), differing **only** in
`AlphanumericSerialNumber` (`PAL02071019` vs `PAL02081019`) and `PortID` — and the persistent UUIDs
swap between them. displayplacer's own help text warns: *"macOS sometimes changes the persistent
screenIds when there are race conditions from external screens waking up in non-deterministic order."*

## P. ⚠️ NEVER use the IORegistry "EDID UUID" / `IOMFBUUID` as a persistence key

Lunar's `possibleEDIDUUIDs()` reconstructs it and reveals the layout:
`VVVVPPPP-0000-0000-WWYY-01TT??HHVV??` = vendor + product + week/year of manufacture + transport +
physical image size — **with the serial byte deliberately commented out**. It encodes nothing that
distinguishes two same-model panels from the same manufacturing week.

m1ddc#41 shows two Lenovo P27q-20s with **byte-identical** EDID UUIDs
(`30AEEA61-0000-0000-131F-0104A53C2278`) but different system UUIDs and different alphanumeric
serials. *"Some vendors populate many monitors in batch using the same EDID UUID."*

## Q. What the reference apps actually do — and what to copy

| App | Persistence key | Identical-monitor behaviour |
|---|---|---|
| **Lunar** | `serial` = `CGDisplayCreateUUIDFromDisplayID` → fallback raw-EDID hex → fallback `CGDirectDisplayID` | ⚠️ **Hack**: if ANY two serials collide, **every** serial gets suffixed with `CGDirectDisplayID` → persistence silently degrades to **per-boot** |
| **MonitorControl** | `prefsId` = `name+vendor+model+"@"+CGDirectDisplayID` (serial only for virtual displays) | No collision (IDs differ), but **any renumbering orphans stored settings**. Long-running issue #49 |
| **BetterDummy** | Same, with a user checkbox *"Use display serial number for association"* | Explicit acknowledgement that **neither choice is universally right** |
| **BetterDisplay** | ⭐ Own internal **`tagID`** ("a BetterDisplay provided unique numeric ID specific to this app installation") + **user-selectable per-display matching strategy**: UUID / basic / extended / location | The mature answer |
| **Rectangle** | None — sidesteps entirely, addresses screens **positionally** (sorted by frame geometry) | N/A |

BetterDisplay's own migration rationale (issue #410): *"Relying on CGDirectDisplayID or display
metrics (like serial number) is not sustainable… It is best to use UUID from now on"* — then it
added the strategy selector (#2053) because UUID alone still wasn't enough.

## R. ★ The recommended construction — a composite with ordered fallbacks

**Do not pick one field. Keep our OWN internal stable ID for the settings record and treat every
hardware identifier as *matching evidence* scored against it** (Lunar's `matchingScore(for:)` is the
reference implementation: +5 for a matching `IODisplayLocation`, then partial matches over serial /
product / vendor / pixel size / year / transport). Make the strategy user-overridable per display,
as BetterDisplay does.

Evidence ladder, most → least stable:
1. **System UUID** (`CGDisplayCreateUUIDFromDisplayID` / `kCGDisplayUUID` from
   `CoreDisplay_DisplayCreateInfoDictionary`) — correct default; survives reboot and port changes;
   **can be reassigned between fully identical panels**
2. **EDID `AlphanumericSerialNumber`** (IORegistry `ProductAttributes`) — **macOS itself ignores it,
   so it is often the ONLY true differentiator between identical panels**; not always populated
3. Vendor + product/model + numeric serial + year/week + product name ("basic"/"extended") —
   deterministic, but by construction **collides for same-batch identical panels**
4. Hardware port / `IODisplayLocation` / IORegistry path ("location") — differentiates identical
   panels but **breaks when the user moves a cable**
5. `CGDirectDisplayID` — runtime handle only; varies on Apple Silicon

m1ddc's selector set is worth copying wholesale: `id`, `uuid` (system), `edid` (EDID UUID),
`seid` = `<alphanumeric serial>:<edid uuid>`, `basic` = `<vendor>:<model>:<serial>`,
`ext` = `+<manufacturer>:<alphanum serial>:<product name>`, `full` = `+<io_location>`.

> **Generalises beyond macOS.** The same trap applies on Linux X11, where our plan is to key on EDID:
> same-batch panels share vendor/product/week/year and often carry no numeric serial. The
> **alphanumeric serial** and the **connector/port path** are the differentiators there too. Design
> the identity layer once, cross-platform, as *own-ID + scored evidence*, not as "the stable ID".

**Never hard-fail on a miss.** For an eye-protection app a wrong match means a monitor tinted
incorrectly — annoying but recoverable; a crash or a lost profile is worse.

---

# LATE ADDITIONS V (8th pass) — TWO DESIGN-INVALIDATING FINDINGS

## S. 🔴🔴 Tauri `transparent: true` costs ~8× GPU power on macOS, permanently

Measured A/B on a **static** page (tauri#15471, `status: upstream`, Tauri 2.11.2 / wry 0.55.1 /
tao 0.35.3, macOS 26.6 Apple Silicon + 26.5 Intel):

| | Power | GPU active residency |
|---|---|---|
| `transparent: true` | **~620 mW** | **36%** |
| opaque | ~75 mW | 10% |

On Intel the WebKit GPU process pins a core. Cause: WebKit/WindowServer force alpha-compositing
**every display frame regardless of content change**.

> **For an always-on eye-protection overlay this is disqualifying for a WebView-based tint.**
> A tint overlay has no DOM — there is no reason for a WebView to be in it at all.

**→ Draw the tint with a native `NSWindow` (no webview): `setOpaque(false)` +
`setBackgroundColor(NSColor with alpha)`, or Tauri's `background_color(Color)` on a webview-less
window. Keep the WebView only for the settings UI.**

This single decision simultaneously dodges:
- tauri#15471 (8× GPU)
- tauri#13415 (`transparent(true)` works in `tauri dev`, renders **solid white after DMG build** —
  open since May 2025; `macOSPrivateApi`, `TAURI_PRIVATE_API=1` and the Cargo feature all failed to
  help)
- the `macOSPrivateApi` App Store trap (the private bits are KVC string keys `drawsBackground` and
  `fullScreenEnabled` — trivially found by static string scan)

## T. 🔴 Tauri's `always_on_top` sets level **3**, not 101 — verified in tao source

```rust
// tao/src/platform_impl/macos/window.rs
let level = if always_on_top { NSWindowLevel::NSFloatingWindowLevel }  // == 3
            else             { NSWindowLevel::NSNormalWindowLevel };   // == 0
```
**Level 3 is below the Dock (20), the menu bar (24) and the status bar (25).** Tauri exposes only a
boolean — there is no level parameter (unlike Electron's `setAlwaysOnTop(flag, level)`).
Root cause of tauri#13413; open feature request tauri#9987.

Likewise `set_visible_on_all_workspaces` **only** toggles `CanJoinAllSpaces` — **nothing in tao ever
sets `FullScreenAuxiliary`** (checked `window.rs` and `window_delegate.rs`). Hence tauri#11488
"visibleOnAllWorkspaces window not staying on top of full-screen apps", closed **not planned**.

✅ What *does* work out of the box: `set_ignore_cursor_events` → `setIgnoresMouseEvents` dispatched
to the main thread (tao comments that the method "isn't thread-safe, and fails silently").

### Level guidance — resolving the earlier contradiction
- ⚠️ **`NSWindow.Level.screenSaver` (101) ≠ `CGWindowLevelForKey(.screenSaverWindow)` (1000)** — the
  AppKit and CoreGraphics namespaces disagree despite the shared name.
- Electron's docs (the most authoritative practical statement found): *"Levels from `floating` to
  `status` place the window below the Dock on macOS. Levels from `pop-up-menu` and higher display
  above the Dock."* This **contradicts** the naive numeric reading (statusBar 25 > dock 20).
- **Use 101** for a persistent full-screen tint. A counterexample exists (Ardent Swift uses
  `.statusBar` = 25 successfully) but for a *transient* panel, not a persistent tint.
- **UNVERIFIED:** the 25-vs-101 discrepancy was not empirically resolved. Spike it.
- Cannot cover: screen saver (1000), login window (separate session — our app isn't running),
  assistiveTechHigh (1500). Mission Control composites our overlay into its view rather than over it.

### Fullscreen coverage — corrected
The widely-cited Apple Forums thread 26677 (El Capitan era) concluding `.fullScreenAuxiliary`
"does NOT help" is **outdated and contradicted by current shipping code**. Working recipe:
`[CanJoinAllSpaces, Stationary, IgnoresCycle, FullScreenAuxiliary]` **plus
`ActivationPolicy::Accessory`** — Electron documents that its fullscreen path *transforms the process
type* (Regular↔Accessory), and a Tauri reporter confirms "using `ActivationPolicy::Accessory` works
but hides the Dock icon". **For a tray utility that is a free win.**

`collectionBehavior` mutual-exclusivity (at most one from each group):
`Primary`/`Auxiliary`/`CanJoinAllApplications` · `Managed`/`Transient`/`Stationary` ·
`ParticipatesInCycle`/`IgnoresCycle` · `FullScreenPrimary`/`FullScreenAuxiliary`/`FullScreenNone` ·
`FullScreenAllowsTiling`/`FullScreenDisallowsTiling`.
⚠️ **`FullScreenNone` opts OUT of fullscreen coverage** — do not copy the slint recipe that uses it.
⚠️ Stage Manager "does not keep a window visible above a fullscreen app" — test explicitly.

### One window per NSScreen — the deciding reason
**System Settings → Desktop & Dock → "Displays have separate Spaces" (default ON).** With it on, a
single window cannot be simultaneously in display A's fullscreen Space and display B's desktop Space.
Use `Monitor::position()` + `size()`, **not `work_area()`** (which excludes the menu bar and Dock we
want to cover).

### 🔴 App Store, stated by a vendor in this exact space
Alin Panaitiu (Lunar / Gamma Dimmer): **"App Store apps are not allowed to place dark overlays above
fullscreen windows."** Combined with `macOSPrivateApi` → **overlay tinting is a Developer-ID product,
not an MAS product.** Gate the private path behind a Cargo feature so an MAS build compiles it out.

### Tahoe note
Tahoe's menu bar is **transparent by default** with a faint drop shadow. So an overlay *below* level
24 still visibly tints the menu-bar region (wallpaper shows through); at ≥101 we tint it directly.
Same visual result, different mechanism — **test both Tahoe menu-bar modes.**
Tahoe-specific Tauri bugs to watch: #15517 (tao 0.35.3 panics in `did_finish_launching`, blank
window), #15271, #15707 (`setTheme` no longer repaints the title bar).

**Version pinning:** tao depends on `objc2 0.6`, `objc2-app-kit 0.3`, `objc2-foundation 0.3`,
`block2 0.6`, `core-graphics 0.25`, `dispatch2 0.3`. **Match exactly** so the `NSWindow` cast from
`ns_window()` is the same Rust type. All needed methods (`setLevel`, `setCollectionBehavior`,
`setIgnoresMouseEvents`, `setOpaque`, `setBackgroundColor`, `setHasShadow`, `setHidesOnDeactivate`,
`orderFrontRegardless`) are **safe** in `objc2-app-kit`. Must run on the main thread
(`app.run_on_main_thread`).

## U. Global hotkeys — `global-hotkey` is Carbon **AND** a CGEventTap

Contradicts the "Carbon-only" assumption. Verified in `global-hotkey` 0.8.0 (exactly what
`tauri-plugin-global-shortcut` depends on — the quoted source **is** our shipping code):

- **Normal keys → Carbon** `RegisterEventHotKey` + `InstallEventHandler`. **Zero TCC permission.**
- **Media keys ONLY → `CGEventTapCreate(SystemDefined)`** → **requires Input Monitoring**
  (`kTCCServiceListenEvent`). Triggered by `MediaPlayPause | MediaTrackNext | MediaTrackPrevious |
  MediaFastForward | MediaRewind`.

> **Bind only normal keys → zero permissions. The moment a user binds a media key, the app silently
> requires Input Monitoring.** Real report: plugins-workspace#2868 — `register("MediaPlayPause")`
> fails with "Failed to watch media key event" *even after enabling Accessibility*, because the right
> permission is Input Monitoring. `global-hotkey` never calls `CGPreflightListenEventAccess()`.

**Carbon is NOT deprecated** — `RegisterEventHotKey` has no deprecation macro; 32-bit Carbon the
*app framework* died with Catalina, but HIToolbox persists as a 64-bit system framework. arm64-native,
sandbox-safe, MAS-safe.

### 🔴 Reserved shortcuts fail SILENTLY
`global-hotkey` passes **`inOptions = 0`**, not `kEventHotKeyExclusive`. Per `CarbonEvents.h`, the
same hotkey **can be registered by multiple applications**, and `eventHotKeyExistsErr (-9878)` fires
only for collisions *within our own process*. So binding Cmd+Space, Cmd+Tab, Cmd+Shift+3/4/5,
Ctrl+arrows, Cmd+Q, Cmd+Option+Esc → **`register()` returns `Ok(())` and the callback never fires.**
Undetectable from the return value. **We must validate against our own denylist in the settings UI.**
Conversely, when it wins it **consumes** the key with no pass-through (global-hotkey#87, closed).

**Not bindable:** Globe/fn — **there is no fn modifier bit in Carbon at all** (global-hotkey#111 open).
Caps Lock — no plumbed modifier. `AudioVolumeUp/Down/Mute` map to legacy scancodes `0x48/0x49/0x4a`
that do **not** correspond to modern Mac volume keys — expect silent never-fire.

**Secure input** (Apple TN2150) blocks HID seize, **CoreGraphics event taps**, and `GetKeys()` —
Carbon hotkeys are **not** on that list. So normal hotkeys keep firing while a password field holds
secure input; **media-key hotkeys stop firing** whenever *any* process has secure input on.
(UNVERIFIED: Apple never states affirmatively that Carbon hotkeys survive; TN2150's omission is
strong negative evidence and matches Alfred/Raycast behaviour.)

### Bugs to design around (three found by source reading, not filed upstream)
1. **Double-fire:** handlers are installed for **both** `kEventHotKeyPressed` and
   `kEventHotKeyReleased` and emit for each. **Every press delivers two callbacks — filter on
   `event.state()`.** Combined with plugins-workspace#1748 (per-shortcut *and* `with_handler` both
   registered → double), up to **4×**. Register one or the other, not both.
2. **Misleading error:** on Carbon `OSStatus` failure it returns `io::Error::last_os_error()`, which
   reads `errno` — unrelated to `OSStatus`, so it returns stale garbage. **Almost certainly the real
   explanation for plugins-workspace#2540's nonsensical "os error 2"** (actual failure is
   `InstallEventHandler`, not a missing file).
3. **Event tap never re-enabled:** `TapDisabledByTimeout`/`TapDisabledByUserInput` are defined but
   never handled, and `CGEventTapEnable` is called once. macOS disables slow taps unilaterally →
   **media hotkeys die permanently for the process lifetime, silently.**
4. Arc leak in `stop_watching_media_keys`.

**Main-thread requirement is real** — `RegisterEventHotKey` is "Not thread safe"; the plugin's
`run_main_thread!` wrapper carries an `unsafe impl Send + Sync` justified only by that guarantee.
**Bypass the wrapper and you are in UB.**

## V. 🔴 Autostart — `SMAppService` is UNREACHABLE from the current plugin

`tauri-plugin-autostart` 2.5.1 pins **`auto-launch = "0.5"`** (`>=0.5.0, <0.6.0`), whose only modes
are `LaunchAgent` and `AppleScript`. **`SMAppService` support landed only in `auto-launch` 0.6.0**
(2026-06-20). **Cargo will never resolve into 0.6** (semver-incompatible) and 0.6 is a breaking API
change → **this needs a plugin PR, not `cargo update`.** Tracking: plugins-workspace#2720, open.

**What the user actually sees today:** System Settings → General → Login Items & Extensions has two
lists. AppleScript / `SMAppService.mainApp` land in *"Open at Login"*; **LaunchAgent mode lands in
"Allow in the Background"** — semantically wrong for a GUI app. Worse, Apple states: *"If a legacy
LaunchAgent doesn't have the `AssociatedBundleIdentifiers` key, instead of the app name, System
Settings displays the organization name in the app's signing certificate."* **auto-launch 0.5 does
not emit that key**, so every Tauri app on the default hits this — field reports show
*"Louis Beaumont · 1 item"* and *"Software from 'SUNSTORY LLC' can run in the background."*
plugins-workspace#2720 also reports **TWO** background-item notifications with the plugin vs ONE with
the native API.

Other 0.5 defects: `is_enabled()` is **just `file.exists()`** — never asks launchd, so it reports
`true` after the user disables the item in System Settings; `disable()` is `fs::remove_file` with no
`launchctl unload`; AppleScript mode **drops all custom args** and does no shell escaping.

**Sandbox/MAS:** LaunchAgent ❌ broken (path outside the container), AppleScript ⚠️ entitlement + TCC
+ high rejection risk, **SMAppService ✅ sanctioned**.

✅ **`objc2-service-management` 0.3.2 exists and is good** — part of the canonical objc2 family, maps
`NSError**` to `Result`, no raw-FFI pain:
```rust
let svc = SMAppService::mainAppService();
if enabled { svc.registerAndReturnError() } else { svc.unregisterAndReturnError() }
```
**No entitlement, no Info.plist key, no TCC prompt.** Needs a valid signature
(`kSMErrorInvalidSignature` otherwise) and macOS 13+. Handle `status() == RequiresApproval` by
calling `openSystemSettingsLoginItems()` rather than reporting failure; treat
`kSMErrorAlreadyRegistered` as success.

**→ Write our own `autostart` module using `objc2-service-management` on macOS with a `#[cfg]`
fallback to the plugin elsewhere. Include a one-time migration deleting any legacy
`~/Library/LaunchAgents/*.plist` or users get double launches. Don't rely on argv for autostart
detection** — neither AppleScript mode nor `SMAppService.mainApp` can pass custom flags; persist a
marker in the settings store instead.

## W. Dark mode — reading and setting, corrected

**Reading:** `NSApp.effectiveAppearance` (KVO-compliant — **prefer KVO + `viewDidChangeEffectiveAppearance`
over the notification**, which has a documented read-after-notify race where it "fires before the
system API returns the new appearance state"). ⚠️ `effectiveAppearance` is 10.9 on
NSView/NSWindow but **10.14 on NSApplication** — probe `respondsToSelector:` first, as tao does.
`currentAppearance` is **deprecated in 12.0**; use `currentDrawingAppearance` /
`performAsCurrentDrawingAppearance:`.

⚠️ **The `defaults` tri-state has an inversion.** With `AppleInterfaceStyleSwitchesAutomatically =
true`: `AppleInterfaceStyle` **absent** ⇒ rendering **Dark**; `"Dark"` ⇒ rendering **Light**. And if
the transition time passes while the Mac is asleep, the stored value is simply wrong.
**Rule: AppKit for current state; `defaults` only to recover the tri-state preference. Never let
`defaults` override AppKit.** (`dark-light` 2.0.0 reads `AppleInterfaceStyle` and nothing else — it
inherits this bug and has no change subscription.)

🔴 **`Window::set_theme` does NOT set the system theme** — tao calls `NSApp.setAppearance:`, which
overrides **our app only**. Consequently `Window::theme()` returns our own override afterwards, not
the system's. `tauri::Theme` has no `Auto` variant. Call on the main thread.

**Setting the system theme: no public API.** Apple FB5714667 ("AppKit API to control system dark
mode"), filed 2018-07-12, **still open with zero Apple comments eight years later**.
- **SkyLight private** ⚡ instant, no prompt, App Store fatal. Symbols
  `SLSSetAppearanceThemeLegacy`, `SLSGetAppearanceThemeLegacy`, `SLSSetAppearanceThemeNotifying`,
  `SLSSetAppearanceThemeSwitchesAutomatically` **verified present in the macOS 26.5 (Tahoe) SDK stub**
  — and Tahoe now also exposes a Swift-mangled `SkyLight.SLSAppearanceTheme`, suggesting Apple
  consumes it internally. 94 GitHub hits. **`SLSSetAppearanceThemeSwitchesAutomatically` is the only
  route to setting Auto** — AppleScript cannot. Harden with `dlopen`/`dlsym` + AppleScript fallback.
- **AppleScript** still works (sindresorhus/dark-mode still uses it exclusively); failure mode is
  **permission, not API removal** (`errAEEventNotPermitted -1743`,
  `errAEEventWouldRequireUserConsent -1744`). Needs `NSAppleEventsUsageDescription` + Automation TCC;
  **does not work sandboxed**. Capture and classify stderr.
- ❌ **`defaults write -g AppleInterfaceStyle Dark` does not work.** Correct framing:
  **`AppleInterfaceStyle` is a *cache of a decision made elsewhere*, not the control surface** —
  causality runs SkyLight → defaults, not the reverse.
- Graceful fallback for an MAS build: deep link
  `x-apple.systempreferences:com.apple.Appearance-Settings.extension`.

---

# LATE ADDITIONS VI (9th pass) — System Settings deep links, refined

Confirms §N with binary-level evidence and adds four corrections.

**Still works on 13 / 14 / 15 / 26.** The compatibility mapping table (`com.apple.preference.security`
et al.) is still present in `/System/Library/PrivateFrameworks/SettingsHost.framework/SettingsHost`
in **macOS 26.4**. Karabiner-Elements v16.1.0 (2026-07-05, README lists Tahoe), AltTab v11.4.3
(2026-07-09) and Rectangle v0.98 (2026-07-15) all ship the legacy form with **no version
conditional**. Electron's own Sequoia-only nag-remover script deliberately uses it.

**Use one unconditional set — do not version-branch.** Version gating in the wild is mutually
contradictory (one project gates the modern form at `#available(macOS 26)`, another at
`macOS 13.0`, for the *same* anchor), which is itself evidence both forms work on both sides.

1. ⚠️ **`Privacy_ScreenRecording` is NOT a real anchor** — the correct one is **`Privacy_ScreenCapture`**.
   (GitHub: 2,668 hits vs 47; absent from the macadmin catalog.) Common copy-paste error.
2. ⚠️ **Local Network has NO anchor** on Sequoia/Tahoe — `Privacy_LocalNetwork` is absent from the
   settings binary; a button can only reach the top-level pane.
3. 🔴 **Fallback chains are DEAD CODE.** Several projects try modern-then-legacy and stop on
   "success" — but `NSWorkspace.openURL:` returns `YES` (and `shell.openExternal` resolves) as soon as
   *the scheme* is handled and System Settings launches. **Neither reports whether the anchor
   resolved.** The fallback branch is unreachable. Pick one URL.
4. ★ **The real engineering problem is not the pane ID — it is System Settings already being open**,
   which makes the anchor get ignored. This is almost certainly the source of "it opens the wrong
   pane" reports. Karabiner runs `killall 'System Settings'` and **polls `pgrep -x` until the process
   is gone** before opening the URL; NetNewsWire inserts a 0.2 s delay plus
   `NSWorkspace.OpenConfiguration(activates: true)` with the comment *"If System Preferences is
   already open, and no delay is provided here, then it appears in the foreground and immediately
   disappears"*; macgo treats it as a first-class edge case and shows manual steps instead.
   ~250 repos match a `x-apple.systempreferences` + `killall` code search.

**Sandbox / App Store: fine, no entitlement.** Sequel Ace is a sandboxed MAS app that opens these via
plain `NSWorkspace openURL:` with nothing privacy-related in its entitlements. No macOS equivalent of
`LSApplicationQueriesSchemes` is needed. (MDM caveat: run as the logged-in user, not root.)

⚠️ **Undocumented but load-bearing.** Apple has never documented the scheme — TN3179 covers exactly
the "user must visit Settings" scenario and offers no programmatic deep link at all. So no
deprecation warning will ever be issued, and no compatibility guarantee exists.

**Verify permission state independently** (`AXIsProcessTrustedWithOptions`, `IOHIDCheckAccess` /
`CGPreflightListenEventAccess`, `CGPreflightScreenCaptureAccess`) — the URL open's return value is
meaningless for that purpose.

To re-derive pane IDs on a future macOS:
`strings "/System/Applications/System Settings.app/Contents/MacOS/System Settings" | awk '/^com.apple./ {print $1}'`

**UNVERIFIED:** whether the already-open anchor bug is deterministic or timing-dependent; and the
exact behaviour of the modern `.extension?anchor` form on Ventura 13 specifically.

---

# LATE ADDITIONS VIII (12th pass) — ★ SUPERSEDES §E: the correct Focus Blur architecture

**§E (5th pass) recommended a four-rect geometric cutout. That is the INFERIOR of the two
approaches.** Source-reading of seven open-source dimmers plus HazeOver's App Store constraints
gives a better answer.

## GG. ★★ The canonical recipe — z-order IS the mask

**The entire HazeOver effect is achievable with ZERO private APIs and ZERO permissions.**

```
N screens → 1 (or 2) borderless NSWindow per screen
  level = .normal                       ← NOT elevated. This is load-bearing.
  isOpaque = false; backgroundColor = black
  ignoresMouseEvents = true; hasShadow = false
  collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
  canBecomeKey/Main = false; animationBehavior = .none

focus change → resolve CGWindowID of the focused window
            → overlay.order(.below, relativeTo: Int(windowID))
```

> **Nobody computes a mask or cutout — the z-order *is* the mask.** 5 of 7 OSS dimmers use exactly
> this. The one that uses a cutout (EsDimKid) documents the reason it loses: **"the cutout is a
> rectangle, so anything overlapping the active window gets it wrong."**

⚠️ **`level` must stay `.normal`.** Raising it forces you into the cutout architecture and all its
overlap bugs. *(Note this does NOT conflict with the level-101 guidance elsewhere in this file —
that applies to the full-screen TINT overlay, a different feature. Focus Blur must be `.normal`.)*

## HH. We do NOT need `_AXUIElementGetWindow`, and we may need no permissions at all

**HazeOver ships on the Mac App Store** (id430798174, since 2011) → sandboxed + no private APIs →
**it cannot be using `_AXUIElementGetWindow`.** Two public-API equivalents, both verified in shipping
OSS:

- **dimsum** — reads AX `kAXPosition`/`kAXSize` and **geometrically matches** against
  `CGWindowListCopyWindowInfo` at **2.0 pt tolerance**. Sandbox-safe; very likely what HazeOver does.
- **hw** / **BlurFocusPoC** — filter `CGWindowListCopyWindowInfo` for
  `kCGWindowLayer == 0 && kCGWindowOwnerName != "Window Server"`, take `.first` of the front app's
  PID, read `kCGWindowNumber`. **AX used purely as a change trigger, never as a data source.**

★ **BlurFocusPoC uses NO Accessibility at all** — `NSWorkspace.didActivateApplicationNotification`
+ `CGWindowListCopyWindowInfo` + a 0.5 s idempotent safety poll. **The purest proof that the basic
effect needs zero permissions.** (It was reverse-engineered from the commercial app *Monocle*.)

→ This *upgrades* the §G "AX is optional" finding: AX is a **latency optimisation, not a data
dependency**. Exactly why HazeOver words it as *"react instantly… and detect the focused window even
more reliably."*

## II. Engineering details worth stealing

1. ⚠️ **`order(.below, relativeTo:)` across process boundaries is the single load-bearing API, and
   it has broken before.** `godbout/OrderBelowVenturaBug` is a minimal repro filed as **FB10702287**
   — *"ordering below windows of other apps doesn't work in Ventura. hopefully a bug, not a new
   restriction from Apple."* Whether it was formally fixed is **UNVERIFIED**; it demonstrably works
   today (openhaze pushed 2026-07-15, dimsum 2026-05-16). **Budget for it breaking.**
2. **Z-order drift is the real problem, not initial ordering.** Every mature dimmer adds a
   **0.15–0.5 s poll on top of** AX events. OpenHaze's `fixDriftIfNeeded()` is the most refined — it
   re-issues `order(.below:)` **only if the overlay drifted *above* its anchor**, deliberately
   tolerating benign drift to avoid churn. BlurFocusPoC's idempotent `lastTarget` guard is the
   simplest.
3. ★ **`AXUIElementSetMessagingTimeout` is the highest-leverage single line in this whole area.**
   The OS default is **6 s** — *"apparently OSX enforces a 6s limit on apps to respond to AX
   queries."* AltTab sets **1 s**; EsDimKid sets **0.5 s**; **Hammerspoon and AeroSpace set nothing,
   and Hammerspoon's five worst open issues all trace to it** (5–10 s beachballs, 30 s first-subscribe
   delays, traced to `com.apple.WebKit.WebContent`). AeroSpace's alternative is more elegant: **one
   dedicated `Thread` + `CFRunLoop` per application**, so a hung app blocks only its own thread.
4. **Two overlays per screen (or a `CATransition(.fade, 0.2s)` on the content layer) is required**
   to avoid a full-screen flash when re-ordering — independently discovered by `hw`, OpenHaze and
   BlurFocusPoC.
5. **Never enumerate all apps synchronously on the main thread at startup** — Hammerspoon's
   most-reported bug class.
6. **Multi-display logic (dimsum):** the display holding the focused window gets `order(.below:)`;
   **every other display gets `orderFront(nil)`** — i.e. fully dimmed. Clean and matches HazeOver's
   "dim all secondary displays" option.
7. **Blur without private API** (FocusBlur): public `NSVisualEffectView` with
   `material = .fullScreenUI`, `blendingMode = .behindWindow`, modulating `alphaValue` as a
   pseudo blur-radius.
8. `setAccessibilitySubrole(nil)` on the overlay — *"alt-tab uses subrole to filter windows"*
   (from `hw`). Lunar similarly sets `setAccessibilityRole(.popover)`. Be a good citizen.
9. **HazeOver's default is single-window, app-level is opt-in** (from its 2011 changelog: *"an
   option to highlight front windows of an active application instead of just a single window"*).
10. HazeOver's overlay **is** `fullFrame`-sized and covers the menu bar — evidenced by its Tahoe
    workaround note (*"if the menu bar gets too dark… turn on 'Show menu bar background'"*).
    Screenshots **do** capture its dim layer, so it does **not** set `sharingType = .none`.

## JJ. Reference implementations, ranked for our purposes

| Repo | License | Private API | Permissions | Note |
|---|---|---|---|---|
| **nshi/dimsum** | MIT | **none** | AX (trigger) | 2 pt frame-matching; the MAS-safe technique |
| **manobendro/BlurFocusPoC** | MIT | blur only | **none** | zero-permission proof; RE'd from Monocle |
| **qwertyyb/hw** | — | **none** | AX (trigger) | smallest; 2-window crossfade |
| **jay739/openhaze** | MIT | `_AXUIElementGetWindow` | AX | most complete clone; best drift handling |
| danielaustralia1/FocusBlur | MIT | `_AXUIElementGetWindow` | AX | ⚠️ its `OverlayView` doc-comment claims a 4-window cutout — **the code does no such thing** (stale comment) |
| tim0120/EsDimKid | — | heavy `CGSSetWindowTags` | AX | the cutout alternative; **not MAS-shippable**; documents why cutout loses |
| Hammerspoon `WindowDimmer.spoon` | — | — | — | **architecturally incapable** — `hs.canvas` can only order relative to other canvases, not arbitrary app windows |

## KK. Correction to the AltTab claims elsewhere in this file

AltTab **re-architected in v11.4.0 (2026-07-02)**: *"complete rework: use WindowServer events instead
of Accessibility."*

🔴 **The "Screen Recording is needed for window titles" premise is now FALSE for AltTab.** It gets
titles from private `SLSWindowIteratorCopyTitle`, AX `kAXTitleAttribute`, and private
`CGSCopyWindowProperty(…, "kCGSWindowTitle", …)` — **none of which is `kCGWindowName`**, so the CGS
private call bypasses the restriction entirely. Screen Recording is **thumbnails-only** there.
*(This does not change our own plan: we still don't need titles, and we should not use private CGS
calls. But do not cite AltTab as evidence that titles require Screen Recording.)*

Also from AltTab, worth knowing: `CGPreflightScreenCaptureAccess` is **frozen per-process** —
*"will not reflect the actual status of the checkbox"* — requiring an app restart (confirms §F).

---

# LATE ADDITIONS VII (11th pass) — gamma runtime behaviour; TWO UNCERTAINTIES RESOLVED

## ★ RESOLVED #1 — the screenshot question (was flagged UNRESOLVED in §7)

**Gamma is NOT captured. An overlay IS captured.** Pass A was right; Pass B was wrong.

Decisive natural experiment — MonitorControl discussion #866: a user reported screenshots from an
external monitor coming out *"noticeably dimmer … as if a transparent black overlay was applied."*
Maintainer waydabber's diagnosis: *"This is normal if you use 'Avoid gamma table manipulation' under
Displays"* — i.e. the shade-window path. Turning that option **off** (back to gamma) made screenshots
normal again. Mechanism: the LUT is applied at **scanout**, downstream of the composited framebuffer
that `screencapture` / ScreenCaptureKit read.

✅ **Mitigation exists:** `NSWindow.sharingType = .none` excludes an overlay from capture. xdr-boost
sets exactly that; **Lunar leaves shades at `.readOnly`, which is why Lunar's shades DO show up in
captures.**

> **Product consequence:** CareUEyes' F1.7 "no yellow screenshots" property is achievable on macOS
> **via the overlay path too**, provided we set `sharingType = .none`. It is *not* automatically lost
> by choosing overlay-primary. Decide deliberately: some users *want* the tint in a screen share.

## ★ RESOLVED #2 — gamma is NOT restored on process exit (an earlier pass claimed it was)

**Do not rely on automatic restoration.** Nothing in the SDK header or Apple's docs says the table is
restored on process death. `CGDisplayRestoreColorSyncSettings` is documented only as an explicit,
**global**, manual call.

Positive evidence that state **survives** the setting process:
- Argyll's `dispwin -d1 -L` is a one-shot CLI that loads a ramp and exits — the calibration stays
  loaded (and `dispwin -dN -L` from another terminal is the documented way out of a black screen).
- The Tahoe bug report notes the display is left *"in an inconsistent visual state even after app
  termination."*
- f.lux's FAQ documents *"screens remained tinted after quitting f.lux in some cases"*, with a
  reboot-and-reset-profile recovery.

Every serious app restores explicitly on quit (MonitorControl `applicationWillTerminate`, amber-tint
`GammaEngine.restore()`, Hammerspoon `hs.screen.restoreGamma()`, Lunar ships a
`restore-colorsync` CLI subcommand for exactly the "I crashed, my screen is black" case).

> **We must ship a crash-safe recovery story** — an out-of-band reset (CLI flag / URL scheme /
> watchdog). A hard-killed tinting app leaves the user tinted with no obvious way out.

⚠️ Two gotchas on the restore path:
1. `CGDisplayRestoreColorSyncSettings()` is **global — all displays, no display-ID argument.** Lunar
   wraps it as `restoreColorSyncSettings(reapplyGammaFor:)` and immediately re-applies gamma to every
   *other* display it manages.
2. **The call is itself buggy**: per Lunar's FAQ it *"should simply do nothing if the gamma tables
   are already at their default values. But for unknown reasons, this API call will sometimes set all
   RGB Gamma tables to `0` and all colors will show up as black."* **Detect the zero table and
   retry** (Lunar's `GammaTable(for:allowZero:).isZero`).

## AA. What resets a custom gamma table — the complete trigger list

| Event | Behaviour |
|---|---|
| Display / system sleep-wake | **Reset.** amber-tint re-applies after **1.0 s** ("display needs initialization time after wake"); MonitorControl waits **3.0 s**; Lunar runs a `Repeater(every: 2, times: N)` re-asserting repeatedly |
| Resolution / refresh / mode change | **Reset, asynchronously.** Psychtoolbox: macOS *"will restore the gamma tables to the user session default … within 2 seconds after a video mode switch, thereby silently undoing"* your setup → PTB sleeps **3 s** post-modeset. Hammerspoon independently converged on **3 s** (*"We seem to have to wait a few seconds for this to work"*) |
| Hot-plug / display add-remove | **Reset** for the affected display. Lunar literally re-posts `screensDidWakeNotification` on add/remove |
| ColorSync profile change | **Reset.** Subscribe to `kColorSyncDisplayDeviceProfilesNotification` on `DistributedNotificationCenter` |
| Fast user switching / lock | Session-scoped; gate work on `sessionDidResignActive` → `loggedOut` |
| True Tone / auto-brightness / EDR | **Actively fights you** — WindowServer asynchronously rewrites the per-display transfer table on Apple Silicon (Ventura+). Accepted root cause of the intermittent **all-black VideoLUT** bug that hits Argyll `dispwin` with no DisplayCAL involved |
| Another gamma app (f.lux) | **Total clobber** — f.lux rewrites every few seconds and wins. MonitorControl ships `checkGammaInterference()` which after 3 events pops an alert titled *"Is f.lux or similar running?"* |
| Fullscreen enter/exit | **Non-event for gamma** (gamma is per-display, not per-window). Major event for overlays |
| Night Shift | **Composes cleanly** — writes the panel CLUT *below* CoreGraphics, so it does not conflict |

⚠️ **Apple Silicon quirk:** a gamma write may not visibly take effect unless the screen is also
redrawing. MonitorControl's workaround is a "gamma activity enforcer" — a **1×1 `NSWindow` at
`.screenSaver` level with `alphaValue` 0.01 whose alpha it toggles on every gamma write**, repositioned
onto the target display first, purely to force a compositor update.

## BB. The re-apply architecture — callback alone is insufficient

`CGDisplayRegisterReconfigurationCallback` fires **twice per display**: once *before* with flags ==
`kCGDisplayBeginConfigurationFlag` only (nothing queryable yet), once *after* with real flags.
Inside the callback you must **not** change display configuration, raise exceptions, or `longjmp`.
Flags (SDK 26.4): `BeginConfiguration 1<<0`, `Moved 1<<1`, `SetMain 1<<2`, `SetMode 1<<3`,
`Add 1<<4`, `Remove 1<<5`, `Enabled 1<<8`, `Disabled 1<<9`, `Mirror 1<<10`, `UnMirror 1<<11`,
`DesktopShapeChanged 1<<12`.

🔴 **Rust/Tauri specific: the callback is delivered on the run loop.** A redshift contributor found
*"the reconfiguration callback will not work as it seems to require a CFRunLoop"* — a headless
process never gets called. **In Tauri, register from the main thread after the event loop is up, not
from a spawned worker.**

**Consensus architecture** (what MonitorControl, Lunar, amber-tint and Hammerspoon converge on):
reconfiguration callback (debounced **1–3 s**, ignoring `beginConfiguration`/`moved`/`setMain`/
`desktopShapeChanged`) **+** `screensDidWake`/`didWakeNotification` (1–3 s delay, ideally a 2 s
repeater ×3–5) **+** `sessionDidBecomeActive` **+** `com.apple.screenIsUnlocked` **+**
`kColorSyncDisplayDeviceProfilesNotification` **+ a low-frequency verification poll** that reads back
`CGGetDisplayTransferByTable` and re-applies on drift. MonitorControl runs callback **and** a 1 s
poll; DisplayCAL's maintainers concluded the only real fix for the async WindowServer clobber is
*"a lightweight re-apply watcher … a poll that re-loads when the ramp degrades."*

⚠️ `NSApplication.didChangeScreenParametersNotification` **also fires as a side effect of our own
gamma writes** — xdr-boost diffs the display-ID set before reacting: *"We must ignore notifications
fired by our own CGSetDisplayTransferByTable / CGDisplayRestoreColorSyncSettings calls."*
⚠️ All `NSWorkspace` notifications must be registered on **`NSWorkspace.shared.notificationCenter`**,
never `NotificationCenter.default` — Apple is explicit that registering elsewhere silently yields
nothing.

## CC. Session scoping — the tint is absent at the login window

Gamma is scoped to the WindowServer GUI session (`CGSessionCopyCurrentDictionary` exposes
`kCGSessionUserIDKey`, `kCGSessionOnConsoleKey`; CG posts
`com.apple.coregraphics.GUIConsoleSessionChanged` on switches). ColorSync calibration has explicit
install scopes for the same reason (Argyll's `-S n|l|u`, default user).
**Our tint will not be present at the login window or in another user's session** — and the app is
normally dead at the login window anyway (a per-user LaunchAgent doesn't run there).

## DD. `CGDisplayFade` — exact constants, and why it cannot work

`kCGMaxDisplayReservationInterval = 15.0` — the header states the limit twice; valid range `(0, 15]`.
*"Failing to release the hardware by the end of the reservation interval will result in the
reservation token becoming invalid, and the hardware being unfaded back to a normal state."* So a
tint would forcibly evaporate every ≤15 s. It is also a **single global resource**
(`CGError.noneAvailable` if another reservation is in effect), so holding it would break every
system fade. `CGDisplayFadeOperationInProgress` is **deprecated since 10.9**.
Ironically the header recommends fades *over* gamma for **transient** effects — which is the correct
read: fades for ≤15 s transitions, gamma for persistent state.
Useful adjacent API: `CGConfigureDisplayFadeEffect` between `CGBeginDisplayConfiguration` and
`CGCompleteDisplayConfiguration` gives a free fade around a mode switch — handy to hide the ugly
2–3 s window where the OS clobbers our gamma during a modeset.

## EE. Window levels from `CGWindowLevel.h` (SDK 26.4) — authoritative
`kCGMainMenuWindowLevel 24` · `kCGStatusWindowLevel 25` · **`kCGPopUpMenuWindowLevel 101`** ·
`kCGOverlayWindowLevel 102` · `kCGDraggingWindowLevel 500` · **`kCGScreenSaverWindowLevel 1000`** ·
`kCGAssistiveTechHighWindowLevel 1500`. Plus `CGShieldingWindowLevel()` (the level of the shield
window used for captured displays) — what MonitorControl uses for its shade.

**Three shipping overlay configurations, verbatim:**
- **MonitorControl:** `level = CGShieldingWindowLevel()`, `[.stationary, .canJoinAllSpaces,
  .ignoresCycle]`, `ignoresMouseEvents = true`, `styleMask = []`, full `screen.frame`
- **Lunar:** `level = .hud`, `[.stationary, .canJoinAllSpaces, .ignoresCycle,
  .fullScreenDisallowsTiling]`, `sharingType = .readOnly`, `isOpaque = false`, plus
  `setAccessibilityRole(.popover)` so assistive tech ignores it; flips black↔white on
  `accessibilityDisplayShouldInvertColors`
- **xdr-boost:** `level = .screenSaver`, `[.canJoinAllSpaces, .stationary, .fullScreenAuxiliary,
  .ignoresCycle, .canJoinAllApplications]`, `ignoresMouseEvents = true`, `hidesOnDeactivate = false`,
  `animationBehavior = .none`, **`sharingType = .none`**, `orderFrontRegardless()`, **plus a 3 s
  watchdog Timer that re-fronts the window if it ever stops being visible**

## FF. Implementation notes for our Rust port
- ✅ A working minimal Rust FFI binding set exists to crib from:
  `github.com/donghao-666/in-your-eyes/blob/main/src/gamma_control.rs` — `CGSetDisplayTransferByTable`,
  `CGGetDisplayTransferByTable`, `CGDisplayGammaTableCapacity`, `CGGetOnlineDisplayList`,
  `CGDisplayRegisterReconfigurationCallback`, `CGDisplayRestoreColorSyncSettings`.
- **Use `CGGetOnlineDisplayList`, not `CGGetActiveDisplayList`** — the SDK header states gamma/palette
  manipulators *"need access to all displays in use, including hardware mirrors which are not
  drawable."* (Confirms §A of the 4th pass.)
- **Verify by readback AND non-degeneracy** — never trust `kCGErrorSuccess`. (Though note §0: on M5
  the readback lies too, so on that hardware only a visual/pixel check would catch it.)
- DisplayLink displays **never** supported gamma manipulation — MonitorControl treats DisplayLink and
  f.lux as the two reasons to force the overlay path.
