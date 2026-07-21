use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

/// Portable mode support.
///
/// When a file named `portable` (containing the magic string below) exists next
/// to the executable, all user data (settings, downloads, logs) is stored in a
/// `Data/` directory alongside the executable instead of the OS app-data dir.
static PORTABLE_DATA_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Magic string the `portable` marker file must start with. An empty or
/// unrelated file next to the exe (created by a package manager, say) must NOT
/// silently flip the app portable.
const PORTABLE_MARKER_MAGIC: &str = "DimRead Portable Mode";

/// Detect portable mode by looking for the `portable` marker file next to the
/// exe. Must be called once at startup before Tauri initializes — so the
/// diagnostics below use `eprintln!` (the tauri log plugin is attached later
/// and would drop a `log::` call made this early).
pub fn init() {
    PORTABLE_DATA_DIR.get_or_init(|| {
        let exe_path = std::env::current_exe().ok()?;
        let exe_dir = exe_path.parent()?;

        if !is_valid_portable_marker(&exe_dir.join("portable")) {
            return None;
        }
        let data_dir = exe_dir.join("Data");
        if !data_dir.exists() {
            std::fs::create_dir_all(&data_dir).ok()?;
        }
        eprintln!("[portable] data dir: {}", data_dir.display());
        Some(data_dir)
    });
}

/// Returns `true` if running in portable mode.
pub fn is_portable() -> bool {
    PORTABLE_DATA_DIR.get().and_then(|v| v.as_ref()).is_some()
}

/// Get the portable data dir (if active). Does not require an AppHandle.
/// Returns `None` when not in portable mode.
pub fn data_dir() -> Option<&'static PathBuf> {
    PORTABLE_DATA_DIR.get().and_then(|v| v.as_ref())
}

/// Portable-aware replacement for `app.path().app_data_dir()`.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, tauri::Error> {
    if let Some(dir) = data_dir() {
        Ok(dir.clone())
    } else {
        app.path().app_data_dir()
    }
}

/// Get the path to use with `tauri-plugin-store`.
/// Returns an absolute path in portable mode (so the store plugin writes to
/// the portable Data dir) or the original relative path otherwise (the plugin
/// resolves relative paths against the app-data dir).
pub fn store_path(relative: &str) -> PathBuf {
    if let Some(dir) = data_dir() {
        dir.join(relative)
    } else {
        PathBuf::from(relative)
    }
}

/// Check if a marker file path contains the portable magic string.
/// Extracted for testability.
fn is_valid_portable_marker(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|s| s.trim().starts_with(PORTABLE_MARKER_MAGIC))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn valid_magic_string_enables_portable() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("portable");
        let mut f = std::fs::File::create(&marker).unwrap();
        write!(f, "{PORTABLE_MARKER_MAGIC}").unwrap();
        assert!(is_valid_portable_marker(&marker));
    }

    #[test]
    fn empty_file_does_not_enable_portable() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("portable");
        std::fs::File::create(&marker).unwrap();
        assert!(!is_valid_portable_marker(&marker));
    }

    #[test]
    fn wrong_content_does_not_enable_portable() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("portable");
        std::fs::write(&marker, "some other content").unwrap();
        assert!(!is_valid_portable_marker(&marker));
    }

    #[test]
    fn missing_file_does_not_enable_portable() {
        assert!(!is_valid_portable_marker(std::path::Path::new(
            "/nonexistent/portable"
        )));
    }

    #[test]
    fn magic_string_with_whitespace_enables_portable() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("portable");
        std::fs::write(&marker, format!("  {PORTABLE_MARKER_MAGIC}\n")).unwrap();
        assert!(is_valid_portable_marker(&marker));
    }
}
