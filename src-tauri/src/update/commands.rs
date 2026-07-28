//! The renderer-facing surface of [`crate::update`].

use tauri::AppHandle;

use super::UpdateCheck;

/// `update_check` — ask GitHub whether a newer release than the running build
/// exists. Manual only: the About tab's button is the sole caller, so DimRead
/// never phones home on its own.
///
/// The version compared is the one baked into the bundle
/// (`tauri.conf.json` → `package_info`), not a stored setting, so a downgrade
/// or a portable copy still reports the truth.
#[tauri::command]
#[specta::specta]
pub async fn update_check(app: AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    super::check(&current).await
}
