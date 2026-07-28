//! Auto Dark (FEATURE-PARITY F9.5-F9.6) — schedule the Windows **system** theme
//! (Light / Dark / Auto (day-night) / Disable) and optionally apply the
//! transparent-taskbar effect, driven by `settings.auto_dark`.
//!
//! ## Seam (frozen)
//! - [`init`] — capture the handle and start the theme scheduler.
//! - [`apply_now`] — evaluate the schedule and apply it immediately (call after
//!   an `auto_dark` settings change or a day/night phase flip).
//! - [`restore_on_exit`] — undo the taskbar effect on graceful shutdown.
//!
//! ## Scope: this module never themes DimRead itself
//! DimRead's own UI is permanently dark (`color-scheme: dark` in
//! `app/styles/globals.css`); re-skinning happens only in the `@theme` blocks
//! there. This module drives the OS. An `app_theme` target used to live here too,
//! writing `AppsUseLightTheme` — but that key re-themes every OTHER Windows app
//! while leaving DimRead untouched, so a control labelled "App theme" in our
//! settings window read as a bug. It was removed; do not reintroduce it.
//!
//! ## How the schedule resolves
//! `"light"` → light, `"dark"` → dark, `"disable"` → left untouched, and
//! `"auto"` → light during the day / dark after sunset.
//!
//! WHICH day/night window `"auto"` runs on is [`AutoDarkSettings::use_day_night_schedule`]:
//! on (the default) it reuses the day/night section's boundaries — the very sun
//! times the colour filter runs on, resolved location and all — via
//! [`crate::display::scheduler::current_schedule_times`]; off it falls back to
//! this section's own `system_sunrise`/`system_sunset` pair. Two schedules that
//! answer "when is it night?" differently is a bug the user has to notice, so
//! sharing is the default and the manual pair is the opt-out.
//!
//! On an actual change the resolved dark flag is written to
//! `HKCU\...\Themes\Personalize` (`SystemUsesLightTheme`, where `1` = light and
//! `0` = dark) and a `WM_SETTINGCHANGE("ImmersiveColorSet")`
//! is broadcast so running apps re-read the theme; the resolved flags are then
//! emitted as [`crate::events::AutoDarkChangedEvent`]. Taskbar transparency
//! (F9.6) is applied best-effort through the undocumented
//! `SetWindowCompositionAttribute` accent policy on `Shell_TrayWnd`, re-asserted
//! when Windows reports that Explorer recreated the taskbar, and restored when
//! toggled off or on exit.
//!
//! ## Restoring the taskbar (do not "simplify" this)
//! There is no way to hand the taskbar back to the shell once its composition
//! attribute has been set. Writing an `ACCENT_DISABLED` policy does NOT undo the
//! override — it pins the taskbar to an opaque bar painted with `gradient_color`
//! (black, when that field is left zeroed), and it survives app exit because the
//! attribute lives on the `Shell_TrayWnd` window rather than in any of our state.
//! The restore therefore replays the policy captured via
//! `GetWindowCompositionAttribute` BEFORE the first override, and deliberately
//! does nothing when that capture failed.
//!
//! Everything Win32 is `cfg(windows)`-gated; off-Windows the seam compiles and is
//! inert (it never touches any registry).

#[cfg(windows)]
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Mutex, OnceLock};
#[cfg(any(windows, test))]
use std::time::Duration;

use tauri::AppHandle;
use tauri_specta::Event;

use crate::events::AutoDarkChangedEvent;
use crate::settings::AutoDarkSettings;

/// Handle for the scheduler to read `settings.auto_dark` from a background
/// context.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Coalescing wake channel for settings, registry, clock/resume, and Explorer
/// notifications. A single worker serializes all theme/taskbar reconciliation.
#[cfg(windows)]
static WAKE_TX: OnceLock<SyncSender<()>> = OnceLock::new();

/// Last resolved system-theme decision, so the registry is written and the event
/// re-broadcast only on an ACTUAL change. Outer `None` = never applied yet; an
/// inner `None` = the target is unmanaged (`"disable"`) and left as-is.
static LAST_THEME: Mutex<Option<ResolvedTheme>> = Mutex::new(None);

/// The resolved dark decision for the system theme. `Some(true)` = dark,
/// `Some(false)` = light, `None` = leave the target untouched.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct ResolvedTheme {
    system: Option<bool>,
}

/// Set once on graceful shutdown so a late scheduler/listener tick can't
/// re-assert the taskbar effect after [`restore_on_exit`] has cleared it.
#[cfg(windows)]
static SHUTTING_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Capture the handle and start the theme scheduler. Idempotent — a second call
/// (or a second window) is a no-op. Called from [`super::init`].
pub fn init(app: &AppHandle) {
    if APP.set(app.clone()).is_ok() {
        #[cfg(windows)]
        {
            use tauri::Listener;

            let (wake_tx, wake_rx) = mpsc::sync_channel(1);
            let _ = WAKE_TX.set(wake_tx);
            let _ = app.listen_any("settings:changed", |_event| request_wake());

            if let Err(err) = std::thread::Builder::new()
                .name("autodark-scheduler".into())
                .spawn(move || scheduler_loop(wake_rx))
            {
                log::warn!("[autodark] failed to start deadline worker: {err}");
            }
            if let Err(err) = std::thread::Builder::new()
                .name("autodark-registry-events".into())
                .spawn(registry_notification_loop)
            {
                log::warn!("[autodark] failed to start registry listener: {err}");
            }
        }
    }
}

/// Wake the serialized worker without ever blocking an event/message-loop
/// thread. A full channel means reconciliation is already pending.
#[cfg(windows)]
fn request_wake() {
    if let Some(tx) = WAKE_TX.get() {
        let _ = tx.try_send(());
    }
}

/// Called by the shared native Windows clock/Explorer listener in the display
/// scheduler. Off-Windows the theme seam remains inert.
#[cfg(windows)]
pub(crate) fn notify_system_change() {
    request_wake();
}

/// Deadline-driven Auto Dark worker. Fixed targets have no timer at all; an
/// automatic target sleeps directly to its next sunrise/sunset boundary.
#[cfg(windows)]
fn scheduler_loop(wake_rx: Receiver<()>) {
    apply_now();
    loop {
        match next_theme_delay() {
            Some(delay) => {
                let _ = wake_rx.recv_timeout(delay);
            }
            None => {
                if wake_rx.recv().is_err() {
                    return;
                }
            }
        }
        apply_now();
    }
}

#[cfg(windows)]
fn next_theme_delay() -> Option<Duration> {
    let app = APP.get()?;
    let settings = crate::settings::store::read_settings(app).auto_dark;
    if settings.system_theme != "auto" {
        return None;
    }
    let now_minutes = local_now_minutes_precise();
    Some(match effective_window(&settings) {
        // Polar day/night: nothing changes until the date does. The shared
        // schedule's astronomy is recomputed per date, so a midnight wake is
        // also what re-derives tomorrow's boundaries.
        ThemeWindow::Fixed { .. } => until_next_local_midnight(now_minutes),
        ThemeWindow::Rises { sunrise, sunset } => {
            duration_until_next_boundary(sunrise, sunset, now_minutes)
                .min(until_next_local_midnight(now_minutes))
        }
    })
}

/// Wake at the date rollover: the shared schedule's sun times are computed for
/// TODAY, so tomorrow's boundaries only exist after midnight.
#[cfg(any(windows, test))]
fn until_next_local_midnight(now_minutes: f64) -> Duration {
    Duration::from_secs_f64(((1440.0 - now_minutes) * 60.0).max(0.05))
}

#[cfg(any(windows, test))]
fn duration_until_next_boundary(sunrise: f64, sunset: f64, now_minutes: f64) -> Duration {
    let next_delta = [sunrise, sunset]
        .into_iter()
        .map(|boundary| (boundary - now_minutes).rem_euclid(1440.0))
        .filter(|delta| *delta > f64::EPSILON)
        .fold(1440.0, f64::min);
    Duration::from_secs_f64((next_delta * 60.0).max(0.05))
}

/// Block in `RegNotifyChangeKeyValue` until Windows reports that Personalize
/// changed. This observes manual theme edits with zero sampling and lets the
/// configured DimRead target reconcile immediately.
#[cfg(windows)]
fn registry_notification_loop() {
    use windows::Win32::System::Registry::{
        HKEY, REG_NOTIFY_CHANGE_LAST_SET, RegNotifyChangeKeyValue,
    };
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_NOTIFY, KEY_READ};

    const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(PERSONALIZE, KEY_READ | KEY_NOTIFY)
    else {
        log::warn!("[autodark] could not open Personalize registry key for notifications");
        return;
    };
    let key_handle = HKEY(key.raw_handle().cast());
    loop {
        // SAFETY: `key` owns this live HKEY for the whole blocking call and no
        // event handle is needed for synchronous notification delivery.
        let status = unsafe {
            RegNotifyChangeKeyValue(key_handle, false, REG_NOTIFY_CHANGE_LAST_SET, None, false)
        };
        if status.is_err() {
            log::warn!("[autodark] Personalize registry notification failed: {status:?}");
            return;
        }
        request_wake();
    }
}

/// Evaluate the Auto Dark schedule and apply it now.
///
/// Reads live `settings.auto_dark`, resolves each target against the current
/// day/night phase, writes only the registry keys that actually changed, emits
/// [`AutoDarkChangedEvent`] on a transition, and re-asserts the taskbar effect.
pub fn apply_now() {
    let Some(app) = APP.get() else {
        return;
    };
    let settings = crate::settings::store::read_settings(app).auto_dark;
    let now_minutes = local_now_minutes();
    let resolved = resolve(&settings, effective_window(&settings), now_minutes);

    let mut last = LAST_THEME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let prev = *last;
    // Reconcile against what Windows ACTUALLY has, not against what we last
    // wrote. Gating on our own cached decision means that once the user changes
    // the theme themselves (Settings → Personalization → Colors), our cache and
    // the registry disagree until the next event/deadline — the setting silently
    // stops controlling anything. Comparing to the live value makes the
    // schedule authoritative and self-healing, and still writes nothing when the
    // registry already agrees.
    if let Some(dark) = resolved.system
        && read_theme_key("SystemUsesLightTheme") != Some(dark)
        && write_theme_key("SystemUsesLightTheme", dark)
    {
        broadcast_theme_change();
    }
    let theme_changed = prev != Some(resolved);
    *last = Some(resolved);
    drop(last);
    if theme_changed {
        emit_changed(app, resolved);
    }

    apply_taskbar(settings.taskbar_transparent);
}

/// Undo the taskbar transparency effect on graceful shutdown (best-effort). A
/// no-op when it was never applied. Called from `app_exit`.
#[cfg(windows)]
pub fn restore_on_exit() {
    // Latch shutdown FIRST so any scheduler/listener wake still in flight can't
    // re-assert transparency after we clear it below.
    SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut last = LAST_TASKBAR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *last {
        restore_original_accent();
        *last = false;
    }
}

/// Off-Windows: nothing to restore.
#[cfg(not(windows))]
pub fn restore_on_exit() {}

// ── Pure resolution (platform-neutral, fully unit-tested) ────────────────────

/// Resolve one target (`"light"`/`"dark"`/`"auto"`/`"disable"`) to the desired
/// dark flag given whether it's currently daytime. `None` = leave untouched.
fn resolve_target(target: &str, day: bool) -> Option<bool> {
    match target {
        "light" => Some(false),
        "dark" => Some(true),
        // Auto = light during the day, dark after sunset.
        "auto" => Some(!day),
        // "disable" (and any unknown value) never touches the target.
        _ => None,
    }
}

/// The daytime window an `"auto"` target is evaluated against.
#[derive(Clone, Copy, Debug, PartialEq)]
enum ThemeWindow {
    /// A sunrise/sunset pair in local minutes-of-day.
    Rises { sunrise: f64, sunset: f64 },
    /// Polar day or polar night: no boundary today, the phase is simply this.
    Fixed { day: bool },
}

/// This section's own `"HH:MM"` pair — the window used when the day/night
/// schedule is opted out of, and the fallback whenever it cannot be read.
fn own_window(settings: &AutoDarkSettings) -> ThemeWindow {
    ThemeWindow::Rises {
        sunrise: parse_hhmm(&settings.system_sunrise),
        sunset: parse_hhmm(&settings.system_sunset),
    }
}

/// The window to resolve against right now, honouring
/// [`AutoDarkSettings::use_day_night_schedule`]. Falls back to [`own_window`]
/// when the display scheduler has no settings handle yet (early boot), so the
/// theme is never left unscheduled.
fn effective_window(settings: &AutoDarkSettings) -> ThemeWindow {
    use crate::display::scheduler::ScheduleTimes;

    if !settings.use_day_night_schedule {
        return own_window(settings);
    }
    match crate::display::scheduler::current_schedule_times() {
        Some(ScheduleTimes::Rises { sunrise, sunset }) => ThemeWindow::Rises { sunrise, sunset },
        Some(ScheduleTimes::AlwaysUp) => ThemeWindow::Fixed { day: true },
        Some(ScheduleTimes::AlwaysDown) => ThemeWindow::Fixed { day: false },
        None => own_window(settings),
    }
}

/// Resolve the system theme target for a settings snapshot at the current
/// wall-clock minute-of-day, against the supplied daytime window.
fn resolve(settings: &AutoDarkSettings, window: ThemeWindow, now_minutes: f64) -> ResolvedTheme {
    let system_day = match window {
        ThemeWindow::Fixed { day } => day,
        ThemeWindow::Rises { sunrise, sunset } => is_day_by_clock(sunrise, sunset, now_minutes),
    };
    ResolvedTheme {
        system: resolve_target(&settings.system_theme, system_day),
    }
}

/// Daytime test from manual sunrise/sunset (local minutes-of-day). The window is
/// `[sunrise, sunset)`; a `sunrise >= sunset` config wraps across midnight.
fn is_day_by_clock(sunrise: f64, sunset: f64, now_minutes: f64) -> bool {
    if (sunrise - sunset).abs() < f64::EPSILON {
        // Degenerate config: no daytime window at all.
        return false;
    }
    if sunrise < sunset {
        now_minutes >= sunrise && now_minutes < sunset
    } else {
        now_minutes >= sunrise || now_minutes < sunset
    }
}

/// Parse an `"HH:MM"` string to local minutes-since-midnight, tolerating stray
/// whitespace and clamping components; unparseable input falls back to midnight.
fn parse_hhmm(value: &str) -> f64 {
    let mut parts = value.splitn(2, ':');
    let hours = parts
        .next()
        .and_then(|p| p.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 23.0);
    let minutes = parts
        .next()
        .and_then(|p| p.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 59.0);
    hours * 60.0 + minutes
}

/// Local wall clock as minutes-of-day (with seconds for sub-minute precision).
fn local_now_minutes() -> f64 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    f64::from(now.hour()) * 60.0 + f64::from(now.minute()) + f64::from(now.second()) / 60.0
}

#[cfg(windows)]
fn local_now_minutes_precise() -> f64 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    f64::from(now.hour()) * 60.0
        + f64::from(now.minute())
        + f64::from(now.second()) / 60.0
        + f64::from(now.nanosecond()) / 60_000_000_000.0
}

/// Broadcast the resolved dark flag to the renderers (a `None` target reports
/// `false` — it is not being darkened).
fn emit_changed(app: &AppHandle, resolved: ResolvedTheme) {
    if let Err(err) = (AutoDarkChangedEvent {
        system_dark: resolved.system.unwrap_or(false),
    })
    .emit(app)
    {
        log::warn!("[autodark] failed to emit autodark:changed: {err}");
    }
}

// ── Windows theme registry + WM_SETTINGCHANGE ────────────────────────────────

/// Write one Personalize theme flag. Returns `true` when the value was written.
/// The registry flag is inverted from our `dark` boolean: `1` = light, `0` =
/// dark.
#[cfg(windows)]
fn write_theme_key(name: &str, dark: bool) -> bool {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};

    const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    let value: u32 = u32::from(!dark);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(PERSONALIZE, KEY_SET_VALUE) {
        Ok(key) => key,
        // The Personalize key normally exists; create it as a fallback.
        Err(_) => match hkcu.create_subkey(PERSONALIZE) {
            Ok((key, _)) => key,
            Err(err) => {
                log::warn!("[autodark] cannot open Personalize key: {err}");
                return false;
            }
        },
    };
    match key.set_value(name, &value) {
        Ok(()) => {
            log::debug!("[autodark] {name} = {value} (dark={dark})");
            true
        }
        Err(err) => {
            log::warn!("[autodark] failed to set {name}: {err}");
            false
        }
    }
}

/// Read a Personalize theme flag back as "is it dark?" (`1` = light → `false`).
/// `None` when the key/value is missing or unreadable, which the caller treats as
/// "unknown, so write it".
#[cfg(windows)]
fn read_theme_key(name: &str) -> Option<bool> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    let value: u32 = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(PERSONALIZE)
        .ok()?
        .get_value(name)
        .ok()?;
    Some(value == 0)
}

#[cfg(not(windows))]
fn read_theme_key(name: &str) -> Option<bool> {
    let _ = name;
    None
}

/// Notify running apps that the theme changed so they re-read it.
#[cfg(windows)]
fn broadcast_theme_change() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };

    let param: Vec<u16> = "ImmersiveColorSet\0".encode_utf16().collect();
    let mut result: usize = 0;
    // SAFETY: broadcasting the documented theme-change notification with a valid
    // null-terminated wide string kept alive for the call; the result is unused.
    unsafe {
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(param.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            100,
            Some(&mut result),
        );
    }
}

#[cfg(not(windows))]
fn write_theme_key(name: &str, dark: bool) -> bool {
    let _ = (name, dark);
    false
}

#[cfg(not(windows))]
fn broadcast_theme_change() {}

// ── Taskbar transparency (best-effort, undocumented accent policy) ───────────

/// Last taskbar-transparency intent we asserted, so it is restored exactly once.
#[cfg(windows)]
static LAST_TASKBAR: Mutex<bool> = Mutex::new(false);

/// Guards the one-time "unavailable" warning so repeated callbacks don't spam.
#[cfg(windows)]
static TASKBAR_WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The undocumented ACCENT policy struct (`ACCENT_POLICY`) — declared locally as
/// there is no typed binding for it.
#[cfg(windows)]
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
#[repr(C)]
struct AccentPolicy {
    accent_state: u32,
    accent_flags: u32,
    gradient_color: u32,
    animation_id: u32,
}

/// The taskbar's accent policy as it was BEFORE we first overrode it, captured on
/// the off→on edge and re-applied verbatim on the on→off edge.
///
/// This exists because there is no "un-set" for `SetWindowCompositionAttribute`:
/// synthesising an `ACCENT_DISABLED` policy does NOT hand the taskbar back to the
/// shell, it pins it to an opaque black bar (with `gradient_color: 0`). The only
/// safe restore is the exact struct we read out beforehand.
#[cfg(windows)]
static ORIGINAL_ACCENT: Mutex<Option<AccentPolicy>> = Mutex::new(None);

/// The undocumented `WINDOWCOMPOSITIONATTRIBDATA` wrapper for
/// `SetWindowCompositionAttribute`.
#[cfg(windows)]
#[repr(C)]
struct WindowCompositionAttributeData {
    attribute: u32,
    data: *mut core::ffi::c_void,
    size_of_data: usize,
}

#[cfg(windows)]
type SetWindowCompositionAttributeFn = unsafe extern "system" fn(
    windows::Win32::Foundation::HWND,
    *mut WindowCompositionAttributeData,
) -> windows::core::BOOL;

#[cfg(windows)]
type GetWindowCompositionAttributeFn = unsafe extern "system" fn(
    windows::Win32::Foundation::HWND,
    *mut WindowCompositionAttributeData,
) -> windows::core::BOOL;

/// `WCA_ACCENT_POLICY`.
#[cfg(windows)]
const WCA_ACCENT_POLICY: u32 = 19;
/// `ACCENT_ENABLE_TRANSPARENTGRADIENT` — the see-through taskbar effect.
#[cfg(windows)]
const ACCENT_ENABLE_TRANSPARENTGRADIENT: u32 = 2;

/// Assert or clear the taskbar effect. When enabled it is (re-)applied every call
/// so an Explorer restart callback repairs the recreated taskbar; the restore
/// runs only on the on→off edge.
///
/// The off path re-applies [`ORIGINAL_ACCENT`] — the policy captured before the
/// first override. If the capture failed we deliberately leave the taskbar ALONE
/// rather than guessing a policy: an unwanted transparent taskbar is a cosmetic
/// annoyance the user can clear by restarting Explorer, whereas guessing produces
/// an opaque black bar that looks like permanent damage.
#[cfg(windows)]
fn apply_taskbar(enabled: bool) {
    // Once shutdown has restored the taskbar, never re-apply the effect — a late
    // apply_now() from the still-running scheduler must not outlive the app with a
    // transparent taskbar.
    if SHUTTING_DOWN.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let mut last = LAST_TASKBAR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Close the check-before-lock race with restore_on_exit(): a worker may
    // have observed `false` and then blocked while shutdown restored the taskbar.
    if SHUTTING_DOWN.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if enabled {
        capture_original_accent();
        set_taskbar_accent(ACCENT_ENABLE_TRANSPARENTGRADIENT);
        *last = true;
    } else if *last {
        restore_original_accent();
        *last = false;
    }
}

/// Read the taskbar's current accent policy once, before the first override.
///
/// Explorer restarts spawn a fresh `Shell_TrayWnd` whose policy is the pristine
/// shell default, so the first capture stays valid for the process lifetime — and
/// re-capturing later would risk latching OUR OWN transparent policy as the
/// "original", which is exactly how a restore turns into a no-op.
#[cfg(windows)]
fn capture_original_accent() {
    let mut original = ORIGINAL_ACCENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if original.is_some() {
        return;
    }
    *original = get_taskbar_accent();
    match *original {
        // Mirror the capture to the recovery journal: this policy is the ONLY
        // way to hand the taskbar back to the shell, and a force-kill would
        // otherwise lose it (leaving a transparent taskbar until the user
        // restarts Explorer). See `crate::session_guard`.
        Some(policy) => crate::session_guard::record_taskbar_accent([
            policy.accent_state,
            policy.accent_flags,
            policy.gradient_color,
            policy.animation_id,
        ]),
        None => log::warn!(
            "[autodark] could not read the taskbar accent policy; transparency will not be \
             auto-restored when toggled off (restart Explorer to clear it)"
        ),
    }
}

/// Seed [`ORIGINAL_ACCENT`] from a journal left by a run that did not shut down
/// cleanly, and hand the taskbar straight back to the shell.
///
/// Without this the next `capture_original_accent` would read the stranded
/// TRANSPARENT policy and latch it as the "original" — turning every later
/// restore into a no-op, exactly the bug the capture-once rule above guards
/// against within a single run.
#[cfg(windows)]
pub(crate) fn recover_taskbar_accent(policy: [u32; 4]) {
    let recovered = AccentPolicy {
        accent_state: policy[0],
        accent_flags: policy[1],
        gradient_color: policy[2],
        animation_id: policy[3],
    };
    *ORIGINAL_ACCENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(recovered);
    set_taskbar_policy(recovered);
    log::info!("[autodark] restored the taskbar accent stranded by an unclean shutdown");
}

#[cfg(not(windows))]
pub(crate) fn recover_taskbar_accent(_policy: [u32; 4]) {}

/// Re-apply the captured pre-override accent policy. No-op when nothing was
/// captured — see [`apply_taskbar`] for why guessing is worse than doing nothing.
#[cfg(windows)]
fn restore_original_accent() {
    let original = *ORIGINAL_ACCENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(policy) = original else {
        return;
    };
    set_taskbar_policy(policy);
}

#[cfg(not(windows))]
fn apply_taskbar(enabled: bool) {
    let _ = enabled;
}

/// Resolve `SetWindowCompositionAttribute` from user32 (undocumented, so it is
/// looked up by name rather than linked). `None` when the export is missing.
#[cfg(windows)]
fn composition_attr_fn() -> Option<SetWindowCompositionAttributeFn> {
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::core::{s, w};
    // SAFETY: user32 is always mapped in a GUI process; GetProcAddress yields
    // None when the undocumented export is absent, which the caller handles.
    unsafe {
        let module = GetModuleHandleW(w!("user32.dll")).ok()?;
        let proc = GetProcAddress(module, s!("SetWindowCompositionAttribute"))?;
        Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            SetWindowCompositionAttributeFn,
        >(proc))
    }
}

/// Resolve `GetWindowCompositionAttribute` from user32 (undocumented, same as its
/// setter counterpart). `None` when the export is missing.
#[cfg(windows)]
fn get_composition_attr_fn() -> Option<GetWindowCompositionAttributeFn> {
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::core::{s, w};
    // SAFETY: user32 is always mapped in a GUI process; GetProcAddress yields
    // None when the undocumented export is absent, which the caller handles.
    unsafe {
        let module = GetModuleHandleW(w!("user32.dll")).ok()?;
        let proc = GetProcAddress(module, s!("GetWindowCompositionAttribute"))?;
        Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            GetWindowCompositionAttributeFn,
        >(proc))
    }
}

/// The primary taskbar window handle (`Shell_TrayWnd`), or a null handle.
#[cfg(windows)]
fn find_taskbar() -> windows::Win32::Foundation::HWND {
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    use windows::core::{PCWSTR, w};
    // SAFETY: querying a well-known shell window class; a null handle (handled by
    // the caller) is returned when the taskbar isn't present.
    unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).unwrap_or_default() }
}

/// Apply an accent STATE to the taskbar, leaving the other policy fields zeroed.
/// Used for the transparency effect itself.
#[cfg(windows)]
fn set_taskbar_accent(accent_state: u32) {
    set_taskbar_policy(AccentPolicy {
        accent_state,
        ..AccentPolicy::default()
    });
}

/// Apply a full accent policy to the taskbar via `SetWindowCompositionAttribute`.
/// Best-effort: silently no-ops (logging once) when the API or taskbar is
/// unavailable.
#[cfg(windows)]
fn set_taskbar_policy(policy: AccentPolicy) {
    let hwnd = find_taskbar();
    if hwnd.0.is_null() {
        return;
    }
    let Some(set_attr) = composition_attr_fn() else {
        if !TASKBAR_WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            log::warn!(
                "[autodark] SetWindowCompositionAttribute unavailable; taskbar transparency disabled"
            );
        }
        return;
    };
    let mut policy = policy;
    let mut data = WindowCompositionAttributeData {
        attribute: WCA_ACCENT_POLICY,
        data: core::ptr::addr_of_mut!(policy).cast(),
        size_of_data: std::mem::size_of::<AccentPolicy>(),
    };
    // SAFETY: `data` points at a live, correctly-sized accent policy for the
    // duration of the call; the undocumented API returns a BOOL we ignore.
    unsafe {
        let _ = set_attr(hwnd, &mut data);
    }
}

/// Read the taskbar's current accent policy via `GetWindowCompositionAttribute`.
/// `None` when the taskbar, the export, or the call itself is unavailable — the
/// caller must treat that as "restore is impossible" rather than substituting a
/// default.
#[cfg(windows)]
fn get_taskbar_accent() -> Option<AccentPolicy> {
    let hwnd = find_taskbar();
    if hwnd.0.is_null() {
        return None;
    }
    let get_attr = get_composition_attr_fn()?;
    let mut policy = AccentPolicy::default();
    let mut data = WindowCompositionAttributeData {
        attribute: WCA_ACCENT_POLICY,
        data: core::ptr::addr_of_mut!(policy).cast(),
        size_of_data: std::mem::size_of::<AccentPolicy>(),
    };
    // SAFETY: `data` points at a live, correctly-sized accent policy the callee
    // fills in; a FALSE return means it wrote nothing, which we surface as None.
    let ok = unsafe { get_attr(hwnd, &mut data) };
    ok.as_bool().then_some(policy)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A settings snapshot on its OWN window — the shared day/night schedule
    /// needs a live `AppHandle`, so the pure resolver is exercised through
    /// [`own_window`] and the sharing itself is covered by
    /// `shared_window_overrides_the_sections_own_pair` below.
    fn settings(system: &str) -> AutoDarkSettings {
        AutoDarkSettings {
            system_theme: system.to_string(),
            use_day_night_schedule: false,
            system_sunrise: "07:00".to_string(),
            system_sunset: "19:00".to_string(),
            taskbar_transparent: false,
        }
    }

    #[test]
    fn fixed_targets_ignore_day_phase() {
        assert_eq!(resolve_target("light", true), Some(false));
        assert_eq!(resolve_target("light", false), Some(false));
        assert_eq!(resolve_target("dark", true), Some(true));
        assert_eq!(resolve_target("dark", false), Some(true));
    }

    #[test]
    fn auto_follows_day_phase() {
        // Day → light, night → dark.
        assert_eq!(resolve_target("auto", true), Some(false));
        assert_eq!(resolve_target("auto", false), Some(true));
    }

    #[test]
    fn disable_and_unknown_leave_target_untouched() {
        assert_eq!(resolve_target("disable", true), None);
        assert_eq!(resolve_target("disable", false), None);
        assert_eq!(resolve_target("bogus", true), None);
    }

    /// Resolve a snapshot against whichever window its own settings imply.
    fn resolve_own(settings: &AutoDarkSettings, now_minutes: f64) -> ResolvedTheme {
        resolve(settings, own_window(settings), now_minutes)
    }

    #[test]
    fn resolve_maps_the_system_target() {
        // Default 07:00..19:00 window.
        const NOON: f64 = 720.0; // day
        const ONE_AM: f64 = 60.0; // night
        assert_eq!(
            resolve_own(&settings("auto"), NOON),
            ResolvedTheme {
                system: Some(false),
            }
        );
        assert_eq!(
            resolve_own(&settings("auto"), ONE_AM),
            ResolvedTheme { system: Some(true) }
        );
        assert_eq!(
            resolve_own(&settings("light"), ONE_AM),
            ResolvedTheme {
                system: Some(false),
            }
        );
        assert_eq!(
            resolve_own(&settings("disable"), ONE_AM),
            ResolvedTheme { system: None }
        );
    }

    #[test]
    fn resolve_uses_the_system_targets_own_sunrise_sunset() {
        // Sunset at 22:00 means 20:00 is still "day" → light, even though the
        // default 19:00 window would have flipped it to dark by then.
        let mut auto = settings("auto");
        auto.system_sunrise = "06:00".to_string();
        auto.system_sunset = "22:00".to_string();
        let eight_pm = 20.0 * 60.0;
        assert_eq!(
            resolve_own(&auto, eight_pm),
            ResolvedTheme {
                system: Some(false),
            }
        );
    }

    #[test]
    fn shared_window_overrides_the_sections_own_pair() {
        // The whole point of `use_day_night_schedule`: the day/night section's
        // boundaries decide, and this section's HH:MM pair stops mattering.
        let auto = settings("auto");
        let shared = ThemeWindow::Rises {
            sunrise: 6.0 * 60.0,
            sunset: 22.0 * 60.0,
        };
        let eight_pm = 20.0 * 60.0;
        // 20:00 is night on the own 07:00..19:00 pair, day on the shared one.
        assert_eq!(
            resolve_own(&auto, eight_pm),
            ResolvedTheme { system: Some(true) }
        );
        assert_eq!(
            resolve(&auto, shared, eight_pm),
            ResolvedTheme {
                system: Some(false),
            }
        );
    }

    #[test]
    fn a_polar_window_pins_the_theme_without_a_boundary() {
        let auto = settings("auto");
        // Polar day → light all "day"; polar night → dark, whatever the clock says.
        assert_eq!(
            resolve(&auto, ThemeWindow::Fixed { day: true }, 60.0),
            ResolvedTheme {
                system: Some(false),
            }
        );
        assert_eq!(
            resolve(&auto, ThemeWindow::Fixed { day: false }, 720.0),
            ResolvedTheme { system: Some(true) }
        );
    }

    #[test]
    fn opting_out_of_the_shared_schedule_keeps_the_own_window() {
        // `effective_window` needs no AppHandle on this branch, so it is
        // directly testable: opted out ⇒ exactly the section's own pair.
        let mut auto = settings("auto");
        auto.system_sunrise = "05:30".to_string();
        auto.system_sunset = "21:15".to_string();
        assert_eq!(
            effective_window(&auto),
            ThemeWindow::Rises {
                sunrise: 5.0 * 60.0 + 30.0,
                sunset: 21.0 * 60.0 + 15.0,
            }
        );
    }

    #[test]
    fn parse_hhmm_is_robust() {
        assert_eq!(parse_hhmm("07:00"), 420.0);
        assert_eq!(parse_hhmm("19:30"), 1170.0);
        assert_eq!(parse_hhmm("  06:45 "), 405.0);
        assert_eq!(parse_hhmm("garbage"), 0.0);
        assert_eq!(parse_hhmm("30:99"), 23.0 * 60.0 + 59.0);
    }

    #[test]
    fn clock_day_window_is_between_sunrise_and_sunset() {
        // 07:00..19:00 window.
        assert!(is_day_by_clock(420.0, 1140.0, 720.0)); // noon → day
        assert!(!is_day_by_clock(420.0, 1140.0, 60.0)); // 01:00 → night
        assert!(is_day_by_clock(420.0, 1140.0, 420.0)); // at sunrise → day
        assert!(!is_day_by_clock(420.0, 1140.0, 1140.0)); // at sunset → night
    }

    #[test]
    fn clock_window_can_wrap_midnight() {
        // Odd config: sunrise 20:00, sunset 06:00 → "day" spans the night.
        assert!(is_day_by_clock(1200.0, 360.0, 1300.0)); // 21:40 → day
        assert!(is_day_by_clock(1200.0, 360.0, 120.0)); // 02:00 → day
        assert!(!is_day_by_clock(1200.0, 360.0, 720.0)); // noon → night
    }

    #[test]
    fn degenerate_clock_window_is_never_day() {
        assert!(!is_day_by_clock(420.0, 420.0, 720.0));
    }

    #[test]
    fn theme_deadline_also_wakes_at_the_date_rollover() {
        // Polar day/night has no boundary to wait for, so the only thing that
        // changes the answer is the date — and the shared schedule recomputes
        // its astronomy per date.
        assert_eq!(
            until_next_local_midnight(1380.0),
            Duration::from_secs(60 * 60)
        );
        // Never a zero-length sleep: a scheduler that wakes instantly at 23:59:59.9
        // would spin until the clock rolled over.
        assert!(until_next_local_midnight(1440.0) > Duration::ZERO);
    }

    #[test]
    fn theme_deadline_targets_the_next_sun_boundary() {
        assert_eq!(
            duration_until_next_boundary(420.0, 1140.0, 360.0),
            Duration::from_secs(60 * 60)
        );
        assert_eq!(
            duration_until_next_boundary(420.0, 1140.0, 720.0),
            Duration::from_secs(7 * 60 * 60)
        );
        assert_eq!(
            duration_until_next_boundary(420.0, 1140.0, 1200.0),
            Duration::from_secs(11 * 60 * 60)
        );
    }
}
