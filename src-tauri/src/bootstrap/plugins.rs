//! Runtime plugin registration, split out of `lib.rs` so the boot sequence
//! reads as one declarative block.

use tauri::{Builder, Wry};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{
    Builder as LogBuilder, RotationStrategy, Target, TargetKind, TimezoneStrategy,
};

pub(crate) fn install_runtime_plugins(builder: Builder<Wry>) -> Builder<Wry> {
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(build_log_plugin());

    // Single-instance: a second launch focuses the existing app window
    // instead of starting another process. Disabled in debug builds so a
    // packaged install can run beside `tauri dev`.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        crate::window_state::show_primary_window(app);
    }));

    // Updater: opt-in. Registering the plugin requires a `plugins.updater`
    // block in tauri.conf.json (endpoints + minisign pubkey), which a starter
    // template cannot ship. Once you have release signing keys, add that
    // config block and re-enable:
    //     .plugin(tauri_plugin_updater::Builder::new().build())
    builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
}

fn build_log_plugin() -> tauri::plugin::TauriPlugin<Wry> {
    LogBuilder::new()
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        // Match the user's clock (and Vite's timestamps) instead of mixing UTC
        // backend lines with local-time renderer lines in the same console.
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(500_000)
        .rotation_strategy(RotationStrategy::KeepOne)
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stdout),
            // Portable installs log next to their data; otherwise the OS log dir.
            Target::new(if let Some(data_dir) = crate::portable::data_dir() {
                TargetKind::Folder {
                    path: data_dir.join("logs"),
                    file_name: Some("dimread".into()),
                }
            } else {
                TargetKind::LogDir {
                    file_name: Some("dimread".into()),
                }
            }),
        ])
        .build()
}
