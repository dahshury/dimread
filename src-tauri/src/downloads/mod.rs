//! Download subsystem.
//!
//! * `transfer` — the generic single-URL transfer engine (HTTP-Range resume,
//!   cooperative pause/cancel flags, stall timeout, atomic `.part` → final
//!   rename, speed/ETA). Copied verbatim from WinSTT — treat it as vendored.
//! * `manager` — a small generic orchestrator on top: a registry of download
//!   handles keyed by caller id, a worker pool sized from
//!   `settings.downloads.concurrency`, pause-park / resume-re-enqueue /
//!   cancel-delete semantics, and `download:update` snapshot emits.
//! * `commands` — the `download_*` IPC surface.
//!
//! The download list is intentionally NOT persisted across restarts: completed
//! files live on disk in the downloads dir; in-flight state is in-memory only.

pub mod commands;
pub mod manager;
pub mod transfer;

use serde::{Deserialize, Serialize};
use specta::Type;

/// One download's renderer-facing state. Emitted as the `download:update`
/// payload on every phase change (plus throttled progress) and returned as a
/// list by `download_list`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    /// Caller-chosen stable id (also the registry key).
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub phase: DownloadPhase,
    /// Canonical progress ratio in `[0, 1]`; `0` while the total is unknown.
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: Option<f32>,
    pub eta_seconds: Option<f32>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DownloadPhase {
    #[default]
    Queued,
    Downloading,
    Paused,
    Completed,
    Cancelled,
    Failed,
}
