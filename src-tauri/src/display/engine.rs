//! The display engine — the orchestrator every other display concern funnels
//! through. This is the STABLE SEAM the phase-2 agents build on; keep the public
//! function signatures below stable.
//!
//! ## Public API (stable seam)
//! - [`init`] — capture each monitor's original gamma ramp, then apply the
//!   persisted settings once. Called from `lib.rs` setup.
//! - [`refresh`] — recompute the target output from `settings.display` +
//!   the active rule override + [`scheduler::day_factor`] and apply it to every
//!   monitor. Call after any settings/override change.
//! - [`set_rule_override`] — force a mode id (Agent C's rules engine) or clear
//!   it (`None`); implies a [`refresh`].
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

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event as _;

use super::gamma::{self, GammaRamp};
use super::grayscale;
use super::monitors::{self, MonitorInfo};
use super::scheduler;
use crate::events::DisplayStateEvent;
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
}

impl Default for DisplayOutput {
    fn default() -> Self {
        Self {
            kelvin: 6500,
            brightness: 100,
            mode: "pause".into(),
            phase: "day".into(),
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
    /// Original ramp per GDI device name, snapshotted at [`init`] and mirrored
    /// to the [`crate::session_guard`] journal for unclean-shutdown recovery.
    /// `BTreeMap` so the journal it serializes into has a stable key order.
    originals: BTreeMap<String, GammaRamp>,
    /// Last applied scalar per device (`kelvin`, `brightness_0_1`) — the START of
    /// the next smooth transition.
    applied: HashMap<String, (f64, f64)>,
    /// Rule-engine forced mode id (Agent C); `None` = follow settings.
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

static ENGINE: Mutex<Option<EngineState>> = Mutex::new(None);

/// Monotonic transition generation — bumped on every apply so an in-flight
/// smooth animation cancels itself when a newer one starts.
static TRANSITION_GEN: AtomicU64 = AtomicU64::new(0);

/// Serializes every `SetDeviceGammaRamp` write against the smooth-transition
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
        originals.insert(m.id.clone(), ramp);
    }
    if stale.is_some() {
        // Reading mode's full-screen colour effect is process-scoped, but clear
        // it unconditionally: it costs one Win32 call and removes any doubt
        // about whether the Magnification runtime outlived the dead process.
        grayscale::force_clear();
    }

    // From here on this process can strand a filter on the display, so publish
    // the originals where the NEXT boot can find them if we never get to run
    // our teardown.
    crate::session_guard::record_gamma_originals(&originals);
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
    refresh();
}

/// Recompute and apply the settings-driven output to every monitor.
pub fn refresh() {
    with_state(|state| {
        // A live preview owns the screen until it is cleared.
        if state.previewing {
            return;
        }
        let settings = crate::settings::store::read_settings(&state.app);
        let display = &settings.display;
        let mode = state
            .rule_override
            .clone()
            .unwrap_or_else(|| display.mode.clone());

        let factor = scheduler::day_factor() as f64;
        let phase = scheduler::current_phase();
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
        grayscale::set_enabled(grayscale_on);
        apply_targets(targets, display.smooth_transition);

        let out = DisplayOutput {
            kelvin: base_kelvin.round() as u32,
            brightness: base_brightness.round() as u32,
            mode,
            phase: phase.as_str().to_string(),
        };
        state.last = out.clone();
        emit_state(&state.app, &out);
    });
}

/// Force a mode id (Agent C rules) or clear it (`None`); re-applies.
pub fn set_rule_override(mode: Option<String>) {
    with_state(|state| state.rule_override = mode);
    refresh();
}

/// Suspend/resume filtering for a foreground full-screen app (FEATURE-PARITY
/// F1.11), driven by the rules watcher. Only re-applies when the flag actually
/// flips, so the 700 ms poll doesn't thrash the gamma ramp.
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

/// Live slider-drag preview: apply raw Kelvin/brightness without persisting.
///
/// Each axis is optional: `None` means "leave that axis at what is currently
/// APPLIED on each monitor". A drag streams only the axis being dragged —
/// carrying the renderer's stored value for the other axis would snap the
/// screen to it whenever it diverges from the applied output (day/night
/// interpolation mid-transition, per-monitor overrides while editing all
/// monitors, a rules-forced mode), observed as brightness jumping to 100 %
/// for the duration of a colour-temperature drag.
pub fn preview(kelvin: Option<u32>, brightness: Option<u32>, monitor_id: Option<String>) {
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
        let monitors = monitors::enumerate();
        for m in &monitors {
            if monitor_id.as_deref().is_some_and(|id| id != m.id) {
                continue;
            }
            let (applied_kelvin, applied_brightness) =
                state.applied.get(&m.id).copied().unwrap_or(last_applied);
            let to_kelvin = kelvin.map_or(applied_kelvin, f64::from);
            let to_brightness = brightness
                .map_or(applied_brightness, |b| f64::from(b) / 100.0)
                .clamp(0.0, 1.0);
            let ramp = gamma::compose(to_kelvin, to_brightness, false);
            gamma::apply_ramp(&m.id, &ramp);
            state
                .applied
                .insert(m.id.clone(), (to_kelvin, to_brightness));
        }
        let out = DisplayOutput {
            kelvin: kelvin.unwrap_or(state.last.kelvin),
            brightness: brightness.unwrap_or(state.last.brightness),
            mode: state.last.mode.clone(),
            phase: state.last.phase.clone(),
        };
        state.last = out.clone();
        emit_state(&state.app, &out);
    });
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
    for (device, ramp) in &state.originals {
        restored &= gamma::apply_ramp(device, ramp);
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

/// `display_preview` — live slider-drag: apply raw Kelvin/brightness to one
/// monitor (or all when `monitor_id` is `None`) without persisting. A `None`
/// axis keeps that axis at each monitor's currently applied value.
#[tauri::command]
#[specta::specta]
pub fn display_preview(kelvin: Option<u32>, brightness: Option<u32>, monitor_id: Option<String>) {
    preview(kelvin, brightness, monitor_id);
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
