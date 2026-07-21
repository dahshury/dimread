# Plan 03 — Hardware backlight brightness (internal panel + DDC/CI externals)
Status: DRAFT
Depends on: 00 (capability layer), 02 (monitor identity)
Parity ref: FEATURE-PARITY.md F2 (parity-adjacent — F2.1/F2.3/F2.4/F2.5), F1.12

---

## 1. What this feature is

Today DimRead "dims" by darkening the gamma ramp — the backlight stays at full power and the panel
just displays darker pixels. This plan adds a *second, physically different* brightness tier: change
the **actual backlight**, the same thing the laptop's brightness keys and the monitor's OSD control.
The user sees one brightness slider per monitor (CareUEyes' "All Monitors · 1 · 2" strip, see
`research/careueyes/images/landing_display-muti-monitor-912x625.png`), with a badge saying whether
that monitor is being driven at the hardware level or only by gamma.

This is a **new capability CareUEyes does not have** — CareUEyes is explicitly gamma-only
(FEATURE-PARITY F1.7/F2.1). It is worth building because hardware brightness is the only mechanism
that reduces emitted light rather than simulating it, which is the actual eye-comfort claim; and
because on macOS the gamma path is *degrading* (`docs/platform-research/macos.md` §0: silently
ignored on M5-class hardware), so we need a mechanism that does not depend on it.

## 2. Current state

Nothing in the repo touches hardware brightness. The relevant seams:

- `src-tauri/src/display/gamma.rs` — `pub type GammaRamp = [[u16; 256]; 3]`,
  `pub fn compose(kelvin: f64, brightness: f64, invert: bool) -> GammaRamp`,
  `pub fn apply_ramp(device: &str, ramp: &GammaRamp) -> bool`. `brightness` here is a **0.0–1.0
  multiplier folded into the LUT** — a software dim. Windows-only (`#[cfg(windows)]`
  `SetDeviceGammaRamp`); the non-Windows arms return `None` / `false`.
- `src-tauri/src/display/engine.rs` — owns `struct Target { device, from_kelvin, from_brightness,
  to_kelvin, to_brightness, invert }` and `fn apply_targets(targets: Vec<Target>, smooth: bool)`.
  `apply_targets` runs a **24-step / 400 ms animation** on a worker thread when
  `settings.display.smooth_transition` is on. Brightness is carried as `to_brightness: f64` in
  `0.0..=1.0` (percent ÷ 100 at the `Target` construction site).
- `src-tauri/src/display/monitors.rs` — `pub struct MonitorInfo { id, index, friendly_name,
  is_primary }` where `id` is the **GDI device name** `\\.\DISPLAY1`. `pub fn enumerate() ->
  Vec<MonitorInfo>` is `Vec::new()` off Windows. Plan 02 replaces this key.
- `src-tauri/src/settings/mod.rs` — `DisplaySettings { mode, wide_range, brightness_wide_range,
  disable_on_fullscreen, smooth_transition, sync_monitors, monitor_overrides: HashMap<String,
  MonitorOverride>, modes }`; `MonitorOverride { kelvin_day, kelvin_night, brightness_day,
  brightness_night }`. `brightness_*` are percentages `0..=100`.
- IPC today: `display_list_monitors`, `display_current`, `display_preview(kelvin, brightness,
  monitor_id)`, `display_preview_end` — all registered in `src-tauri/src/commands_registry.rs`.

**Everything brightness-related is currently Windows-only and software-only.** There is no notion of
a monitor that *cannot* be driven, so no vocabulary yet for reporting unavailability.

## 3. Per-platform verdict table

Two independent tiers per platform: **internal** (laptop/iMac panel) and **external** (DDC/CI over
the video cable). Verdicts given as `internal / external`.

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | UNVERIFIED / FULL | internal: WMI `WmiMonitorBrightnessMethods.WmiSetBrightness`; external: `ddc-winapi` (`GetMonitorCapabilities`/`SetVCPFeature`, VCP `0x10`) | The external path is the one both research files name as the cross-platform crate substrate (`docs/platform-research/linux.md` §2: `ddc-hi` uses `ddc-winapi` on Windows). **The internal/WMI path is not covered by either research file — UNVERIFIED, needs a spike.** Many desktop GPUs expose no internal panel at all, which is the normal case here. |
| macOS (Intel) | PARTIAL / PARTIAL | internal: private `DisplayServicesSetBrightness` (dlopen) with `CoreDisplay_Display_SetUserBrightness` as the legacy alternative; external: `IOFramebufferPortFromCGDisplayID` + `IOI2CSendRequest` | `macos.md` §2 lists all three internal entry points and marks the whole area **Risk: MEDIUM-HIGH, private, no crate**. ⚠️ **`IOI2CSendRequest` can kernel-panic on Intel** (from the 4th-pass brief; *not* corroborated in `macos.md` §2 — carry as UNVERIFIED but treat as disqualifying until falsified). `IODisplaySetFloatParameter` is listed but is the Apple-Silicon-broken one. |
| macOS (Apple Silicon) | PARTIAL / PARTIAL | internal: `DisplayServicesSetBrightness` ONLY; external: `IOAVServiceCreateWithService` + `IOAVServiceWriteI2C`/`ReadI2C` | `macos.md` §2: `DisplayServices*` is "necessary on Apple Silicon/macOS 11"; `IODisplaySetFloatParameter` is a **no-op on Apple Silicon** and displayutil deliberately does not use it; the **CoreDisplay path does not work on Apple Silicon** either. External uses `ARM64_DDC_7BIT_ADDRESS = 0x37`, `ARM64_DDC_DATA_ADDRESS = 0x51`, packet `[0x80|(len+1), len] + data + [0]` + XOR checksum. ⚠️ **M1 built-in HDMI ports do not support DDC at all**; DisplayLink adapters never do; `macos.md` §2 adds 2018 Mac mini HDMI, many HDMI→USB-C cables, and several Samsung/LG/BenQ OSD settings to the field-failure list. |
| Linux X11 | FULL / PARTIAL | internal: logind `org.freedesktop.login1.Session.SetBrightness("backlight", name, u value)`; external: `/dev/i2c-N` + `ddc-hi` | `linux.md` §2 [VERIFIED]. logind is polkit-gated but "normally granted to the active local session **with no prompt**" and is explicitly designed for this. External is PARTIAL only because it needs a udev rule we must ship (below). |
| Linux Wayland — KDE | FULL / FULL | `org.kde.Solid.PowerManagement` → `/org/kde/Solid/PowerManagement/Actions/BrightnessControl.setBrightness` | `linux.md` §2: on **KDE ≥ 6.2 this single D-Bus call covers internal *and* DDC externals, with hotplug handling — skip i2c entirely.** This is the best-case platform and needs no udev rule, no polkit dance, no i2c permission. |
| Linux Wayland — GNOME | FULL / PARTIAL | internal: logind; external: our own i2c + udev rule | `linux.md` §2: "**No GNOME equivalent for external monitors.**" GNOME will not do DDC for us, so external requires the full i2c permission story. |
| Linux Wayland — wlroots | FULL / PARTIAL | internal: logind; external: our own i2c + udev rule | Same as GNOME. No desktop service to delegate to. |

Cross-cutting, both DDC platforms: **DDC is slow (10s–100s of ms per write) and monitors vary in
conformance.** `linux.md` §2: "KDE's PowerDevil stopped animating DDC changes *to minimize monitor
lifespan risk* and applies after a 0.5 s debounce — copy that behaviour." That is not advice we get
to weigh; rapid VCP writes are a documented wear risk on the monitor's NVRAM. See §4.

## 4. Design

### 4.1 Module

New backend module `src-tauri/src/backlight/` (AGENTS.md: "New backend features get their own module
+ a command file registered in `commands_registry.rs`"):

```
src-tauri/src/backlight/
  mod.rs        // trait + registry + the debounced writer
  commands.rs   // backlight_probe / backlight_get / backlight_set
  windows.rs    // ddc-winapi + (spike) WMI
  macos.rs      // DisplayServices dlopen + IOAVService / IOI2CSendRequest
  linux.rs      // logind zbus proxy + ddc-hi + KDE Solid.PowerManagement
```

### 4.2 The trait and its types

```rust
/// How a monitor's backlight is reached. Surfaces in the UI badge so the user
/// knows whether "brightness" is physical or simulated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BacklightTransport {
    /// Internal panel (WMI / DisplayServices / logind backlight subsystem).
    Internal,
    /// DDC/CI over the video link (ddc-winapi / IOAVService / IOI2CSendRequest / i2c-dev).
    Ddc,
    /// Delegated to the desktop environment (KDE Solid.PowerManagement).
    DesktopService,
}

/// Why a monitor cannot be driven — rendered verbatim in the UI. Never `None`
/// when `writable == false`; that is the anti-silent-no-op contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BacklightUnavailable {
    NoBacklightDevice,
    DdcNotSupportedByMonitor,
    DdcBlockedByLink,      // HDMI on M1, DisplayLink, adapter swallows I2C
    PermissionDenied,      // /dev/i2c-N not accessible; polkit refused
    BackendUnavailable,    // no platform impl compiled/loaded
    ProbeTimedOut,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BacklightCapability {
    /// Plan 02's stable monitor id — the SAME key `MonitorInfo.id` uses.
    pub monitor_id: String,
    pub transport: Option<BacklightTransport>,
    /// Can we write brightness at all?
    pub writable: bool,
    /// Can we READ the current value back? Independent of `writable`:
    /// plenty of monitors accept VCP 0x10 writes and refuse the read.
    pub readable: bool,
    /// Present iff `!writable`. Drives the UI's explanation string.
    pub unavailable: Option<BacklightUnavailable>,
}

#[derive(Debug)]
pub enum BacklightError {
    Unavailable(BacklightUnavailable),
    Io(String),
}

/// One platform backend. `probe` is allowed to be slow (DDC enumeration is
/// seconds); everything else must return promptly.
pub trait BacklightBackend: Send + Sync {
    fn probe(&self) -> Vec<BacklightCapability>;
    /// Current backlight as a percentage 0..=100. `Ok(None)` = writable but not
    /// readable (report the last value WE wrote, never a fabricated number).
    fn get(&self, monitor_id: &str) -> Result<Option<u8>, BacklightError>;
    fn set(&self, monitor_id: &str, percent: u8) -> Result<(), BacklightError>;
}
```

**Data-model consequence of the weakest platform.** Three fields are `Option` *because of specific
hardware that can never fill them*, and each must be optional in Rust **and** in the generated
`src/bindings.ts` from day one:

1. `get()` → `Ok(None)`. Write-only DDC monitors are ordinary, and `macos.md` §2's field-failure list
   (Samsung Input Signal Plus, LG Uniformity, BenQ B.I.+) contains monitors that answer writes and
   not reads. The UI must render "—" or the optimistic last-written value clearly labelled, never a
   zero.
2. `BacklightCapability.transport: Option<_>` — a monitor with no reachable backlight has no
   transport, and inventing `Ddc` for it would make the UI lie.
3. `unavailable: Option<_>` carries the *reason*, which is the entire anti-silent-no-op mechanism.

### 4.3 The debounced writer — non-negotiable

DDC writes go through a single serialized worker per backend, never from the UI thread and **never
from `engine::apply_targets`' animation loop**:

```rust
/// Queue a brightness write. Coalescing: only the LAST value per monitor inside
/// the window is sent. Copies KDE PowerDevil (linux.md §2).
pub fn request_set(monitor_id: &str, percent: u8);

const DDC_DEBOUNCE: Duration = Duration::from_millis(500);
```

- **No animation, ever, on a `Ddc` transport.** `settings.display.smooth_transition` must be ignored
  for hardware brightness. The existing 24-step/400 ms loop in `engine::apply_targets` would issue
  24 VCP writes per change; at 10–100 ms each it would not even keep up, and it is precisely the
  wear pattern PowerDevil removed.
- `Internal` and `DesktopService` transports may animate, but there is no reason to — start without.
- A slider drag must call `display_preview`-style live updates against **gamma only**; hardware
  brightness lands on drag-end plus the 500 ms debounce.

### 4.4 Where it composes with the existing engine

`engine::refresh` gains a split: the mode preset's `brightness_*` percentage is routed to *either*
`gamma::compose(..., brightness01, ...)` (today's behaviour) *or* `backlight::request_set(...)`,
per monitor, per the new setting. When hardware brightness is active for a monitor, the gamma ramp
for that monitor is composed with `brightness = 1.0` so the two do not multiply.

### 4.5 Settings schema change

New section in `src-tauri/src/settings/mod.rs` (add struct + field on `AppSettings`, `Option<...>`
on `PartialSettings`, arm in `merge_patch`, clamp in `normalize_settings`, mirror the Zod schema on
the frontend — the four-step recipe in that file's module doc):

```rust
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct BacklightSettings {
    /// Master opt-in. OFF by default: this tier touches hardware, can be slow,
    /// and forecloses the Mac App Store (see §6).
    pub enabled: bool,
    /// Per stable-monitor-id opt-in. A monitor absent from the map uses gamma.
    pub monitors: HashMap<String, MonitorBacklight>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorBacklight {
    pub use_hardware: bool,
    /// Backlight percent at full day / full night, interpolated by
    /// `scheduler::day_factor()` exactly like `ModePreset` (F2.4).
    pub day: u32,
    pub night: u32,
}
```

`normalize_settings` clamps `day`/`night` to `0..=100`.

### 4.6 IPC surface

Three new commands in `commands_registry.rs` under a `// ── backlight ──` heading:

```rust
#[tauri::command] #[specta::specta]
pub fn backlight_probe() -> Vec<BacklightCapability>;

#[tauri::command] #[specta::specta]
pub fn backlight_get(monitor_id: String) -> Option<u8>;

#[tauri::command] #[specta::specta]
pub fn backlight_set(monitor_id: String, percent: u8) -> Result<(), String>;
```

Plus one event `backlight:changed` (`BacklightChangedEvent { monitor_id: String, percent: Option<u8>
}`) so the settings window follows external changes (OSD, brightness keys) where the backend can
observe them. Regenerate bindings with `cd src-tauri && cargo test export_bindings` — never hand-edit
`src/bindings.ts` (AGENTS.md).

### 4.7 Crate choices

| Platform | Crate | Note |
|---|---|---|
| Windows external | `ddc-winapi` (directly, or via `ddc` traits) | `linux.md` §2 names it as `ddc-hi`'s Windows backend. |
| Linux external | `ddc-hi` (i2c backend) | `linux.md` §2 recommends it as "the right choice for a cross-platform app" — ⚠️ but flags **"`ddc-hi` maintenance status in 2026 UNVERIFIED — check last-publish before committing."** Carry that tag. |
| macOS external | **`ddc-macos` 0.2.2, depended on DIRECTLY** | Supports Apple Silicon. **Never reach it via `ddc-hi`**, which is ~5 years stale and pins an ancient `ddc-macos` that predates the `IOAVService` work. ⚠️ `macos.md` §2 independently concluded "**`ddc-hi` does NOT cover the Apple-silicon `IOAVService` path** — expect to port `Arm64DDC.swift` to raw FFI. **Budget real time.**" The claim that `ddc-macos` 0.2.2 closes that gap is **UNVERIFIED against the on-disk research** — spike it (§9); if it fails, the hand-port is the fallback and the estimate goes up a size. |
| macOS internal | none — raw FFI + `dlopen` | `macos.md` §2: "Rust: raw FFI + `dlopen` of the PrivateFrameworks. No crate." |
| Linux internal | `zbus` hand-rolled logind proxy | `linux.md` §2: "**no canonical example found — UNVERIFIED**". |

### 4.8 macOS specifics the design must encode

- **Symbol resolution must be fallible per symbol, at runtime.** `dlopen` the framework, `dlsym`
  each entry point, and degrade to `unavailable: BackendUnavailable` when one is missing. This is
  not defensive padding: **12 `DisplayServices*` symbols were removed in macOS 15**, including
  `DisplayServicesBrightnessChanged`, which is dead — anything built on a change-notification
  callback must be rewritten as polling. The core get/set pair is reported stable through 26.5.
  (Both claims come from the 4th-pass brief; `macos.md` §2 predates them — **UNVERIFIED on disk**.)
- **The `IOAVService` ↔ display mapping is heuristic, not authoritative.** `macos.md` §2: MonitorControl
  "scores EDID UUID segments (vendor/product/manufacture date/image size) + up to 10 points for
  location, then does greedy allocation with taken-sets to prevent double-assignment." Copy that
  weighted scorer wholesale, including the greedy taken-set allocation — a naive nearest-match will
  assign two identical panels to the same service.
- **Do not use `IOServiceMatching` to find the services.** Walk the IORegistry for
  `DCPAVServiceProxy` nodes and keep only those whose `Location == "External"`. (4th-pass brief;
  not in `macos.md` — UNVERIFIED on disk, but it is the mechanism MonitorControl's `Arm64DDC.swift`
  uses and is cheap to confirm in a spike.)
- Because plan 02 owns the stable id, the heuristic's *output* is a mapping from plan-02 monitor id →
  `IOAVService`. That mapping is cache-invalidated on `CGDisplayRegisterReconfigurationCallback`
  (`macos.md` §0/§3), debounced ~500 ms and re-enumerated from scratch rather than diffed
  (`macos.md` §A).

## 5. Implementation steps

Each step leaves the repo green (`bun run lint typecheck test check:fsd`, `cargo fmt --check &&
cargo clippy --all-targets && cargo test`).

1. **Types + no-op registry.** Add `src-tauri/src/backlight/mod.rs` with the trait, the four
   `Serialize + Type` types, and a `NullBackend` returning
   `unavailable: Some(BackendUnavailable)` for every monitor from plan 02. Register the three
   commands + the event in `commands_registry.rs`; regenerate bindings. Nothing works yet, but the
   UI can already render "hardware brightness unavailable on this platform" honestly.
2. **Settings section.** `BacklightSettings` / `MonitorBacklight` + `PartialSettings` arm +
   `merge_patch` arm + `normalize_settings` clamps + unit tests mirroring the existing
   `merge_patch_clamps_concurrency` style. Mirror the Zod schema frontend-side.
3. **The debounced writer.** `request_set` + the 500 ms coalescing worker, backend-agnostic, unit
   tested against a fake backend that records call timestamps. This is pure logic and must be tested
   before any hardware backend exists.
4. **Windows DDC backend.** `ddc-winapi` enumeration + VCP `0x10` get/set, mapped to plan-02 ids.
   First real backend, and the one we can iterate on locally.
5. **Linux internal via logind.** `zbus` proxy for `SetBrightness`, reading
   `/sys/class/backlight/*/max_brightness` for the scale. ⚠️ **Do not fall back to writing sysfs
   directly** — `linux.md` §2: udev `GROUP=`/`MODE=` keys **do not apply** to backlight (no `/dev`
   node; the attribute is kernel-hardcoded 0644 root), so a sysfs fallback would need the
   `RUN+=` chgrp/chmod rule `brightnessctl` ships. logind avoids the whole problem.
6. **KDE Solid.PowerManagement backend.** Detect `$XDG_CURRENT_DESKTOP` contains `KDE` and the
   interface introspects; if so, prefer it for *both* tiers and skip i2c entirely (`linux.md` §2).
   Ship the `POWERDEVIL_NO_DDCUTIL`-equivalent escape hatch as a settings toggle.
7. **Linux external via i2c + `ddc-hi`**, gated on the udev rule being present (§6). *Spike first:
   confirm `ddc-hi`'s 2026 maintenance status (`linux.md` §2 UNVERIFIED).*
8. **macOS internal.** `dlopen` + per-symbol `dlsym` of `DisplayServicesGet/SetBrightness`. *Spike
   first: confirm the surviving symbol set on the macOS 26 baseline.*
9. **macOS external, Apple Silicon.** `ddc-macos` 0.2.2 + the MonitorControl weighted-scoring
   IORegistry walk. *Spike first (§9): does `ddc-macos` 0.2.2 actually carry the `IOAVService`
   path? If not, hand-port `Arm64DDC.swift` and re-estimate.*
10. **macOS external, Intel** — `IOI2CSendRequest`. ⚠️ **Gate behind an explicit, off-by-default,
    warning-labelled setting until the kernel-panic report is falsified.** Shipping a default-on
    path that can panic a user's Mac is not an acceptable failure mode.
11. **Engine integration.** Route brightness in `engine::refresh` per-monitor; force `brightness =
    1.0` into `gamma::compose` for hardware-driven monitors; suppress `smooth_transition` for `Ddc`.
12. **Frontend.** New FSD slice `src/features/backlight/` (model + api), consumed by the existing
    Display view's monitor strip. Run `bun run check:fsd`. Every capability with
    `unavailable: Some(_)` renders a specific i18n string in `messages/en.json` — one key per
    `BacklightUnavailable` variant, so `bun run check:i18n` enforces coverage.

Steps 7, 8, 9 are **spike-gated and cannot be estimated until the spikes land**.

## 6. Permissions, packaging, distribution

**macOS — this tier forecloses the Mac App Store. Say it plainly.**
`macos.md` §7's tier table is explicit: "DDC, DisplayServices, CoreBrightness, UniversalAccess →
❌ private → MAS reject (2.5.1)". Everything in this plan on macOS is private API. If a MAS SKU ever
matters, this whole plan must sit behind a Cargo feature that the MAS build does not enable —
exactly the "keep the private-API tiers behind a build feature" recommendation in `macos.md` §7.
Notarization and Developer ID distribution are **unaffected**; no entitlement is required; no TCC
prompt is triggered. So the cost is precisely one distribution channel, not the platform.

**Linux — external monitors need a udev rule, and that blocks pure Flatpak.**
`linux.md` §2: ddcutil ships `/usr/lib/udev/rules.d/60-ddcutil-i2c.rules` using the **`uaccess` tag**,
which grants the active local session user access with no group membership and no re-login — "the
modern correct approach". We must either ship an equivalent rule in our `.deb`/`.rpm`, or declare a
dependency on `ddcutil`. Neither is possible from inside a Flatpak sandbox, and `linux.md` states it
as "**a hard blocker for pure Flatpak**". Consequences:

- `.deb` / `.rpm` / AUR: ship the rule in `/usr/lib/udev/rules.d/`. Works.
- AppImage: cannot install a udev rule. External DDC is `PermissionDenied` unless the user has
  `ddcutil` installed. Detect and say so.
- Flatpak / Snap: external DDC is **BLOCKED**. On KDE ≥ 6.2 the `Solid.PowerManagement` D-Bus route
  works *through* the portal-visible session bus and sidesteps this entirely — another reason to
  prefer it. Internal brightness via logind also works (D-Bus, no device node).

**Linux internal — polkit, no prompt.** `linux.md` §2: logind's `SetBrightness` is "polkit-gated,
normally granted to the active local session with no prompt. Explicitly designed for this use case."
No packaging action needed. A remote/inactive session will be refused → `PermissionDenied`.

**Windows.** No manifest change, no elevation. DDC works unelevated.

## 7. Failure modes & degradation

The design premise: **on this feature, unavailability is the common case, not the exception.** A
desktop with one DisplayPort monitor behind a KVM, an M1 MacBook using its HDMI port, and a Flatpak
install are all normal and all yield no hardware control.

| Failure | What the user sees |
|---|---|
| No backend for the platform | The hardware-brightness toggle is **absent**, not disabled-and-mysterious; the Display tab shows only the gamma slider, as today. |
| Monitor probed, DDC unsupported | Per-monitor row shows "Gamma only — this monitor doesn't answer DDC/CI" and the hardware toggle for that row is disabled with that reason as its tooltip. |
| `PermissionDenied` on Linux i2c | Explicit remediation text naming the missing udev rule and the `ddcutil` package, plus a "why" link. Never a generic error. |
| Write succeeds, screen doesn't change | Cannot be detected in general (some monitors ACK and ignore). Mitigate by reading back where `readable`, and by *never* claiming success in the UI beyond echoing what we wrote. |
| Write-only monitor (`get` → `Ok(None)`) | Slider shows our last-written value with a subtle "not confirmed by the monitor" affordance; not a fabricated read. |
| Probe hangs | Hard per-monitor timeout → `ProbeTimedOut`. DDC enumeration blocking app start is a real risk; probe **off the startup path**, lazily, on first open of the Display tab. |
| Hot-plug / sleep-wake | Re-probe on the platform reconfiguration signal (macOS `CGDisplayRegisterReconfigurationCallback`, Linux RandR `ScreenChangeNotify` / KDE hotplug), debounced 500 ms, re-enumerated from scratch (`macos.md` §A). |

**State restoration.** Unlike gamma, hardware brightness is **persistent in the monitor's own NVRAM
and survives our process exiting**. `engine::restore_all` restores gamma ramps on exit; there is no
equivalent guarantee here and we must not pretend otherwise. Decision: **capture each monitor's
brightness at first successful probe and restore it on clean exit** (extend `app_exit`), but
document that a crash leaves the monitor where we left it — and add a "Reset monitor brightness"
action to the Display tab so the user has a recovery path that does not involve the OSD. Do **not**
attempt a restore from a crash handler: issuing DDC writes from a signal handler is unsafe and the
0.5 s debounce cannot run there.

## 8. Testing

**Unit-testable, in CI, on any platform:**
- The debounce/coalescing worker (step 3) against a fake `BacklightBackend` recording
  `(timestamp, monitor_id, percent)` — assert only the last value in a window is sent, assert no
  animation frames, assert per-monitor independence.
- Percent ↔ device-units scaling (`max_brightness` on Linux, VCP max on DDC), including the
  `max = 0` and `max = 1` degenerate cases.
- Day/night interpolation of `MonitorBacklight { day, night }` — reuse the `scheduler::day_factor`
  seam, which is already pure and tested (`src-tauri/src/display/scheduler.rs`).
- Settings merge/clamp tests alongside the existing ones in `settings/mod.rs`.
- The MonitorControl-style EDID+location weighted scorer: pure function over synthetic EDID blobs,
  including two-identical-panels and the `serial == 0x0000_0000` sentinel case (`macos.md` §A).

**Manual only, per hardware — cannot run in CI:**
- Every DDC path. Needs at least: one DisplayPort external, one HDMI external, one known-bad
  monitor from `macos.md` §2's field-failure list, and one DisplayLink adapter (to confirm we report
  `DdcBlockedByLink` rather than hanging).
- macOS internal on both an Intel Mac and an Apple Silicon Mac — the two use different symbols and
  `macos.md` §2 says the CoreDisplay path is Apple-Silicon-broken.
- M1 MacBook **HDMI port** specifically — expected to fail; the test is that we report it correctly.
- Linux: one KDE ≥ 6.2 seat (Solid route), one GNOME seat (logind + our own i2c), one seat *without*
  the udev rule (permission-denied messaging), one Flatpak install (external BLOCKED messaging).
- Intel-Mac `IOI2CSendRequest` panic reproduction — this must be attempted deliberately on a
  disposable machine before step 10 ships enabled.

**Not testable at all:** long-term monitor NVRAM wear from write frequency. Mitigated by policy
(0.5 s debounce, no animation) rather than verification.

## 9. Open questions / spikes needed

1. **Does `ddc-macos` 0.2.2 actually implement the Apple-Silicon `IOAVService` path?** `macos.md` §2
   says the ecosystem crate does not and budgets a hand-port of `Arm64DDC.swift`. The 4th-pass brief
   says `ddc-macos` 0.2.2 does. Blocking for step 9; decides whether that step is M or L.
2. **`IOI2CSendRequest` kernel panic on Intel** — reproducible? Under what conditions? Blocking for
   step 10. Until answered, Intel external DDC ships off by default.
3. **Which `DisplayServices*` symbols exist on the macOS 26.5 baseline?** The claim is that 12 were
   removed in macOS 15 and `DisplayServicesBrightnessChanged` is dead. Not in `macos.md` §2 —
   UNVERIFIED. Blocking for step 8 and for whether we can be notification-driven or must poll.
4. **`ddc-hi` maintenance status in 2026** — `linux.md` §2 flags this explicitly as UNVERIFIED.
   Blocking for step 7.
5. **Windows internal-panel brightness (WMI `WmiMonitorBrightnessMethods`)** — not covered by either
   research file. Needs a spike before we can claim FULL on Windows laptops.
6. **logind `SetBrightness` from Rust/zbus** — `linux.md` §2: "no canonical example found —
   UNVERIFIED". Needs a working proxy before step 5 can be estimated.
7. **Does the KDE `Solid.PowerManagement` route work from inside a Flatpak?** If yes, KDE Flatpak
   users get full external control and the Flatpak story improves materially.
8. Should hardware brightness and gamma brightness be **one slider or two**? One slider mapping the
   bottom of its range to backlight and the top to gamma is what users expect; two sliders is what
   is actually happening. Product decision, needed before step 12.

## 10. Effort

| Platform | Size | Note |
|---|---|---|
| Shared (types, debounce, settings, IPC, UI) | **M** | Mostly mechanical; the debounce worker is the only subtle part. |
| Windows | **M** | `ddc-winapi` is well-trodden. WMI internal path is an unknown S–M. |
| Linux | **M** | logind + KDE Solid are both single D-Bus calls. The i2c path is small; the *packaging* work (udev rule across three package formats) is the real cost. |
| macOS | **L–XL** | Two private frameworks, a heuristic display-mapping algorithm to port, an unresolved crate question, a possible kernel panic, and Intel/ARM divergence at every layer. |

**Single biggest risk:** the macOS external path. It is the only place where the plan depends on an
unresolved crate question (§9.1) whose negative answer converts a dependency into a hand-port of
`Arm64DDC.swift` plus a weighted-scoring heuristic — and where a second unresolved question (§9.2)
is a *kernel panic*. If both go badly, macOS external DDC should be cut rather than shipped, leaving
macOS with internal-panel control only.
