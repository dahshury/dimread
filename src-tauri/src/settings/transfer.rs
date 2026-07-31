//! Versioned, human-readable settings backups for the Settings window.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{AppSettings, commands::SettingsSnapshot};

const SETTINGS_WINDOW: &str = "settings";
const EXPORT_VERSION: u32 = 1;
const MAX_IMPORT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTransferResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SettingsSnapshot>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsBackup {
    format: String,
    version: u32,
    app_version: String,
    exported_at: u64,
    settings: AppSettings,
}

impl SettingsTransferResult {
    fn ok(path: PathBuf, snapshot: Option<SettingsSnapshot>) -> Self {
        Self {
            ok: true,
            cancelled: None,
            error: None,
            path: Some(path.to_string_lossy().into_owned()),
            snapshot,
        }
    }
    fn cancelled() -> Self {
        Self {
            ok: false,
            cancelled: Some(true),
            error: None,
            path: None,
            snapshot: None,
        }
    }
    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            cancelled: None,
            error: Some(message.into()),
            path: None,
            snapshot: None,
        }
    }
}

fn authorize_settings(webview: &WebviewWindow, operation: &str) -> Result<(), String> {
    if webview.label() == SETTINGS_WINDOW {
        return Ok(());
    }
    Err(format!(
        "settings transfer operation '{operation}' is not allowed from window '{}'",
        webview.label()
    ))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn safe_file_stem(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn backup_format(app: &AppHandle) -> String {
    format!("{}-settings", safe_file_stem(&app.package_info().name))
}

fn export_name(app: &AppHandle) -> String {
    format!("{}-{}.json", backup_format(app), now_seconds())
}

fn record_failure(operation: &'static str, summary: &'static str, error: &str) {
    crate::diagnostics::record_issue("settings", operation, summary, error.to_string());
}

#[tauri::command]
#[specta::specta]
pub async fn settings_export_backup(
    app: AppHandle,
    webview: WebviewWindow,
) -> SettingsTransferResult {
    if let Err(error) = authorize_settings(&webview, "export") {
        return SettingsTransferResult::failed(error);
    }
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export Settings")
        .add_filter("Settings backup", &["json"])
        .set_file_name(export_name(&app));
    if let Ok(documents) = app.path().document_dir() {
        dialog = dialog.set_directory(documents);
    }
    let Some(chosen) = dialog.blocking_save_file() else {
        return SettingsTransferResult::cancelled();
    };
    let path = match chosen.into_path() {
        Ok(path) => path,
        Err(error) => return SettingsTransferResult::failed(error.to_string()),
    };
    let backup = SettingsBackup {
        format: backup_format(&app),
        version: EXPORT_VERSION,
        app_version: app.package_info().version.to_string(),
        exported_at: now_seconds(),
        settings: super::store::read_settings(&app),
    };
    let result = serde_json::to_vec_pretty(&backup)
        .map_err(|error| error.to_string())
        .and_then(|bytes| std::fs::write(&path, bytes).map_err(|error| error.to_string()));
    match result {
        Ok(()) => SettingsTransferResult::ok(path, None),
        Err(error) => {
            record_failure("export", "Settings could not be exported", &error);
            SettingsTransferResult::failed(error)
        }
    }
}

fn decode_backup(bytes: &[u8], expected_format: &str) -> Result<AppSettings, String> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid settings backup: {error}"))?;
    let settings_value = value
        .get_mut("settings")
        .ok_or_else(|| "Invalid settings backup: missing settings tree".to_string())?;
    super::migrate_legacy_location_source(settings_value);
    let mut backup: SettingsBackup = serde_json::from_value(value)
        .map_err(|error| format!("Invalid settings backup: {error}"))?;
    if backup.format != expected_format {
        return Err("This backup belongs to a different application.".into());
    }
    if backup.version > EXPORT_VERSION {
        return Err(format!(
            "This backup uses unsupported format version {}.",
            backup.version
        ));
    }
    super::normalize_settings(&mut backup.settings);
    Ok(backup.settings)
}

fn read_backup(app: &AppHandle, path: &Path) -> Result<AppSettings, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err("The selected settings backup is larger than 5 MB.".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    decode_backup(&bytes, &backup_format(app))
}

#[tauri::command]
#[specta::specta]
pub async fn settings_import_backup(
    app: AppHandle,
    webview: WebviewWindow,
) -> SettingsTransferResult {
    if let Err(error) = authorize_settings(&webview, "import") {
        return SettingsTransferResult::failed(error);
    }
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Import Settings")
        .add_filter("Settings backup", &["json"])
        .blocking_pick_file()
    else {
        return SettingsTransferResult::cancelled();
    };
    let path = match chosen.into_path() {
        Ok(path) => path,
        Err(error) => return SettingsTransferResult::failed(error.to_string()),
    };
    let result = read_backup(&app, &path)
        .and_then(|settings| super::commands::replace_settings(&app, settings));
    match result {
        Ok(snapshot) => SettingsTransferResult::ok(path, Some(snapshot)),
        Err(error) => {
            record_failure("import", "Settings could not be imported", &error);
            SettingsTransferResult::failed(error)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn settings_reset_defaults(
    app: AppHandle,
    webview: WebviewWindow,
) -> Result<SettingsSnapshot, String> {
    authorize_settings(&webview, "reset")?;
    super::commands::replace_settings(&app, AppSettings::default()).inspect_err(|error| {
        record_failure("reset", "Settings could not be reset", error);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_file_stem_is_cross_platform_safe() {
        assert_eq!(safe_file_stem("Tauri Starter"), "tauri-starter");
        assert_eq!(safe_file_stem("  app/name!  "), "app-name");
    }
    #[test]
    fn backup_round_trips_settings() {
        let backup = SettingsBackup {
            format: "test-settings".into(),
            version: EXPORT_VERSION,
            app_version: "1.0.0".into(),
            exported_at: 1,
            settings: AppSettings::default(),
        };
        let bytes = serde_json::to_vec(&backup).unwrap();
        let decoded: SettingsBackup = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.settings, backup.settings);
    }

    #[test]
    fn import_migrates_coordinates_from_pre_location_source_backups() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format": "test-settings",
            "version": EXPORT_VERSION,
            "appVersion": "0.0.1",
            "exportedAt": 1,
            "settings": {
                "dayNight": {
                    "useLocation": true,
                    "latitude": 51.5074,
                    "longitude": -0.1278
                }
            }
        }))
        .unwrap();

        let settings = decode_backup(&bytes, "test-settings").expect("legacy backup imports");

        assert_eq!(settings.day_night.location_source, "manual");
    }
}
