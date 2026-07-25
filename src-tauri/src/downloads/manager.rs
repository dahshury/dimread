//! Generic download manager: registry + worker pool + pause/resume/cancel.
//!
//! Architecture (distilled from WinSTT's model download manager, minus all
//! catalog logic):
//!   * a registry `Mutex<BTreeMap<String, Arc<DownloadHandle>>>` keyed by the
//!     caller-chosen id,
//!   * a FIFO queue of pending ids drained by a worker pool whose size is
//!     re-read from `settings.downloads.concurrency` per slot,
//!   * pause PARKS the transfer (the worker returns, freeing its slot; the
//!     partial `.part` file stays for HTTP-Range resume),
//!   * resume re-enqueues, cancel deletes the partial file,
//!   * every state change emits a full `download:update` snapshot; progress is
//!     throttled to ~10 Hz by the transfer engine's `progress_interval`.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use super::transfer::{
    PauseCancelFlags, TransferOutcome, TransferProgress, TransferRequest, progress_fraction_of,
    transfer_url,
};
use super::{DownloadPhase, DownloadSnapshot};
use crate::events::DownloadUpdateEvent;

/// How often the transfer engine reports progress (also the emit rate cap).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    })
}

fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
struct ProgressState {
    phase: DownloadPhase,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    speed_bps: Option<f32>,
    eta_seconds: Option<f32>,
    error: Option<String>,
}

pub struct DownloadHandle {
    id: String,
    url: String,
    file_name: String,
    flags: PauseCancelFlags,
    state: Mutex<ProgressState>,
    /// Set by `download_remove` so a still-running worker's final emit can't
    /// resurrect an entry the renderer already dropped.
    removed: AtomicBool,
}

impl DownloadHandle {
    fn snapshot(&self) -> DownloadSnapshot {
        let state = lock_recover(&self.state);
        DownloadSnapshot {
            id: self.id.clone(),
            url: self.url.clone(),
            file_name: self.file_name.clone(),
            phase: state.phase,
            progress: match state.phase {
                DownloadPhase::Completed => 1.0,
                _ => state.total_bytes.map_or(0.0, |total| {
                    progress_fraction_of(state.downloaded_bytes, total)
                }),
            },
            downloaded_bytes: state.downloaded_bytes,
            total_bytes: state.total_bytes,
            speed_bps: state.speed_bps,
            eta_seconds: state.eta_seconds,
            error: state.error.clone(),
        }
    }

    fn set_phase(&self, phase: DownloadPhase, error: Option<String>) {
        let mut state = lock_recover(&self.state);
        state.phase = phase;
        state.error = error;
        if phase != DownloadPhase::Downloading {
            state.speed_bps = None;
            state.eta_seconds = None;
        }
    }

    fn phase(&self) -> DownloadPhase {
        lock_recover(&self.state).phase
    }

    fn apply_progress(&self, progress: TransferProgress) {
        let mut state = lock_recover(&self.state);
        state.downloaded_bytes = progress.downloaded_bytes;
        state.total_bytes = progress.total_bytes;
        state.speed_bps = progress.speed_bps;
        state.eta_seconds = progress.eta_seconds;
    }
}

#[derive(Default)]
pub struct DownloadManager {
    entries: Mutex<BTreeMap<String, Arc<DownloadHandle>>>,
    queue: Mutex<VecDeque<String>>,
    active: AtomicUsize,
}

/// The destination directory for every download: `<app data>/downloads`
/// (portable-aware). Created on demand.
pub fn downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::portable::app_data_dir(app)
        .map_err(|err| format!("app data dir unresolved: {err}"))?
        .join("downloads");
    std::fs::create_dir_all(&dir).map_err(|err| format!("create downloads dir: {err}"))?;
    Ok(dir)
}

/// Reject path-traversal in the caller-supplied file name; the destination
/// must stay inside the downloads dir.
fn sanitize_file_name(file_name: &str) -> Result<(), String> {
    let name = file_name.trim();
    if name.is_empty() {
        return Err("file name must not be empty".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains(':') {
        return Err(format!("invalid file name '{file_name}'"));
    }
    Ok(())
}

fn emit_snapshot(app: &AppHandle, handle: &DownloadHandle) {
    if handle.removed.load(Ordering::Acquire) {
        return;
    }
    if let Err(err) = DownloadUpdateEvent(handle.snapshot()).emit(app) {
        log::warn!("[downloads] failed to emit download:update: {err}");
    }
}

impl DownloadManager {
    fn handle(&self, id: &str) -> Result<Arc<DownloadHandle>, String> {
        lock_recover(&self.entries)
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown download '{id}'"))
    }

    fn dequeue(&self, id: &str) -> bool {
        let mut queue = lock_recover(&self.queue);
        let before = queue.len();
        queue.retain(|queued| queued != id);
        queue.len() != before
    }

    fn paths(app: &AppHandle, file_name: &str) -> Result<(PathBuf, PathBuf), String> {
        let dir = downloads_dir(app)?;
        let final_path = dir.join(file_name);
        let partial_path = dir.join(format!("{file_name}.part"));
        Ok((final_path, partial_path))
    }

    /// Register + enqueue a new download. Errors when the id is already queued
    /// or actively downloading (pause/cancel it first); a completed, failed,
    /// paused, or cancelled entry with the same id is restarted from scratch
    /// state (the partial file, if any, still resumes via HTTP-Range).
    pub fn start(
        &self,
        app: &AppHandle,
        id: String,
        url: String,
        file_name: String,
    ) -> Result<(), String> {
        sanitize_file_name(&file_name)?;
        let handle = {
            let mut entries = lock_recover(&self.entries);
            if let Some(existing) = entries.get(&id)
                && matches!(
                    existing.phase(),
                    DownloadPhase::Queued | DownloadPhase::Downloading
                )
            {
                return Err(format!("download '{id}' is already in progress"));
            }
            let handle = Arc::new(DownloadHandle {
                id: id.clone(),
                url,
                file_name,
                flags: PauseCancelFlags::default(),
                state: Mutex::new(ProgressState::default()),
                removed: AtomicBool::new(false),
            });
            entries.insert(id.clone(), Arc::clone(&handle));
            handle
        };
        lock_recover(&self.queue).push_back(id);
        emit_snapshot(app, &handle);
        self.pump(app);
        Ok(())
    }

    /// Pause: a queued entry parks immediately; an active transfer's wakeable
    /// control signal interrupts its current network wait and frees the slot.
    pub fn pause(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let handle = self.handle(id)?;
        match handle.phase() {
            DownloadPhase::Queued => {
                self.dequeue(id);
                handle.set_phase(DownloadPhase::Paused, None);
                emit_snapshot(app, &handle);
            }
            DownloadPhase::Downloading => handle.flags.pause(),
            _ => {}
        }
        Ok(())
    }

    /// Resume a paused (or failed) entry: clear the flags and re-enqueue.
    pub fn resume(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let handle = self.handle(id)?;
        if !matches!(
            handle.phase(),
            DownloadPhase::Paused | DownloadPhase::Failed | DownloadPhase::Cancelled
        ) {
            return Ok(());
        }
        handle.flags.reset();
        handle.set_phase(DownloadPhase::Queued, None);
        lock_recover(&self.queue).push_back(id.to_string());
        emit_snapshot(app, &handle);
        self.pump(app);
        Ok(())
    }

    /// Cancel: an active transfer's wakeable control signal interrupts its
    /// current network wait (the engine deletes the partial file); a
    /// parked/queued entry is cancelled and its partial file deleted here.
    pub fn cancel(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let handle = self.handle(id)?;
        match handle.phase() {
            DownloadPhase::Downloading => {
                handle.flags.cancel();
                // Clear a pending pause so the cancel is what the loop observes.
                handle.flags.resume();
            }
            DownloadPhase::Queued | DownloadPhase::Paused => {
                self.dequeue(id);
                let (_, partial_path) = Self::paths(app, &handle.file_name)?;
                let _ = std::fs::remove_file(partial_path);
                handle.set_phase(DownloadPhase::Cancelled, None);
                emit_snapshot(app, &handle);
            }
            _ => {}
        }
        Ok(())
    }

    /// Remove: cancel if needed, delete BOTH the partial and the completed
    /// file, and drop the registry entry. No event is emitted — the renderer
    /// drops its row when the command resolves.
    pub fn remove(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let handle = self.handle(id)?;
        handle.removed.store(true, Ordering::Release);
        if handle.phase() == DownloadPhase::Downloading {
            handle.flags.cancel();
            handle.flags.resume();
        }
        self.dequeue(id);
        let (final_path, partial_path) = Self::paths(app, &handle.file_name)?;
        let _ = std::fs::remove_file(partial_path);
        let _ = std::fs::remove_file(final_path);
        lock_recover(&self.entries).remove(id);
        Ok(())
    }

    /// Current snapshots for every registered download.
    pub fn list(&self) -> Vec<DownloadSnapshot> {
        lock_recover(&self.entries)
            .values()
            .map(|handle| handle.snapshot())
            .collect()
    }

    /// Drain the queue into free worker slots. The concurrency budget is
    /// re-read from settings per slot, so a settings change applies to every
    /// download started (or resumed) afterwards without restart.
    fn pump(&self, app: &AppHandle) {
        loop {
            let budget = crate::settings::store::read_settings(app)
                .downloads
                .concurrency
                .clamp(1, 4) as usize;
            if self.active.load(Ordering::Acquire) >= budget {
                return;
            }
            let Some(id) = lock_recover(&self.queue).pop_front() else {
                return;
            };
            let Ok(handle) = self.handle(&id) else {
                continue;
            };
            self.active.fetch_add(1, Ordering::AcqRel);
            handle.set_phase(DownloadPhase::Downloading, None);
            emit_snapshot(app, &handle);
            spawn_worker(app.clone(), handle);
        }
    }

    /// Worker completion: release the slot and pull the next queued item.
    fn on_worker_done(&self, app: &AppHandle) {
        self.active.fetch_sub(1, Ordering::AcqRel);
        self.pump(app);
    }
}

fn spawn_worker(app: AppHandle, handle: Arc<DownloadHandle>) {
    tauri::async_runtime::spawn(async move {
        let result = match DownloadManager::paths(&app, &handle.file_name) {
            Ok((final_path, partial_path)) => {
                let request = TransferRequest {
                    delete_partial_on_cancel: true,
                    final_path: Some(final_path.as_path()),
                    known_total_bytes: None,
                    partial_path: partial_path.as_path(),
                    progress_interval: PROGRESS_INTERVAL,
                    url: &handle.url,
                };
                let progress_handle = Arc::clone(&handle);
                let progress_app = app.clone();
                transfer_url(
                    http_client(),
                    request,
                    Some(&handle.flags),
                    move |progress| {
                        progress_handle.apply_progress(progress);
                        if lock_recover(&progress_handle.state).phase == DownloadPhase::Downloading
                        {
                            emit_snapshot(&progress_app, &progress_handle);
                        }
                    },
                )
                .await
                .map(|report| report.outcome)
                .map_err(|err| err.to_string())
            }
            Err(err) => Err(err),
        };

        // Overlay pill on terminal outcomes (skipped for entries the renderer
        // already removed — same guard as the snapshot emit).
        let overlay_outcome = match &result {
            Ok(TransferOutcome::Complete) => Some(true),
            Err(_) => Some(false),
            Ok(_) => None,
        };
        match result {
            Ok(TransferOutcome::Complete) => handle.set_phase(DownloadPhase::Completed, None),
            Ok(TransferOutcome::Paused) => handle.set_phase(DownloadPhase::Paused, None),
            Ok(TransferOutcome::Cancelled) => handle.set_phase(DownloadPhase::Cancelled, None),
            Err(err) => {
                log::warn!("[downloads] '{}' failed: {err}", handle.id);
                handle.set_phase(DownloadPhase::Failed, Some(err));
            }
        }
        emit_snapshot(&app, &handle);
        if let Some(succeeded) = overlay_outcome
            && !handle.removed.load(Ordering::Acquire)
        {
            crate::overlay::notify_download_terminal(&app, &handle.file_name, succeeded);
        }
        app.state::<DownloadManager>().on_worker_done(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_file_name_rejects_traversal() {
        assert!(sanitize_file_name("model.bin").is_ok());
        assert!(sanitize_file_name("archive.tar.gz").is_ok());
        assert!(sanitize_file_name("").is_err());
        assert!(sanitize_file_name("  ").is_err());
        assert!(sanitize_file_name("../evil.bin").is_err());
        assert!(sanitize_file_name("dir/evil.bin").is_err());
        assert!(sanitize_file_name("dir\\evil.bin").is_err());
        assert!(sanitize_file_name("C:evil.bin").is_err());
    }

    #[test]
    fn snapshot_reports_full_progress_when_completed() {
        let handle = DownloadHandle {
            id: "a".into(),
            url: "https://example.com/a.bin".into(),
            file_name: "a.bin".into(),
            flags: PauseCancelFlags::default(),
            state: Mutex::new(ProgressState::default()),
            removed: AtomicBool::new(false),
        };
        handle.set_phase(DownloadPhase::Completed, None);
        assert_eq!(handle.snapshot().progress, 1.0);
    }

    #[test]
    fn phase_transitions_clear_rate_fields() {
        let handle = DownloadHandle {
            id: "a".into(),
            url: "https://example.com/a.bin".into(),
            file_name: "a.bin".into(),
            flags: PauseCancelFlags::default(),
            state: Mutex::new(ProgressState::default()),
            removed: AtomicBool::new(false),
        };
        {
            let mut state = lock_recover(&handle.state);
            state.phase = DownloadPhase::Downloading;
            state.speed_bps = Some(1024.0);
            state.eta_seconds = Some(3.0);
        }
        handle.set_phase(DownloadPhase::Paused, None);
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.phase, DownloadPhase::Paused);
        assert_eq!(snapshot.speed_bps, None);
        assert_eq!(snapshot.eta_seconds, None);
    }
}
