//! Crash diagnostics — capture an unhandled-panic report to the temp dir.
//!
//! FEATURE-PARITY F10.6: CareUEyes auto-saves a crash dump to `%temp%` on crash.
//! We install a panic hook that writes a timestamped text report (message,
//! location, backtrace) to `%TEMP%/dimread-crash-<epoch_ms>.log`, then chains
//! the previously-installed hook so the normal logging/abort behaviour is
//! preserved. This is a best-effort diagnostic artifact — not a full native
//! minidump — but it gives support a stack to work from where there was nothing.

use std::any::Any;
use std::backtrace::Backtrace;
use std::io::Write as _;
use std::panic::{self, PanicHookInfo};
use std::time::{SystemTime, UNIX_EPOCH};

/// Install the crash-report panic hook. Call once, as early as possible in
/// `run` (before any thread that might panic is spawned).
pub fn install() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        write_crash_report(info);
        // A panic on the smooth-transition worker, the autodark deadline worker, or the
        // blur tracker would otherwise leave the screen tinted and the taskbar
        // transparent. This is the one abnormal-exit path that can still run
        // code with the in-memory snapshots intact, so undo the system state
        // here BEFORE chaining into the aborting hook.
        crate::app_exit::restore_system_state();
        previous(info);
    }));
}

/// Best-effort: serialize the panic to a timestamped file in the temp dir.
fn write_crash_report(info: &PanicHookInfo<'_>) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let path = std::env::temp_dir().join(format!("dimread-crash-{millis}.log"));
    let location = info.location().map_or_else(
        || "unknown".to_string(),
        |l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
    );
    let message = payload_str(info.payload());
    let backtrace = Backtrace::force_capture();
    let report = format!(
        "DimRead crash report\nversion: {}\ntime_ms: {millis}\nlocation: {location}\nmessage: {message}\n\nbacktrace:\n{backtrace}\n",
        env!("CARGO_PKG_VERSION"),
    );
    if let Ok(mut file) = std::fs::File::create(&path) {
        let _ = file.write_all(report.as_bytes());
    }
    log::error!(
        "[crash] panic at {location}: {message} (report: {})",
        path.display()
    );
}

/// Extract a human-readable message from a panic payload (`&str` / `String`).
fn payload_str(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::payload_str;

    #[test]
    fn payload_str_extracts_str_and_string() {
        let borrowed: &str = "boom";
        assert_eq!(payload_str(&borrowed), "boom");
        let owned: String = "kaboom".to_string();
        assert_eq!(payload_str(&owned), "kaboom");
        let other: i32 = 5;
        assert_eq!(payload_str(&other), "<non-string panic payload>");
    }
}
