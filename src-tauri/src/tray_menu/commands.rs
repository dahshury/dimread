//! IPC surface for the tray flyout. Every command is scoped to the `tray-menu`
//! webview — no other window may drive the popup's geometry.

use tauri::{AppHandle, LogicalSize};

use super::TRAY_MENU_LABEL;

/// Reject a call that did not originate in the popup itself.
fn assert_is_tray_menu(webview: &tauri::WebviewWindow) -> Result<(), String> {
    if webview.label() == TRAY_MENU_LABEL {
        return Ok(());
    }
    log::warn!("[tray-menu] blocked call from window '{}'", webview.label());
    Err(format!(
        "window '{}' may not drive the tray menu",
        webview.label()
    ))
}

/// `tray_menu_hide` — dismiss the popup (an item was activated, or Escape).
#[tauri::command]
#[specta::specta]
pub fn tray_menu_hide(app: AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    assert_is_tray_menu(&webview)?;
    super::hide(&app);
    Ok(())
}

/// `tray_menu_resize` — size the OS window to the renderer's measured content
/// (its `ResizeObserver` reports every change) and re-clamp against the tray
/// anchor so growth never pushes the popup under the taskbar.
///
/// The no-op guard matters: `ResizeObserver` fires on every reflow (hover, a
/// focus ring, subpixel rounding), and an unguarded `set_size` would loop
/// resize → `Resized` → re-anchor → jitter.
#[tauri::command]
#[specta::specta]
pub fn tray_menu_resize(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    assert_is_tray_menu(&webview)?;
    let next_w = width.max(1.0).ceil();
    let next_h = height.max(1.0).ceil();
    let scale = webview.scale_factor().unwrap_or(1.0);
    let current = webview.inner_size().ok().map(|size| {
        (
            (f64::from(size.width) / scale).round(),
            (f64::from(size.height) / scale).round(),
        )
    });
    if current == Some((next_w, next_h)) {
        return Ok(());
    }
    // Mark the resize BEFORE it lands: `set_size` bounces WebView2's focus, and
    // the blur handler must already see the grace when that arrives.
    super::note_resize();
    webview
        .set_size(LogicalSize::new(next_w, next_h))
        .map_err(|e| e.to_string())?;
    super::reanchor(&app);
    Ok(())
}
