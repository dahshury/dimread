//! DimRead — Rust shell.
//!
//! Boot order (`run`):
//!   1. `portable::init()` — detect the portable marker before anything reads
//!      a data path.
//!   2. Build the specta command/event registry and register plugins.
//!   3. `setup`: mount events, initialize the settings store ON THE MAIN
//!      THREAD (see `settings::store`), manage the download registry, build
//!      the APP window eagerly (programmatically, so portable mode can
//!      redirect the WebView2 user-data folder), restore its position, create
//!      the tray, reconcile autostart, then let the renderer reveal the window.
//!      Secondary-window prewarming begins after the page loads.
//!
//! The app has ONE top-level window — `windows::PRIMARY_WINDOW`, the settings
//! window. It carries the live quick controls at the top of its Display tab, so
//! there is no separate "main" panel and no second taskbar surface.
//!
//! There is deliberately NO splash screen: the app window paints fast. If your
//! app grows a heavy boot phase, WinSTT's splash + deferred-startup-thread
//! pattern is the reference to port.

mod app_exit;
mod bootstrap;
mod commands_registry;
mod crash;
pub mod display;
pub mod downloads;
pub mod events;
pub mod focus;
pub mod hotkeys;
pub mod magicx;
pub mod overlay;
pub mod portable;
pub mod rules;
pub mod session_guard;
pub mod settings;
pub mod tray;
pub mod tray_menu;
mod window_state;
pub mod windows;

#[cfg(test)]
use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri::Manager;

pub use commands_registry::make_specta_builder;

pub fn run() {
    // Install the crash-report panic hook first, so a panic anywhere in boot or
    // runtime leaves a diagnostic artifact in %temp% (FEATURE-PARITY F10.6).
    crash::install();

    // Detect portable mode before anything else.
    portable::init();

    let specta_builder = make_specta_builder();
    let invoke_handler = specta_builder.invoke_handler();

    let builder = bootstrap::plugins::install_runtime_plugins(tauri::Builder::default());

    let app = match builder
        .on_page_load(|webview, payload| {
            focus::blur::on_page_load(webview.label(), payload.event());
            if webview.label() == windows::PRIMARY_WINDOW
                && payload.event() == tauri::webview::PageLoadEvent::Finished
            {
                windows::on_primary_page_loaded(webview.app_handle());
            }
        })
        .setup(move |app| {
            let app_handle = app.handle().clone();
            windows::record_main_thread();
            specta_builder.mount_events(app);

            // Build the settings store handle HERE — on the main (event-loop)
            // thread — before any background thread reads settings (the store
            // constructor clones the AppHandle, which is not safe off-thread
            // on the Wry runtime).
            settings::store::init_settings_store(&app_handle);

            // Did the previous run die with a filter still on the display (or a
            // transparent taskbar)? Read the recovery journal BEFORE any engine
            // snapshots the current system state — `display::engine::init`
            // consumes this to repair the monitors first, so it captures the
            // true originals rather than our own stranded tint.
            let stale_session = session_guard::init(&app_handle);
            if let Some(policy) = stale_session.as_ref().and_then(|s| s.taskbar_accent) {
                magicx::theme::recover_taskbar_accent(policy);
            }

            app_handle.manage(downloads::manager::DownloadManager::default());

            // Create the app window eagerly, from its `WINDOW_SPECS` entry, so
            // the one window roster stays in one place. `ensure_window` also
            // applies portable mode's `data_directory` (which redirects the
            // WebView2 profile to Data/) — the reason this is programmatic
            // rather than declared in tauri.conf.json.
            let app_window = windows::ensure_window(&app_handle, windows::PRIMARY_WINDOW)
                .map_err(|err| format!("failed to create the app window: {err}"))?;
            window_state::restore_window_position(&app_handle, &app_window);

            tray::init_tray(&app_handle)?;

            // Converge the OS launch-at-login registration with the persisted
            // setting (the registry entry can be wiped by other tools), then
            // arm the persisted global hotkeys (hot-swapped on later saves).
            let boot_settings = settings::store::read_settings(&app_handle);
            settings::commands::sync_autostart(&app_handle, boot_settings.general.autostart);
            hotkeys::apply_hotkey_settings(&app_handle, &boot_settings.hotkeys);

            // Snapshot original gamma ramps + apply the persisted display
            // settings, start the day/night scheduler (drives day↔night
            // interpolation + re-applies gamma as the clock advances / after
            // wake), then start the per-app rules engine.
            display::engine::init(&app_handle, stale_session.as_ref());
            display::scheduler::init(&app_handle);
            rules::init(&app_handle);

            // Initialise the Focus (F8) + MagicX (F9) engines. Both are
            // no-op-safe stubs at the foundation: they capture the app handle
            // and prepare their seams; the phase-2 slices fill in the runtime.
            focus::init(&app_handle);
            magicx::init(&app_handle);

            // Keep the app window hidden until the renderer has hydrated its
            // settings and painted its first frame. A native fallback prevents
            // a renderer failure from leaving an invisible process running
            // indefinitely.
            window_state::schedule_initial_reveal_fallback(&app_handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == windows::PRIMARY_WINDOW {
                    // A native close of the app window (Alt+F4, the taskbar
                    // context menu) bypasses `close_self_window`, so route it
                    // through the same helper: hide to tray, or quit through
                    // `request_app_exit` so the store plugin gets its flush and
                    // the display filters are restored.
                    window_state::close_primary_window(window.app_handle());
                    return;
                }
                // Secondary windows hide (keep-alive) so re-open preserves
                // renderer state.
                if let Err(err) =
                    windows::close_window_internal(window.app_handle(), window.label())
                {
                    log::warn!("native close of '{}' failed: {err}", window.label());
                }
            }
            tauri::WindowEvent::Moved(position) => {
                // Remember where the user drags the app window so it reopens
                // there next run. Skip the (-32000, -32000) sentinel Windows
                // reports for a minimized window.
                if window.label() == windows::PRIMARY_WINDOW
                    && position.x > -30000
                    && position.y > -30000
                {
                    window_state::save_window_position(window.app_handle(), position.x, position.y);
                }
            }
            tauri::WindowEvent::ThemeChanged(theme) => {
                log::debug!("Theme changed to: {theme:?}");
                tray::refresh_tray_icon(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(invoke_handler)
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(err) => {
            eprintln!("error while building tauri application: {err}");
            return;
        }
    };

    app.run(|_app, _event| {
        // The catch-all chokepoint for shutdown. The tray Quit and the app
        // window's close button already route through `request_app_exit`, but
        // everything else reaches the event loop's exit WITHOUT passing through
        // it: `app.exit()` called from a plugin, the last window being
        // destroyed, and — the one that matters on Windows — the OS ending the
        // session on logoff/shutdown/restart. `restore_system_state` is
        // idempotent, so the paths that already restored just fall through.
        //
        // Deliberately `Exit` and NOT `ExitRequested`: the latter is a question
        // ("may I exit?") that a handler may `prevent_exit()`, and restoring
        // there would drop the user's filters — and delete the recovery
        // journal — while the app carries on running. `Exit` is the statement.
        if matches!(&_event, tauri::RunEvent::Exit) {
            app_exit::restore_system_state();
        }

        // Tauri exposes these callbacks on every desktop platform. Reconcile
        // wall-clock schedules when the event loop resumes or any app window
        // becomes active; the scheduler coalesces duplicate notifications.
        if matches!(
            &_event,
            tauri::RunEvent::Resumed
                | tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::Focused(true),
                    ..
                }
        ) {
            display::scheduler::notify_app_activity();
        }

        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &_event {
            window_state::show_primary_window(_app);
        }
    });
}

// ── TypeScript bindings export ──────────────────────────────────────────────
// `cargo test export_bindings` regenerates `src/bindings.ts` from the live
// command/event registry; CI re-runs it and asserts the checked-in file is up
// to date. The post-processing below tightens the generated output (drops the
// unused TAURI_CHANNEL import, replaces `as any` casts with typed helpers).

#[cfg(test)]
fn export_typescript_bindings(
    builder: &tauri_specta::Builder<tauri::Wry>,
    path: &str,
) -> Result<(), String> {
    builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::Number),
            path,
        )
        .map_err(|err| format!("failed to export TypeScript bindings: {err}"))?;
    post_process_typescript_bindings(path)
        .map_err(|err| format!("failed to post-process TypeScript bindings: {err}"))?;
    Ok(())
}

#[cfg(test)]
fn post_process_typescript_bindings(path: &str) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let processed = strip_unused_tauri_channel_import(&text);
    let processed = normalize_generated_result_errors(&processed);
    let processed = replace_generated_event_helper(&processed);
    let processed = trim_trailing_whitespace(&processed);

    if processed != text {
        std::fs::write(path, processed)?;
    }

    Ok(())
}

#[cfg(test)]
fn strip_unused_tauri_channel_import(text: &str) -> String {
    let generated_import_lf = "import {\n\tinvoke as TAURI_INVOKE,\n\tChannel as TAURI_CHANNEL,\n} from \"@tauri-apps/api/core\";";
    let generated_import_crlf = generated_import_lf.replace('\n', "\r\n");
    let cleaned_import = "import { invoke as TAURI_INVOKE } from \"@tauri-apps/api/core\";";

    text.replace(generated_import_lf, cleaned_import)
        .replace(&generated_import_crlf, cleaned_import)
}

#[cfg(test)]
fn normalize_generated_result_errors(text: &str) -> String {
    let without_error_casts = text
        .replace(
            "return { status: \"error\", error: e  as any };",
            "return __commandError__(e);",
        )
        .replace(
            "return { status: \"error\", error: e as any };",
            "return __commandError__(e);",
        );

    if without_error_casts.contains("function __commandError__") {
        return without_error_casts;
    }

    let newline = preferred_typescript_newline(&without_error_casts);
    let result_type_lf = "export type Result<T, E> =\n\t| { status: \"ok\"; data: T }\n\t| { status: \"error\"; error: E };\n";
    let result_type = normalize_newlines(result_type_lf, newline);
    let helper = normalize_newlines(COMMAND_ERROR_HELPER_LF, newline);
    let replacement = format!("{result_type}{newline}{helper}");

    without_error_casts.replacen(&result_type, &replacement, 1)
}

#[cfg(test)]
fn replace_generated_event_helper(text: &str) -> String {
    let start_marker = "function __makeEvents__<T extends Record<string, any>>(";
    let Some(start) = text.find(start_marker) else {
        return text.to_string();
    };

    let newline = preferred_typescript_newline(text);
    let helper = normalize_newlines(EVENT_HELPER_LF, newline);
    let mut processed = String::with_capacity(start + helper.len() + 1);
    processed.push_str(&text[..start]);
    processed.push_str(&helper);
    if text.ends_with('\n') {
        processed.push_str(newline);
    }
    processed
}

#[cfg(test)]
fn preferred_typescript_newline(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

#[cfg(test)]
fn normalize_newlines(text: &str, newline: &str) -> String {
    if newline == "\r\n" {
        text.replace('\n', "\r\n")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
const COMMAND_ERROR_HELPER_LF: &str = "function __commandError__<E>(error: unknown): { status: \"error\"; error: E } {\n\treturn { status: \"error\", error: error as E };\n}\n";

#[cfg(test)]
const EVENT_HELPER_LF: &str = r#"type __EventAccessor__<T> = __EventObj__<T> & {
	(handle: __WebviewWindow__): __EventObj__<T>;
};

type __EventMap__<T extends object> = {
	[K in keyof T]: __EventAccessor__<T[K]>;
};

function __makeWindowEventObj__<T>(
	name: string,
	window: __WebviewWindow__,
): __EventObj__<T> {
	return {
		listen: (cb) => window.listen<T>(name, cb),
		once: (cb) => window.once<T>(name, cb),
		emit: ((payload?: T) =>
			window.emit(name, payload)) as __EventObj__<T>["emit"],
	};
}

function __makeGlobalEventObj__<T>(name: string): __EventObj__<T> {
	return {
		listen: (cb) => TAURI_API_EVENT.listen<T>(name, cb),
		once: (cb) => TAURI_API_EVENT.once<T>(name, cb),
		emit: ((payload?: T) =>
			TAURI_API_EVENT.emit(name, payload)) as __EventObj__<T>["emit"],
	};
}

function __makeEventAccessor__<T>(name: string): __EventAccessor__<T> {
	const eventObj = __makeGlobalEventObj__<T>(name);
	const accessor = ((window: __WebviewWindow__) =>
		__makeWindowEventObj__<T>(name, window)) as __EventAccessor__<T>;
	accessor.listen = eventObj.listen;
	accessor.once = eventObj.once;
	accessor.emit = eventObj.emit;
	return accessor;
}

function __makeEvents__<T extends object>(
	mappings: Record<keyof T, string>,
): __EventMap__<T> {
	return new Proxy({} as __EventMap__<T>, {
		get: (_, event: string | symbol) =>
			__makeEventAccessor__<T[keyof T]>(mappings[event as keyof T]),
	});
}"#;

#[cfg(test)]
fn trim_trailing_whitespace(text: &str) -> String {
    let mut trimmed = String::with_capacity(text.len());

    for segment in text.split_inclusive('\n') {
        let (line, newline) = if let Some(line) = segment.strip_suffix("\r\n") {
            (line, "\r\n")
        } else if let Some(line) = segment.strip_suffix('\n') {
            (line, "\n")
        } else {
            (segment, "")
        };
        trimmed.push_str(line.trim_end_matches([' ', '\t']));
        trimmed.push_str(newline);
    }

    trimmed
}

#[cfg(test)]
mod bindings_export_tests {
    use super::{export_typescript_bindings, make_specta_builder};

    /// Regenerates `src/bindings.ts` from the live command/event registry.
    /// Run `cargo test` to refresh it; CI re-runs this then `git diff
    /// --exit-code src/bindings.ts` asserts the checked-in file is up to date.
    #[test]
    fn export_bindings() {
        export_typescript_bindings(&make_specta_builder(), "../src/bindings.ts")
            .expect("Failed to export typescript bindings");
    }
}
