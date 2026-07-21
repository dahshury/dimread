//! Overlay notification pill: a transparent, click-through, non-focusable
//! always-on-top window docked top-center of the work area (pattern from
//! WinSTT's recording overlay, reduced to a generic notification surface).
//!
//! Flow:
//!   1. `overlay_notify(payload)` resolves the payload (tone/duration
//!      defaults + clamps), positions + shows the prewarmed hidden `overlay`
//!      window, and emits the `overlay:notify` specta event with the RESOLVED
//!      notification (so the renderer's exit timer and the Rust hide timer
//!      agree on timing).
//!   2. The renderer plays the DynamicIsland enter animation, shows the pill
//!      for `duration_ms`, then plays its exit; Rust hides the OS window at
//!      `duration_ms + OVERLAY_EXIT_GRACE_MS` so the fully-faded frame is
//!      composited before the hide (same rationale as the picker's grace).
//!   3. A new notify while one is visible REPLACES it: the sequence counter
//!      invalidates the pending hide and the renderer swaps content in place
//!      (no queue — last notification wins; documented template behavior).
//!   4. `overlay_dismiss` emits `overlay:dismiss` (renderer plays its exit
//!      now) and hides after just the grace.
//!
//! The download manager calls `notify_download_terminal` on completed/failed
//! transfers, so the pill has a real producer out of the box.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, LogicalPosition, Manager};
use tauri_specta::Event as _;

use crate::events::{OverlayDismissEvent, OverlayNotifyEvent};

/// The overlay window label (see `windows::WINDOW_SPECS`).
pub const OVERLAY_LABEL: &str = "overlay";
/// Window footprint (logical px) — matches the `WINDOW_SPECS` entry.
const OVERLAY_WIDTH: f64 = 720.0;

/// Visible-duration default + clamps (ms).
const DEFAULT_DURATION_MS: u32 = 4000;
const MIN_DURATION_MS: u32 = 1200;
const MAX_DURATION_MS: u32 = 30_000;
/// How long after the renderer's exit animation starts the OS window hides.
/// MUST exceed the renderer's close transition (160 ms `--panel-close-dur`)
/// so the fully-faded frame is composited before the hide — WebView2
/// re-presents the last composited frame on the next show.
const OVERLAY_EXIT_GRACE_MS: u64 = 400;
/// First-show race: the prewarmed webview may need a beat after `show()`
/// before its listener sees the event; duplicate notifies are idempotent
/// (the renderer replaces content in place).
const OVERLAY_NOTIFY_REEMIT_MS: &[u64] = &[75, 250];

/// Monotonic notify/dismiss counter: delayed hides and re-emits capture the
/// value at schedule time and only fire while it is still current, so a new
/// notify extends/replaces instead of being cut short by a stale timer.
static OVERLAY_SEQ: AtomicU64 = AtomicU64::new(0);

/// Notification tone → the renderer maps it to status color tokens.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum OverlayTone {
    #[default]
    Neutral,
    Success,
    Warning,
    Error,
}

/// `overlay_notify` input: everything but the message is optional.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverlayNotifyPayload {
    #[specta(optional)]
    pub title: Option<String>,
    pub message: String,
    #[specta(optional)]
    pub tone: Option<OverlayTone>,
    #[specta(optional)]
    pub duration_ms: Option<u32>,
}

/// The resolved notification broadcast via `overlay:notify`: optional inputs
/// filled with their effective values (tone default, duration clamped).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverlayNotification {
    #[specta(optional)]
    pub title: Option<String>,
    pub message: String,
    pub tone: OverlayTone,
    pub duration_ms: u32,
}

pub(crate) fn resolve_notification(payload: OverlayNotifyPayload) -> OverlayNotification {
    OverlayNotification {
        title: payload.title.filter(|t| !t.trim().is_empty()),
        message: payload.message,
        tone: payload.tone.unwrap_or_default(),
        duration_ms: payload
            .duration_ms
            .unwrap_or(DEFAULT_DURATION_MS)
            .clamp(MIN_DURATION_MS, MAX_DURATION_MS),
    }
}

/// Dock the overlay top-center of the work area of the display the main
/// window lives on (primary display when main is gone). Top edge = work-area
/// top: the pill's `flatTop` island hangs flush from the screen edge.
fn place_overlay(app: &AppHandle, window: &tauri::WebviewWindow) {
    let anchor_point = app
        .get_webview_window("main")
        .and_then(|main| {
            let scale = main.scale_factor().unwrap_or(1.0);
            let pos = main.outer_position().ok()?;
            let size = main.outer_size().ok()?;
            Some((
                (pos.x as f64 + size.width as f64 / 2.0) / scale,
                (pos.y as f64 + size.height as f64 / 2.0) / scale,
            ))
        })
        .unwrap_or((0.0, 0.0));
    let (work_x, work_y, work_w, _work_h) =
        crate::windows::placement::work_area_for_point(app, anchor_point);
    let x = (work_x + (work_w - OVERLAY_WIDTH) / 2.0).round();
    if let Err(err) = window.set_position(LogicalPosition::new(x, work_y)) {
        log::warn!("[overlay] failed to position overlay: {err}");
    }
}

/// Show the overlay window and broadcast the resolved notification.
pub fn notify(app: &AppHandle, payload: OverlayNotifyPayload) -> Result<(), String> {
    let notification = resolve_notification(payload);
    if notification.message.trim().is_empty() {
        return Err("overlay message must not be empty".into());
    }
    // A fresh notify owns the window: cancels any pending hide/re-emit.
    let seq = OVERLAY_SEQ.fetch_add(1, Ordering::SeqCst) + 1;

    let window = crate::windows::ensure_window(app, OVERLAY_LABEL)?;
    place_overlay(app, &window);
    // Idempotent re-assert: creation sets click-through on Windows/macOS, but
    // Linux defers it to after the first show (hidden GTK windows aren't
    // realized yet) — and it must hold for every show path anyway.
    let _ = window.set_ignore_cursor_events(true);
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_always_on_top(true);
    // Deliberately NO set_focus(): the pill must never steal keyboard focus.

    let event = OverlayNotifyEvent(notification.clone());
    if let Err(err) = event.emit(app) {
        log::warn!("[overlay] failed to emit overlay:notify: {err}");
    }
    schedule_notify_reemits(app, event, seq);
    schedule_hide(
        app,
        seq,
        u64::from(notification.duration_ms) + OVERLAY_EXIT_GRACE_MS,
    );
    Ok(())
}

/// Duplicate-notify re-emits for the first-show listener race (the renderer
/// replaces content in place, so duplicates are idempotent).
fn schedule_notify_reemits(app: &AppHandle, event: OverlayNotifyEvent, seq: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut elapsed = 0;
        for delay_ms in OVERLAY_NOTIFY_REEMIT_MS {
            std::thread::sleep(Duration::from_millis(delay_ms - elapsed));
            elapsed = *delay_ms;
            if OVERLAY_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            if let Err(err) = event.emit(&app) {
                log::warn!("[overlay] failed to re-emit overlay:notify: {err}");
            }
        }
    });
}

/// Hide the OS window after `delay_ms`, unless a newer notify/dismiss took
/// ownership in the meantime.
fn schedule_hide(app: &AppHandle, seq: u64, delay_ms: u64) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay_ms));
        if OVERLAY_SEQ.load(Ordering::SeqCst) != seq {
            return;
        }
        let _ = app.clone().run_on_main_thread(move || {
            if OVERLAY_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = window.hide();
            }
        });
    });
}

/// Dismiss early: the renderer plays its exit now; the window hides after
/// the exit grace.
pub fn dismiss(app: &AppHandle) {
    let seq = OVERLAY_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    if let Err(err) = (OverlayDismissEvent {}).emit(app) {
        log::warn!("[overlay] failed to emit overlay:dismiss: {err}");
    }
    schedule_hide(app, seq, OVERLAY_EXIT_GRACE_MS);
}

/// Real producer: the download manager reports terminal transfer states here
/// (Rust-side copy — the overlay renderer displays backend-provided text; a
/// template that needs localized notifications should emit message KEYS and
/// translate in the overlay view).
pub(crate) fn notify_download_terminal(app: &AppHandle, file_name: &str, succeeded: bool) {
    let payload = if succeeded {
        OverlayNotifyPayload {
            title: Some("Download complete".into()),
            message: file_name.to_string(),
            tone: Some(OverlayTone::Success),
            duration_ms: None,
        }
    } else {
        OverlayNotifyPayload {
            title: Some("Download failed".into()),
            message: file_name.to_string(),
            tone: Some(OverlayTone::Error),
            duration_ms: None,
        }
    };
    if let Err(err) = notify(app, payload) {
        log::warn!("[overlay] download notification failed: {err}");
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// `overlay_notify` — show the overlay pill with the given notification.
#[tauri::command]
#[specta::specta]
pub fn overlay_notify(app: AppHandle, payload: OverlayNotifyPayload) -> Result<(), String> {
    notify(&app, payload)
}

/// `overlay_dismiss` — dismiss the pill early (renderer exit + delayed hide).
#[tauri::command]
#[specta::specta]
pub fn overlay_dismiss(app: AppHandle) {
    dismiss(&app);
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_DURATION_MS, MAX_DURATION_MS, MIN_DURATION_MS, OverlayNotifyPayload, OverlayTone,
        resolve_notification,
    };

    fn payload(message: &str) -> OverlayNotifyPayload {
        OverlayNotifyPayload {
            title: None,
            message: message.into(),
            tone: None,
            duration_ms: None,
        }
    }

    #[test]
    fn resolve_fills_defaults() {
        let resolved = resolve_notification(payload("hello"));
        assert_eq!(resolved.tone, OverlayTone::Neutral);
        assert_eq!(resolved.duration_ms, DEFAULT_DURATION_MS);
        assert_eq!(resolved.title, None);
    }

    #[test]
    fn resolve_clamps_duration() {
        let mut too_short = payload("x");
        too_short.duration_ms = Some(1);
        assert_eq!(resolve_notification(too_short).duration_ms, MIN_DURATION_MS);

        let mut too_long = payload("x");
        too_long.duration_ms = Some(10_000_000);
        assert_eq!(resolve_notification(too_long).duration_ms, MAX_DURATION_MS);
    }

    #[test]
    fn resolve_drops_blank_titles() {
        let mut blank = payload("x");
        blank.title = Some("   ".into());
        assert_eq!(resolve_notification(blank).title, None);

        let mut kept = payload("x");
        kept.title = Some("Done".into());
        assert_eq!(resolve_notification(kept).title.as_deref(), Some("Done"));
    }

    #[test]
    fn tone_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&OverlayTone::Success).unwrap(),
            "\"success\""
        );
        let parsed: OverlayTone = serde_json::from_str("\"error\"").unwrap();
        assert_eq!(parsed, OverlayTone::Error);
    }
}
