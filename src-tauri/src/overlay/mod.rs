//! Overlay notification pill: a transparent, click-through, non-focusable
//! always-on-top window docked top-center of the work area (pattern from
//! WinSTT's recording overlay, reduced to a generic notification surface).
//!
//! Flow:
//!   1. `overlay_notify(payload)` resolves the payload (tone/duration
//!      defaults + clamps), positions + shows the prewarmed hidden `overlay`
//!      window, and emits the `overlay:notify` specta event with the RESOLVED
//!      notification.
//!   2. The renderer plays the DynamicIsland enter animation, shows the pill
//!      until Rust emits `overlay:dismiss` at the semantic duration deadline,
//!      then acknowledges the real CSS exit completion before Rust hides the
//!      OS window.
//!   3. A new notify while one is visible REPLACES it: its sequence invalidates
//!      stale duration/animation callbacks and the renderer swaps content
//!      (no queue — last notification wins; documented template behavior).
//!   4. Listener startup uses subscribe-then-snapshot, so no timed re-emits are
//!      needed to cover a suspended or newly resumed WebView.
//!
//! The download manager calls `notify_download_terminal` on completed/failed
//! transfers, so the pill has a real producer out of the box.

use std::sync::Mutex;
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
#[derive(Default)]
struct OverlayState {
    sequence: u64,
    current: Option<OverlayNotification>,
}

/// Cached authoritative state for the renderer's subscribe-then-snapshot
/// handshake. Sequence allocation and replacement are atomic under this lock.
static OVERLAY_STATE: Mutex<OverlayState> = Mutex::new(OverlayState {
    sequence: 0,
    current: None,
});

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
    /// Process-monotonic ordering for event/snapshot races.
    pub sequence: u64,
    #[specta(optional)]
    pub title: Option<String>,
    pub message: String,
    pub tone: OverlayTone,
    pub duration_ms: u32,
}

/// Authoritative lifecycle snapshot read only after event listeners are live.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySnapshot {
    pub sequence: u64,
    #[specta(optional)]
    pub notification: Option<OverlayNotification>,
}

pub(crate) fn resolve_notification(payload: OverlayNotifyPayload) -> OverlayNotification {
    OverlayNotification {
        sequence: 0,
        title: payload.title.filter(|t| !t.trim().is_empty()),
        message: payload.message,
        tone: payload.tone.unwrap_or_default(),
        duration_ms: payload
            .duration_ms
            .unwrap_or(DEFAULT_DURATION_MS)
            .clamp(MIN_DURATION_MS, MAX_DURATION_MS),
    }
}

/// Dock the overlay top-center of the work area of the display the app window
/// lives on (primary display when it is gone). Top edge = work-area top: the
/// pill's `flatTop` island hangs flush from the screen edge.
fn place_overlay(app: &AppHandle, window: &tauri::WebviewWindow) {
    let anchor_point = app
        .get_webview_window(crate::windows::PRIMARY_WINDOW)
        .and_then(|anchor| {
            let scale = anchor.scale_factor().unwrap_or(1.0);
            let pos = anchor.outer_position().ok()?;
            let size = anchor.outer_size().ok()?;
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
    let mut notification = notification;
    let seq = {
        let mut state = OVERLAY_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sequence += 1;
        notification.sequence = state.sequence;
        state.current = Some(notification.clone());
        state.sequence
    };

    let window = crate::windows::ensure_window(app, OVERLAY_LABEL).inspect_err(|_| {
        clear_if_current(seq);
    })?;
    place_overlay(app, &window);
    // Idempotent re-assert: creation sets click-through on Windows/macOS, but
    // Linux defers it to after the first show (hidden GTK windows aren't
    // realized yet) — and it must hold for every show path anyway.
    let _ = window.set_ignore_cursor_events(true);
    window.show().map_err(|error| {
        clear_if_current(seq);
        error.to_string()
    })?;
    let _ = window.set_always_on_top(true);
    // Deliberately NO set_focus(): the pill must never steal keyboard focus.

    let event = OverlayNotifyEvent(notification.clone());
    if let Err(err) = event.emit(app) {
        log::warn!("[overlay] failed to emit overlay:notify: {err}");
    }
    schedule_duration_deadline(app, seq, notification.duration_ms);
    Ok(())
}

/// A notification's visible duration is itself time-based. This is a one-shot
/// semantic deadline; delivery and native-window lifecycle are callback-driven.
fn schedule_duration_deadline(app: &AppHandle, seq: u64, duration_ms: u32) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(u64::from(duration_ms)));
        dismiss_if_current(&app, Some(seq));
    });
}

fn dismiss_if_current(app: &AppHandle, expected: Option<u64>) {
    let sequence = {
        let mut state = OVERLAY_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.current.is_none()
            || expected.is_some_and(|sequence| {
                state.current.as_ref().map(|item| item.sequence) != Some(sequence)
            })
        {
            return;
        }
        state.sequence += 1;
        state.current = None;
        state.sequence
    };
    if let Err(err) = (OverlayDismissEvent { sequence }).emit(app) {
        log::warn!("[overlay] failed to emit overlay:dismiss: {err}");
    }
}

fn clear_if_current(sequence: u64) {
    let mut state = OVERLAY_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.current.as_ref().map(|item| item.sequence) == Some(sequence) {
        state.current = None;
    }
}

/// Dismiss early: the renderer plays its exit and reports when it actually
/// completed; there is no guessed native-hide delay.
pub fn dismiss(app: &AppHandle) {
    dismiss_if_current(app, None);
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

/// Latest notification for a race-free subscribe-then-snapshot handshake.
#[tauri::command]
#[specta::specta]
pub fn overlay_snapshot() -> OverlaySnapshot {
    let state = OVERLAY_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    OverlaySnapshot {
        sequence: state.sequence,
        notification: state.current.clone(),
    }
}

/// Renderer acknowledgement that the CSS exit really completed. A newer
/// notification keeps the native window alive, making late callbacks harmless.
#[tauri::command]
#[specta::specta]
pub fn overlay_hide_complete(app: AppHandle, sequence: u64) {
    let should_hide = {
        let state = OVERLAY_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sequence == sequence && state.current.is_none()
    };
    if should_hide && let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
    }
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
