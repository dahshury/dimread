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
use std::sync::atomic::{AtomicU32, Ordering};
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
/// In-memory cache of the last parsed tree so hot readers skip JSON decode.
static SETTINGS_CACHE: Mutex<Option<AppSettings>> = Mutex::new(None);
/// Monotonic process-local revision for the canonical settings snapshot.
/// Every durable write advances it while holding `SETTINGS_WRITE_LOCK`.
static SETTINGS_REVISION: AtomicU32 = AtomicU32::new(0);
/// Process-wide serializer for every read-modify-write of the settings file.
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn settings_revision() -> u32 {
    SETTINGS_REVISION.load(Ordering::Acquire)
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
            PathBuf::from(".")
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

/// Build the store handle with the plugin's debounced auto-save DISABLED: the
/// default auto-save is a plain non-atomic `fs::write` fired 100 ms after every
/// `set`, which could tear the file after our durable write already committed
/// it. Disabling it makes the atomic path the only writer.
fn build_settings_store(app: &AppHandle) -> Result<Arc<Store<tauri::Wry>>, String> {
    app.store_builder(store_path())
        .disable_auto_save()
        .build()
        .map_err(|err| format!("settings store: {err}"))
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

/// Read the persisted settings. Defaults cleanly on a missing/partial blob —
/// every field is `#[serde(default)]`.
pub fn read_settings(app: &AppHandle) -> AppSettings {
    if let Some(settings) = lock_recover(&SETTINGS_CACHE).clone() {
        return settings;
    }
    let settings = match settings_store(app) {
        Ok(store) => match store.get(SETTINGS_KEY) {
            Some(value) => {
                let mut parsed =
                    serde_json::from_value::<AppSettings>(value).unwrap_or_else(|err| {
                        log::warn!(
                            "[settings] persisted settings failed to parse ({err}); using defaults"
                        );
                        AppSettings::default()
                    });
                normalize_settings(&mut parsed);
                parsed
            }
            None => AppSettings::default(),
        },
        Err(err) => {
            log::warn!("[settings] failed to open settings store: {err}");
            AppSettings::default()
        }
    };
    *lock_recover(&SETTINGS_CACHE) = Some(settings.clone());
    settings
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
    store.set(SETTINGS_KEY, value);
    durable_save_store(&store)?;
    *lock_recover(&SETTINGS_CACHE) = Some(settings.clone());
    SETTINGS_REVISION.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

/// Materialize the canonical default tree on first run so the file exists and
/// later partial writes have a complete base.
fn seed_defaults(app: &AppHandle) {
    with_settings_write_lock(|| {
        let Ok(store) = settings_store(app) else {
            return;
        };
        if store.get(SETTINGS_KEY).is_some() {
            return;
        }
        let defaults = AppSettings::default();
        if let Ok(value) = serde_json::to_value(&defaults) {
            store.set(SETTINGS_KEY, value);
            if let Err(err) = durable_save_store(&store) {
                log::error!("[settings] failed to persist fresh defaults: {err}");
            } else {
                *lock_recover(&SETTINGS_CACHE) = Some(defaults);
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

fn atomic_write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("settings store path has no parent dir: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;

    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        // fsync the bytes to stable storage BEFORE the rename so the swap can't
        // publish an empty/partial inode after a power loss.
        file.sync_all().map_err(|e| e.to_string())?;
    }
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    // Best-effort: keep a copy of the last known-good file for boot recovery.
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    if let Err(err) = std::fs::copy(path, PathBuf::from(bak)) {
        log::debug!("[settings] failed to refresh settings .bak (non-fatal): {err}");
    }
    Ok(())
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
    fn write_lock_serializes_whole_tree_rmw() {
        use std::sync::Arc;

        // Model the production read→merge→write span: two threads each replace
        // ONE section under the lock; neither section may be lost.
        let store = Arc::new(Mutex::new(AppSettings::default()));

        let s1 = Arc::clone(&store);
        let t1 = std::thread::spawn(move || {
            for _ in 0..200 {
                with_settings_write_lock(|| {
                    let mut tree = lock_recover(&s1).clone();
                    tree.general.autostart = true;
                    *lock_recover(&s1) = tree;
                });
                std::thread::yield_now();
            }
        });
        let s2 = Arc::clone(&store);
        let t2 = std::thread::spawn(move || {
            for _ in 0..200 {
                with_settings_write_lock(|| {
                    let mut tree = lock_recover(&s2).clone();
                    tree.downloads.concurrency = 4;
                    *lock_recover(&s2) = tree;
                });
                std::thread::yield_now();
            }
        });
        t1.join().unwrap();
        t2.join().unwrap();

        let final_tree = lock_recover(&store).clone();
        assert!(final_tree.general.autostart);
        assert_eq!(final_tree.downloads.concurrency, 4);
    }
}
