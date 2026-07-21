//! Download IPC surface. Thin wrappers over [`super::manager::DownloadManager`]
//! (managed app state) so command bodies stay declarative.

use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use super::DownloadSnapshot;
use super::manager::{DownloadManager, downloads_dir};

/// Start (or restart) a download. `id` is the caller-chosen registry key; the
/// file lands in the app-data downloads dir as `file_name` (a bare file name,
/// no path separators).
#[tauri::command]
#[specta::specta]
pub fn download_start(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
    url: String,
    file_name: String,
) -> Result<(), String> {
    manager.start(&app, id, url, file_name)
}

#[tauri::command]
#[specta::specta]
pub fn download_pause(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.pause(&app, &id)
}

#[tauri::command]
#[specta::specta]
pub fn download_resume(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.resume(&app, &id)
}

#[tauri::command]
#[specta::specta]
pub fn download_cancel(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.cancel(&app, &id)
}

/// Delete the downloaded file (and any partial) and drop the registry entry.
#[tauri::command]
#[specta::specta]
pub fn download_remove(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    manager.remove(&app, &id)
}

#[tauri::command]
#[specta::specta]
pub fn download_list(manager: State<'_, DownloadManager>) -> Vec<DownloadSnapshot> {
    manager.list()
}

/// Reveal the downloads directory in the OS file manager.
#[tauri::command]
#[specta::specta]
pub fn open_downloads_dir(app: AppHandle) -> Result<(), String> {
    let dir = downloads_dir(&app)?;
    app.app_handle()
        .opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|err| err.to_string())
}
