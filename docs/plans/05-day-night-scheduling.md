# Plan 05 — Day & night scheduling (sun times, geolocation, OS night-light cooperation)
Status: DRAFT
Depends on: 00 (capability layer), 01 (tint engine)
Parity ref: FEATURE-PARITY.md F3.1–F3.5, F1.12

---

## 1. What this feature is

The app runs warmer and dimmer at night and returns to neutral by day, ramping smoothly across a
configurable transition window. Each preset mode carries separate day and night endpoints; the
schedule interpolates between them. Sunrise/sunset come either from the user's coordinates or from
manual times (`research/careueyes/images/docs_display_day-and-night-feature_03_default-times.jpg`
vs `..._04_custom-times.jpg`), the transition width is configurable
(`..._05_transition-settings.jpg`), and the current temperature/brightness is shown live
(`..._06_real-time-display.jpg`, FEATURE-PARITY F1.12).

**This is the most portable feature in the whole port.** The maths is already written, already
cross-platform, and already unit-tested. What remains is location acquisition and not fighting the
operating system's own night-light.

## 2. Current state

**Already portable and complete — do not touch except to extend.**

`src-tauri/src/display/suncalc.rs` — pure NOAA solar-position maths, no I/O, no platform code:
```rust
pub enum SunTimes {
    Rises { sunrise_minutes: f64, sunset_minutes: f64 },
    AlwaysUp,    // polar day
    AlwaysDown,  // polar night
}
pub fn sun_times(latitude: f64, longitude: f64, date: NaiveDate, tz_offset_minutes: i32) -> SunTimes
```
`SUNRISE_ZENITH_DEG = 90.833` (refraction + apparent solar radius). Polar cases are handled as
first-class variants rather than errors — already correct.

`src-tauri/src/display/scheduler.rs` — the clock side:
```rust
pub enum Phase { Day, Night, Transition }
pub fn day_factor() -> f32          // 0.0 = full night, 1.0 = full day
pub fn current_phase() -> Phase
pub fn init(app: &AppHandle)        // captures AppHandle, spawns the ticker
fn schedule_factor(day_night: &DayNightSettings, date: NaiveDate, now_minutes: f64,
                   tz_offset_minutes: i32) -> (f32, Phase)   // pure, fully tested
fn ramp_factor(now_minutes: f64, sunrise: f64, sunset: f64, transition: f64) -> f32
```
`schedule_factor` takes *all* runtime state as parameters, which is why the 13 tests at the bottom of
that file cover polar day/night, DST-offset agreement between manual and location modes, overlapping
ramps, and garbage `"HH:MM"` input without any platform dependency. **This is the model the rest of
the port should copy.**

Runtime driver: a 30 s ticker thread (`TICK_INTERVAL`, `fn ticker_loop`) calling
`display::engine::refresh()` when the factor drifts >1 % **or** when wall time jumps by more than
`TICK_INTERVAL * 3` (90 s) — the suspend/resume and clock-change guard.

`src-tauri/src/settings/mod.rs`:
```rust
pub struct DayNightSettings {
    pub enabled: bool, pub use_location: bool,
    pub latitude: f64, pub longitude: f64,
    pub sunrise: String, pub sunset: String,   // "HH:MM", used when !use_location
    pub transition_minutes: u32,
}
```
Defaults: `enabled: true, use_location: false, lat/long 0.0, 07:00/19:00, 60 min`.

`src-tauri/src/display/engine.rs` consumes it: `let factor = scheduler::day_factor() as f64;` →
`interpolate(preset, factor)` → `DisplayOutput { kelvin, brightness, mode, phase }` emitted on
`display:state`.

**What is missing:**
- **F3.2 geolocation auto-detect.** `use_location` exists, but there is no way to *obtain* a
  latitude/longitude — the user must type coordinates. Defaults are `0.0, 0.0` (Null Island, in the
  Gulf of Guinea), so a user who flips `use_location` without typing anything silently gets equatorial
  sun times. That is a bug today.
- **F3.5 live preview behaviour** — dragging a night slider during the day should preview the night
  value and revert on release. `engine::preview` / `clear_preview` exist but are phase-agnostic.
- **Cooperation with the OS's own night-light.** Nothing. On every platform, both we and the OS write
  the same single global resource, last writer wins.
- Nothing anywhere reports that the schedule is running against `0.0, 0.0`.

## 3. Per-platform verdict table

The scheduling core is FULL everywhere; the table therefore covers the two things that are *not*
portable. Verdicts given as `geolocation / night-light cooperation`.

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | UNVERIFIED / UNVERIFIED | geo: `Windows.Devices.Geolocation.Geolocator`; night-light: no documented API | Neither research file covers Windows (both are macOS/Linux). The Geolocation API is gated on a **system-wide privacy toggle** plus a per-app grant, and returns "denied" as an ordinary outcome. Windows Night light state lives in an undocumented `CloudStore` registry blob — **UNVERIFIED**; and because Windows Night light also drives the display colour pipeline, it and our gamma tint are two writers of one resource. Assume conflict, do not assume we can inhibit it. Spike both (§9). |
| macOS (Intel) | PARTIAL / **FULL** | geo: CoreLocation (TCC prompt); night-light: Night Shift needs **no** cooperation | `macos.md` §1: Night Shift via `CBBlueLightClient` in CoreBrightness.framework, "**stable since 10.12.4** across Shifty/NightOwl/displayutil", **Risk: MEDIUM** (private → App Store out, notarization unaffected). Crucially Night Shift operates **below** the gamma layer, so it composes with our tint instead of fighting it, and it is HDR-safe — unlike our gamma path, which `macos.md` §1 notes macOS **disables HDR** for. |
| macOS (Apple Silicon) | PARTIAL / **FULL** | same | Same as Intel. Night Shift is unaffected by the M5 gamma bug (`macos.md` §0) because it is a different pipeline stage — which makes it *more* attractive on exactly the hardware where our own tint is failing. |
| Linux X11 | PARTIAL / PARTIAL | geo: XDG Location portal / GeoClue; night-light: per-desktop | `linux.md` §1: X11 gamma is "global single-slot state per CRTC. Night Light / KDE Night Color / `xrandr --gamma` / another redshift instance all *overwrite* us. **Unavoidable clash** (jonls/redshift#759)." Cooperation is therefore mandatory, not polish. Note also: adjustments **stack** unless reset first. |
| Linux Wayland — KDE | PARTIAL / **FULL** | `org.kde.KWin.NightLight.inhibit() -> u` / `uninhibit(u)` | `linux.md` §1 [VERIFIED against KWin source], path `/org/kde/KWin/NightLight`: "`inhibit()`/`uninhibit()` is **the clean way to suppress KDE's night light while we own the tint**." Take a cookie on tint-engine start, release it on stop/exit. Note the same interface's **properties are ALL read-only** and `preview()` self-reverts after a hardcoded 15 s `QTimer` — so inhibit is the only durable handle here, and it is the right one. |
| Linux Wayland — GNOME | PARTIAL / PARTIAL | `org.gnome.SettingsDaemon.Color` → `DisabledUntilTomorrow` (b, rw), or gsettings `night-light-enabled` | `linux.md` §1 [VERIFIED against gsd-color-manager.c]. There is **no inhibit/uninhibit pair** — the only handles are a *transient* `DisabledUntilTomorrow` (semantically wrong: it says "until tomorrow", not "while DimRead runs") and a **persistent** GSettings write that we would have to remember to undo. PARTIAL because neither is scoped to our process lifetime, so a crash leaves GNOME's night light disabled. ⚠️ `linux.md` §1 also warns of a real-world `d` vs `u` **type-mismatch** report on `Temperature` → **introspect at runtime, don't hardcode**. |
| Linux Wayland — wlroots | PARTIAL / N/A | no built-in night light to inhibit | wlroots compositors ship no night-light of their own; the user runs gammastep/wlsunset, which competes for the **exclusive** `zwlr_gamma_control_v1` (`linux.md` §1: "a second client gets `failed`"). We cannot inhibit it — but we *can* detect the failure and name the conflict, which is better than either desktop above. |

**Geolocation is PARTIAL everywhere it is possible at all**, because every route either prompts, can
be refused, or depends on a positioning backend outside our control. See §6 and §9.

## 4. Design

### 4.1 What does not change

`suncalc.rs` and `scheduler.rs`'s pure core (`schedule_factor`, `ramp_factor`, `phase_of`,
`parse_hhmm`) are correct and portable. **No changes.** Everything below hangs off the edges.

### 4.2 Geolocation as a one-shot, never a subscription

The single most important design decision: **we resolve coordinates once, on explicit user action,
and persist the numbers — we never hold a location subscription.** Sun times move by seconds per day
at a fixed location; a user who moves city can press the button again. This turns a continuous,
privacy-alarming capability into a discrete one, and it means a denied permission costs the user
nothing they cannot type in manually.

```rust
// src-tauri/src/geo/mod.rs — new module
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Coordinates { pub latitude: f64, pub longitude: f64 }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GeoSource {
    /// Platform location service (CoreLocation / XDG portal / Windows Geolocator).
    System,
    /// Coarse IP lookup — a NETWORK CALL. Opt-in, see §6.
    IpLookup,
    /// The user typed it.
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GeoError {
    /// The user said no. Never retry automatically.
    PermissionDenied,
    /// No location service on this system / portal not exported / GeoClue absent.
    Unavailable,
    /// Service present, returned no fix (no GPS, positioning backend dead).
    NoFix,
    Timeout,
    /// IP lookup only.
    NetworkFailed,
}

/// Resolve coordinates ONCE. Never called at startup, never on a timer — only
/// from an explicit "Detect my location" action. `source` is chosen by the
/// caller so the UI, not the backend, owns the privacy decision.
pub async fn resolve(source: GeoSource) -> Result<Coordinates, GeoError>;

/// What this platform could do if asked — for the button's enabled state and
/// its explanatory text. Must NOT trigger a permission prompt.
pub fn capability() -> GeoCapability;
```

**Data-model consequence of the weakest platform.** `resolve` returns `Result`, and
`GeoError::PermissionDenied` is a *first-class expected outcome on macOS*, not an error path. The UI
must be fully usable with manual coordinates forever; the detect button is a convenience, never a
gate. This mirrors the precedent `macos.md` §5 draws from HazeOver: "**never gate the app behind a
first-launch TCC prompt**."

### 4.3 Settings schema changes

Extend `DayNightSettings` (the four-step recipe in `settings/mod.rs`'s module doc — struct field,
`PartialSettings` arm, `merge_patch` arm, Zod mirror):

```rust
pub struct DayNightSettings {
    // … existing fields unchanged …
    /// Where `latitude`/`longitude` came from. Drives the UI label ("Detected"
    /// vs "Manual") and lets us warn about the Null Island default.
    pub location_source: GeoSource,          // default: Manual
    /// True once the user has actually supplied/confirmed coordinates. Guards
    /// the (0.0, 0.0) footgun — see §7.
    pub location_set: bool,                  // default: false
    /// Suppress the OS's own night-light while our tint is active (§4.5).
    pub inhibit_system_night_light: bool,    // default: true where supported
}
```

`normalize_settings` gains: clamp `latitude` to `-90.0..=90.0`, `longitude` to `-180.0..=180.0`, and
`transition_minutes` to a sane ceiling (the existing `ramp_factor` already degrades gracefully on
overlap via `min(morning, evening)`, but a 10 000-minute window should not be persistable).

### 4.4 IPC surface

```rust
#[tauri::command] #[specta::specta]
pub async fn geo_capability() -> GeoCapability;

#[tauri::command] #[specta::specta]
pub async fn geo_resolve(source: GeoSource) -> Result<Coordinates, GeoError>;
```

Registered in `commands_registry.rs` under a new `// ── geolocation ──` heading; regenerate with
`cd src-tauri && cargo test export_bindings`.

The **resolved coordinates are returned to the renderer and shown to the user before anything is
persisted.** We do not silently write a location into settings. This is both a privacy property and
a correctness one (the user can see that the IP lookup put them 200 km away and reject it).

### 4.5 Night-light cooperation

New module `src-tauri/src/nightlight/` with a two-method trait, driven from the tint engine's
start/stop rather than from settings:

```rust
/// A handle on the OS's own night-light, held for as long as WE own the tint.
/// Dropping it MUST restore the OS's previous behaviour.
pub trait NightLightInhibitor: Send + Sync {
    fn inhibit(&self) -> Result<InhibitCookie, NightLightError>;
    fn release(&self, cookie: InhibitCookie);
}
```

Per platform:

- **KDE Wayland — the clean case.** `org.kde.KWin.NightLight.inhibit() -> u` returns a cookie;
  `uninhibit(u)` releases it (`linux.md` §1, VERIFIED against KWin source). Cookie-scoped, so KWin
  itself handles the "app died" case. Take on tint start, release on tint stop and on `app_exit`.
- **GNOME Wayland/X11 — degraded.** No inhibit pair. Options are `DisabledUntilTomorrow` (transient,
  wrong semantics) or the persistent GSettings write. **Recommendation: do neither by default.**
  Offer it as an explicit opt-in with honest wording ("Turn off GNOME's Night Light while DimRead is
  running — DimRead will turn it back on when it exits, but not if it crashes"), plus a
  restore-on-launch ledger like plan 04's.
- **macOS — nothing to do, and that is the good news.** `macos.md` §1: Night Shift is a separate,
  lower pipeline stage; it composes with gamma rather than overwriting it, and it is HDR-safe where
  our gamma path is not. `CBBlueLightClient` (`+supportsBlueLightReduction`, `-setStrength:commit:`
  0.0–1.0, `-setEnabled:`, `-setMode:`, `-setSchedule:`, `-getBlueLightStatus:`,
  `-setStatusNotificationBlock:`) lets us *read* whether Night Shift is on so we can tell the user
  their screen is being warmed twice — and, optionally, **drive Night Shift instead of our own gamma**
  on hardware where gamma is broken. Private API, MAS-disqualifying, notarization unaffected, risk
  MEDIUM (`macos.md` §1). A Rust reference implementation exists in `smudge/nightlight` (MIT); no
  crate, so call through `objc2` `msg_send!`.
- **X11 (any DE) — cannot inhibit, must detect.** `linux.md` §1 is explicit that the clash is
  unavoidable. Detect the competing writer heuristically (our ramp read-back does not match what we
  wrote) and surface it. Also: **reset to identity before writing**, because "adjustments *stack*
  unless reset first" (`linux.md` §1, jonls/redshift#659).
- **wlroots** — `zwlr_gamma_control_v1` is exclusive; a competing gammastep gets us `failed` on bind.
  Report "gammastep/wlsunset is already controlling your display" by name.
- **Windows** — UNVERIFIED, spike (§9).

### 4.6 DST correctness

`scheduler::evaluate()` already does the right thing:
```rust
let tz_offset_minutes = now.offset().fix().local_minus_utc() / 60;
```
This reads the offset **in force at the moment of evaluation** from `chrono::Local`, and
`suncalc::sun_times` documents that "the offset is applied verbatim, so passing the DST-correct
offset for the day yields DST-correct local times." Nothing is cached across midnight
(`scheduler.rs` module doc). The ticker's `jumped` check (`elapsed > TICK_INTERVAL * 3`, i.e. > 90 s)
also catches the one-hour spring-forward as a forced refresh — so the ramp re-evaluates immediately
at the transition rather than drifting for 30 s.

**The requirement this plan adds is a test, not a change.** Specifically: at a spring-forward
instant, `schedule_factor` must be evaluated with the *new* offset and produce the factor for the
*new* local time — i.e. the schedule follows the wall clock, not UTC. The existing
`manual_and_location_agree_at_matching_times` test is the right shape; extend it to a DST-transition
date in a DST-observing zone. Also cover the autumn fall-back, where an hour of local time repeats
and the factor must retrace the same values rather than jumping.

Edge case worth an explicit test: a location whose longitude puts solar noon far from clock noon
(e.g. western China, UTC+8 everywhere) — `sun_times` should still produce sane, in-range minutes.

## 5. Implementation steps

1. **Fix the Null Island bug.** Add `location_set: bool`; if `use_location && !location_set`,
   `schedule_factor` must fall back to the manual `sunrise`/`sunset` strings and the UI must show a
   warning. Pure logic, testable, and it fixes a live correctness bug independent of everything else
   in this plan. Land first.
2. **Settings + IPC scaffolding.** `location_source`, `inhibit_system_night_light`, the
   `Coordinates`/`GeoSource`/`GeoError`/`GeoCapability` types, `geo_capability` + `geo_resolve`
   returning `Err(Unavailable)` on every platform. Regenerate bindings. Frontend renders a
   "Detect my location" button that is honestly disabled with a reason.
3. **DST + longitude test pass.** Extend `scheduler.rs`'s test module with the spring-forward,
   fall-back, and far-from-solar-noon cases described in §4.6. No production code changes expected —
   if any test fails, that is a bug found for free.
4. **Linux geolocation via the XDG Location portal** (`ashpd`). *Spike-gated (§9.2).*
5. **macOS geolocation via CoreLocation.** Requires `NSLocationWhenInUseUsageDescription` in the
   Info.plist (§6). Must be reachable **only** from the explicit button.
6. **Windows geolocation via `Windows.Devices.Geolocation`.** *Spike-gated (§9.1).*
7. **IP-geo fallback** — separate step, separate opt-in, separate review. See §6; this is a product
   decision as much as an engineering one and should not be smuggled in with step 4.
8. **KDE night-light inhibit.** `org.kde.KWin.NightLight.inhibit()`/`uninhibit()` wired to tint
   start/stop and `app_exit`. Smallest, highest-confidence win in the plan (VERIFIED source).
9. **macOS Night Shift read-back** via `CBBlueLightClient.getBlueLightStatus:` — inform the user
   when both are warming the screen. Behind the same private-API feature flag as plans 03/04.
10. **X11 conflict detection** — reset-to-identity-then-write, plus read-back mismatch detection and
    a named warning. Depends on plan 01 owning the RandR path.
11. **GNOME night-light opt-in** with the restore ledger. Lowest priority; the semantics are bad and
    the honest default is to leave GNOME's night light alone.
12. **F3.5 live preview.** Extend `engine::preview` to accept a phase so dragging a night slider
    during the day previews the night value and `clear_preview` reverts. Purely local to
    `engine.rs` + `src/features/display/`.

## 6. Permissions, packaging, distribution

**macOS — CoreLocation breaks the zero-TCC posture, deliberately and narrowly.**
`macos.md`'s architectural recommendation §6 is "**ship needing ZERO TCC grants.**" CoreLocation is a
TCC prompt, so adding it is a conscious exception. It is defensible only under these constraints:
- The prompt fires **only** from an explicit "Detect my location" click, never at launch, never as a
  side effect of enabling the day/night schedule.
- `NSLocationWhenInUseUsageDescription` must be added to the Info.plist. Its text is user-visible and
  should say why: sunrise/sunset times, computed locally, coordinates never transmitted.
- A denial is permanent and silent-by-OS: the second prompt never appears. So on
  `PermissionDenied` we must deep-link to Privacy & Security → Location Services and explain, once.
- CoreLocation itself is **public API and MAS-compatible** — unlike plans 03 and 04, this does not
  cost the App Store.

**Linux — the portal app-ID trap applies here too.**
`linux.md` §10 documents it for GlobalShortcuts, and it is a per-D-Bus-peer property, not a
per-interface one: "since portal 1.21.0 `CreateSession` **rejects connections with no app ID**. A
normally-installed (non-sandboxed) binary must first call
`org.freedesktop.host.portal.Registry.Register(app_id, …)` — once per D-Bus peer, **before any other
portal call** — with an `app_id` matching an *installed* `.desktop` basename (GNOME additionally
demands reverse-DNS)." **Whichever plan lands a portal call first owns this registration**; plans 05
and any hotkey work must share one implementation. Also note `linux.md` §10's runtime warning:
"**`zbus`'s async-runtime feature is global and Tauri uses tokio** — either use ashpd's tokio feature
consistently or isolate. **Do not mix.**"

Flatpak/Snap: the Location portal is the *correct* route inside a sandbox, so this is one of the few
capabilities that is *better* under Flatpak than out of it.

**Windows.** `Windows.Devices.Geolocation` requires the system Location service to be on and the app
to be permitted; a packaged (MSIX) app declares the `location` capability, an unpackaged Win32 app is
governed by the global toggle. UNVERIFIED — spike (§9.1).

### The IP-geolocation fallback — flag this as a real product decision

FEATURE-PARITY's own platform note says "Sunrise/sunset: compute locally (no network) from lat/long
or IP-geo once", so it is in scope. But **DimRead is a privacy-adjacent utility that otherwise makes
zero network calls**, and the download manager is the only existing networking code. Adding an IP
lookup means:

- The app contacts a third party, who learns our user's IP address and that they run DimRead. Even a
  "no logging" provider is a trust transfer the user did not ask for.
- It happens on a machine where the user may have *deliberately denied* the OS location permission.
  Silently routing around a denied permission with a network call would be a serious breach of the
  user's expressed intent — **if the system permission was denied, the IP fallback must NOT be
  offered automatically.**
- Any privacy policy / store listing must disclose it. "Makes no network connections" is a
  marketable property we would be giving up.

**Recommendation:** ship it, but only as (a) a distinct, clearly-labelled second button
("Estimate from my IP address — this contacts <provider>"), (b) never automatic, never a fallback
chain from a denied system permission, (c) result shown before persisting, (d) a hard-coded
provider named in the UI and in the docs, (e) coordinates only — never store or log the response
body. If the team is not comfortable with all five, cut step 7 and keep manual entry. Manual entry
plus a link to a "find my coordinates" page is a perfectly good answer.

## 7. Failure modes & degradation

| Failure | What the user sees |
|---|---|
| `use_location` on, no coordinates ever set | **Today: silently uses Null Island.** After step 1: schedule falls back to the manual times and an inline warning says location is not set, with the detect button next to it. This is the highest-value fix in the plan. |
| Location permission denied | One-time explanation + deep link to system settings; the detect button becomes "Set manually"; **the feature keeps working** on manual times. Never re-prompt. |
| No location service at all (bare wlroots, no GeoClue) | Detect button disabled with "your system doesn't provide a location service"; manual entry unaffected. |
| Location service present, returns no fix | `NoFix` — distinct from `Unavailable`, because the remediation differs (wait / move near a window vs there is nothing to wait for). |
| Polar latitudes | Already correct: `SunTimes::AlwaysUp` → permanent day factor 1.0, `AlwaysDown` → 0.0. The UI should *say* "midnight sun" / "polar night" rather than showing a blank sunrise time. |
| Another app owns the display ramp (X11 / wlroots) | Named warning identifying the conflict class; on wlroots the bind failure is explicit, on X11 it is heuristic. Never silently lose the tint. |
| We inhibited KDE's night light and crashed | KWin releases cookies when the owning D-Bus connection dies — no ledger needed. The one platform where this is free. |
| We disabled GNOME's night light and crashed | GNOME's night light stays off. Requires the restore-on-launch ledger; this is why the default is not to touch it. |
| macOS Night Shift also on | Screen is warmed twice. Detect via `CBBlueLightClient` and tell the user, offering to turn one off. Do not silently override. |
| Clock/timezone changed, or resume from sleep | Already handled: the 90 s jump detector forces `engine::refresh()`. |

**Reporting unavailability to the UI:** `GeoCapability` is read at settings-panel mount and drives
the button's enabled state *and* its label, so the user never clicks a button that cannot work. The
night-light inhibitor reports through plan 00's capability layer as a per-desktop tri-state
(inhibitable / detectable-only / unknown).

## 8. Testing

**Unit-testable in CI, on any platform — and most of this already exists:**
- `scheduler.rs`'s 13 existing tests stay green; add the DST spring-forward, DST fall-back, and
  far-from-solar-noon cases (§4.6).
- The `location_set` fallback: `use_location = true, location_set = false` must produce the *manual*
  times, byte-identical to `use_location = false`.
- `latitude`/`longitude` clamping in `normalize_settings`, including NaN and ±infinity from a corrupt
  settings blob (serde will accept those from JSON floats).
- `suncalc::sun_times` against published NOAA values for a spread of latitudes and dates — the
  existing London-solstice test is one point; make it a table.
- The night-light inhibitor state machine (take cookie → tint stops → release; take → app exits →
  release; double-take is idempotent) against a fake inhibitor.
- `GeoError` → user-facing message mapping, so `bun run check:i18n` proves every variant has a key.

**Manual only:**
- Every geolocation backend, because every one of them is a permission dialog. Specifically: macOS
  first-grant, macOS after-denial (confirm no second prompt and that the deep link lands), Linux
  portal on GNOME and on KDE, Linux with GeoClue absent.
- KDE night-light inhibit: verify KDE's own night light visibly stops while ours runs, and resumes
  on quit **and on kill -9**.
- macOS Night Shift interaction on a real Mac, including on HDR content (`macos.md` §1: gamma
  disables HDR; Night Shift does not — this is the observable difference).
- The Flatpak portal path.

**Cannot be tested in CI:** anything involving a real clock crossing a real DST boundary. Mitigate by
keeping `schedule_factor` parameterised on `(date, now_minutes, tz_offset_minutes)` — which it
already is — so DST is a *data* case in a unit test rather than a wall-clock one. **This is the
single best structural property the existing code has; preserve it.**

## 9. Open questions / spikes needed

1. **Windows geolocation and Windows Night light** — neither research file covers Windows. Needed:
   does `Windows.Devices.Geolocation` work from an unpackaged Tauri binary, what does denial look
   like, and is there *any* supported way to observe or inhibit Windows Night light? Blocking for
   steps 6 and for the Windows row of the §3 table.
2. **XDG Location portal availability in practice.** `linux.md` enumerates the portal interface set
   but does not verify the Location portal specifically, nor which backends export it —
   **UNVERIFIED**. Additionally: GeoClue's positioning backend needs checking in 2026; if the
   underlying WiFi-positioning provider is unavailable, the portal returns success with no fix and
   we must map that to `NoFix`, not `Unavailable`. Blocking for step 4.
3. **`org.gnome.SettingsDaemon.Color` `DisabledUntilTomorrow` semantics** — does it reset at
   midnight, at sunrise, or on gsd restart? `linux.md` §1 documents the property but not its
   lifetime. Blocking for step 11.
4. **`CBBlueLightClient` read-only usage risk.** `macos.md` §1 rates the whole client MEDIUM, but
   read-only calls (`getBlueLightStatus:`, `supportsBlueLightReduction`) should be materially safer
   than the setters. Confirm before step 9 — if read-only is low-risk, step 9 can ship even in a
   build where the setters are feature-flagged off.
5. **Does driving Night Shift instead of gamma actually look right on macOS?** `macos.md` §0 makes
   this strategically important (gamma is broken on M5-class hardware; Night Shift is not). But
   Night Shift's strength is a single 0.0–1.0 scalar, not a Kelvin value, so our mode presets would
   need a mapping. Worth a spike because it may be the best macOS tint path there is —
   ⚠️ overlapping with `macos.md` §B's MediaAccessibility matrix suggestion; evaluate both together
   and hand the result to plan 01.
6. **Which IP-geo provider, if any?** Product + legal, not engineering. Gates step 7.
7. **Should the transition window be asymmetric?** `scheduler.rs`'s doc comment records CareUEyes'
   asymmetric anchoring (morning ramp *starts* at sunrise; evening ramp *ends* at sunset) and we
   match it. Worth confirming against the CareUEyes screenshots that this is what users actually
   expect, since it means the screen is already fully warm at sunset rather than starting to warm.

## 10. Effort

| Platform | Size | Note |
|---|---|---|
| Scheduling core | **XS** | Already done and already portable. Only tests are added. |
| Null Island fix (step 1) | **XS** | Pure logic, fixes a live bug, ships alone. |
| Geolocation — shared types + UI | **S** | |
| Geolocation — macOS (CoreLocation) | **S–M** | Public API; the work is the permission UX, not the call. |
| Geolocation — Linux (portal) | **M** | Carries the portal app-ID registration and the zbus/tokio runtime hazard, both of which are shared cost with the hotkeys work. |
| Geolocation — Windows | **UNVERIFIED** | Cannot size until §9.1. |
| Night-light — KDE | **XS** | Two D-Bus calls, VERIFIED source. |
| Night-light — macOS read-back | **S** | |
| Night-light — GNOME / X11 detection | **M** | Mostly messaging and a restore ledger. |
| IP-geo fallback | **S** to build, **L** to decide | |

**Single biggest risk:** not technical. It is that the IP-geolocation fallback gets added quietly as
"just a fallback" and turns a no-network privacy utility into one that phones a third party the first
time a user enables a schedule. The engineering is trivial; the decision is not, and §6 exists to
force it into the open. The largest *technical* risk is the shared portal/app-ID/zbus-runtime work on
Linux (§6, `linux.md` §10), which is a hazard this plan inherits rather than creates — coordinate it
with whichever plan lands portals first.
