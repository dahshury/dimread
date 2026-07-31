//! Local diagnostics: log access, live log streaming, support bundles, and a
//! bounded in-memory timeline of operational failures.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;
use zip::CompressionMethod;
use zip::write::SimpleFileOptions;

const SETTINGS_WINDOW: &str = "settings";
const MAX_ISSUES: usize = 200;
const MAX_BUNDLED_LOGS: usize = 20;

static ISSUES: OnceLock<Mutex<VecDeque<OperationalIssue>>> = OnceLock::new();
static NEXT_ISSUE_ID: AtomicU64 = AtomicU64::new(1);
static LIVE_LOG_STREAMING: AtomicBool = AtomicBool::new(false);
static LIVE_LOG_APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationalIssue {
    pub id: u64,
    pub timestamp_ms: u64,
    pub severity: String,
    pub area: String,
    pub operation: String,
    pub summary: String,
    pub detail: String,
    pub remediation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticActionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl DiagnosticActionResult {
    fn ok(path: PathBuf) -> Self {
        Self {
            ok: true,
            cancelled: None,
            error: None,
            path: Some(path.to_string_lossy().into_owned()),
        }
    }
    fn cancelled() -> Self {
        Self {
            ok: false,
            cancelled: Some(true),
            error: None,
            path: None,
        }
    }
    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            cancelled: None,
            error: Some(message.into()),
            path: None,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn issue_store() -> &'static Mutex<VecDeque<OperationalIssue>> {
    ISSUES.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_ISSUES)))
}

fn remediation_for(detail: &str) -> &'static str {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("permission") || lower.contains("access is denied") {
        "Check file permissions and security software, then try again."
    } else if lower.contains("space") || lower.contains("disk full") {
        "Free disk space and try the operation again."
    } else if lower.contains("network") || lower.contains("connection") {
        "Check the network connection and retry."
    } else {
        "Retry the operation. If it repeats, save a support bundle."
    }
}

pub(crate) fn record_issue(
    area: impl Into<String>,
    operation: impl Into<String>,
    summary: impl Into<String>,
    detail: impl Into<String>,
) {
    let detail = detail.into();
    let issue = OperationalIssue {
        id: NEXT_ISSUE_ID.fetch_add(1, Ordering::Relaxed),
        timestamp_ms: now_ms(),
        severity: "error".into(),
        area: area.into(),
        operation: operation.into(),
        summary: summary.into(),
        remediation: remediation_for(&detail).into(),
        detail,
    };
    if let Ok(mut issues) = issue_store().lock() {
        while issues.len() >= MAX_ISSUES {
            issues.pop_front();
        }
        issues.push_back(issue);
    }
}

fn recent_issues(limit: Option<usize>) -> Vec<OperationalIssue> {
    let limit = limit.unwrap_or(MAX_ISSUES).min(MAX_ISSUES);
    issue_store()
        .lock()
        .map(|issues| issues.iter().rev().take(limit).cloned().collect())
        .unwrap_or_default()
}

fn clear_issues() -> usize {
    let Ok(mut issues) = issue_store().lock() else {
        return 0;
    };
    let count = issues.len();
    issues.clear();
    count
}

fn authorize_settings(webview: &WebviewWindow, operation: &str) -> Result<(), String> {
    if webview.label() == SETTINGS_WINDOW {
        return Ok(());
    }
    Err(format!(
        "diagnostics operation '{operation}' is not allowed from window '{}'",
        webview.label()
    ))
}

fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = crate::portable::data_dir() {
        return Ok(data_dir.join("logs"));
    }
    app.path().app_log_dir().map_err(|error| error.to_string())
}

fn emit_live_log_record(record: &log::Record<'_>) {
    if record.level() == log::Level::Error {
        record_issue(
            "runtime",
            record.target(),
            "A native operation failed",
            record.args().to_string(),
        );
    }
    if !LIVE_LOG_STREAMING.load(Ordering::Acquire) {
        return;
    }
    let Some(app) = LIVE_LOG_APP.get() else {
        return;
    };
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW) else {
        LIVE_LOG_STREAMING.store(false, Ordering::Release);
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        LIVE_LOG_STREAMING.store(false, Ordering::Release);
        return;
    }
    let payload = crate::events::DiagnosticsLogLineEvent {
        level: record.level().as_str().to_ascii_lowercase(),
        message: record.args().to_string(),
        target: record.target().to_string(),
        timestamp_ms: now_ms(),
    };
    let _ = window.emit("diagnostics:log-line", payload);
}

pub(crate) fn live_log_target() -> Target {
    let dispatch = tauri_plugin_log::fern::Dispatch::new()
        .chain(tauri_plugin_log::fern::Output::call(emit_live_log_record));
    Target::new(TargetKind::Dispatch(dispatch)).filter(|metadata| {
        LIVE_LOG_STREAMING.load(Ordering::Acquire) || metadata.level() == log::Level::Error
    })
}

#[tauri::command]
#[specta::specta]
pub fn diagnostics_set_log_streaming(
    app: AppHandle,
    webview: WebviewWindow,
    enabled: bool,
) -> Result<bool, String> {
    authorize_settings(&webview, "live log streaming")?;
    if enabled {
        let _ = LIVE_LOG_APP.set(app);
    }
    LIVE_LOG_STREAMING.store(enabled, Ordering::Release);
    Ok(enabled)
}

#[tauri::command]
#[specta::specta]
pub fn diagnostics_open_logs_folder(
    app: AppHandle,
    webview: WebviewWindow,
) -> DiagnosticActionResult {
    if let Err(error) = authorize_settings(&webview, "open logs folder") {
        return DiagnosticActionResult::failed(error);
    }
    let result = (|| {
        let directory = logs_dir(&app)?;
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        app.opener()
            .open_path(directory.to_string_lossy(), None::<String>)
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(directory)
    })();
    match result {
        Ok(path) => DiagnosticActionResult::ok(path),
        Err(error) => {
            record_issue(
                "diagnostics",
                "open_logs_folder",
                "The logs folder could not be opened",
                error.clone(),
            );
            DiagnosticActionResult::failed(error)
        }
    }
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

fn default_bundle_name(app: &AppHandle) -> String {
    format!(
        "{}-support-{}.zip",
        safe_file_stem(&app.package_info().name),
        now_ms()
    )
}

fn collect_log_files(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("log"))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    files.truncate(MAX_BUNDLED_LOGS);
    files
}

fn system_info(app: &AppHandle) -> String {
    [
        format!("Application: {}", app.package_info().name),
        format!("Version: {}", app.package_info().version),
        format!("Tauri: {}", tauri::VERSION),
        format!("Platform: {}", std::env::consts::OS),
        format!("Architecture: {}", std::env::consts::ARCH),
        format!("Portable: {}", crate::portable::is_portable()),
    ]
    .join("\n")
}

fn write_bundle(app: &AppHandle, path: &Path) -> Result<(), String> {
    let file = File::create(path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for log_path in collect_log_files(&logs_dir(app)?) {
        let Some(name) = log_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let bytes = std::fs::read(&log_path).map_err(|error| error.to_string())?;
        archive
            .start_file(format!("logs/{name}"), options)
            .map_err(|error| error.to_string())?;
        archive
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
    }
    archive
        .start_file("system-info.txt", options)
        .map_err(|error| error.to_string())?;
    archive
        .write_all(system_info(app).as_bytes())
        .map_err(|error| error.to_string())?;
    archive
        .start_file("operational-issues.json", options)
        .map_err(|error| error.to_string())?;
    let issues =
        serde_json::to_vec_pretty(&recent_issues(None)).map_err(|error| error.to_string())?;
    archive
        .write_all(&issues)
        .map_err(|error| error.to_string())?;
    archive.finish().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn diagnostics_save_bundle(
    app: AppHandle,
    webview: WebviewWindow,
) -> DiagnosticActionResult {
    if let Err(error) = authorize_settings(&webview, "save support bundle") {
        return DiagnosticActionResult::failed(error);
    }
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save Support Bundle")
        .add_filter("Zip archive", &["zip"])
        .set_file_name(default_bundle_name(&app));
    if let Ok(desktop) = app.path().desktop_dir() {
        dialog = dialog.set_directory(desktop);
    }
    let Some(chosen) = dialog.blocking_save_file() else {
        return DiagnosticActionResult::cancelled();
    };
    let path = match chosen.into_path() {
        Ok(path) => path,
        Err(error) => return DiagnosticActionResult::failed(error.to_string()),
    };
    match write_bundle(&app, &path) {
        Ok(()) => DiagnosticActionResult::ok(path),
        Err(error) => {
            record_issue(
                "diagnostics",
                "save_bundle",
                "The support bundle could not be saved",
                error.clone(),
            );
            DiagnosticActionResult::failed(error)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn diagnostics_recent_issues(
    webview: WebviewWindow,
    limit: Option<usize>,
) -> Vec<OperationalIssue> {
    if authorize_settings(&webview, "read operational issues").is_err() {
        return Vec::new();
    }
    recent_issues(limit)
}

#[tauri::command]
#[specta::specta]
pub fn diagnostics_clear_issues(webview: WebviewWindow) -> usize {
    if authorize_settings(&webview, "clear operational issues").is_err() {
        return 0;
    }
    clear_issues()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_stems_are_safe_for_bundle_names() {
        assert_eq!(safe_file_stem("Tauri Starter"), "tauri-starter");
        assert_eq!(safe_file_stem("  DimRead!  "), "dimread");
    }
    #[test]
    fn issue_buffer_returns_newest_first_and_can_clear() {
        clear_issues();
        record_issue("test", "one", "first", "failure one");
        record_issue("test", "two", "second", "failure two");
        let issues = recent_issues(Some(1));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].summary, "second");
        assert_eq!(clear_issues(), 2);
    }
}
