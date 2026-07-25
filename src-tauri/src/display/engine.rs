//! The display engine — the orchestrator every other display concern funnels
//! through. This is the STABLE SEAM; keep the public function signatures below
//! stable.
//!
//! ## Public API (stable seam)
//! - [`init`] — capture each monitor's original gamma ramp, then apply the
//!   persisted settings once. Called from `lib.rs` setup.
//! - [`refresh`] — recompute the target output from `settings.display` +
//!   the active rule override + [`scheduler::day_factor`] and apply it to every
//!   monitor. Call after any settings/override change.
//! - [`set_rule_override`] — force a mode id or clear it (`None`); implies a
//!   [`refresh`].
//! - [`current_output`] — the last applied [`DisplayOutput`] (Kelvin / brightness
//!   percent / mode id / phase) for the UI badge + `display_current`.
//! - [`preview`] / [`clear_preview`] — live slider-drag: apply raw Kelvin/
//!   brightness to one monitor (or all) without persisting; `clear_preview`
//!   reverts to the real settings-driven output.
//! - [`restore_all`] — put every monitor's original ramp back and clear
//!   grayscale. Called on app exit and whenever the mode is `pause`. Reports
//!   whether every ramp write succeeded, so the exit teardown can keep the
//!   recovery journal when a monitor could not be restored.
//!
//! ## Behaviour
//! - Per-monitor: `settings.display.sync_monitors` applies one value everywhere;
//!   otherwise `settings.display.monitor_overrides[id]` per monitor (falling back
//!   to the active mode preset when a monitor has no override).
//! - Day/night: each preset carries `*_day` / `*_night` values; the engine
//!   interpolates them by [`scheduler::day_factor`].
//! - Editing mode inverts the ramp; Reading mode engages full-screen grayscale;
//!   `pause` restores original ramps (no filtering).
//! - `settings.display.smooth_transition` animates ramp changes over ~400 ms in a
//!   worker thread ([`TRANSITION_GEN`] cancels a superseded animation).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event as _;

use super::gamma::{self, GammaRamp};
use super::grayscale;
use super::monitors::{self, MonitorInfo};
use super::scheduler;
use super::values::DisplayPhase;
use crate::events::{DisplayStateEvent, DisplayTopologyEvent};
use crate::settings::{AppSettings, ModePreset};

/// The engine's current output, surfaced to the UI badge, `display_current`, and
/// the `display:state` event. `brightness` is a percentage (0..=100).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DisplayOutput {
    pub kelvin: u32,
    pub brightness: u32,
    pub mode: String,
    pub phase: String,
    /// True only when Reading mode's compositor-wide grayscale matrix was
    /// successfully installed. Other Reading-mode adjustments may still be
    /// active when this is false.
    pub grayscale_applied: bool,
}

impl Default for DisplayOutput {
    fn default() -> Self {
        Self {
            kelvin: 6500,
            brightness: 100,
            mode: "pause".into(),
            phase: "day".into(),
            grayscale_applied: false,
        }
    }
}

/// Fallback preset for an unknown/missing mode id (neutral-ish custom).
const FALLBACK_PRESET: ModePreset = ModePreset {
    kelvin_day: 5500,
    kelvin_night: 5500,
    brightness_day: 90,
    brightness_night: 90,
};

struct EngineState {
    app: AppHandle,
    /// Original ramp per durable native display id, snapshotted at [`init`] and
    /// mirrored to the [`crate::session_guard`] journal for unclean-shutdown recovery.
    /// `BTreeMap` so the journal it serializes into has a stable key order.
    originals: BTreeMap<String, OriginalRamp>,
    /// Last applied scalar per device (`kelvin`, `brightness_0_1`) — the START of
    /// the next smooth transition.
    applied: HashMap<String, (f64, f64)>,
    /// Rule-engine forced mode id; `None` = follow settings.
    rule_override: Option<String>,
    /// True while a full-screen app is foreground and `disable_on_fullscreen` is
    /// set — filtering is suspended (originals restored) until it leaves
    /// (FEATURE-PARITY F1.11). Driven by the rules watcher.
    fullscreen_suspend: bool,
    /// True while a live slider-drag preview owns the screen (`refresh` yields to
    /// it until `clear_preview`).
    previewing: bool,
    /// Last applied output (for `current_output`).
    last: DisplayOutput,
}

#[derive(Clone, Debug)]
enum OriginalRamp {
    /// Native APIs where DimRead must write the captured LUT back explicitly.
    Captured(Box<GammaRamp>),
    /// Wayland gamma-control: destroying the live control makes the compositor
    /// restore the exact state it captured when the control was created.
    CompositorManaged,
}

fn journal_originals(originals: &BTreeMap<String, OriginalRamp>) -> BTreeMap<String, GammaRamp> {
    originals
        .iter()
        .filter_map(|(device, original)| match original {
            OriginalRamp::Captured(ramp) => Some((device.clone(), **ramp)),
            OriginalRamp::CompositorManaged => None,
        })
        .collect()
}

static ENGINE: Mutex<Option<EngineState>> = Mutex::new(None);

/// Monotonic transition generation — bumped on every apply so an in-flight
/// smooth animation cancels itself when a newer one starts.
static TRANSITION_GEN: AtomicU64 = AtomicU64::new(0);

/// Latched before exit restoration so late scheduler/WinEvent callbacks cannot
/// start a fresh gamma transition after the original ramps are restored.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Coalescing signal for native hot-plug/reconfiguration callbacks. Native
/// callbacks must return promptly, so they only enqueue a wake; the worker does
/// enumeration, original-ramp capture, journalling, and re-application.
static TOPOLOGY_TX: OnceLock<SyncSender<()>> = OnceLock::new();

/// Serializes every native display-ramp write against the smooth-transition
/// worker. The generation check alone is check-then-write: the worker could
/// pass its check, lose the CPU, and land one more dimmed frame AFTER
/// [`restore_ramps`] put the originals back — on the exit path that strands the
/// filter on the display with the recovery journal already cleared, and the
/// next boot launders the dim into its captured "originals". Writers hold this
/// lock around {generation check + ramp writes}; the bump in [`restore_ramps`]/
/// [`preview`] happens under the same lock, so no stale write can follow it.
/// Lock order: `ENGINE` (optional) → `RAMP_WRITE`; the worker takes only
/// `RAMP_WRITE`, so there is no inversion.
static RAMP_WRITE: Mutex<()> = Mutex::new(());

fn lock_ramp_write() -> std::sync::MutexGuard<'static, ()> {
    RAMP_WRITE.lock().unwrap_or_else(|p| p.into_inner())
}

fn with_state<R>(f: impl FnOnce(&mut EngineState) -> R) -> Option<R> {
    let mut guard = ENGINE.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_mut().map(f)
}

/// One monitor's gamma target for an apply pass.
struct Target {
    device: String,
    from_kelvin: f64,
    from_brightness: f64,
    to_kelvin: f64,
    to_brightness: f64,
    invert: bool,
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn preset_for<'a>(settings: &'a AppSettings, mode: &str) -> &'a ModePreset {
    settings.display.modes.get(mode).unwrap_or(&FALLBACK_PRESET)
}

/// Interpolate a preset's day/night endpoints by `factor` (0=night, 1=day).
/// Returns `(kelvin, brightness_percent)`.
fn interpolate(preset: &ModePreset, factor: f64) -> (f64, f64) {
    let kelvin = lerp(preset.kelvin_night as f64, preset.kelvin_day as f64, factor);
    let brightness = lerp(
        preset.brightness_night as f64,
        preset.brightness_day as f64,
        factor,
    );
    (kelvin, brightness)
}

/// Snapshot original ramps and apply the persisted settings once.
///
/// `stale` is the [`crate::session_guard`] journal from a previous run that did
/// NOT shut down cleanly (`None` on a normal boot). When present, each monitor
/// is put back BEFORE its ramp is read, because a force-kill leaves our own
/// filter on the device and reading it here would launder that tint into the
/// new "original" — making it unremovable, and compounding on every crash.
pub fn init(app: &AppHandle, stale: Option<&crate::session_guard::SessionJournal>) {
    let monitors = monitors::enumerate();
    let mut originals = BTreeMap::new();
    for m in &monitors {
        if gamma::compositor_managed(&m.id) {
            originals.insert(m.id.clone(), OriginalRamp::CompositorManaged);
            continue;
        }
        let candidate = match stale {
            // Clean boot: whatever is on the device IS the original.
            None => gamma::read_ramp(&m.id).unwrap_or_else(gamma::identity),
            // Unclean boot. Prefer the ramp the dead run recorded; if it
            // recorded none for this monitor (hot-plugged since, or a
            // corrupt journal) fall back to identity rather than trusting
            // the device — identity is at worst a lost custom calibration,
            // whereas trusting it can mean a permanently dim screen.
            Some(journal) => {
                crate::session_guard::recover_ramp(journal, &m.id).unwrap_or_else(gamma::identity)
            }
        };
        // Last line of defence for the paths the journal cannot cover (a kill
        // in the restore-then-clear gap, a failed exit restore on an older
        // build): a candidate "original" that is itself a brightness-cut ramp
        // is a stranded filter, not the monitor's true state. Capturing it
        // would make `pause` restore a dim screen forever.
        let ramp = if gamma::plausible_original(&candidate) {
            candidate
        } else {
            log::warn!(
                "[display] ramp captured for {} looks like a stranded filter (peak far below full scale) - using identity as its original",
                m.id
            );
            gamma::identity()
        };
        if stale.is_some() {
            gamma::apply_ramp(&m.id, &ramp);
        }
        originals.insert(m.id.clone(), OriginalRamp::Captured(Box::new(ramp)));
    }
    if stale.is_some() {
        // Reading mode's full-screen colour effect is process-scoped, but clear
        // it unconditionally where supported so a recovered session starts from
        // a known compositor state.
        let _ = grayscale::force_clear();
    }

    // From here on this process can strand a filter on the display, so publish
    // the originals where the NEXT boot can find them if we never get to run
    // our teardown.
    crate::session_guard::record_gamma_originals(&journal_originals(&originals));
    {
        let mut guard = ENGINE.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(EngineState {
            app: app.clone(),
            originals,
            applied: HashMap::new(),
            rule_override: None,
            fullscreen_suspend: false,
            previewing: false,
            last: DisplayOutput::default(),
        });
    }
    log::debug!(
        "[display] engine initialized ({} monitor(s))",
        monitors.len()
    );
    start_topology_worker();
    refresh();
}

fn start_topology_worker() {
    if TOPOLOGY_TX.get().is_some() {
        return;
    }
    let (tx, rx) = mpsc::sync_channel(1);
    if TOPOLOGY_TX.set(tx).is_err() {
        return;
    }
    if let Err(err) = std::thread::Builder::new()
        .name("display-topology".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                if SHUTTING_DOWN.load(Ordering::Acquire) {
                    return;
                }
                reconcile_topology();
            }
        })
    {
        log::warn!("[display] failed to start topology worker: {err}");
        return;
    }
    if !monitors::start_topology_listener(notify_topology_change) {
        log::warn!("[display] native display-topology listener is unavailable");
    }
}

/// Native callbacks call this lightweight seam; duplicate notifications are
/// coalesced by the capacity-one channel instead of triggering concurrent I/O.
pub(crate) fn notify_topology_change() {
    if let Some(tx) = TOPOLOGY_TX.get() {
        match tx.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) => {}
            Err(TrySendError::Disconnected(())) => {
                // Resource exhaustion can make the long-lived worker fail to
                // start. Preserve correctness with a bounded one-shot worker
                // rather than dropping every future native notification.
                if let Err(err) = std::thread::Builder::new()
                    .name("display-topology-fallback".into())
                    .spawn(reconcile_topology)
                {
                    log::warn!("[display] failed to start fallback topology reconcile: {err}");
                }
            }
        }
    }
}

fn reconcile_topology() {
    let monitors = monitors::enumerate();
    let current_ids: HashSet<String> = monitors.iter().map(|monitor| monitor.id.clone()).collect();
    let mut originals_changed = false;
    let mut app = None;
    let mut journal_snapshot = None;

    with_state(|state| {
        app = Some(state.app.clone());
        let _io = lock_ramp_write();
        TRANSITION_GEN.fetch_add(1, Ordering::SeqCst);
        state
            .applied
            .retain(|device, _| current_ids.contains(device));

        let removed: Vec<String> = state
            .originals
            .keys()
            .filter(|device| !current_ids.contains(*device))
            .cloned()
            .collect();
        for device in removed {
            state.originals.remove(&device);
            gamma::forget_device(&device);
            originals_changed = true;
        }

        for monitor in &monitors {
            if state.originals.contains_key(&monitor.id) {
                continue;
            }
            let original = if gamma::compositor_managed(&monitor.id) {
                OriginalRamp::CompositorManaged
            } else {
                OriginalRamp::Captured(Box::new(gamma::read_ramp(&monitor.id).unwrap_or_else(
                    || {
                        log::warn!(
                            "[display] could not capture original ramp for newly connected {}; using identity",
                            monitor.id
                        );
                        gamma::identity()
                    },
                )))
            };
            state.originals.insert(monitor.id.clone(), original);
            originals_changed = true;
        }
        if originals_changed {
            journal_snapshot = Some(journal_originals(&state.originals));
        }
    });

    if let Some(originals) = journal_snapshot {
        crate::session_guard::record_gamma_originals(&originals);
    }
    if let Some(app) = app {
        if let Err(err) = DisplayTopologyEvent(monitors).emit(&app) {
            log::warn!("[display] failed to emit display:topology: {err}");
        }
        // Re-apply even for disconnect-only changes so no stale per-monitor
        // target remains and every connected output reflects current settings.
        refresh();
    }
}

/// Recompute and apply the settings-driven output to every monitor.
pub fn refresh() {
    if SHUTTING_DOWN.load(Ordering::Acquire) {
        return;
    }
    with_state(|state| {
        let phase = scheduler::current_phase();
        // A live preview owns the gamma output until it is cleared, but the
        // renderer must still hear a real schedule-boundary phase change. That
        // lets an implicit transition preview end at sunrise/sunset instead of
        // pinning the selected endpoint forever.
        if state.previewing {
            let phase = phase.as_str();
            if state.last.phase != phase {
                state.last.phase = phase.to_string();
                emit_state(&state.app, &state.last);
            }
            return;
        }
        let settings = crate::settings::store::read_settings(&state.app);
        let display = &settings.display;
        let mode = state
            .rule_override
            .clone()
            .unwrap_or_else(|| display.mode.clone());

        let factor = scheduler::day_factor() as f64;
        let monitors = monitors::enumerate();

        let preset = preset_for(&settings, &mode);
        let (base_kelvin, base_brightness) = interpolate(preset, factor);

        // A full-screen app is foreground (F1.11) — suspend filtering entirely,
        // exactly like `pause`, until it leaves. The badge still reports the
        // selected mode so the UI state is unchanged when filtering resumes.
        if state.fullscreen_suspend {
            restore_ramps(state);
            grayscale::set_enabled(false);
            let out = DisplayOutput {
                kelvin: base_kelvin.round() as u32,
                brightness: base_brightness.round() as u32,
                mode,
                phase: phase.as_str().to_string(),
                grayscale_applied: false,
            };
            state.last = out.clone();
            emit_state(&state.app, &out);
            return;
        }

        // `pause` = no filtering: restore originals and clear grayscale.
        if mode == "pause" {
            restore_ramps(state);
            grayscale::set_enabled(false);
            let out = DisplayOutput {
                kelvin: base_kelvin.round() as u32,
                brightness: base_brightness.round() as u32,
                mode,
                phase: phase.as_str().to_string(),
                grayscale_applied: false,
            };
            state.last = out.clone();
            emit_state(&state.app, &out);
            return;
        }

        let invert = mode == "editing";
        let grayscale_on = mode == "reading";

        // Start point for a monitor with no `applied` entry (first apply after
        // boot, or leaving `pause`/fullscreen-suspend, which restore originals
        // and clear the map): the engine's last REPORTED output — in `pause`
        // that is the undimmed passthrough actually on screen — so the smooth
        // transition animates from what the user sees. Same fallback `preview`
        // uses. NB `applied` stores brightness as a 0..=1 fraction while the
        // interpolated `base_brightness` is a percent; falling back to the
        // percent kept the ramp clamped at full brightness for nearly the whole
        // animation and then snapped, seen as a second, separate dim step.
        let last_applied = (
            f64::from(state.last.kelvin),
            f64::from(state.last.brightness) / 100.0,
        );
        let mut targets = Vec::with_capacity(monitors.len().max(1));
        for m in &monitors {
            let (to_kelvin, to_brightness_pct) = if display.sync_monitors {
                (base_kelvin, base_brightness)
            } else if let Some(ov) = display.monitor_overrides.get(&m.id) {
                let ovp = ModePreset {
                    kelvin_day: ov.kelvin_day,
                    kelvin_night: ov.kelvin_night,
                    brightness_day: ov.brightness_day,
                    brightness_night: ov.brightness_night,
                };
                interpolate(&ovp, factor)
            } else {
                (base_kelvin, base_brightness)
            };
            let (from_kelvin, from_brightness) =
                state.applied.get(&m.id).copied().unwrap_or(last_applied);
            targets.push(Target {
                device: m.id.clone(),
                from_kelvin,
                from_brightness,
                to_kelvin,
                to_brightness: to_brightness_pct / 100.0,
                invert,
            });
        }

        for t in &targets {
            state
                .applied
                .insert(t.device.clone(), (t.to_kelvin, t.to_brightness));
        }
        let grayscale_applied = grayscale_on && grayscale::set_enabled(true);
        if !grayscale_on {
            let _ = grayscale::set_enabled(false);
        }
        apply_targets(targets, display.smooth_transition);

        let out = DisplayOutput {
            kelvin: base_kelvin.round() as u32,
            brightness: base_brightness.round() as u32,
            mode,
            phase: phase.as_str().to_string(),
            grayscale_applied,
        };
        state.last = out.clone();
        emit_state(&state.app, &out);
    });
}

/// Prevent all future callback-driven refreshes. Called before exit restores
/// the original monitor ramps; idempotent for the process lifetime.
pub(crate) fn begin_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::Release);
}

/// Force a mode id or clear it (`None`); re-applies.
pub fn set_rule_override(mode: Option<String>) {
    with_state(|state| state.rule_override = mode);
    refresh();
}

/// Suspend/resume filtering for a foreground full-screen app (FEATURE-PARITY
/// F1.11), driven by the rules watcher. Only re-applies when the flag actually
/// flips, so duplicate native callbacks do not thrash the gamma ramp.
pub fn set_fullscreen_suspend(suspend: bool) {
    let changed = with_state(|state| {
        if state.fullscreen_suspend == suspend {
            return false;
        }
        state.fullscreen_suspend = suspend;
        true
    })
    .unwrap_or(false);
    if changed {
        refresh();
    }
}

/// The last applied output (for the UI badge and `display_current`).
pub fn current_output() -> DisplayOutput {
    with_state(|state| state.last.clone()).unwrap_or_default()
}

/// Live slider-drag preview without persisting.
///
/// Each axis is optional: `None` means "leave that axis at what is currently
/// APPLIED on each monitor. When `endpoint_phase` is present, supplied values
/// are day/night ENDPOINT edits and are interpolated through the live schedule
/// exactly like [`refresh`]. This prevents a raw 100% drag preview from snapping
/// to (for example) 87% on release during an evening transition. `None` keeps
/// the deliberate raw off-phase preview used by the Day/Night selector.
pub fn preview(
    kelvin: Option<u32>,
    brightness: Option<u32>,
    monitor_id: Option<String>,
    endpoint_phase: Option<DisplayPhase>,
) {
    with_state(|state| {
        state.previewing = true;
        // Supersede any in-flight smooth-transition animation so it stops
        // re-applying the old interpolated ramp over this live drag. Bump and
        // write under the ramp-write lock so a worker frame that already
        // passed its generation check cannot land after this preview's writes.
        let _io = lock_ramp_write();
        TRANSITION_GEN.fetch_add(1, Ordering::SeqCst);
        // Fallback for a monitor with no applied entry (e.g. `pause` restored
        // its original ramp): the engine's last reported output, which in
        // `pause` is the undimmed passthrough the screen is actually showing.
        let last_applied = (
            f64::from(state.last.kelvin),
            f64::from(state.last.brightness) / 100.0,
        );
        let settings = crate::settings::store::read_settings(&state.app);
        let mode = state
            .rule_override
            .as_deref()
            .unwrap_or(&settings.display.mode);
        let factor = f64::from(scheduler::day_factor());
        let invert = mode == "editing";
        let monitors = monitors::enumerate();
        let mut reported = None;
        for m in &monitors {
            if monitor_id.as_deref().is_some_and(|id| id != m.id) {
                continue;
            }
            let (applied_kelvin, applied_brightness) =
                state.applied.get(&m.id).copied().unwrap_or(last_applied);
            let (to_kelvin, to_brightness) = endpoint_phase.map_or_else(
                || {
                    (
                        kelvin.map_or(applied_kelvin, f64::from),
                        brightness.map_or(applied_brightness, |value| f64::from(value) / 100.0),
                    )
                },
                |phase| {
                    preview_endpoint_output(
                        preset_for_monitor(&settings, mode, &m.id),
                        phase,
                        factor,
                        kelvin,
                        brightness,
                        applied_kelvin,
                        applied_brightness,
                    )
                },
            );
            let to_brightness = to_brightness.clamp(0.0, 1.0);
            let ramp = gamma::compose(to_kelvin, to_brightness, invert);
            gamma::apply_ramp(&m.id, &ramp);
            state
                .applied
                .insert(m.id.clone(), (to_kelvin, to_brightness));
            reported.get_or_insert((to_kelvin, to_brightness));
        }
        let (reported_kelvin, reported_brightness) = reported.unwrap_or(last_applied);
        let out = DisplayOutput {
            kelvin: reported_kelvin.round() as u32,
            brightness: (reported_brightness * 100.0).round() as u32,
            mode: state.last.mode.clone(),
            phase: state.last.phase.clone(),
            grayscale_applied: false,
        };
        state.last = out.clone();
        emit_state(&state.app, &out);
    });
}

fn preset_for_monitor(settings: &AppSettings, mode: &str, monitor_id: &str) -> ModePreset {
    if settings.display.sync_monitors {
        return *preset_for(settings, mode);
    }
    settings
        .display
        .monitor_overrides
        .get(monitor_id)
        .map_or_else(ModePreset::default, |override_| ModePreset {
            kelvin_day: override_.kelvin_day,
            kelvin_night: override_.kelvin_night,
            brightness_day: override_.brightness_day,
            brightness_night: override_.brightness_night,
        })
}

fn preview_endpoint_output(
    mut preset: ModePreset,
    phase: DisplayPhase,
    factor: f64,
    kelvin: Option<u32>,
    brightness: Option<u32>,
    applied_kelvin: f64,
    applied_brightness: f64,
) -> (f64, f64) {
    match phase {
        DisplayPhase::Day => {
            if let Some(value) = kelvin {
                preset.kelvin_day = value;
            }
            if let Some(value) = brightness {
                preset.brightness_day = value;
            }
        }
        DisplayPhase::Night => {
            if let Some(value) = kelvin {
                preset.kelvin_night = value;
            }
            if let Some(value) = brightness {
                preset.brightness_night = value;
            }
        }
    }
    let (interpolated_kelvin, interpolated_brightness) = interpolate(&preset, factor);
    (
        kelvin.map_or(applied_kelvin, |_| interpolated_kelvin),
        brightness.map_or(applied_brightness, |_| interpolated_brightness / 100.0),
    )
}

/// End a live preview and revert to the settings-driven output.
pub fn clear_preview() {
    with_state(|state| state.previewing = false);
    refresh();
}

/// Restore every monitor's original ramp and clear grayscale. Safe to call even
/// before [`init`] (no-op). Returns `false` when at least one ramp write
/// failed — the exit teardown uses this to KEEP the recovery journal so the
/// next boot can repair what this process could not put back.
pub fn restore_all() -> bool {
    with_state(|state| {
        let restored = restore_ramps(state);
        grayscale::set_enabled(false);
        restored
    })
    .unwrap_or(true)
}

fn restore_ramps(state: &mut EngineState) -> bool {
    // Bump-then-write under the ramp-write lock: once this returns, no stale
    // smooth-transition frame can re-dim a monitor we just restored.
    let _io = lock_ramp_write();
    TRANSITION_GEN.fetch_add(1, Ordering::SeqCst);
    let mut restored = true;
    for (device, original) in &state.originals {
        restored &= match original {
            OriginalRamp::Captured(ramp) => gamma::apply_ramp(device, ramp),
            OriginalRamp::CompositorManaged => gamma::release_ramp(device),
        };
        state.applied.remove(device);
    }
    restored
}

/// Apply per-monitor targets, optionally animating over ~400 ms.
fn apply_targets(targets: Vec<Target>, smooth: bool) {
    let generation = TRANSITION_GEN.fetch_add(1, Ordering::SeqCst) + 1;

    if !smooth {
        let _io = lock_ramp_write();
        for t in &targets {
            let ramp = gamma::compose(t.to_kelvin, t.to_brightness, t.invert);
            gamma::apply_ramp(&t.device, &ramp);
        }
        return;
    }

    std::thread::spawn(move || {
        const STEPS: u32 = 24;
        const DURATION_MS: u64 = 400;
        for step in 1..=STEPS {
            {
                // Check-and-write atomically w.r.t. `restore_ramps`/`preview`:
                // both bump the generation UNDER this lock, so a frame that
                // passes the check here can never land after a restore — a
                // stale write on the exit path would re-dim the display AFTER
                // the originals were put back (and after the recovery journal
                // was cleared), poisoning the next boot's captured originals.
                let _io = lock_ramp_write();
                if TRANSITION_GEN.load(Ordering::SeqCst) != generation {
                    return; // Superseded by a newer apply — abandon this animation.
                }
                let f = step as f64 / STEPS as f64;
                for t in &targets {
                    let kelvin = lerp(t.from_kelvin, t.to_kelvin, f);
                    let brightness = lerp(t.from_brightness, t.to_brightness, f);
                    let ramp = gamma::compose(kelvin, brightness, t.invert);
                    gamma::apply_ramp(&t.device, &ramp);
                }
            }
            std::thread::sleep(Duration::from_millis(DURATION_MS / STEPS as u64));
        }
    });
}

fn emit_state(app: &AppHandle, output: &DisplayOutput) {
    if let Err(err) = DisplayStateEvent(output.clone()).emit(app) {
        log::warn!("[display] failed to emit display:state: {err}");
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// `display_list_monitors` — every physical monitor the engine can drive.
#[tauri::command]
#[specta::specta]
pub fn display_list_monitors() -> Vec<MonitorInfo> {
    monitors::enumerate()
}

/// `display_current` — the last applied output (Kelvin / brightness% / mode /
/// phase) for the real-time readout.
#[tauri::command]
#[specta::specta]
pub fn display_current() -> DisplayOutput {
    current_output()
}

/// `display_preview` — live slider-drag on one monitor (or all when
/// `monitor_id` is `None`) without persisting. `endpoint_phase` makes supplied
/// values follow the same schedule interpolation as their eventual commit;
/// `None` requests a raw off-phase preview. A `None` axis keeps that axis at
/// each monitor's currently applied value.
#[tauri::command]
#[specta::specta]
pub fn display_preview(
    kelvin: Option<u32>,
    brightness: Option<u32>,
    monitor_id: Option<String>,
    endpoint_phase: Option<DisplayPhase>,
) {
    preview(kelvin, brightness, monitor_id, endpoint_phase);
}

/// `display_preview_end` — end the live preview and revert to the settings
/// output.
#[tauri::command]
#[specta::specta]
pub fn display_preview_end() {
    clear_preview();
}

/// `display_set_value` — persist ONE colour-temperature/brightness edit.
///
/// The renderer sends the edit it wants, not a copy of the settings tree; the
/// read-modify-write happens in [`super::values::commit_edit`] under the
/// settings write lock. Every surface (Display tab, tray flyout, hotkeys) goes
/// through here, so they cannot drift apart or overwrite one another.
///
/// Returns the post-write snapshot so the releasing surface can adopt the
/// committed value in the SAME turn it drops its local drag override. Waiting
/// for the `settings:changed` broadcast instead leaves the slider rendering the
/// pre-drag value for a frame — the visible snap-back on release. This matters
/// most in `pause`, where [`super::values::apply_edit_to`] also redirects the
/// edit into `custom` and moves `display.mode`, so the renderer's copy is wrong
/// about the mode as well as the value.
#[tauri::command]
#[specta::specta]
pub fn display_set_value(
    app: AppHandle,
    edit: super::values::DisplayEdit,
) -> Result<crate::settings::commands::SettingsSnapshot, String> {
    let result = super::values::commit_edit(&app, &edit);
    if result.is_ok() {
        // The edit is stored; drop any live preview so the engine re-applies
        // from settings (this doubles as the "re-apply now" signal).
        clear_preview();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset() -> ModePreset {
        ModePreset {
            kelvin_day: 6500,
            kelvin_night: 3500,
            brightness_day: 100,
            brightness_night: 74,
        }
    }

    #[test]
    fn endpoint_preview_matches_the_output_refresh_will_apply() {
        let (kelvin, brightness) = preview_endpoint_output(
            preset(),
            DisplayPhase::Day,
            0.5,
            None,
            Some(100),
            5000.0,
            0.87,
        );
        assert_eq!(kelvin, 5000.0, "an untouched axis stays applied");
        assert_eq!(brightness, 0.87, "100/74 at 50% must preview as 87%");
    }

    #[test]
    fn endpoint_preview_interpolates_kelvin_without_moving_brightness() {
        let (kelvin, brightness) = preview_endpoint_output(
            preset(),
            DisplayPhase::Night,
            0.25,
            Some(4500),
            None,
            5750.0,
            0.805,
        );
        assert_eq!(kelvin, 5000.0);
        assert_eq!(brightness, 0.805, "an untouched axis stays applied");
    }
}
