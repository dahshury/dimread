# Plan 02 — Monitor enumeration + stable per-monitor identity
Status: DRAFT
Depends on: 00 (platform capability layer). Consumed by 01 (the display engine keys targets on it).
Parity ref: FEATURE-PARITY.md F2.3 (per-monitor tab strip: "All Monitors · 1 · 2"), F11.1 (Driver
Information)

---

## 1. What this feature is

The Display tab's monitor strip — "All monitors · Monitor 1 · Monitor 2" — that lets the user tune
each display independently or sync them all (F2.3, `research/careueyes/images/landing_display-912x625.png`).
The visible feature is small. The invisible one is not: **the per-monitor settings the user tunes
must still be attached to the right monitor tomorrow**, after a reboot, after unplugging the dock,
after the monitors come back in a different order.

That requires a per-monitor identity that is stable across sessions. We currently use the Windows
GDI device name, and it is the **persisted key of a settings map**. Changing it is therefore a
**data migration**, not a refactor.

## 2. Current state

```rust
// src-tauri/src/display/monitors.rs:19-30
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// GDI device name, e.g. `\\.\DISPLAY1`. The engine's per-monitor key.
    pub id: String,
    pub index: u32,
    pub friendly_name: String,
    pub is_primary: bool,
}

#[cfg(windows)]  pub fn enumerate() -> Vec<MonitorInfo> { windows_impl::enumerate() }
#[cfg(not(windows))] pub fn enumerate() -> Vec<MonitorInfo> { Vec::new() }   // ← silent empty
```

`windows_impl::enumerate` (`monitors.rs:75-114`) walks `EnumDisplayMonitors` → `GetMonitorInfoW`,
takes `MONITORINFOEXW.szDevice` as `id`, and resolves `friendly_name` via `EnumDisplayDevicesW`.

**Where `id` is used as a persisted key — this is the crux:**

| Site | Use |
|---|---|
| `src-tauri/src/settings/mod.rs:188` | `pub monitor_overrides: HashMap<String, MonitorOverride>` — **persisted to `dimread-settings.json`** |
| `src/shared/config/settings-schema/index.ts:174-178` | `monitorOverrides: z.record(z.string(), monitorOverrideSchema)` — the Zod mirror |
| `src-tauri/src/display/engine.rs:227` | `display.monitor_overrides.get(&m.id)` — the lookup |
| `src-tauri/src/display/engine.rs:145, 227, 245, 255, 311-317, 347` | ramp I/O, applied-state map, preview targeting |
| `src/views/main/ui/panels/display/MonitorStrip.tsx:31` | `value: monitor.id` — the Switcher option value |
| `src/views/main/ui/panels/DisplayPanel.tsx:62-73` | `selectedMonitorId` state, `fallbackMonitorId` |
| `src-tauri/src/display/engine.rs:419` | `display_preview(kelvin, brightness, monitor_id: Option<String>)` — IPC |

So `id` is simultaneously (a) the device handle used for I/O, (b) the settings-map key, and (c) the
UI selection token. **Conflating those three is the design flaw.** They have different lifetimes:
(a) is per-session, (b) must outlive reboots, (c) is per-window-instance.

**There is no settings migration facility at all.** `src-tauri/src/settings/store.rs:2-19` says so
explicitly: *"Ported (simplified — no secret sealing, **no schema migrations**) from WinSTT's
settings store."* There is no `schema_version` field in `AppSettings` (`settings/mod.rs:403-417`).
Adding one is part of this plan.

Also silent today: `enumerate()` returns an **empty vec** on non-Windows (`monitors.rs:37-40`), so
the whole monitor strip vanishes with no explanation — exactly the failure mode plan 00 exists to
eliminate.

## 3. Per-platform verdict table

The feature under test: **can we produce a per-monitor key that survives a reboot and a replug, and
that does not collide between two identical panels?**

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | GDI device name (`MONITORINFOEXW.szDevice`) — current impl | ⚠️ **UNVERIFIED, and not covered by either research file:** `\\.\DISPLAYn` is an enumeration slot, not a hardware identity — unplugging display 1 plausibly renumbers the rest. Win32 offers a stronger source (`EnumDisplayDevicesW` with `EDD_GET_DEVICE_INTERFACE_NAME`, or the `DISPLAYCONFIG_*` / `QueryDisplayConfig` target-device path, which carries the monitor's hardware ID). **Spike it (§9 Q1)** — the whole migration is easier if we change key source once rather than twice. |
| macOS (Intel) | **PARTIAL** | `CGDisplayCreateUUIDFromDisplayID`, then a degradation ladder | ⚠️ **Corrected linkage (`macos.md` §A, 4th pass):** the symbol is exported by **`ColorSync.tbd`, NOT `CoreGraphics.tbd`** — verified against SDK stub libraries. **Link `ColorSync`, or `ApplicationServices` which re-exports it. Linking CoreGraphics fails.** (This supersedes the §3 note that said "Link ApplicationServices, not ColorSync" — ApplicationServices still works, CoreGraphics never did.) **No crate binds it; declare by hand, as winit does.** ⚠️ **Apple does not promise UUID stability** — the docs page carries no discussion text; the claim rests on third-party consensus. Treat as *empirically reliable, contractually unpromised*. |
| macOS (Apple Silicon) | **PARTIAL** | same | same |
| Linux X11 | **FULL** | EDID via RandR output property (`RRGetOutputProperty`, atom `EDID`) | `linux.md` §3: contains PNP vendor + product + serial, "stable across ports and reconnects". ⚠️ **Connector names (`HDMI-1`, `DP-2`) are NOT stable.** Subject to the same EDID-sentinel problem as everywhere else (below). |
| Linux Wayland — KDE | **PARTIAL** | `kscreen-doctor -j` / KScreen D-Bus | ⚠️ `linux.md` §3 marks the **KDE D-Bus interface UNVERIFIED**. Shelling out to `kscreen-doctor` is not acceptable in a shipping app (may not be installed; not available in a Flatpak sandbox). Until the D-Bus route is verified, KDE Wayland falls back to the generic `wl_output` path and inherits its collision problem. |
| Linux Wayland — GNOME | **PARTIAL** | `org.gnome.Mutter.DisplayConfig.GetCurrentState()` | `linux.md` §3: returns monitor specs `(connector, vendor, product, serial)` plus logical monitors with a **double** (fractional) scale and a primary flag. The best identity available on any Wayland session — but it is **GNOME-only**, so it cannot be the general design. |
| Linux Wayland — wlroots | **BLOCKED for identical panels**, PARTIAL otherwise | `wl_output` `geometry` (make + model) + v4 `name`/`description` | ⚠️ `linux.md` §3, stated flatly: **"EDID is NOT exposed to Wayland clients — the substitute is make+model, which cannot distinguish two identical monitors."** And **"`name` may be reused after an output is destroyed — not durable"**; `description` is free-form, do not parse. Two identical monitors on a wlroots Wayland session **cannot be told apart by any means available to us**. This is a protocol decision, not a gap we can engineer around. |

**Tauri's `Monitor` is insufficient on every platform — do not build on it.**
`linux.md` §3: name/size/position/work_area/scale_factor, "**no stable ID, no EDID, no vendor/model,
no primary flag**". `macos.md` §3: same list, and `name()` goes `None` on disconnect. And
`macos.md` §A adds the decisive detail: **tao implements `Monitor::name()` as
`format!("Monitor #{}", CGDisplay::new(id).model_number())`** — the *model number*, not
`NSScreen.localizedName` — so **two identical panels get byte-identical names.** We need our own
native enumeration layer on all three platforms.

**The mechanical root of the identical-monitors problem, worth stating once:** `macos.md` §A —
**EDID sentinels are common. Vendor/model `0xFFFF_FFFF` and serial `0x0000_0000` mean "absent", and
many panels ship no EDID serial at all.** This is not a macOS quirk; the same EDID blob is what X11
reads. Any design that assumes "serial disambiguates identical panels" is wrong on a large fraction
of real hardware.

## 4. Design

### 4.1 Split the three roles that `id` currently plays

```rust
// src-tauri/src/display/monitors.rs

/// Per-SESSION device handle. What the backend does I/O against. Never persisted.
/// Windows: GDI device name. macOS: CGDirectDisplayID. X11: RROutput/RRCrtc.
/// Wayland: wl_output global name.
pub type MonitorHandle = String;

/// The PERSISTED settings key. Scheme-prefixed so keys from different platforms
/// and different key SOURCES can never collide inside one settings file — a
/// portable install on a USB stick genuinely can see all of them.
///   "win-gdi:\\.\DISPLAY1"
///   "mac-uuid:9C9F2C1E-...."          | "mac-uuid:9C9F2C1E-...@1920,0"
///   "x11-edid:04721ec0-3d8b12ff"      (vendor+product+serial hash)
///   "gnome-spec:DP-1|Dell|U2720Q|ABC123"
///   "wl-makemodel:Dell Inc.|DELL U2720Q"   ← ambiguous by construction
pub type MonitorKey = String;

/// How much we trust the key to name exactly one physical panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KeyConfidence {
    /// Backed by a hardware identifier believed unique.
    Unique,
    /// Two identical panels would collide (no EDID serial, or Wayland make+model
    /// only). Per-monitor overrides are DISABLED with an explanation.
    Ambiguous,
    /// Only a session-scoped handle was available; overrides will not survive a
    /// replug. Allowed, but the UI says so.
    Transient,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// Session device handle — what plan 01's backends do I/O against.
    pub handle: MonitorHandle,
    /// Persisted settings key.
    pub key: MonitorKey,
    pub key_confidence: KeyConfidence,
    /// 0-based enumeration index (UI paint order only — NEVER a key).
    pub index: u32,
    /// Human-readable label for the UI.
    pub friendly_name: String,

    // --- descriptors, all Option because the weakest backend cannot supply them ---
    #[specta(optional)] pub connector: Option<String>,   // "DP-1"; not stable, diagnostic only
    #[specta(optional)] pub vendor: Option<String>,
    #[specta(optional)] pub model: Option<String>,
    #[specta(optional)] pub serial: Option<String>,
    /// Top-left in the desktop coordinate space. MAY BE NEGATIVE. See §4.4.
    #[specta(optional)] pub origin: Option<(i32, i32)>,

    /// `None` where the platform genuinely cannot tell us. Generic Wayland has
    /// NO primary flag (`linux.md` §3).
    #[specta(optional)] pub is_primary: Option<bool>,
}
```

**Data-model consequences of the weakest platform (TEMPLATE §4), each forced by a specific finding:**

- `serial: Option<String>` — EDID sentinel `0x0000_0000`, and Wayland exposes no EDID at all.
- `is_primary: Option<bool>` — **this is a breaking change to an existing field.** `linux.md` §3:
  Tauri/`wl_output` give "no primary flag"; GDK3 has `is_primary` but integer scale only; only
  Mutter's logical monitors carry it on Wayland. The one consumer,
  `DisplayPanel.tsx:66` (`monitors.find((m) => m.isPrimary) ?? monitors[0]`), becomes
  `monitors.find((m) => m.isPrimary === true) ?? monitors[0]` — a one-line change now, versus a
  hunt through the app later.
- `origin: Option<(i32,i32)>` — needed for the macOS collision tiebreak (§4.2) and for the UI to
  draw a spatial arrangement. Optional because Wayland does not tell clients their absolute
  position at all (`linux.md` §5-6: "a normal client cannot learn … even its own absolute position").
- `connector/vendor/model` — absent or unparseable on generic Wayland.

### 4.2 Per-platform key derivation, as a degradation ladder

`macos.md` §A is emphatic that there is no perfect answer, and gives the calibration:
**MonitorControl deliberately keys prefs on the TRANSIENT display ID** —
`"(name + vendor + model + @ + (isVirtual ? serial : identifier))"` — *"They accepted orphaned prefs
on reordering rather than risk two identical monitors colliding onto one settings blob. That is an
informed trade-off by the people who know this API best."* We take the opposite default (prefer the
UUID) but adopt their governing rule verbatim:

> **Never hard-fail on a miss. Fall back to defaults and re-learn.**

An unmatched key is not an error condition. It produces a monitor using the mode preset, exactly as
if it had never been tuned — which is precisely the behaviour of `engine.rs:236` today when
`monitor_overrides.get()` misses.

**macOS ladder** (`macos.md` §A):
1. `CGDisplayCreateUUIDFromDisplayID` → `mac-uuid:<uuid>` · confidence `Unique`.
2. On collision (two displays yielding the same UUID — degenerate but reported): append
   `CGDisplayBounds().origin` → `mac-uuid:<uuid>@<x>,<y>`. Research rationale: position is *"what
   users actually think in, and survives reboots better than the display ID"*.
3. Then `CGDisplayUnitNumber`.
4. Always **store `localizedName` alongside** for UI and heuristic rematch.
Enumerate with **`CGGetOnlineDisplayList`, not `CGGetActiveDisplayList`** — *"a tinting app wants
hardware presence, not drawability (Active excludes mirrored secondaries)"*.

**Windows**: `win-gdi:<szDevice>` today, pending §9 Q1. Confidence `Unique` if the DISPLAYCONFIG
hardware-ID route lands; `Transient` if we keep the enumeration-slot name (honest labelling of a
key we suspect is a slot).

**Linux X11**: parse the EDID blob from `RRGetOutputProperty(output, atom "EDID")`; key
`x11-edid:<vendor><product>-<serial>`. **Reject the sentinels** (`0xFFFF_FFFF` vendor/product,
`0x0000_0000` serial) before use — a sentinel serial degrades confidence to `Ambiguous`, it does not
become part of the key.

**Linux GNOME Wayland**: `org.gnome.Mutter.DisplayConfig.GetCurrentState()` →
`gnome-spec:<connector>|<vendor>|<product>|<serial>`, confidence `Unique` when serial is present and
non-sentinel, else `Ambiguous`.

**Linux generic/wlroots Wayland**: `wl-makemodel:<make>|<model>`. **Confidence is `Ambiguous`
whenever two enumerated outputs produce the same key** — which is the common two-identical-monitors
case, and is unfixable (`linux.md` §3). The UI disables per-monitor overrides with
`reasonNoEdidOnWayland` (plan 00). We do **not** fabricate a key from `wl_output.name` — it "may be
reused after an output is destroyed", so it would silently reassign a user's settings to a different
physical panel, which is worse than not supporting the feature.

### 4.3 The settings migration

**This is the load-bearing part of the plan.** Legacy keys (`\\.\DISPLAY1`) exist in real users'
`dimread-settings.json` on Windows, and only on Windows — the app has never shipped elsewhere. That
fact makes the migration tractable: **we are migrating one known key format, on one platform, where
the legacy key is still derivable at runtime.**

1. **Add a version field** to `AppSettings` (`settings/mod.rs:403-417`) and its Zod mirror:
   ```rust
   /// Persisted schema version. Absent in pre-migration blobs ⇒ serde default 0.
   pub schema_version: u32,
   ```
   Current shipped format becomes **v0**; this plan produces **v1**.
2. **Add a migration step to the load path** in `settings/store.rs::read_settings` (`store.rs:118`),
   run **inside `with_settings_write_lock`** (`store.rs:148`) and persisted immediately via
   `write_settings_value` so it happens exactly once. The existing atomic temp-file + fsync + rename
   write (`store.rs:200-228`) already gives us crash-safety for the migration itself.
3. **The v0→v1 transform**, in a new `settings/migrate.rs`:
   - Enumerate monitors *now*, producing for each both the new `key` and its `legacy_windows_id`
     (the GDI device name — which the Windows backend still computes anyway).
   - For each entry in `display.monitor_overrides`: if the key matches a current monitor's
     `legacy_windows_id`, **re-key it** to the new scheme-prefixed key.
   - **Unmatched legacy keys are preserved verbatim, never dropped.** A monitor that is simply
     unplugged today must get its settings back when it returns. Migration re-runs are idempotent
     because scheme-prefixed keys never match a legacy pattern.
   - Set `schema_version = 1`.
4. **Migration must not require a monitor to be present.** If enumeration returns empty (headless,
   RDP, a race at boot), the migration **bumps nothing** and retries next launch. Migrating with an
   empty monitor list would orphan every override permanently. This guard is the single most
   important line in `migrate.rs`.
5. **Frontend**: `settings-schema/index.ts` gains `schemaVersion: z.number().int().catch(0).default(0)`.
   The renderer never migrates — it is a pure mirror; Rust is the only writer. The `partialize` in
   `src/entities/setting/model/settings-store.ts:127` persists the settings tree to `localStorage`
   as well, so **that copy also carries stale keys**. It heals on the next `settings:changed`
   broadcast because the Rust-side tree wins, but a first paint from `localStorage` can briefly show
   pre-migration state. Acceptable; note it so nobody debugs it twice.

**No migration is needed for macOS or Linux** — there is no legacy data there. Their keys are v1
from birth.

### 4.4 Coordinates (macOS), so it is written down once

`macos.md` §3 + §A:
- Quartz = top-left origin, y-down. Cocoa/`NSScreen` = bottom-left, y-up, relative to the *primary*
  screen.
- **The flip must use the MAIN display's height, never a per-screen height:**
  `y_cocoa = mainHeight - (y_quartz + height)`.
- **Displays above or left of main give negative coordinates. Never clamp to `>= 0`.**
- ⚠️ **`NSScreen.main` is NOT the primary screen** — it is the screen with the keyboard-focused
  window, so it changes as the user moves windows. Use **`CGMainDisplayID()`** for "the display with
  the menu bar". `macos.md` §A calls this a "very common bug". `NSScreen.screens[0]` is
  conventionally the menu-bar screen but is not guaranteed.
- `NSScreen.screens(mtm)` / `mainScreen(mtm)` are **main-thread-only** (`MainThreadMarker`).

### 4.5 Re-enumeration

Shares plan 01 §4.5's reconfiguration plumbing; the specific rule for enumeration:

⚠️ `macos.md` §A: `didChangeScreenParametersNotification` is **coalesced and often late, arriving in
bursts with transient intermediate states during hot-plug** → **debounce ~500 ms and re-enumerate
from scratch rather than diffing.** Adopt "debounce + full re-enumerate, never diff" on **all**
platforms — diffing an unstable intermediate state is how monitor lists end up with ghosts.

Enumeration changes emit a new typed event so the UI stops being load-once
(`src/features/display/model/use-monitors.ts` currently fetches once on mount and never refreshes):

```rust
// src-tauri/src/events.rs, beside DisplayStateEvent (events.rs:102-110)
pub struct MonitorsChangedEvent(pub Vec<MonitorInfo>);
impl tauri_specta::Event for MonitorsChangedEvent { const NAME: &'static str = "display:monitors"; }
```
Add `"DISPLAY_MONITORS": "display:monitors"` to `src/shared/api/native-events.ts::NATIVE_EVENTS`;
register in `commands_registry.rs::collect_events![]`; regenerate `src/bindings.ts` via
`cargo test export_bindings`.

### 4.6 IPC surface

`display_list_monitors()` keeps its name and returns the enriched `MonitorInfo`.
`display_preview(kelvin, brightness, monitor_id: Option<String>)` (`engine.rs:419`) — the parameter
is a **handle**, not a key; rename to `monitor_handle` while touching it, since the two are now
distinct types and confusing them is the bug this plan exists to prevent.

## 5. Implementation steps

1. **Split the type**: `MonitorInfo` gains `handle` / `key` / `key_confidence` and the optional
   descriptors; `is_primary` becomes `Option<bool>`. Windows fills `key = "win-gdi:" + szDevice`
   and `handle = szDevice`. Update `engine.rs` call sites to use `handle` for I/O and `key` for
   `monitor_overrides`. Update `MonitorStrip.tsx` / `DisplayPanel.tsx`. Regenerate bindings.
   *Repo green; Windows behaviour identical except the settings key gains a prefix.*
2. **Add `schema_version` + `settings/migrate.rs` (v0→v1)** with the empty-enumeration guard.
   Unit-test the transform as a pure function (§8). *This step must ship together with step 1 — step
   1 alone would orphan every existing user's per-monitor overrides.*
3. **`MonitorsChangedEvent`** + debounced re-enumeration; make `use-monitors.ts` subscribe.
4. **macOS enumeration**: `CGGetOnlineDisplayList`, hand-declared `CGDisplayCreateUUIDFromDisplayID`
   linked against **ColorSync or ApplicationServices**, the §4.2 ladder, `CGMainDisplayID()` for
   primary, `NSScreen.localizedName` for the label, `visibleFrame()` for work area. *Small spike to
   confirm the linkage — §9 Q2.*
5. **Linux X11 enumeration**: `RRGetScreenResourcesCurrent` → `RRGetOutputInfo` → `RRGetCrtcInfo`;
   primary via `RRGetOutputPrimary`; EDID via `RRGetOutputProperty`; sentinel rejection.
6. **Linux Wayland enumeration**: `wl_output` (make/model/scale, v4 name/description) as the base;
   GNOME upgrade path via `org.gnome.Mutter.DisplayConfig.GetCurrentState()` over `zbus`.
   Confidence = `Ambiguous` on duplicate keys.
7. **Capability wiring**: feed plan 00's `FeatureId::StableMonitorIdentity` and `PerMonitorTint` from
   `KeyConfidence`; `Ambiguous` ⇒ `PerMonitorTint` blocked with `reasonNoEdidOnWayland`.
8. **UI**: monitor strip renders through `CapabilityGate`; `Transient`/`Ambiguous` show a persistent
   caption. Add the monitor table (key, confidence, vendor/model/serial, origin) to About → Driver
   Information (F11.1) — it makes every future identity bug report self-diagnosing.

## 6. Permissions, packaging, distribution

Nothing in this plan needs a permission, entitlement, TCC prompt, udev rule, polkit action or group
membership on any platform, and nothing forecloses a distribution channel.

- **macOS**: `CGGetOnlineDisplayList`, `CGDisplayCreateUUIDFromDisplayID`, `CGDisplayBounds`,
  `NSScreen` are all public, sandbox-safe, no prompt. The only build-system consequence is the
  **link flag**: `#[link(name = "ColorSync", kind = "framework")]` or `ApplicationServices`
  (`macos.md` §A). Getting this wrong is a link error, not a runtime surprise — cheap to discover.
- **Linux**: RandR is ordinary X protocol traffic; `wl_output` is core Wayland; Mutter's
  `DisplayConfig` is a session-bus call. All work inside a Flatpak sandbox. The Flatpak manifest
  will need `--talk-name=org.gnome.Mutter.DisplayConfig` for the GNOME upgrade path — worth noting
  now so it is not discovered during packaging.
- **Windows**: nothing. If §9 Q1 moves us to `QueryDisplayConfig`, still nothing.
- **Portable installs** (`src-tauri/src/portable.rs`): the scheme prefix in `MonitorKey` is what
  keeps a settings file carried between machines — or between OSes on the same USB stick — from
  mis-matching keys. That is the concrete reason the prefix exists.

## 7. Failure modes & degradation

**Silent no-ops today**: `enumerate()` returns an empty vec off Windows (`monitors.rs:37-40`), so
the monitor strip silently disappears (`DisplayPanel.tsx:140` renders it only when
`monitors.length > 1`). After this plan, an empty list on a supported platform is an error state
that reports itself.

| Situation | User sees |
|---|---|
| Key `Ambiguous` (two identical panels, Wayland or no EDID serial) | Monitor strip visible but **disabled**, with `reasonNoEdidOnWayland`: identical displays cannot be told apart, so settings apply to all. Falls back to `sync_monitors` behaviour. |
| Key `Transient` | Strip enabled, persistent caption: per-monitor settings may not survive unplugging this display. |
| Persisted key matches no current monitor | **Nothing.** Silence is correct here — the monitor is unplugged. Its override is preserved and reapplies on return (§4.3 rule 3). No error, no toast, no "orphaned settings" dialog. |
| Migration runs with an empty monitor list | Skipped, retried next launch (§4.3 rule 4). Logged at `warn`. |
| Migration partially matches (one of two monitors present) | Matched entries re-keyed, unmatched preserved verbatim, `schema_version` **still set to 1** — the preserved legacy keys are inert and will never match a v1 key, so they cost nothing and can be recovered manually. |
| Enumeration fails entirely on a supported platform | `display_list_monitors` returns empty **and** plan 00's `StableMonitorIdentity` reports `Blocked`; the UI says the display list could not be read rather than showing a bare empty strip. |
| Hot-plug burst | Debounced 500 ms, full re-enumerate, `display:monitors` emitted once (§4.5). |

**State restore**: this plan writes nothing to hardware, so it has no restore obligation. The one
destructive operation is the settings migration, and it is protected by `store.rs`'s existing atomic
write + `.bak` refresh (`store.rs:221-227`) — a crash mid-migration leaves either the v0 file or the
v1 file, never a torn one.

## 8. Testing

**Unit-testable in CI, on any host — the migration especially:**

- `migrate_v0_to_v1(overrides, monitors) -> overrides` as a **pure function**. Table:
  all keys match; none match; partial match; already-v1 keys (idempotence — run it twice, assert
  fixpoint); **empty monitor list ⇒ input returned unchanged and version NOT bumped** (the
  most important assertion in this plan); a legacy key that coincidentally starts with a scheme
  prefix.
- Key derivation per platform as pure functions over synthetic descriptor structs: sentinel EDID
  values (`0xFFFF_FFFF` vendor/product, `0x0000_0000` serial) degrade confidence rather than
  entering the key; duplicate `wl-makemodel:` keys across two outputs ⇒ both `Ambiguous`; macOS
  ladder step-down on collision.
- EDID blob parser: vendor/product/serial extraction, against a small corpus of captured blobs
  checked into `test/`. Pure bytes in, struct out — ideal CI test.
- Coordinate flip: `y_cocoa = mainHeight - (y_quartz + height)` with a display **above** main
  producing a negative result, asserted **not** clamped.
- Frontend: `MonitorStrip` renders disabled + captioned when `keyConfidence === "ambiguous"`;
  `DisplayPanel`'s primary fallback handles `isPrimary: null`.

**Manual only, on real hardware:**

- **Two identical monitors** — the case the whole plan turns on. On Windows, macOS, X11 and a
  wlroots Wayland session. Expected results differ per platform and *all four are correct*: Windows
  distinguishes, macOS distinguishes by UUID, X11 distinguishes only if the panels carry serials,
  wlroots does not distinguish at all and must say so.
- Reboot persistence: tune monitor 2, reboot, confirm the override reattached.
- Replug / reorder: unplug both, plug back in swapped ports; confirm settings follow the *panels*,
  not the ports (this is precisely what connector names would get wrong — `linux.md` §3).
- Dock / KVM / Thunderbolt hub cycling; sleep-wake with a display asleep.
- Mirrored displays on macOS — confirms the `CGGetOnlineDisplayList` vs `CGGetActiveDisplayList`
  choice (`macos.md` §A).
- **Upgrade test with a real v0 `dimread-settings.json`** carrying per-monitor overrides: install
  the new build over the old, confirm overrides survived. Do this before any release, and keep a v0
  fixture file in `test/` forever.

**Cannot be tested in CI:** all enumeration. No CI runner has two identical monitors, a Wayland
session, or a Mac with an external display. The pure-function split above exists specifically so
that the *decision logic* — which is where the bugs will be — is fully covered without hardware.

## 9. Open questions / spikes needed

1. **Is the Windows GDI device name actually stable across replug/reorder?** Neither research file
   covers Windows. If `\\.\DISPLAYn` is an enumeration slot, today's per-monitor overrides are
   already silently mis-attaching for users with multiple displays, and the migration should go
   straight to a hardware-backed key (`EnumDisplayDevicesW` + `EDD_GET_DEVICE_INTERFACE_NAME`, or
   `QueryDisplayConfig`'s target device path) rather than migrating twice. **Answer this before
   step 1 freezes the key format.** Tagged **UNVERIFIED** — not sourced from the research files.
2. **macOS linkage confirmation.** `macos.md` §A is explicit (ColorSync.tbd, verified against SDK
   stub libraries; ApplicationServices re-exports; **CoreGraphics fails**) but this contradicts the
   earlier §3 note in the same document. Five minutes with a link test settles it; do it before
   writing step 4, not during.
3. **KDE Wayland monitor identity.** `linux.md` §3 leaves the KScreen **D-Bus interface
   UNVERIFIED**. Until verified, KDE Wayland degrades to the generic `wl_output` path and inherits
   `Ambiguous`. Is there a supported D-Bus route on Plasma 6? Shelling out to `kscreen-doctor` is
   not acceptable for a shipped app.
4. **Is `CGDisplayCreateUUIDFromDisplayID` stable across a macOS major upgrade?** `macos.md` §A:
   *"Apple does not promise UUID stability … the claim rests on third-party consensus."* We cannot
   spike this on demand — it needs longitudinal observation. **Mitigation instead of an answer:**
   §4.2's "never hard-fail, fall back to defaults and re-learn" rule means a UUID change costs the
   user their per-monitor tuning once, silently and recoverably, rather than breaking the app.
   Store `localizedName` + `origin` alongside so a future heuristic rematch is possible without a
   further migration.
5. **Should `KeyConfidence::Ambiguous` disable per-monitor overrides, or allow them with a warning?**
   Plan 00's stated default is disable-with-explanation. But `macos.md` §A records that
   MonitorControl chose the *opposite* trade — accepting orphaned prefs rather than collision. The
   two cases differ (orphaning loses settings; collision applies the wrong settings to the wrong
   panel), which argues for disabling. **Product decision, not a technical one — confirm before
   step 7.**

## 10. Effort

| Platform | Size | |
|---|---|---|
| Type split + call-site rewire + bindings (step 1) | **S** | mechanical, ~8 call sites |
| Schema version + migration + tests (step 2) | **M** | small code, high care; the empty-list guard is the whole game |
| Re-enumeration event + debounce (step 3) | **S** | shares plan 01's plumbing |
| macOS (step 4) | **M** | hand-declared FFI, the ladder, main-thread rules |
| Linux X11 + EDID parse (step 5) | **M** | EDID parsing is fiddly but pure and testable |
| Linux Wayland + Mutter (step 6) | **M** | two code paths, one of which can only ever be `Ambiguous` |
| Capability + UI wiring (steps 7–8) | **S** | plan 00 did the heavy lifting |

**Biggest risk: the migration is a one-shot, irreversible operation on real users' data, and its
correctness depends on hardware that is present at the moment it runs.** Every other step in these
three plans can be fixed in the next release; a migration that runs with an empty monitor list, or
that drops unmatched keys, destroys per-monitor settings permanently. The three mitigations —
**skip when enumeration is empty, preserve unmatched keys verbatim, and make the transform a pure
function with a v0 fixture in `test/`** — are not optional polish; they are the plan. Ship step 1
and step 2 together, never step 1 alone.
