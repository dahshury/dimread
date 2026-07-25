//! Global hotkeys on top of tauri-plugin-global-shortcut.
//!
//! Universal wiring (pattern distilled from WinSTT's shortcut module):
//!   * a process-wide registry `id → accelerator` so re-registering an id
//!     REPLACES its accelerator and duplicate accelerators across different
//!     ids are rejected with a typed error string,
//!   * validation BEFORE touching the live registration (an invalid
//!     replacement never disarms a working binding),
//!   * every trigger (key-down edge) emits the `hotkey:triggered` specta
//!     event; built-in behaviors (the `toggleMain` id toggles main-window
//!     visibility) run Rust-side first so they work with no renderer focused,
//!   * `apply_hotkey_settings` arms the persisted `settings.hotkeys` section —
//!     called at startup AND on every hotkeys-section save (hot-swap, no
//!     restart; see `settings::commands::settings_save`).
//!
//! Accelerators use Tauri's token vocabulary ("Ctrl+Shift+Space", "F5",
//! "Alt+ArrowUp"); the renderer's HotkeyRecorder emits that format directly.

pub mod actions;

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_specta::Event as _;

use crate::events::HotkeyTriggeredEvent;
use crate::settings::HotkeysSettings;

/// The built-in binding id wired to main-window visibility.
pub const TOGGLE_MAIN_ID: &str = "toggleMain";

/// Live registrations: id → the accelerator string it is bound to.
static REGISTERED: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

fn lock_registry() -> std::sync::MutexGuard<'static, BTreeMap<String, String>> {
    REGISTERED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Modifier token vocabulary accepted by the plugin's accelerator parser.
const MODIFIER_TOKENS: &[&str] = &[
    "ctrl",
    "control",
    "shift",
    "alt",
    "option",
    "meta",
    "command",
    "cmd",
    "super",
    "win",
    "windows",
    "commandorcontrol",
    "cmdorctrl",
];

/// Validate + parse an accelerator for the Tauri global-shortcut backend:
/// non-empty, no `fn` key (unsupported), and at least one non-modifier main
/// key (modifier-only global shortcuts are not supported by the plugin).
pub(crate) fn validate_accelerator(raw: &str) -> Result<Shortcut, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("hotkey accelerator must not be empty".into());
    }
    let tokens: Vec<String> = raw
        .split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect();
    if tokens.iter().any(|t| t == "fn" || t == "function") {
        return Err("the 'fn' key is not supported by global shortcuts".into());
    }
    if !tokens
        .iter()
        .any(|t| !MODIFIER_TOKENS.contains(&t.as_str()))
    {
        return Err(
            "hotkey must include a main key (letter, number, F-key, …) in addition to modifiers"
                .into(),
        );
    }
    raw.parse::<Shortcut>()
        .map_err(|e| format!("invalid accelerator '{raw}': {e}"))
}

/// Trigger path: run the built-in behavior for well-known ids, then broadcast
/// `hotkey:triggered` so renderers can react (demo toasts, app features).
fn on_hotkey_triggered(app: &AppHandle, id: &str, accelerator: &str) {
    if id == TOGGLE_MAIN_ID {
        toggle_main_window(app);
    }
    // Display-hotkey effects (brightness/temp steps, mode toggles) live in
    // `actions`; unknown ids are ignored there, so the call is unconditional.
    actions::handle_action(app, id);
    if let Err(err) = (HotkeyTriggeredEvent {
        id: id.to_string(),
        accelerator: accelerator.to_string(),
    })
    .emit(app)
    {
        log::warn!("[hotkeys] failed to emit hotkey:triggered for '{id}': {err}");
    }
}

/// Built-in `toggleMain` behavior: hide the visible app window, or surface +
/// focus it (native, so it works while no app window has focus).
///
/// The hotkey id stays `toggleMain` because it is a persisted settings field
/// (`hotkeys.toggleMain`); the window it toggles is
/// [`crate::windows::PRIMARY_WINDOW`] — the app's only top-level window.
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(crate::windows::PRIMARY_WINDOW) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if visible && !minimized {
        crate::window_state::hide_primary_window(app);
    } else {
        crate::window_state::show_primary_window(app);
    }
}

/// Register (or REPLACE) the binding for `id`. Duplicate accelerators across
/// different ids and invalid accelerators are rejected with a typed error
/// string; re-registering an id with its current accelerator is an idempotent
/// repair (re-arms a lost OS registration).
pub(crate) fn register_hotkey_internal(
    app: &AppHandle,
    id: &str,
    accelerator: &str,
) -> Result<(), String> {
    let shortcut = validate_accelerator(accelerator)?;
    let canonical = accelerator.trim().to_string();

    let previous = {
        let registry = lock_registry();
        // Reject a combo another id already owns (a silently shadowed shortcut
        // is the confusing failure mode this guard exists for).
        for (other_id, other_accel) in registry.iter() {
            if other_id != id
                && other_accel
                    .parse::<Shortcut>()
                    .is_ok_and(|other| other == shortcut)
            {
                return Err(format!(
                    "'{canonical}' is already in use by hotkey '{other_id}'"
                ));
            }
        }
        registry.get(id).cloned()
    };

    // Idempotent repair: same id + same combo — keep the live registration,
    // re-arming it only if the OS-side registration was lost.
    if let Some(previous) = &previous
        && previous
            .parse::<Shortcut>()
            .is_ok_and(|prev| prev == shortcut)
        && app.global_shortcut().is_registered(shortcut)
    {
        return Ok(());
    }

    // Defensive: the combo is registered with the plugin but not owned by any
    // id in our registry (should not happen through this module's API).
    if previous
        .as_deref()
        .and_then(|p| p.parse::<Shortcut>().ok())
        .is_none_or(|prev| prev != shortcut)
        && app.global_shortcut().is_registered(shortcut)
    {
        return Err(format!("'{canonical}' is already in use"));
    }

    // Replace: drop the id's previous registration before arming the new one.
    if let Some(previous) = previous {
        unregister_shortcut_string(app, &previous);
        lock_registry().remove(id);
    }

    let handler_id = id.to_string();
    let handler_accel = canonical.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app_handle, fired, event| {
            if fired == &shortcut && event.state == ShortcutState::Pressed {
                on_hotkey_triggered(app_handle, &handler_id, &handler_accel);
            }
        })
        .map_err(|e| format!("couldn't register '{canonical}': {e}"))?;

    lock_registry().insert(id.to_string(), canonical);
    Ok(())
}

/// Unregister the binding for `id`. Unknown ids are a silent no-op so
/// settings-driven disarms stay idempotent.
pub(crate) fn unregister_hotkey_internal(app: &AppHandle, id: &str) -> Result<(), String> {
    let Some(accelerator) = lock_registry().remove(id) else {
        return Ok(());
    };
    unregister_shortcut_string(app, &accelerator);
    Ok(())
}

fn unregister_shortcut_string(app: &AppHandle, accelerator: &str) {
    let Ok(shortcut) = accelerator.parse::<Shortcut>() else {
        return;
    };
    if !app.global_shortcut().is_registered(shortcut) {
        return;
    }
    if let Err(err) = app.global_shortcut().unregister(shortcut) {
        log::warn!("[hotkeys] failed to unregister '{accelerator}': {err}");
    }
}

/// Arm/disarm every persisted hotkey from the settings tree. Called once at
/// startup (lib.rs setup) and after every save that changed the `hotkeys`
/// section, so rebinds go live immediately — hot-swap, not startup-only.
/// Failures are logged, never propagated: a stale persisted combo must not
/// fail the save that is trying to fix it.
pub fn apply_hotkey_settings(app: &AppHandle, hotkeys: &HotkeysSettings) {
    apply_one(app, TOGGLE_MAIN_ID, &hotkeys.toggle_main);
    // Arm the seven display-action accelerators (owned by `actions`) so their
    // persisted bindings are live from boot, not only after a re-record.
    actions::apply_action_hotkeys(app, hotkeys);
    // focus-read
    apply_one(app, "focusRead", &hotkeys.focus_read);
}

fn apply_one(app: &AppHandle, id: &str, accelerator: &str) {
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        if let Err(err) = unregister_hotkey_internal(app, id) {
            log::debug!("[hotkeys] '{id}' not disarmed: {err}");
        }
        return;
    }
    if let Err(err) = register_hotkey_internal(app, id, accelerator) {
        log::warn!("[hotkeys] failed to arm '{id}' = '{accelerator}': {err}");
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// One live registration, as reported by `hotkey_list`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyInfo {
    pub id: String,
    pub accelerator: String,
}

/// `hotkey_register` — validate + register `accelerator` under `id` (replacing
/// the id's previous accelerator). Errors with a typed message on an invalid
/// combo or one already owned by another id.
#[tauri::command]
#[specta::specta]
pub fn hotkey_register(app: AppHandle, id: String, accelerator: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("hotkey id must not be empty".into());
    }
    register_hotkey_internal(&app, id, &accelerator)
}

/// `hotkey_unregister` — disarm the binding for `id` (idempotent).
#[tauri::command]
#[specta::specta]
pub fn hotkey_unregister(app: AppHandle, id: String) -> Result<(), String> {
    unregister_hotkey_internal(&app, id.trim())
}

/// `hotkey_list` — every live registration (id + accelerator), sorted by id.
#[tauri::command]
#[specta::specta]
pub fn hotkey_list() -> Vec<HotkeyInfo> {
    lock_registry()
        .iter()
        .map(|(id, accelerator)| HotkeyInfo {
            id: id.clone(),
            accelerator: accelerator.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::validate_accelerator;

    #[test]
    fn rejects_empty_and_whitespace() {
        assert!(validate_accelerator("").is_err());
        assert!(validate_accelerator("   ").is_err());
    }

    #[test]
    fn rejects_modifier_only_and_fn() {
        assert!(validate_accelerator("Ctrl+Shift").is_err());
        assert!(validate_accelerator("Super").is_err());
        assert!(validate_accelerator("Fn+F5").is_err());
    }

    #[test]
    fn accepts_tauri_vocabulary() {
        for accel in [
            "Ctrl+Shift+Space",
            "Alt+ArrowUp",
            "F5",
            "Super+K",
            "Ctrl+Alt+Delete",
        ] {
            assert!(
                validate_accelerator(accel).is_ok(),
                "expected '{accel}' to validate"
            );
        }
    }

    #[test]
    fn parse_is_token_order_and_case_insensitive() {
        let a = validate_accelerator("ctrl+shift+k").unwrap();
        let b = validate_accelerator("Shift+Ctrl+K").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn rejects_garbage_tokens() {
        assert!(validate_accelerator("Ctrl+NotAKey").is_err());
    }
}
