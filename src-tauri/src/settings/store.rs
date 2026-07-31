//! Settings persistence: store I/O + the process-wide write lock + revision.
//!
//! Ported (simplified — no secret sealing, no schema migrations) from WinSTT's
//! settings store. The load-bearing pieces kept intact:
//!
//!   * The store handle is built ONCE on the MAIN thread (`init_settings_store`
//!     from the setup hook). `StoreExt::store` clones the `AppHandle` — and on
//!     the Wry runtime that clone touches tao's non-`Send` `Rc<EventLoopRunner>`,
//!     so constructing the store from a background thread is UB-adjacent.
//!     Every later access reuses the cached `Arc<Store>`.
//!   * The store dir is resolved ONCE to an ABSOLUTE path. `portable::store_path`
//!     returns a bare relative path in non-portable mode; the plugin resolves it
//!     against app-data but a naive `fs::write` would resolve it against the CWD,
//!     silently splitting reads and writes across two files.
//!   * Writes are atomic + durable: temp file + fsync + rename, with a `.bak`
//!     refresh of the last-known-good file. The plugin's debounced auto-save is
//!     DISABLED so this is the only writer.
//!   * A process-wide write lock serializes every read-merge-write span, and a
//!     monotonic REVISION lets renderer windows do optimistic concurrency.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::AppHandle;
use tauri_plugin_store::{Store, StoreExt};

use super::{AppSettings, normalize_settings};

/// Persisted store key for the settings tree.
const SETTINGS_KEY: &str = "settings";
/// The settings store file name (under the app-data / portable data dir).
pub const SETTINGS_FILE: &str = "dimread-settings.json";

/// The RESOLVED absolute directory holding the settings file.
static RESOLVED_STORE_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Process-wide cached handle to the settings store (see module docs).
static SETTINGS_STORE: OnceLock<Arc<Store<tauri::Wry>>> = OnceLock::new();
/// The canonical in-process snapshot. Keeping the revision and tree behind the
/// same mutex prevents readers from ever pairing one commit's revision with
/// another commit's settings.
static SETTINGS_STATE: Mutex<SettingsState> = Mutex::new(SettingsState {
    revision: 0,
    settings: None,
});
/// Process-wide serializer for every read-modify-write of the settings file.
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

struct SettingsState {
    revision: u32,
    settings: Option<AppSettings>,
}

pub fn settings_revision() -> u32 {
    lock_recover(&SETTINGS_STATE).revision
}

/// Recover a possibly-poisoned mutex: settings writes must keep working after
/// a panicked thread held the lock (the data is a whole-tree replace, so a
/// half-applied mutation cannot be observed).
fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn resolve_store_dir(app: &AppHandle) {
    let _ = RESOLVED_STORE_DIR.get_or_init(|| {
        crate::portable::app_data_dir(app).unwrap_or_else(|err| {
            log::error!("[settings] app-data dir unresolved ({err}); falling back to CWD");
            std::env::current_dir().unwrap_or_else(|cwd_err| {
                log::error!("[settings] current directory unresolved too: {cwd_err}");
                PathBuf::from(".")
            })
        })
    });
}

fn store_path() -> PathBuf {
    match RESOLVED_STORE_DIR.get() {
        Some(dir) => dir.join(SETTINGS_FILE),
        None => crate::portable::store_path(SETTINGS_FILE),
    }
}

/// Resolve `file` inside the SAME directory the settings file lives in, so
/// sibling state (the `session_guard` journal) follows portable mode without
/// duplicating the app-data resolution. Safe to call before
/// [`init_settings_store`] — it resolves the directory on demand.
pub fn data_file_path(app: &AppHandle, file: &str) -> PathBuf {
    resolve_store_dir(app);
    match RESOLVED_STORE_DIR.get() {
        Some(dir) => dir.join(file),
        None => crate::portable::store_path(file),
    }
}

/// Build + cache the settings store handle on the MAIN thread. MUST be called
/// once from the tauri setup hook before any background thread reads settings.
/// Idempotent. Also seeds the default tree on first run.
pub fn init_settings_store(app: &AppHandle) {
    resolve_store_dir(app);
    if SETTINGS_STORE.get().is_none() {
        match build_settings_store(app) {
            Ok(store) => {
                let _ = SETTINGS_STORE.set(store);
            }
            Err(err) => {
                log::error!("[settings] failed to initialize settings store handle: {err}");
            }
        }
    }
    seed_defaults(app);
}

/// Build an in-memory plugin store, then detach it from the plugin resource
/// registry. The plugin unconditionally saves every registered store with a
/// plain `fs::write` on `RunEvent::Exit`, even when auto-save is disabled.
/// Detaching keeps the convenient synchronized cache while ensuring this
/// module's atomic writer remains the only writer for the file.
fn build_settings_store(app: &AppHandle) -> Result<Arc<Store<tauri::Wry>>, String> {
    let path = store_path();
    match recover_settings_file(&path) {
        Ok(RecoveryStatus::Recovered) => {
            log::warn!(
                "[settings] recovered settings from {}",
                backup_path(&path).display()
            );
        }
        Ok(RecoveryStatus::Unavailable(reason)) => {
            log::warn!("[settings] no valid persisted settings were available: {reason}");
        }
        Ok(RecoveryStatus::PrimaryValid) => {}
        Err(err) => log::error!("[settings] backup recovery failed: {err}"),
    }
    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .map_err(|err| format!("settings store: {err}"))?;
    store.close_resource();
    Ok(store)
}

fn settings_store(app: &AppHandle) -> Result<Arc<Store<tauri::Wry>>, String> {
    if let Some(store) = SETTINGS_STORE.get() {
        return Ok(Arc::clone(store));
    }
    resolve_store_dir(app);
    let store = build_settings_store(app)?;
    let _ = SETTINGS_STORE.set(Arc::clone(&store));
    Ok(store)
}

fn parse_settings_value(mut value: serde_json::Value) -> Result<AppSettings, String> {
    super::migrate_legacy_location_source(&mut value);
    let mut settings =
        serde_json::from_value::<AppSettings>(value).map_err(|err| err.to_string())?;
    normalize_settings(&mut settings);
    Ok(settings)
}

fn load_settings(app: &AppHandle) -> AppSettings {
    match settings_store(app) {
        Ok(store) => match store.get(SETTINGS_KEY) {
            Some(value) => parse_settings_value(value).unwrap_or_else(|err| {
                log::warn!("[settings] persisted settings failed to parse ({err}); using defaults");
                AppSettings::default()
            }),
            None => AppSettings::default(),
        },
        Err(err) => {
            log::warn!("[settings] failed to open settings store: {err}");
            AppSettings::default()
        }
    }
}

/// Read the canonical settings tree and its matching revision atomically.
pub(crate) fn read_settings_snapshot(app: &AppHandle) -> (u32, AppSettings) {
    let mut state = lock_recover(&SETTINGS_STATE);
    if state.settings.is_none() {
        state.settings = Some(load_settings(app));
    }
    (
        state.revision,
        state
            .settings
            .as_ref()
            .expect("settings state was initialized above")
            .clone(),
    )
}

/// Read the persisted settings. Defaults cleanly on a missing/partial blob —
/// every field is `#[serde(default)]`.
pub fn read_settings(app: &AppHandle) -> AppSettings {
    read_settings_snapshot(app).1
}

/// Run `f` with the process-wide settings write lock held. Do NOT call from
/// within an already-guarded span — `std::sync::Mutex` is non-reentrant.
pub(crate) fn with_settings_write_lock<R>(f: impl FnOnce() -> R) -> R {
    let _guard = lock_recover(&SETTINGS_WRITE_LOCK);
    f()
}

/// Persist a full settings tree to the store, flush durably, refresh the
/// in-memory cache, and advance the revision. Callers hold the write lock.
pub(crate) fn write_settings_value(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let store = settings_store(app)?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    let next_revision = lock_recover(&SETTINGS_STATE)
        .revision
        .checked_add(1)
        .ok_or_else(|| "settings revision exhausted".to_string())?;
    set_store_value_durably(&store, value)?;
    let mut state = lock_recover(&SETTINGS_STATE);
    state.settings = Some(settings.clone());
    state.revision = next_revision;
    Ok(())
}

fn set_store_value_durably(
    store: &Store<tauri::Wry>,
    value: serde_json::Value,
) -> Result<(), String> {
    let previous = store.get(SETTINGS_KEY);
    store.set(SETTINGS_KEY, value);
    if let Err(err) = durable_save_store(store) {
        match previous {
            Some(value) => store.set(SETTINGS_KEY, value),
            None => {
                store.delete(SETTINGS_KEY);
            }
        }
        return Err(err);
    }
    Ok(())
}

/// Materialize the canonical default tree on first run so the file exists and
/// later partial writes have a complete base.
fn seed_defaults(app: &AppHandle) {
    with_settings_write_lock(|| {
        let Ok(store) = settings_store(app) else {
            return;
        };
        if store
            .get(SETTINGS_KEY)
            .is_some_and(|value| parse_settings_value(value).is_ok())
        {
            return;
        }
        let defaults = AppSettings::default();
        if let Ok(value) = serde_json::to_value(&defaults) {
            if let Err(err) = set_store_value_durably(&store, value) {
                log::error!("[settings] failed to persist fresh defaults: {err}");
            } else {
                lock_recover(&SETTINGS_STATE).settings = Some(defaults);
            }
        }
    });
}

/// Atomically + durably persist the ENTIRE store cache to disk:
///   1. serialize every key to pretty JSON,
///   2. write it to a sibling temp file and `fsync` it,
///   3. `rename` the temp over the target (atomic on Windows + POSIX),
///   4. refresh a `.bak` copy of the now-good file for crash recovery.
fn durable_save_store(store: &Store<tauri::Wry>) -> Result<(), String> {
    let mut map = serde_json::Map::new();
    for (key, value) in store.entries() {
        map.insert(key, value);
    }
    atomic_write_json(&store_path(), &serde_json::Value::Object(map))
}

fn appended_path(path: &Path, suffix: &str) -> PathBuf {
    let mut appended = path.as_os_str().to_owned();
    appended.push(suffix);
    PathBuf::from(appended)
}

fn backup_path(path: &Path) -> PathBuf {
    appended_path(path, ".bak")
}

fn temp_path(path: &Path) -> PathBuf {
    appended_path(path, ".tmp")
}

fn atomic_replace_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = temp_path(path);
    let result = (|| {
        let parent = path
            .parent()
            .ok_or_else(|| format!("settings store path has no parent dir: {}", path.display()))?;
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("create settings directory {}: {err}", parent.display()))?;
        let mut file = std::fs::File::create(&tmp)
            .map_err(|err| format!("create settings temp file {}: {err}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|err| format!("write settings temp file {}: {err}", tmp.display()))?;
        file.sync_all()
            .map_err(|err| format!("sync settings temp file {}: {err}", tmp.display()))?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|err| {
            format!(
                "replace settings file {} from {}: {err}",
                path.display(),
                tmp.display()
            )
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn atomic_write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    atomic_replace_bytes(path, &bytes)?;

    // Recovery is only useful if refreshing it cannot tear the old backup.
    let backup = backup_path(path);
    if let Err(err) = atomic_replace_bytes(&backup, &bytes) {
        log::debug!("[settings] failed to refresh settings .bak (non-fatal): {err}");
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum RecoveryStatus {
    PrimaryValid,
    Recovered,
    Unavailable(String),
}

fn read_valid_store_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("read {}: {err}", path.display())),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|err| format!("parse {}: {err}", path.display()))?;
    let settings = value
        .get(SETTINGS_KEY)
        .cloned()
        .ok_or_else(|| format!("{} has no '{SETTINGS_KEY}' tree", path.display()))?;
    parse_settings_value(settings).map_err(|err| format!("validate {}: {err}", path.display()))?;
    Ok(Some(value))
}

fn recover_settings_file(path: &Path) -> Result<RecoveryStatus, String> {
    let primary_problem = match read_valid_store_json(path) {
        Ok(Some(_)) => return Ok(RecoveryStatus::PrimaryValid),
        Ok(None) => format!("{} is missing", path.display()),
        Err(err) => err,
    };
    let backup = backup_path(path);
    match read_valid_store_json(&backup) {
        Ok(Some(value)) => {
            atomic_write_json(path, &value)?;
            Ok(RecoveryStatus::Recovered)
        }
        Ok(None) => Ok(RecoveryStatus::Unavailable(format!(
            "{primary_problem}; {} is missing",
            backup.display()
        ))),
        Err(backup_problem) => Ok(RecoveryStatus::Unavailable(format!(
            "{primary_problem}; {backup_problem}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_json_persists_and_refreshes_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let value = serde_json::json!({ "settings": { "general": { "autostart": true } } });

        atomic_write_json(&path, &value).expect("atomic write succeeds");

        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk, value);
        let bak: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("settings.json.bak")).unwrap())
                .unwrap();
        assert_eq!(bak, value);
        assert!(!dir.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn atomic_write_json_replaces_existing_primary_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        atomic_write_json(&path, &serde_json::json!({ "settings": {} }))
            .expect("first atomic write succeeds");
        let expected = serde_json::json!({
            "settings": { "general": { "autostart": true } }
        });

        atomic_write_json(&path, &expected).expect("replacement atomic write succeeds");

        let primary: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let backup: serde_json::Value =
            serde_json::from_slice(&std::fs::read(backup_path(&path)).unwrap()).unwrap();
        assert_eq!((primary, backup), (expected.clone(), expected));
    }

    #[test]
    fn atomic_write_json_removes_temp_file_when_replace_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::create_dir(&path).unwrap();

        let error = atomic_write_json(&path, &serde_json::json!({ "settings": {} }))
            .expect_err("a file cannot replace a directory");

        assert!(error.contains("replace settings file"));
        assert!(!temp_path(&path).exists());
    }

    #[test]
    fn recovery_restores_valid_backup_before_defaults_are_needed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let expected = serde_json::json!({
            "settings": { "general": { "autostart": true } }
        });
        atomic_write_json(&path, &expected).expect("seed valid primary and backup");
        std::fs::write(&path, b"{ corrupt").unwrap();

        let status = recover_settings_file(&path).expect("backup recovery succeeds");

        assert_eq!(status, RecoveryStatus::Recovered);
        let restored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored, expected);
    }

    #[test]
    fn write_lock_serializes_whole_tree_rmw() {
        use std::sync::{Arc, Barrier};

        // Model the production read→merge→write span: two threads each replace
        // ONE section under the lock; neither section may be lost.
        let store = Arc::new(Mutex::new(AppSettings::default()));
        // Release both writers at the same instant without repeatedly yielding
        // and hoping the OS scheduler creates contention.
        let start = Arc::new(Barrier::new(3));

        let s1 = Arc::clone(&store);
        let start1 = Arc::clone(&start);
        let t1 = std::thread::spawn(move || {
            start1.wait();
            for _ in 0..200 {
                with_settings_write_lock(|| {
                    let mut tree = lock_recover(&s1).clone();
                    tree.general.autostart = true;
                    *lock_recover(&s1) = tree;
                });
            }
        });
        let s2 = Arc::clone(&store);
        let start2 = Arc::clone(&start);
        let t2 = std::thread::spawn(move || {
            start2.wait();
            for _ in 0..200 {
                with_settings_write_lock(|| {
                    let mut tree = lock_recover(&s2).clone();
                    tree.appearance.reduced_motion = true;
                    *lock_recover(&s2) = tree;
                });
            }
        });
        start.wait();
        t1.join().unwrap();
        t2.join().unwrap();

        let final_tree = lock_recover(&store).clone();
        assert!(final_tree.general.autostart);
        assert!(final_tree.appearance.reduced_motion);
    }
}
