# Plan 00 — Platform capability layer
Status: DRAFT
Depends on: (none — this is the foundation for 01, 02 and everything after)
Parity ref: FEATURE-PARITY.md — cross-cutting; gates F1.6, F1.7, F1.9, F1.11, F2.3, F4.\*, F8.\*, F9.\*, F10.1, F10.4

---

## 1. What this feature is

A runtime model of **what this build can actually do on the machine it is running on**, computed
once at startup and surfaced to the renderer as a typed struct. Today DimRead assumes Windows: every
Win32 path is `#[cfg(windows)]`-gated with a silent no-op on other targets (see
`src-tauri/src/display/gamma.rs:99-107`, `monitors.rs:37-40`, `grayscale.rs:19-20`). Ported to
macOS and Linux, that pattern produces an app whose sliders move, whose toggles flip, and whose
screen never changes.

The user-visible product of this plan is the opposite: every control that cannot work on this
machine is **rendered disabled with a one-line reason** — "Per-monitor tint is unavailable on GNOME
Wayland: the desktop applies one colour temperature to all displays" — and every control that works
in a reduced way says so. The stated product preference is **disable-with-explanation as the
default, degrade-where-possible where a degraded mode is genuinely useful**. Silent no-ops are
forbidden.

This plan also fixes the **platform-module directory convention** that plans 01+ follow.

## 2. Current state

There is no capability concept anywhere in the repo. What exists:

- **Backend.** `src-tauri/src/` is organised by infrastructure concern (`display/`, `focus/`,
  `hotkeys/`, `magicx/`, `overlay/`, `rules/`, `settings/`, `windows/`). Platform code is inlined
  as `mod windows_impl` blocks inside concern modules — e.g.
  `src-tauri/src/display/gamma.rs:109` (`mod windows_impl`), `display/monitors.rs:42`,
  `display/grayscale.rs:22`. `src-tauri/Cargo.toml` has a single
  `[target.'cfg(windows)'.dependencies]` block carrying `windows 0.61` and `winreg`.
- **No `src-tauri/src/platform/` directory exists.**
- **IPC.** `src-tauri/src/commands_registry.rs::make_specta_builder()` is the single
  `collect_commands![]` / `collect_events![]` registry. `src/bindings.ts` is generated
  (`cd src-tauri && cargo test export_bindings`) and never hand-edited.
- **Settings.** `src-tauri/src/settings/mod.rs` defines the tree; `src/shared/config/settings-schema/index.ts`
  mirrors it in Zod; `src/entities/setting/model/settings-store.ts` holds it in Zustand.
  `src-tauri/src/settings/store.rs:2-19` states plainly that it was ported **without schema
  migrations** — relevant to plan 02, noted here because the capability layer must not need one
  (capabilities are runtime-derived, never persisted).
- **UI.** Controls are unconditionally enabled. `src/views/main/ui/panels/DisplayPanel.tsx:140`
  is the only conditional rendering of a display control, and it keys on monitor count, not
  capability. `src/features/display/model/use-monitors.ts` already carries the one existing
  environment check, `hasNativeRuntime()` from `@/shared/api` — the seam a capability hook slots
  beside.
- **i18n.** `messages/en.json` has 23 top-level namespaces (`displayTab`, `optionsTab`, `focusTab`,
  `magicxTab`, …). The lint gate rejects JSX string literals, so explanation strings must be keys
  from day one. There is no `capability` namespace.

Portable today: the pure maths (`gamma::compose`, `gamma::kelvin_to_rgb`, `display::suncalc`,
`display::scheduler`), the settings pipeline, the window shell, i18n. Windows-only: everything that
touches a device.

## 3. Per-platform verdict table

The feature under test here is **the capability probe itself** — can we determine, accurately and
cheaply, what this machine supports?

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | `cfg!(windows)` + Win32 availability checks | Single session model, no compositor variance. The only real probe is "did `MagInitialize` succeed" (already done at `display/grayscale.rs:59-73`) and DXGI/GDI presence. Packaging detected from the NSIS portable marker (`src-tauri/src/portable.rs`). |
| macOS (Intel) | **FULL** for identity, **PARTIAL** for effect | `cfg!(target_os="macos")` + framework `dlopen` presence checks | We can detect OS version, display list, HDR state, and whether a private framework symbol resolves. We **cannot** probe whether gamma actually takes effect — see next row. |
| macOS (Apple Silicon) | **PARTIAL** | same | ⚠️ **A write-then-read-back gamma probe is NOT sufficient.** `docs/platform-research/macos.md` §0: on M5-class hardware `CGSetDisplayTransferByTable` returns `kCGErrorSuccess`, `CGGetDisplayTransferByTable` **reads the values back correctly, and nothing changes on screen** (Apple radars FB22273730 / FB22273782). The readback lies. Gamma capability on macOS is therefore reported as `unverified`, never `full`, and the truth is resolved by the **user** (see §4, "the macOS honesty valve"). |
| Linux X11 | **FULL** | `$WAYLAND_DISPLAY` absent + `$DISPLAY` present + RandR ≥1.3 version query | Highest-fidelity environment in the whole matrix (`docs/platform-research/linux.md` §0, §1, §5-6). Probe = one RandR version round-trip. |
| Linux Wayland — KDE | **FULL** | `$WAYLAND_DISPLAY` + `$XDG_CURRENT_DESKTOP=KDE` + D-Bus name-has-owner on `org.kde.KWin` | The only compositor that natively supports layer-shell **and** the GlobalShortcuts portal **and** the Background portal (`linux.md` §"cross-cutting punchline"). Portal versions read from `org.freedesktop.portal.Desktop` properties. |
| Linux Wayland — GNOME | **FULL** (probe), gates the most features | `$WAYLAND_DISPLAY` + `$XDG_CURRENT_DESKTOP` contains `GNOME` + `org.gnome.Mutter.DisplayConfig` owner | Detection is easy; the *results* are the most restrictive in the document. Layer-shell **refused permanently** (mutter#973 closed without implementation, `linux.md` §7); no `ext-layer-shell` exists and standardisation is not coming. This is the row that most needs disable-with-explanation. |
| Linux Wayland — wlroots | **PARTIAL** | `$SWAYSOCK` / `$HYPRLAND_INSTANCE_SIGNATURE` / registry-probe for `zwlr_*` globals | sway and Hyprland are precisely identifiable via their env vars + IPC sockets. Bare wlroots (river, labwc, Wayfire) has no single reliable marker — fall back to binding-probing the Wayland registry for `zwlr_gamma_control_manager_v1` / `zwlr_layer_shell_v1`. ⚠️ **UNVERIFIED**: `linux.md` does not confirm that a registry bind-probe is side-effect-free for every one of these globals; spike it (§9). |

**The Xwayland trap, stated once and inherited by every later plan:** a Tauri app running under
Wayland also sees `$DISPLAY` set, pointing at Xwayland. Checking `$DISPLAY` first misroutes to a
backend that sees only Xwayland clients — no root window, no `_NET_ACTIVE_WINDOW`, no working XRandR
gamma for the real outputs (`linux.md` §0, §"Recommended architecture"). **`$WAYLAND_DISPLAY` is
checked FIRST, unconditionally.**

## 4. Design

### 4.1 Directory convention (binding on plans 01+)

```
src-tauri/src/platform/
├── mod.rs          # PlatformCapabilities + FeatureCapability types; `capabilities()` accessor
├── commands.rs     # the `platform_capabilities` IPC command
├── detect.rs       # env/session/compositor/packaging detection — PURE over an injected env map
├── windows/mod.rs  # #[cfg(target_os = "windows")]
├── macos/mod.rs    # #[cfg(target_os = "macos")]
├── linux/mod.rs    # #[cfg(target_os = "linux")]  — submodules: x11.rs, wayland.rs, portal.rs, dbus.rs
└── unsupported.rs  # #[cfg(not(any(...)))] — every capability reports `blocked`, reason `unsupportedOs`
```

Rules, enforced by review:

1. **Concern modules keep their orchestration; only the device I/O moves.** `display/engine.rs` stays
   the orchestrator and the stable seam. `display/gamma.rs` keeps `compose` / `kelvin_to_rgb` /
   `identity` (pure, unit-tested) and loses `mod windows_impl`, which becomes
   `platform/windows/gamma.rs`.
2. **One `#[cfg]` boundary per concern, at the `platform/` module root** — not scattered `#[cfg]`
   arms inside business logic. Concern code calls `crate::platform::gamma::apply_ramp(...)`; the
   `platform` module re-exports whichever implementation compiled.
3. **`unsupported.rs` must always compile.** A build for an OS we have not ported keeps the crate
   green, with every capability `blocked`.
4. Cargo gains `[target.'cfg(target_os = "macos")'.dependencies]` and
   `[target.'cfg(target_os = "linux")'.dependencies]` blocks alongside the existing
   `[target.'cfg(windows)'.dependencies]`.

### 4.2 The capability types

```rust
// src-tauri/src/platform/mod.rs

/// How well a feature works on THIS machine. Mirrors the plan-template verdicts
/// so a plan row and a runtime report use the same vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityLevel {
    /// Works as designed.
    Full,
    /// Works, but reduced. `reason` says how.
    Partial,
    /// Cannot work here. `reason` says why. UI disables the control.
    Blocked,
    /// We cannot determine this without user confirmation or a spike.
    /// Treated as Partial by the UI, with a distinct explanation.
    Unverified,
}

/// Stable, machine-readable reason code. This is the i18n key suffix — see §4.5.
/// NEVER a free-form string: a free-form string cannot be translated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReasonCode {
    UnsupportedOs,
    WaylandNoGlobalPositioning,   // linux.md §7
    WaylandNoGammaProtocol,       // linux.md §1
    GnomeLayerShellRefused,       // mutter#973, linux.md §7
    KdePreviewAutoReverts,        // 15 s QTimer, linux.md §1
    DesktopTintIsGlobalOnly,      // gsd Temperature is not per-monitor
    NoEdidOnWayland,              // linux.md §3
    MacosGammaUnreliable,         // macos.md §0 (M5 radars)
    MacosGammaDisablesHdr,        // macos.md §0
    GammaCannotExpressGrayscale,  // macos.md §4 / linux.md §4 — arithmetic, not policy
    RequiresPrivateApi,
    RequiresAccessibilityGrant,
    PortalInterfaceMissing,
    PortalVersionTooOld,
    SandboxBlocksDeviceAccess,    // Flatpak/Snap vs /dev/i2c-*
    CompositorUnknown,
    NeedsSpike,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FeatureId {
    ColourTemperature,      // F1.1-F1.2  (plan 01)
    Brightness,             // F2.1-F2.2  (plan 01)
    PerMonitorTint,         // F2.3       (plans 01 + 02)
    StableMonitorIdentity,  // F2.3       (plan 02)
    ScreenshotPassthrough,  // F1.7 — "no yellow screenshots"
    Invert,                 // F1.5 Editing mode
    Grayscale,              // F1.6 Reading mode
    FullscreenAppDetection, // F1.11
    ForegroundWindowRules,  // F4.1-F4.3
    OverlayWindows,         // F6, F8
    PerWindowEffects,       // F9.1-F9.4
    GlobalHotkeys,          // F10.4
    Autostart,              // F10.1
    SystemThemeControl,     // F9.5
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCapability {
    pub feature: FeatureId,
    pub level: CapabilityLevel,
    /// Which backend serves it, e.g. "gamma.x11.randr", "overlay.macos.nswindow",
    /// "dbus.gnome.settingsdaemon". Diagnostic, shown in About → Driver Information
    /// (parity F11.1), never user-facing prose.
    #[specta(optional)]
    pub mechanism: Option<String>,
    /// Present whenever `level != Full`. Drives the UI explanation.
    #[specta(optional)]
    pub reason: Option<ReasonCode>,
    /// Untranslated diagnostic detail for logs/About (e.g. "portal v1, need v2").
    #[specta(optional)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub os: OsKind,                        // windows | macos | linux | other
    pub session: SessionKind,              // windows | quartz | x11 | wayland | unknown
    #[specta(optional)]
    pub compositor: Option<CompositorId>,  // kwin | mutter | sway | hyprland | wlroots | other
    #[specta(optional)]
    pub desktop_raw: Option<String>,       // verbatim $XDG_CURRENT_DESKTOP, for bug reports
    pub packaging: PackagingKind,          // native | flatpak | snap | appImage | portable
    pub portals: Vec<PortalInterface>,     // { name, version } — Linux only, empty elsewhere
    pub features: Vec<FeatureCapability>,
}
```

**Data-model consequence of the weakest platform.** Three fields are `Option` from day one *because
one backend can never fill them*, and retrofitting optionality through `src/bindings.ts` is far more
painful later (`linux.md` §"Recommended architecture" makes this point explicitly):

- `compositor` — meaningless on Windows/macOS, and genuinely unknowable on bare wlroots.
- `mechanism` — a `blocked` feature has no backend.
- `PortalInterface.version` — a portal that is not present has no version, and an unowned D-Bus name
  cannot be distinguished from a not-yet-started service.

### 4.3 Detection order (Linux — the part that is easy to get wrong)

`platform/linux/detect.rs`, written as a **pure function over an injected env map** so it is fully
unit-testable in CI on any host:

```rust
pub fn detect_session(env: &dyn EnvSource) -> SessionKind;
pub fn detect_compositor(env: &dyn EnvSource, session: SessionKind) -> Option<CompositorId>;
pub fn detect_packaging(env: &dyn EnvSource, fs: &dyn FsProbe) -> PackagingKind;
```

Order, non-negotiable:

1. **`$WAYLAND_DISPLAY` first.** Non-empty ⇒ `SessionKind::Wayland`. Do not look at `$DISPLAY` yet
   — under Wayland it points at Xwayland (`linux.md` §0).
2. Else `$DISPLAY` non-empty ⇒ `SessionKind::X11`. (Cross-check `$XDG_SESSION_TYPE` and log a
   warning on disagreement; do not let it override the two above.)
3. Compositor identity, in order of decreasing certainty:
   `$SWAYSOCK` ⇒ `Sway` · `$HYPRLAND_INSTANCE_SIGNATURE` ⇒ `Hyprland` ·
   `$XDG_CURRENT_DESKTOP` (colon-separated, case-insensitive `contains`) ⇒ `KDE` / `GNOME` /
   `COSMIC` / … · else Wayland-registry bind-probe for `zwlr_layer_shell_v1` +
   `zwlr_gamma_control_manager_v1` ⇒ `Wlroots` · else `None` with reason `CompositorUnknown`.
4. **Packaging**: `/.flatpak-info` exists ⇒ `Flatpak` · `$SNAP` non-empty ⇒ `Snap` ·
   `$APPIMAGE` non-empty ⇒ `AppImage` · else `Native`. This is the same detection
   `linux.md` §10 requires for the autostart fix, so it lives here once and both consumers read it.
5. **Portal versions**: for each interface we care about (`GlobalShortcuts`, `Background`,
   `Settings`), read the `version` property on `org.freedesktop.portal.Desktop` over zbus.
   ⚠️ `linux.md` §1 records a real-world D-Bus **type mismatch** report on the GNOME colour
   interface — **introspect at runtime, do not hardcode signatures.** Apply the same caution here.

### 4.4 IPC surface

One new command in `platform/commands.rs`, registered in
`src-tauri/src/commands_registry.rs::make_specta_builder()` under a new `// ── platform ──` group:

```rust
/// `platform_capabilities` — what this build can do on this machine. Computed
/// once at startup (OnceLock) and returned verbatim; cheap to call repeatedly.
#[tauri::command]
#[specta::specta]
pub fn platform_capabilities() -> PlatformCapabilities { crate::platform::capabilities().clone() }
```

Plus one typed event for the cases where capabilities genuinely change mid-session — a monitor with
a different EDID is hot-plugged, the user installs the GNOME Window Calls extension, the user flips
the `GDK_BACKEND=x11` setting (which needs a restart, but the *pending* state should surface):

```rust
// src-tauri/src/events.rs, alongside DisplayStateEvent (events.rs:102-110)
pub struct PlatformCapabilitiesEvent(pub PlatformCapabilities);
impl tauri_specta::Event for PlatformCapabilitiesEvent {
    const NAME: &'static str = "platform:capabilities";
}
```
Add `"PLATFORM_CAPABILITIES": "platform:capabilities"` to
`src/shared/api/native-events.ts::NATIVE_EVENTS`.

Both go through `cargo test export_bindings` — `src/bindings.ts` is regenerated, never edited.

**Capabilities are never persisted.** They do not enter `AppSettings`, the Zod schema, or the
Zustand settings store. A settings blob copied between machines (or a portable install on a USB
stick) must not carry a stale capability set. They live in a **separate** entity store.

### 4.5 Frontend shape (FSD)

New slice — run `bun run check:fsd` after creating it, and expect a REVIEW flag needing an
acknowledgement in `fsd.config.json` in the same style as the existing `features/display` entry:

```
src/entities/capability/
├── index.ts                       # public barrel
├── model/
│   ├── capability-store.ts        # Zustand: capabilities + load()/subscribe to platform:capabilities
│   ├── use-capability.ts          # useCapability(FeatureId) -> FeatureCapability | undefined
│   └── capability-text.ts         # (level, reason) -> i18n key. PURE. Unit-tested.
└── ui/
    └── CapabilityGate.tsx         # the disable-with-explanation wrapper
```

`entities/` may be imported by `features/`, `widgets/` and `views/` — correct direction for FSD.
It must not import from `features/`.

`CapabilityGate` is the one component that encodes the UX contract:

| Level | Control | Explanation |
|---|---|---|
| `full` | enabled | none |
| `partial` | **enabled** | persistent inline caption under the control, muted |
| `unverified` | **enabled** | persistent inline caption + (macOS gamma only) a "Did that work?" confirmation affordance |
| `blocked` | **disabled**, `aria-disabled`, not focus-trapped | persistent inline caption — **never a hover-only tooltip** |

The blocked explanation is *always visible text*, never tooltip-only: a disabled control the user
cannot hover (touch, keyboard-only, screen reader) must still say why.

### 4.6 i18n key strategy

Two flat namespaces in `messages/en.json`, both keyed on the Rust enums so the compiler and the
message file stay in lockstep:

```jsonc
"capability": {
  "featureColourTemperature": "Colour temperature",
  "featureGrayscale": "Reading mode (grayscale)",
  // … one per FeatureId, camelCase-matching the serde rename

  "reasonWaylandNoGammaProtocol":
    "Wayland has no standard colour-temperature protocol, and this desktop does not provide one.",
  "reasonGnomeLayerShellRefused":
    "GNOME does not allow apps to place overlay windows. Run a GNOME X11 session, or switch to another desktop, to use this.",
  "reasonKdePreviewAutoReverts":
    "KDE only lets apps preview a colour temperature; it reverts automatically. DimRead keeps re-applying it, so you may see brief flickers.",
  "reasonGammaCannotExpressGrayscale":
    "Grayscale needs to mix the red, green and blue channels together, which the graphics colour table cannot do.",
  "reasonMacosGammaUnreliable":
    "On some Macs the system reports the colour change was applied but the screen does not change. DimRead cannot detect this — use the overlay mode if the screen looks unchanged.",
  // … one per ReasonCode

  "levelPartial": "Limited on this system",
  "levelBlocked": "Not available on this system",
  "levelUnverified": "May not work on this system"
}
```

Rules:
- **Key = `capability.reason` + PascalCase(ReasonCode)**, derived mechanically in
  `capability-text.ts`. Adding a `ReasonCode` in Rust and forgetting the message is caught by
  `bun run check:i18n` once the checker is given the enum list (step 7 below).
- Explanations are **written for the user, not the developer**: no protocol names, no issue numbers,
  no "mutter#973". The mechanism string carries that for About → Driver Information.
- Every explanation says **what the user can do**, if anything ("Run a GNOME X11 session…").
  Where nothing can be done, it says so without apologising.
- One string per reason, *not* per (feature × reason) pair — otherwise the message file grows
  combinatorially. Where a reason genuinely reads wrong for one feature, add a
  `reason<Code>For<Feature>` override and have `capability-text.ts` prefer it. Keep these rare.

## 5. Implementation steps

Each step leaves the repo green (`bun run lint && bun run typecheck && bun run test && bun run check:fsd`
and `cargo fmt --check && cargo clippy --all-targets && cargo test`).

1. **Create `src-tauri/src/platform/` with types + `unsupported.rs` only.** No detection yet;
   `capabilities()` returns every `FeatureId` as `Blocked`/`UnsupportedOs` on non-Windows and
   hardcoded `Full` on Windows. Register `platform_capabilities` in `commands_registry.rs`, add
   `PlatformCapabilitiesEvent` to `events.rs` + `native-events.ts`, regenerate bindings. *Repo is
   green on all three OSes at this point and nothing behaves differently on Windows.*
2. **Move the Win32 device I/O.** `display/gamma.rs::windows_impl` → `platform/windows/gamma.rs`;
   `display/monitors.rs::windows_impl` → `platform/windows/monitors.rs`;
   `display/grayscale.rs::windows_impl` → `platform/windows/grayscale.rs`. Pure logic stays put.
   Behaviour-preserving refactor; existing tests in `display/gamma.rs:163-196` must pass untouched.
3. **`platform/detect.rs` + `platform/linux/detect.rs`, pure over an injected `EnvSource`.** Ship
   the full unit-test table here (§8) — this is the highest-value testable artefact in the plan and
   it runs in CI on Windows.
4. **Linux runtime probes**: zbus D-Bus name-has-owner + portal `version` properties; Wayland
   registry bind-probe. *Needs a spike* — see §9.
5. **macOS probes**: OS version, `CGGetOnlineDisplayList` count, HDR/EDR state per display,
   `dlopen` presence of the private frameworks we might use. **No gamma effect probe** — see §7.
6. **Frontend `entities/capability`** + `CapabilityGate`. Wire *one* consumer first
   (`DisplayPanel.tsx`'s monitor strip, gated on `PerMonitorTint`) to prove the pattern end-to-end.
7. **i18n**: add the `capability` namespace to `messages/en.json`; extend `tools/`'s
   `check:i18n` to assert every `ReasonCode` and `FeatureId` variant has a message. Locale files
   other than `en` inherit the usual missing-key behaviour.
8. **Retrofit remaining consumers** — Options→Display, Focus, MagicX, Hotkeys panels. Mechanical
   once step 6 lands.
9. **About → Driver Information** (parity F11.1): dump `PlatformCapabilities` verbatim, copyable.
   Costs almost nothing and makes every future bug report tractable.

## 6. Permissions, packaging, distribution

The capability layer itself requires **no permission, no entitlement, no TCC prompt, no udev rule,
no polkit action** on any platform. That is deliberate: a probe that needs permission to run cannot
report that permission is missing.

Consequences it *reports* (owned by later plans, surfaced here):

- **Flatpak/Snap**: `linux.md` §2 — DDC/CI needs a udev rule (`uaccess` tag, as ddcutil ships) and
  is a "hard blocker for pure Flatpak". The layer detects the sandbox and pre-emptively marks
  external-monitor brightness `Blocked`/`SandboxBlocksDeviceAccess` rather than letting it fail at
  first use. Same for autostart: `linux.md` §10 — Flatpak autostart via the plugin **silently
  succeeds and does nothing**; the layer routes to the Background portal instead.
- **macOS**: reporting `RequiresAccessibilityGrant` is free. Following the HazeOver precedent
  (`macos.md` §5), Accessibility must stay **optional** — never gate the app behind a first-launch
  TCC prompt, and never request Screen Recording (`macos.md` §6).
- **App Store**: the layer is public API only and forecloses nothing. It is however the mechanism by
  which a hypothetical MAS build advertises its reduced feature set — a MAS SKU compiled without the
  private-API tiers reports those features `Blocked`/`RequiresPrivateApi` and the same UI copy
  explains it. `macos.md` §7 documents that MonitorControl *Lite* ships on MAS exactly this way.
- **Windows**: no change. Portable-install detection already exists in `src-tauri/src/portable.rs`
  and folds into `PackagingKind`.

## 7. Failure modes & degradation

**The contract: no code path may return "success" for an operation it did not perform.** Today's
`gamma::apply_ramp` returns `false` off-Windows (`display/gamma.rs:104-107`) and every caller in
`display/engine.rs` ignores the return value. That is the exact failure this plan exists to kill.

| Failure | What the user sees |
|---|---|
| Whole feature unsupported | Control disabled, inline reason, About lists it as blocked |
| Feature degraded | Control enabled, persistent inline caption naming the limitation |
| Probe itself fails (D-Bus timeout, Wayland connect error) | Level `Unverified`, reason `NeedsSpike`/`CompositorUnknown`, control **enabled** — we do not disable on a failed probe, because a false negative that hides a working feature is worse than an honest "we're not sure" |
| Backend fails at apply time despite `Full` | The apply path returns `Err`, the engine downgrades that feature to `Partial` at runtime and emits `platform:capabilities` — the UI updates live |

**The macOS honesty valve.** `macos.md` §0 is unambiguous: on M5-class hardware the gamma write
succeeds, the readback is correct, and the screen does not change. There is **no programmatic probe
that can detect this**. Therefore:

- macOS gamma is reported `Unverified` with `MacosGammaUnreliable` — never `Full`, on any Mac,
  because we cannot distinguish affected from unaffected hardware.
- The UI offers the user the resolution: a "the screen didn't change" affordance next to the gamma
  toggle that switches the display engine to the overlay backend (plan 01) and remembers the choice.
- The choice is a **user preference, persisted in settings** — not a capability. Capabilities are
  derived; preferences are stored. Keeping that boundary clean is what stops the capability set from
  needing a settings migration.

**State restore is NOT this plan's job** but this plan must not obstruct it: `capabilities()` is
computed from a `OnceLock` and does no device writes, so a crash during probing leaves nothing to
restore. Plan 01 owns gamma-state restoration.

## 8. Testing

**Unit-testable in CI, on any host** (this is most of the plan's value):

- `detect_session` / `detect_compositor` / `detect_packaging` over a table of synthetic env maps —
  Wayland+`$DISPLAY` set (the Xwayland trap), Wayland-only, X11-only, neither, sway, Hyprland,
  `XDG_CURRENT_DESKTOP="ubuntu:GNOME"`, `"KDE"`, `"COSMIC"`, Flatpak, Snap, AppImage, and
  combinations (Flatpak + GNOME Wayland). **The Xwayland case is the single most important assertion
  in this plan** — assert `detect_session` returns `Wayland` when both vars are set.
- `capability-text.ts`: `(level, reason) -> key` mapping, including the per-feature override path.
  Bun test, colocated as `capability-text.test.ts`.
- Message-key parity: every `ReasonCode`/`FeatureId` has a message (`bun run check:i18n`, extended).
- `CapabilityGate` render tests: `blocked` renders `aria-disabled` + visible text; `partial` renders
  enabled + caption; `full` renders bare.

**Manual only, on real hardware** — cannot run in CI:

- Whether the Wayland registry bind-probe is side-effect-free on sway / Hyprland / river / labwc.
- Portal version reporting on KDE Plasma ≥5.27, GNOME ≥48, and a wlroots session
  (`linux.md` §10: xdg-desktop-portal-wlr does not implement GlobalShortcuts at all — assert we
  report `PortalInterfaceMissing`, not a timeout).
- macOS: that the layer reports `Unverified` for gamma on **both** an affected M5-class machine and
  an unaffected M3 — identical output is the correct result.
- Flatpak/Snap builds actually detecting themselves (needs the packaging work to exist first).

**Cannot be tested at all in CI:** every Linux Wayland row. GitHub Actions runners provide no
Wayland session. Budget a physical/VM test matrix — minimum KDE Plasma Wayland, GNOME Wayland, sway,
and one X11 session.

## 9. Open questions / spikes needed

1. **Wayland registry bind-probe safety.** Is binding `zwlr_gamma_control_manager_v1` purely to test
   for its existence side-effect-free? `linux.md` §1 notes `wlr-gamma-control` is **exclusive** —
   a second client gets `failed`. If merely *binding the manager* (as opposed to calling
   `get_gamma_control`) claims exclusivity, our probe would lock out `gammastep`/`wlsunset` at
   startup. **Blocks step 4.** Must be resolved before any Wayland gamma work in plan 01.
2. **zbus async-runtime conflict.** `linux.md` §10: "`zbus`'s async-runtime feature is global and
   Tauri uses tokio — either use ashpd's tokio feature consistently or isolate with async-std. **Do
   not mix.**" This plan introduces the *first* zbus usage in the crate and therefore sets the
   choice for every later plan. Decide before step 4. Recommendation: tokio feature throughout,
   matching Tauri.
3. **Bare-wlroots identification** (river, labwc, Wayfire) has no verified marker. Carried as
   **UNVERIFIED**; if the bind-probe is unsafe (Q1), we may have to report `CompositorUnknown` and
   let the *first real use* determine capability.
4. **`GDK_BACKEND=x11` as a user-facing setting.** `linux.md` §"Recommended architecture" calls it
   "a legitimate product decision" and the only path to a working overlay on GNOME Wayland. It
   requires a **restart** to take effect, and it changes the capability set. Does it belong in this
   plan (as a capability-influencing preference) or plan 01? Proposal: the setting lives in plan 01,
   but this plan must model "capabilities depend on a restart-scoped preference" from the start —
   i.e. `PlatformCapabilities` carries what is true *now*, and the UI shows a pending-restart banner
   separately. Confirm before step 1 freezes the struct.
5. **XDG portal `org.freedesktop.portal.Settings`** for light/dark is tagged **UNVERIFIED** in
   `linux.md` §9 ("not confirmed this session"). `SystemThemeControl` capability on Linux therefore
   ships as `Unverified` until re-researched. Do not upgrade it on the basis of this plan.

## 10. Effort

| Platform | Size | |
|---|---|---|
| Types + directory convention + IPC + bindings | **S** | mechanical |
| Windows (move `windows_impl` blocks) | **S** | behaviour-preserving refactor |
| Frontend `entities/capability` + `CapabilityGate` + i18n | **M** | ~9 consumers to retrofit |
| macOS probes | **M** | mostly "report Unverified honestly" |
| Linux probes | **L** | first zbus + first Wayland client code in the crate; 2 blocking spikes |

**Biggest risk:** the capability enum set is a **frozen IPC contract the moment plans 01 and 02
build on it.** `FeatureId` and `ReasonCode` flow through generated `src/bindings.ts` into the i18n
message file into the UI. Getting the granularity wrong — one `ColourTemperature` flag where the
product actually needs `ColourTemperature` × `PerMonitor` × `ScreenshotPassthrough` separately —
means a churn across all three layers. **Mitigation: derive the enum variants directly from the
verdict tables in plans 01 and 02 before writing step 1.** Write those tables first; this plan's
step 1 is genuinely blocked on them, despite being numbered 00.
