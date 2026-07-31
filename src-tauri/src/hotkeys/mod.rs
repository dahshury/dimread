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

/// Persisted bindings that could not be armed at startup/hot-swap. Keeping
/// these separate from `REGISTERED` lets the UI distinguish "saved" from
/// "actually active" without pretending Tauri's process-local
/// `is_registered` can see another application.
static UNAVAILABLE: Mutex<BTreeMap<String, (String, String)>> = Mutex::new(BTreeMap::new());

fn lock_registry() -> std::sync::MutexGuard<'static, BTreeMap<String, String>> {
    REGISTERED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_unavailable() -> std::sync::MutexGuard<'static, BTreeMap<String, (String, String)>> {
    UNAVAILABLE
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

#[cfg(target_os = "windows")]
fn validate_windows_reserved(tokens: &[String]) -> Result<(), String> {
    let has = |token: &str| tokens.iter().any(|part| part == token);
    let has_any = |candidates: &[&str]| candidates.iter().any(|token| has(token));

    if has_any(&["win", "windows", "super", "meta", "command", "cmd"]) {
        return Err("Windows-key shortcuts are reserved by the operating system".into());
    }
    if has("f12") {
        return Err("F12 is reserved by Windows for debuggers".into());
    }
    if has_any(&["printscreen", "printscrn", "prtsc", "snapshot"]) {
        return Err("Print Screen shortcuts are reserved by Windows".into());
    }

    let ctrl = has_any(&["ctrl", "control"]);
    let alt = has_any(&["alt", "option"]);
    let shift = has("shift");
    let reserved = (ctrl && alt && has("delete"))
        || (alt && has("tab"))
        || (alt && has("f4"))
        || (ctrl && has_any(&["escape", "esc"]))
        || (ctrl && shift && has_any(&["escape", "esc"]));
    if reserved {
        return Err("this shortcut is reserved by Windows".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn validate_windows_reserved(_tokens: &[String]) -> Result<(), String> {
    Ok(())
}

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
    validate_windows_reserved(&tokens)?;
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

    let handler_id = id.to_string();
    let handler_accel = canonical.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app_handle, fired, event| {
            if fired == &shortcut && event.state == ShortcutState::Pressed {
                on_hotkey_triggered(app_handle, &handler_id, &handler_accel);
            }
        })
        .map_err(|e| format!("couldn't register '{canonical}': {e}"))?;

    // The OS registration above is the availability check and the reservation.
    // Keep it claimed while committing the swap; probing and releasing here
    // would create a race with another application.
    if let Some(previous) = previous.as_deref()
        && !previous
            .parse::<Shortcut>()
            .is_ok_and(|old| old == shortcut)
        && let Err(err) = unregister_shortcut_string(app, previous)
    {
        let rollback = unregister_shortcut_string(app, &canonical);
        return Err(match rollback {
            Ok(()) => format!("couldn't replace '{previous}': {err}"),
            Err(rollback_err) => format!(
                "couldn't replace '{previous}': {err}; candidate rollback also failed: {rollback_err}"
            ),
        });
    }

    lock_registry().insert(id.to_string(), canonical);
    lock_unavailable().remove(id);
    Ok(())
}

/// Unregister the binding for `id`. Unknown ids are a silent no-op so
/// settings-driven disarms stay idempotent.
pub(crate) fn unregister_hotkey_internal(app: &AppHandle, id: &str) -> Result<(), String> {
    let Some(accelerator) = lock_registry().get(id).cloned() else {
        lock_unavailable().remove(id);
        return Ok(());
    };
    unregister_shortcut_string(app, &accelerator)?;
    lock_registry().remove(id);
    lock_unavailable().remove(id);
    Ok(())
}

fn unregister_shortcut_string(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let Ok(shortcut) = accelerator.parse::<Shortcut>() else {
        return Ok(());
    };
    if !app.global_shortcut().is_registered(shortcut) {
        return Ok(());
    }
    app.global_shortcut()
        .unregister(shortcut)
        .map_err(|err| format!("failed to unregister '{accelerator}': {err}"))
}

/// The complete persisted roster in UI order. Keeping it centralized is what
/// makes whole-section reconfiguration coherent: a two-row swap is validated
/// as the desired end state instead of being rejected halfway through because
/// the first row still sees the second row's old registration.
fn configured_bindings(h: &HotkeysSettings) -> [(&'static str, &str); 12] {
    [
        ("brightnessUp", h.brightness_up.as_str()),
        ("brightnessDown", h.brightness_down.as_str()),
        ("tempUp", h.temp_up.as_str()),
        ("tempDown", h.temp_down.as_str()),
        ("toggleFilter", h.toggle_filter.as_str()),
        ("toggleReading", h.toggle_reading.as_str()),
        ("toggleEditing", h.toggle_editing.as_str()),
        (TOGGLE_MAIN_ID, h.toggle_main.as_str()),
        ("focusRead", h.focus_read.as_str()),
        ("focusBlur", h.focus_blur.as_str()),
        ("magicDark", h.magic_dark.as_str()),
        ("magicGray", h.magic_gray.as_str()),
    ]
}

/// Validate a desired roster before touching the OS. Exact duplicate parsed
/// shortcuts make BOTH rows unavailable; subset/superset chords remain valid
/// because the global-shortcut backend matches complete accelerators.
fn validate_desired_bindings(bindings: &[(&'static str, &str)]) -> BTreeMap<String, String> {
    let mut errors = BTreeMap::new();
    let mut parsed: Vec<(&str, &str, Shortcut)> = Vec::new();
    for (id, raw) in bindings {
        let accelerator = raw.trim();
        if accelerator.is_empty() {
            continue;
        }
        let shortcut = match validate_accelerator(accelerator) {
            Ok(shortcut) => shortcut,
            Err(error) => {
                errors.insert((*id).to_string(), error);
                continue;
            }
        };
        for (other_id, other_accelerator, other_shortcut) in &parsed {
            if other_shortcut == &shortcut {
                errors.insert(
                    (*id).to_string(),
                    format!("'{accelerator}' is already assigned to hotkey '{other_id}'"),
                );
                errors.entry((*other_id).to_string()).or_insert_with(|| {
                    format!("'{other_accelerator}' is also assigned to hotkey '{id}'")
                });
            }
        }
        parsed.push((id, accelerator, shortcut));
    }
    errors
}

/// Arm/disarm every persisted hotkey from the settings tree. Called once at
/// startup and after every hotkeys-section save. Existing managed bindings are
/// released as a roster before the desired roster is armed, which makes swaps
/// work and guarantees a failed desired binding cannot leave a hidden stale
/// accelerator active under that id. Individual OS failures are reported by
/// `hotkey_list` and never reject the settings save.
pub fn apply_hotkey_settings(app: &AppHandle, hotkeys: &HotkeysSettings) {
    let bindings = configured_bindings(hotkeys);
    let mut errors = validate_desired_bindings(&bindings);

    // Release the complete managed roster first. Unknown ids registered by a
    // future extension remain untouched.
    for (id, _) in &bindings {
        if let Err(error) = unregister_hotkey_internal(app, id) {
            errors.entry((*id).to_string()).or_insert(error);
        }
    }

    {
        let mut unavailable = lock_unavailable();
        for (id, _) in &bindings {
            unavailable.remove(*id);
        }
    }

    for (id, raw) in bindings {
        let accelerator = raw.trim();
        if accelerator.is_empty() {
            continue;
        }
        if let Some(error) = errors.get(id) {
            lock_unavailable().insert(id.to_string(), (accelerator.to_string(), error.clone()));
            log::warn!("[hotkeys] failed to arm '{id}' = '{accelerator}': {error}");
            continue;
        }
        if let Err(error) = register_hotkey_internal(app, id, accelerator) {
            lock_unavailable().insert(id.to_string(), (accelerator.to_string(), error.clone()));
            log::warn!("[hotkeys] failed to arm '{id}' = '{accelerator}': {error}");
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// One configured shortcut's runtime status, as reported by `hotkey_list`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyInfo {
    pub id: String,
    pub accelerator: String,
    pub active: bool,
    pub error: Option<String>,
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

/// `hotkey_list` — every active or unavailable shortcut, sorted by id.
#[tauri::command]
#[specta::specta]
pub fn hotkey_list() -> Vec<HotkeyInfo> {
    let registered = lock_registry();
    let unavailable = lock_unavailable();
    let mut rows: BTreeMap<String, HotkeyInfo> = registered
        .iter()
        .map(|(id, accelerator)| {
            (
                id.clone(),
                HotkeyInfo {
                    id: id.clone(),
                    accelerator: accelerator.clone(),
                    active: true,
                    error: None,
                },
            )
        })
        .collect();
    for (id, (accelerator, error)) in unavailable.iter() {
        rows.insert(
            id.clone(),
            HotkeyInfo {
                id: id.clone(),
                accelerator: accelerator.clone(),
                active: false,
                error: Some(error.clone()),
            },
        );
    }
    rows.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::{configured_bindings, validate_accelerator, validate_desired_bindings};
    use crate::settings::HotkeysSettings;

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
        for accel in ["Ctrl+Shift+Space", "Alt+ArrowUp", "F5"] {
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
    fn configured_roster_contains_every_persisted_binding_once() {
        let hotkeys = HotkeysSettings::default();
        let bindings = configured_bindings(&hotkeys);
        assert_eq!(bindings.len(), 12);
        let ids: std::collections::BTreeSet<_> = bindings.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids.len(), bindings.len());
        assert!(ids.contains("toggleMain"));
        assert!(ids.contains("focusRead"));
        assert!(ids.contains("magicGray"));
    }

    #[test]
    fn desired_roster_rejects_exact_duplicates_but_allows_supersets() {
        let bindings = [
            ("first", "Ctrl+V"),
            ("second", "Shift+Ctrl+V"),
            ("third", "ctrl+v"),
        ];
        let errors = validate_desired_bindings(&bindings);
        assert!(errors.contains_key("first"));
        assert!(!errors.contains_key("second"));
        assert!(errors.contains_key("third"));
    }

    #[test]
    fn rejects_garbage_tokens() {
        assert!(validate_accelerator("Ctrl+NotAKey").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_windows_reserved_shortcuts() {
        for accel in [
            "F12",
            "Ctrl+Alt+Delete",
            "Alt+Tab",
            "Alt+F4",
            "Ctrl+Escape",
            "Ctrl+Shift+Escape",
            "PrintScreen",
            "Super+K",
        ] {
            assert!(
                validate_accelerator(accel).is_err(),
                "expected '{accel}' to be reserved"
            );
        }
    }
}
