# Plan 06 — Per-app rules (auto-switch mode by foreground window)
Status: DRAFT
Depends on: 00 (capability layer)
Parity ref: FEATURE-PARITY.md F4.1–F4.5, F1.11 (full-screen suspend rides the same watcher)

---

## 1. What this feature is

While a matching app owns the foreground, the display mode switches automatically and reverts when
focus moves away — Photoshop forces `pause` (no filtering, colour-critical work), a game forces
`game`, and so on (`research/careueyes/images/docs_display_custom-rules_01_img.jpg` through `_06_`).
Rules are edited in a list with a per-rule mode dropdown (F4.4), and the pattern is captured by
pointing at a window — CareUEyes' drag-crosshair "Finder Tool" (F4.3), which we implement as a
window picker.

## 2. Current state

`src-tauri/src/rules/mod.rs` — complete and working, **Windows-only**.

The pure part, already portable and unit-tested (`mod matcher`, compiled under
`#[cfg(any(windows, test))]`):
```rust
fn rule_matches(rule: &Rule, process: &str, class_name: &str, title: &str) -> bool
fn resolve_override(rules: &RulesSettings, process: &str, class_name: &str, title: &str) -> Option<String>
```
`process` and `class` compare the **whole string** case-insensitively; `title` is a case-insensitive
**substring** match; blank patterns and unknown kinds never match; `resolve_override` returns the
first matching rule's mode. Eight tests cover it.

The platform part (`mod windows_impl`, `#[cfg(windows)]`):
- `POLL_INTERVAL_MS: u64 = 700` — a polling watcher thread, deliberately simpler than
  `SetWinEventHook`.
- `fn foreground_info() -> Option<ForegroundInfo>` — `GetForegroundWindow` →
  `GetWindowThreadProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
  `QueryFullProcessImageNameW` for the image basename, `GetClassNameW`, `GetWindowTextW`,
  plus `is_self: pid == std::process::id()`.
- `fn watcher_loop(app: &AppHandle)` — re-reads settings each tick, calls
  `crate::display::engine::set_rule_override(Some(mode) | None)` only on change, and holds the
  previous override when *our own* window is foreground (so opening DimRead doesn't clear a rule).
- `fn is_fullscreen_foreground() -> bool` — FEATURE-PARITY F1.11. **Needs window geometry**
  (`GetWindowRect` vs `GetMonitorInfoW`'s `rcMonitor`) and lives in this same watcher.
- `pub fn list_windows() -> Vec<OpenWindow>` via `EnumWindows`, filtered by `should_list` (visible,
  titled, not a tool window unless `WS_EX_APPWINDOW`).

```rust
pub struct OpenWindow { pub id: String, pub process: String, pub title: String, pub class_name: String }
#[tauri::command] pub fn rules_list_windows() -> Vec<OpenWindow>   // Vec::new() off Windows
#[cfg(not(windows))] pub fn init(_app: &AppHandle) {}              // silent no-op
```

Settings (`src-tauri/src/settings/mod.rs`): `RulesSettings { enabled: bool, items: Vec<Rule> }`,
`Rule { id, match_kind: String /* "process"|"class"|"title" */, pattern, mode }`.

Frontend: `src/features/rules/` — `lib/rule-model.ts` mirrors the Rust matcher
(`MATCH_KINDS = ["process", "class", "title"]`, `toMatchKind`, `patternForWindow(win, kind)`),
`ui/RuleDialog.tsx`, `api/use-open-windows.ts`.

**Every field of `OpenWindow` is a non-optional `String` today, and every one of them is unavailable
on at least one target platform.** That is the whole problem.

## 3. Per-platform verdict table

The hard constraint: this feature needs **foreground-app identity**, and on the single largest Linux
target that is the most restricted thing in the entire port.

| Platform | Verdict | Mechanism | Notes |
|---|---|---|---|
| Windows 10/11 | **FULL** | `GetForegroundWindow` + `QueryFullProcessImageNameW` + `GetClassNameW` + `GetWindowTextW` | Works today. Process name, class, title, pid, geometry — all four match kinds plus F1.11 fullscreen detection. |
| macOS (Intel / Apple Silicon) | **PARTIAL** | `NSWorkspace.frontmostApplication` + `NSWorkspaceDidActivateApplicationNotification`; enumeration via `CGWindowListCopyWindowInfo` | `macos.md` §5: **zero permissions** — PID, bundle ID, name, icon of the frontmost app, push-based. `macos.md` §6: `CGWindowListCopyWindowInfo` gives `kCGWindowNumber`, `kCGWindowOwnerPID`, `kCGWindowOwnerName`, `kCGWindowBounds`, `kCGWindowLayer`, `kCGWindowAlpha`, `kCGWindowIsOnscreen` **unpermissioned** — "everything works EXCEPT `kCGWindowName`", which is redacted without Screen Recording. ⚠️ **Do NOT request Screen Recording**: `macos.md` §6 — "the highest-friction macOS permission and Sequoia's periodic re-prompting made users hostile to it." **Title matching is therefore unavailable on macOS, by choice.** No window-class concept. Precise per-window geometry for the *focused* window needs Accessibility (`macos.md` §5) — optional, HazeOver-style, never a launch gate. |
| Linux X11 | **FULL** | `_NET_ACTIVE_WINDOW` on the root + `PropertyChangeMask`/`PropertyNotify`; `_NET_CLIENT_LIST` to enumerate | `linux.md` §5–6 [VERIFIED]. Active window, title (`_NET_WM_NAME`), class (`WM_CLASS`), pid, geometry — full fidelity, push-based. ⚠️ **Prefer XRes 1.2 `XResQueryClientIds` over `_NET_WM_PID`** — the latter "is voluntary and may carry a sandbox/remote PID"; Metacity, Marco and wlroots all migrated to XRes. Geometry needs `XTranslateCoordinates` (reparenting WMs insert frame windows). ⚠️ But see `linux.md` §0: GNOME 50 **removed** X11 entirely and KDE 6.8 is Wayland-exclusive — this row is a shrinking population. |
| Linux Wayland — KDE | **PARTIAL** | KWin scripting: `org.kde.KWin` `/Scripting` `loadScript(path, name)` + `start()`, injected JS calling back over D-Bus via `callDBus` | `linux.md` §6: full fidelity — `KWin::Window` exposes `x/y/width/height`, `pid`, `caption`, `resourceClass`, `desktopFileName`; `workspace.windowActivated` for push events. **A supported third-party route**, but we must author, ship and install a JS shim, and its lifetime is tied to KWin's scripting API across Plasma versions. PARTIAL for deployment cost, not capability. ⚠️ **KWin implements NEITHER foreign-toplevel protocol** (verified against `KDE/kwin@master`; open request = KDE Bug 502647). |
| Linux Wayland — GNOME | **BLOCKED without a user-installed extension** | `org.gnome.Shell.Extensions.Windows` from ickyicky/window-calls or flexagoon/focused-window-dbus | `linux.md` §5: **mutter implements NEITHER `ext-foreign-toplevel-list-v1` NOR `zwlr-foreign-toplevel-management-v1`** (verified against `GNOME/mutter@main`). `org.gnome.Shell.Eval` has been blocked since GNOME 41 and is "**Unavailable for a shipping app**". There is **no window-info XDG portal** and no proposal in flight. So on the *most common* Linux desktop, the only route is a **third-party GNOME Shell extension the user installs by hand**, which "break[s] across GNOME majors. Real deployment burden." Without it: BLOCKED, full stop. |
| Linux Wayland — wlroots (sway / Hyprland) | **FULL** | sway `GET_TREE` over the i3-IPC socket (`$SWAYSOCK`); Hyprland `clients`/`activewindow` + `.socket2.sock` push | `linux.md` §6 table: both give geometry ✅, pid ✅, and focus events ✅. The best Wayland backends we have. |
| Linux Wayland — generic (river, Wayfire, labwc, COSMIC, niri) | **PARTIAL — severely** | `ext_foreign_toplevel_handle_v1` / `zwlr_foreign_toplevel_handle_v1` | `linux.md` §5, **definitive**: the handle's entire event surface is `title`, `app_id`, `identifier`, `done`, `closed`; the wlr variant adds `output_enter/leave`, `state` (incl. **`activated`**), `parent`. "**Neither carries PID or geometry.**" A normal Wayland client "cannot learn the focused window, any window's geometry, or even its own absolute position." → app_id + title + activated. Nothing else, ever. |

## 4. Design

### 4.1 The data model is dictated by the weakest backend — decide this once, on day one

`linux.md`'s architectural recommendation states it as an imperative:

> **Design the data model around the weakest backend.** Make `pid` and `geometry` `Option<…>` in the
> Rust types **and in the tauri-specta bindings from day one**. The generic Wayland path can never
> fill them, and retrofitting optionality through `src/bindings.ts` and the frontend later is far
> more painful than accepting it now. Key the model on **`app_id`/`wm_class`, not PID** — it is the
> one identifier available on every backend.

Concretely, replacing `OpenWindow`:

```rust
/// A window's identity as far as THIS platform/session can determine it.
/// Every field except `app_key` is `Option` because at least one shipping
/// backend can never supply it. Do not "fix" this by defaulting to "".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    /// Opaque, stable-for-this-listing handle (HWND / CGWindowID / X11 Window /
    /// wl toplevel `identifier` / sway con id). Distinguishes two windows of the
    /// same app in the picker. NOT a match key.
    pub id: String,

    /// ★ THE UNIVERSAL KEY — the only field every backend can fill.
    /// Windows: process image basename (`photoshop.exe`).
    /// macOS:   bundle identifier (`com.adobe.Photoshop`), falling back to
    ///          `kCGWindowOwnerName` when there is no bundle.
    /// X11:     `WM_CLASS` instance/class.
    /// Wayland: `app_id`.
    /// Rules match on THIS. Never on `pid`.
    pub app_key: String,

    /// Human-readable app name for the picker UI. Always available in practice,
    /// but not a match key — it is localised on macOS and unstable everywhere.
    pub app_name: Option<String>,

    /// Window title. `None` on macOS (Screen Recording withheld by design,
    /// macos.md §6) and on backends that don't expose it.
    pub title: Option<String>,

    /// Win32 class name / X11 WM_CLASS class component. `None` on macOS and on
    /// Wayland (where `app_id` is the only class-like notion and lives in
    /// `app_key`).
    pub class_name: Option<String>,

    /// `None` on every generic-Wayland backend (linux.md §5: the protocol has no
    /// pid). Also `None` on X11 when XRes is unavailable and we decline to trust
    /// `_NET_WM_PID`.
    pub pid: Option<u32>,

    /// `None` on ALL generic Wayland; `None` on macOS without Accessibility.
    /// F1.11 full-screen detection depends on this — see §4.5.
    pub geometry: Option<WindowRect>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }
```

**`Option` is load-bearing here, not defensive.** Coercing a missing title to `""` would make a
`title` rule with pattern `""` … well, `rule_matches` already rejects blank *patterns*, but a blank
*subject* silently never matches, which is precisely the silent no-op the house rules forbid. `None`
lets the matcher return a distinguishable "cannot evaluate this rule here" and lets the UI say so.

Correspondingly in `src/bindings.ts` (generated — regenerate via `cd src-tauri && cargo test
export_bindings`, never hand-edit) these become `string | null`, `number | null`,
`WindowRect | null`, and `src/features/rules/lib/rule-model.ts`'s `patternForWindow` must return
`string | null` and the dialog must disable the corresponding match kind.

### 4.2 The backend trait

```rust
pub trait ForegroundBackend: Send + Sync {
    /// What this backend can actually produce. Static per session.
    fn capability(&self) -> ForegroundCapability;
    /// The current foreground window, or `None` when nothing is focused.
    fn foreground(&self) -> Option<WindowIdentity>;
    /// Enumerate candidate windows for the picker. `Err` when the backend cannot
    /// enumerate at all (generic Wayland) — NOT an empty Vec, which reads as
    /// "no windows are open".
    fn list_windows(&self) -> Result<Vec<WindowIdentity>, ForegroundError>;
    /// Push-based focus notifications where available (NSWorkspace notification,
    /// X11 PropertyNotify, sway/Hyprland event socket, KWin windowActivated).
    /// Backends without one fall back to the shared poller.
    fn subscribe(&self, sink: Box<dyn Fn(Option<WindowIdentity>) + Send>) -> Option<Subscription>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundCapability {
    pub backend: BackendKind,       // Win32 | MacNsWorkspace | X11 | Sway | Hyprland
                                    // | KWinScript | GnomeExtension | GenericWayland | None
    pub has_app_key: bool,          // always true when a backend exists
    pub has_title: bool,
    pub has_class_name: bool,
    pub has_pid: bool,
    pub has_geometry: bool,
    pub can_enumerate: bool,
    pub push_events: bool,
    /// Present when `backend == None` or a route needs user action
    /// (e.g. "install the Window Calls GNOME extension"). Rendered verbatim.
    pub setup_hint: Option<String>,
}
```

`ForegroundCapability` is the entire anti-silent-no-op mechanism for this feature and feeds plan 00.

### 4.3 Backend selection — detect `$WAYLAND_DISPLAY` FIRST

`linux.md`'s recommended architecture is explicit and the ordering matters:

> **Detect `$WAYLAND_DISPLAY` FIRST** — a Tauri app under Xwayland also sees `$DISPLAY` set, and
> checking `$DISPLAY` first misroutes to a backend that sees only Xwayland clients.

Then `$XDG_CURRENT_DESKTOP`, `$SWAYSOCK`, `$HYPRLAND_INSTANCE_SIGNATURE`. Descending data quality
(`linux.md`): X11 → sway/Hyprland → KWin script → GNOME extension → generic Wayland.

Also relevant: `linux.md` §0 notes that **Xwayland is not a fallback for us** — "It gives no root
window → no `_NET_ACTIVE_WINDOW`". So the X11 backend must refuse to activate under Wayland rather
than half-work.

### 4.4 Mapping the existing `match_kind` onto app_id-only backends

Today's three kinds (`"process" | "class" | "title"`, mirrored in
`src/features/rules/lib/rule-model.ts`) do not survive contact with the other platforms. The
migration:

| Existing kind | Windows | macOS | X11 | Wayland (generic / sway / Hyprland / KWin) |
|---|---|---|---|---|
| `process` | image basename — unchanged | bundle id (`app_key`) | binary basename resolved from the XRes pid | **maps to `app_id`** |
| `class` | `GetClassNameW` — unchanged | **unavailable** → rule disabled with a reason | `WM_CLASS` | `app_id` (same value as `process` — collapses) |
| `title` | unchanged | **unavailable** (Screen Recording, declined by design) | `_NET_WM_NAME` | available |

Two design decisions follow.

1. **Add a fourth kind, `"appKey"`, and make it the default on non-Windows platforms.** It matches
   `WindowIdentity.app_key` — the one universal field. Keep `process`/`class`/`title` for platforms
   where they are meaningfully distinct. On generic Wayland, `process` and `class` are *aliases* of
   `appKey`; rather than silently aliasing them (confusing when a user reads their rule list), the
   picker only ever produces `appKey` rules there, and imported/legacy `process`/`class` rules are
   evaluated against `app_key` with a UI note explaining the coercion.
2. **A rule whose subject field is `None` must be visibly non-evaluable, not silently false.**
   `rule_matches` becomes:

```rust
/// `None` = this rule CANNOT be evaluated on this backend (the required field is
/// unavailable), which is different from `Some(false)` = evaluated and did not match.
pub(crate) fn rule_matches(rule: &Rule, id: &WindowIdentity) -> Option<bool>;

/// Unchanged contract: first matching rule wins, `None` when rules are disabled
/// or nothing matches. Non-evaluable rules are SKIPPED, and reported separately.
pub(crate) fn resolve_override(rules: &RulesSettings, id: &WindowIdentity)
    -> (Option<String>, Vec<RuleId /* non-evaluable */>);
```

The non-evaluable list drives a badge in the rules list ("This rule can't work on your desktop —
titles aren't available"). That is the F4 equivalent of plan 04's disabled mode grid.

**Settings are per-machine.** `dimread-settings.json` is local (`settings/store.rs`), so there is no
cross-platform rule migration to perform — a user's Windows rules never arrive on their Mac. This
removes the worst version of the problem and is worth stating so nobody builds a migration.

### 4.5 F1.11 full-screen suspend is collateral damage

`is_fullscreen_foreground()` currently compares `GetWindowRect` against `GetMonitorInfoW`'s
`rcMonitor`. **It needs `geometry`, which is `None` on all generic Wayland and on macOS without
Accessibility.** So `DisplaySettings.disable_on_fullscreen` — a *separate, default-ON* feature that
happens to live in this watcher — silently stops working on those platforms unless we act.

Design: move it out of `rules/` into its own `fullscreen` concern reading the same
`ForegroundBackend`, and give it its own capability flag derived from `has_geometry`. On macOS there
is a better route anyway: `kCGWindowBounds` from `CGWindowListCopyWindowInfo` is available
**unpermissioned** (`macos.md` §6), so we can compare against `CGDisplayBounds` without Accessibility.
On generic Wayland it is genuinely `Unsupported` and the settings toggle must say so.

### 4.6 Watcher shape

Keep the 700 ms poller as the **fallback**, and prefer push where the backend has it: NSWorkspace
notification (macOS), `PropertyNotify` on `_NET_ACTIVE_WINDOW` (X11), `.socket2.sock` (Hyprland),
i3-IPC `window` event (sway), `workspace.windowActivated` (KWin script). Push is not just efficiency
— on macOS it is the documented mechanism, and `macos.md` §5 notes HazeOver advertises reacting
"instantly" as the *benefit* of the optional permission tier.

The existing `is_self` guard (hold the previous override when our own window is foreground) must be
reimplemented per backend: pid comparison on Windows/X11/sway/Hyprland, bundle-id comparison on
macOS, `app_id` comparison on generic Wayland.

### 4.7 IPC changes

`rules_list_windows() -> Vec<OpenWindow>` becomes:

```rust
#[tauri::command] #[specta::specta]
pub fn rules_list_windows() -> Result<Vec<WindowIdentity>, String>;

#[tauri::command] #[specta::specta]
pub fn rules_capability() -> ForegroundCapability;
```

Both registered in `commands_registry.rs` under `// ── rules ──`; regenerate bindings. The `Result`
is the point: generic Wayland returns `Err`, and the picker renders "your desktop doesn't let apps
list windows — type the app id instead" rather than an empty list that reads as a bug.

## 5. Implementation steps

1. **Introduce `WindowIdentity` + `ForegroundCapability` with the Windows backend behind them.**
   Pure refactor: `OpenWindow` → `WindowIdentity` with the `Option` fields (Windows fills all of
   them), `rule_matches`/`resolve_override` take `&WindowIdentity` and return the non-evaluable
   list, `rules_capability` added, bindings regenerated, `rule-model.ts` and `RuleDialog.tsx`
   updated for nullable fields. **No behaviour change on Windows.** This is the step that pays the
   `linux.md` "day one" instruction; everything else is additive.
2. **Non-evaluable reporting in the UI.** Rules list badges + i18n keys (`check:i18n` enforces
   coverage); picker handles `Err`. Still Windows-only, but the app now tells the truth on every
   platform it might later run on.
3. **Add the `appKey` match kind** to `MATCH_KINDS`, the Rust matcher, and the dialog; default to it
   off Windows.
4. **Extract F1.11 fullscreen detection** into its own module with its own capability flag (§4.5).
5. **macOS backend.** `NSWorkspace.frontmostApplication` + `NSWorkspaceDidActivateApplicationNotification`
   (zero permissions), `CGWindowListCopyWindowInfo` for the picker with `title: None`,
   `kCGWindowBounds` for fullscreen detection. **Do not touch Screen Recording. Do not gate on
   Accessibility.** Optional Accessibility tier is a *later* step, HazeOver-style.
6. **X11 backend.** `x11rb` + hand-rolled EWMH; `_NET_ACTIVE_WINDOW` with `PropertyChangeMask`;
   `_NET_CLIENT_LIST`; **XRes `XResQueryClientIds` for pid**; `XTranslateCoordinates` for geometry.
   Must refuse to activate when `$WAYLAND_DISPLAY` is set (§4.3).
7. **sway + Hyprland backends.** `swayipc` / the `hyprland` crate. Highest value per line of code on
   Wayland — full fidelity, push events, no permission story at all.
8. **Generic Wayland backend.** `wayland-protocols` `ext_foreign_toplevel_list_v1` +
   `wayland-protocols-wlr` for `activated`. `pid`/`geometry` = `None`, `list_windows` works where
   the compositor implements the protocol. **Explicitly excludes GNOME and KDE** (§3).
9. **KWin scripting backend.** Author the JS shim, ship it, `loadScript` + `start()` over D-Bus, shim
   calls back via `callDBus`. *Spike-gated (§9.2)* — installation lifetime and Plasma-version
   compatibility are the unknowns, not the API.
10. **GNOME extension backend.** Detect `org.gnome.Shell.Extensions.Windows`; if absent, report
    `backend: None` with a `setup_hint` naming the extension and linking to it. **Never bundle or
    auto-install.** Degrade with the clear in-app explanation `linux.md` §"Recommended architecture"
    asks for.
11. **Frontend picker per capability.** `src/features/rules/` — hide match kinds the backend cannot
    supply; show the setup hint; run `bun run check:fsd`.

Steps 9 and 10 are the ones to defer or cut if the schedule tightens: KDE users can still write
`appKey` rules by typing the app id, and GNOME users can too. **The picker is a convenience; the
matcher is the feature.** That is worth designing for deliberately — every backend must degrade to
"type the app id yourself" rather than to nothing.

## 6. Permissions, packaging, distribution

**macOS — the whole point is that this costs ZERO permissions.**
`macos.md` §5: `NSWorkspace.frontmostApplication` gives PID, bundle ID, name and icon with no TCC
grant. `macos.md` §6: `CGWindowListCopyWindowInfo` returns everything except `kCGWindowName`
unpermissioned, and concludes "**For our Rules feature the unpermissioned subset is sufficient**
(we match on process/app name). **Do NOT request Screen Recording.**" This plan takes that
instruction literally: **title matching is a Windows/X11/Wayland feature and simply does not exist on
macOS.** No entitlement, no Info.plist key, no MAS impact, no notarization impact — this is the one
plan in the port that costs nothing on macOS.

The *optional* Accessibility tier (`kTCCServiceAccessibility`, via `accessibility-sys` v0.2.0 per
`macos.md` §5) would add precise focused-window geometry and instant push updates. If ever added:
- Follow HazeOver — the app must work fully without it (`macos.md` §5).
- ⚠️ "**The grant is keyed to the code signature** — every re-signed dev build is a new identity, so
  we re-prompt constantly in development and users may re-grant after updates."

**Linux — no permissions, but real deployment burden on two desktops.**
- X11, sway, Hyprland, generic Wayland: nothing. Ordinary client protocols and user-owned sockets.
- **KDE**: we must ship a JS file and load it into KWin at runtime. Packaging must place it somewhere
  readable; a Flatpak's `/app` path is visible to KWin only if the sandbox exports it — **verify
  before promising KDE support in a Flatpak** (§9.2).
- **GNOME**: the user installs a third-party extension themselves. This is a genuine product cost —
  a support burden, a version-fragility risk (`linux.md` §6: "Extensions break across GNOME
  majors"), and a step most users will not take. It should be presented as an optional enhancement
  in the rules panel, not as a broken feature.
- **No portal exists and none is coming.** `linux.md` §5: "**XDG portals: confirmed NO window-info
  portal.** … No proposal in flight." Do not plan for one.

**Windows.** Unchanged. Note the existing limitation that windows of elevated processes cannot be
inspected by a non-elevated DimRead (already documented in `focus/blur.rs`); the same applies to
rules and should be surfaced the same way.

## 7. Failure modes & degradation

| Failure | What the user sees |
|---|---|
| Generic Wayland: cannot enumerate windows | Picker replaced by a text field with a "how do I find my app id?" hint (`.desktop` basename), plus the capability's `setup_hint`. **Not an empty list.** |
| GNOME Wayland, no extension | Rules panel shows the feature as unavailable with the extension named and linked. Rules remain *editable* (so the user can prepare them) but a banner says they will not fire. Editing-but-inert must be explicit. |
| A `title` rule on macOS | The rule shows a "not supported on macOS" badge; `resolve_override` skips it and reports it as non-evaluable. This is why `rule_matches` returns `Option<bool>`. |
| A `class` rule on Wayland | Coerced to match `app_key` with a visible note, or flagged non-evaluable — decided in step 3. |
| Rules match but the mode doesn't change | Means the display engine refused, not the matcher. `engine::set_rule_override` is unchanged and already logs; keep them distinguishable in the UI. |
| Elevated app foreground (Windows) | No identity readable → treated as "no match" and the previous override is held (current behaviour). Surface as a hint, matching `focus/blur.rs`'s existing tooltip. |
| Our own window in front | Previous override held — existing, correct behaviour; must be reimplemented per backend (§4.6) or opening DimRead's own settings will clear the user's active rule. Easy regression to introduce. |
| F1.11 fullscreen suspend where `has_geometry == false` | The `disable_on_fullscreen` toggle is disabled with a reason, rather than silently doing nothing while defaulting to ON. |
| Compositor restarts / KWin script unloaded | Backend reports itself unhealthy; re-arm on the next poll; surface a transient banner rather than dying silently. |

**On exit/crash:** rules hold no OS-global state — `set_rule_override(None)` is in-process and the
display engine's own `restore_all()` already covers the visible effect. Nothing to restore, unlike
plans 03 and 04. The one exception is the KWin script: unload it on clean exit, and make
`loadScript` idempotent so a crashed previous run does not leave a duplicate registered.

## 8. Testing

**Unit-testable in CI, any platform — this is where the value is:**
- The existing eight matcher tests in `rules/mod.rs`, ported to `&WindowIdentity`, plus new cases for
  every `None` field × every match kind. The `Option<bool>` contract needs a test per combination:
  `None` subject → `None`; blank pattern → `Some(false)`; matching subject → `Some(true)`.
- `resolve_override` returning the non-evaluable list: a rules set mixing evaluable and non-evaluable
  rules must return the *first evaluable match* and report the rest, not stop at the first
  non-evaluable one.
- The `app_key` derivation table (§4.4) as a pure function per backend kind, fed synthetic inputs.
- Backend selection from environment variables (§4.3): assert `$WAYLAND_DISPLAY` set + `$DISPLAY` set
  selects a Wayland backend, never X11. This is the exact bug `linux.md` warns about and it is
  trivially testable.
- `rule-model.ts` mirror tests in `src/features/rules/lib/rule-model.test.ts` — extend for nullable
  `patternForWindow`.

**Manual only, per environment:**
- Windows regression after step 1 — the refactor touches working code and must be verified against
  the existing behaviour (process, class, title rules; self-window guard; fullscreen suspend).
- macOS: rule firing on app switch with **no permissions granted at all** — the headline claim.
  Verify the picker lists apps with `title: None` and the UI handles it.
- Each Linux backend on its own desktop. Minimum set: X11 (any DE), sway, Hyprland, KDE Wayland with
  the script loaded, GNOME Wayland with and without the extension, and one generic-Wayland
  compositor (river or labwc) to confirm the degraded picker messaging.
- KWin script survival across a KWin restart (`kwin_wayland --replace` or a Plasma session reload).

**Cannot be tested in CI:** every backend. All of them need a live session with a window manager. The
mitigation is the same structural one plan 05 relies on — keep the matcher and the app_key derivation
pure and parameterised, so CI covers the decision logic and manual testing only has to confirm that
the platform data arrives in the right shape.

## 9. Open questions / spikes needed

1. **`app_key` normalisation across platforms.** `photoshop.exe` vs `com.adobe.Photoshop` vs
   `Adobe Photoshop 2026` (X11 `WM_CLASS`) vs `photoshop` (`app_id`). Should we case-fold and strip
   `.exe`? Should the picker offer a "match loosely" option? Affects step 1's matcher contract, so
   resolve early.
2. **KWin script deployment.** Where does the file live in a `.deb` / AppImage / Flatpak, is
   `loadScript` given a host path or a sandbox path, and does the script survive a KWin restart?
   `linux.md` §6 verifies the *API*; the *lifecycle* is unverified. Blocking for step 9.
3. **Does `ext_foreign_toplevel_list_v1` have enough adoption to be worth step 8?** `linux.md` §5 is
   clear that GNOME and KDE do not implement it, and sway/Hyprland have better native IPC — which
   leaves river, labwc, Wayfire, COSMIC and niri. Measure before building.
4. **macOS: is bundle id or `kCGWindowOwnerName` the better `app_key`?** Bundle id is stable and
   non-localised; owner name is what the user sees. Probably bundle id for matching, owner name for
   display — confirm with a real app set (Electron apps, wrappers, and CLI-launched binaries with no
   bundle are the interesting cases).
5. **X11 `XResQueryClientIds` in `x11rb`** — is the XRes 1.2 extension bound? `linux.md` §5
   recommends it over `_NET_WM_PID` but does not confirm Rust availability. Blocking for step 6's
   `pid` field; falls back to `None` (which the model already permits) if not.
6. **Should `class` be retired entirely off Windows** rather than coerced? Retiring is simpler and
   more honest; coercing preserves rules users may have typed. Decide in step 3.
7. **GNOME product decision:** is "install this third-party extension" acceptable to ask of users at
   all, or do we ship GNOME Wayland with rules honestly marked unavailable? Given `linux.md` §0
   ("the dominant Linux target is **GNOME Wayland**"), this decides whether F4 exists for most Linux
   users. It is the single most consequential open question in this plan.

## 10. Effort

| Platform | Size | Note |
|---|---|---|
| Step 1 refactor (`WindowIdentity`, `Option` everywhere, bindings, frontend) | **M** | Touches working Windows code and the generated bindings. Do it first, do it once. |
| Windows | **XS** | Already done; only the refactor and re-verification. |
| macOS | **S–M** | Zero permissions, public APIs, push notifications. The easiest platform in the entire port. |
| Linux X11 | **M** | EWMH + XRes + `XTranslateCoordinates` by hand; well-documented, no surprises. |
| Linux sway + Hyprland | **S** | Two maintained crates, full fidelity. |
| Linux generic Wayland | **S** | Small surface — because the protocol *is* small. |
| Linux KDE (KWin script) | **L** | Authoring + shipping + lifecycle of an injected JS shim, with an unverified deployment story. |
| Linux GNOME | **M engineering / XL product** | The code is a D-Bus client. The problem is that it depends on the user installing something. |

**Single biggest risk:** GNOME Wayland is simultaneously the largest Linux target (`linux.md` §0) and
the only environment where this feature is BLOCKED without user-installed third-party software. There
is no portal, `Shell.Eval` is closed, and neither foreign-toplevel protocol is implemented — this is
verified against mutter's source tree, not inferred, so it will not improve on its own. Plan for
per-app rules to be *unavailable* for a large share of Linux users and make that visible in the UI,
rather than discovering it after shipping. The mitigating design choice is §5's rule: **every backend
must degrade to "type the app id yourself", never to nothing** — that keeps the matcher working
everywhere `app_key` can be read, which is everywhere except GNOME Wayland.
