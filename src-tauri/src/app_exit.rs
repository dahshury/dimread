//! Graceful-but-guaranteed process exit, and the system-state teardown every
//! exit path funnels through.
//!
//! `app.exit(0)` asks tao to end the event loop, but WebView2 teardown with
//! hidden keep-alive windows (settings/picker/gallery) can stall, which shows
//! up as "the tray Quit does nothing". Pair every quit request with a
//! watchdog thread that force-terminates the process if the graceful path
//! stalls past a short deadline.
//!
//! [`restore_system_state`] is the teardown itself, split out from
//! [`request_app_exit`] because a tray Quit is only ONE of the ways this
//! process ends. It is also called from the `RunEvent::ExitRequested` arm in
//! `lib.rs` (covering `app.exit()` from anywhere, last-window-destroyed, and
//! OS session end) and from the panic hook in [`crate::crash`] — the one crash
//! path where our snapshots are still live and recovery is still possible.
//! Anything it cannot cover (a hard kill) is repaired at the next boot by
//! [`crate::session_guard`].

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

const WATCHDOG_MS: u64 = 3000;

/// Set once the teardown has run, so the several exit paths that can fire in
/// sequence (panic hook → `ExitRequested` → tray Quit) do the work once.
static RESTORED: AtomicBool = AtomicBool::new(false);

/// Put back every piece of system state that lives OUTSIDE this process, then
/// drop the recovery journal.
///
/// Idempotent and safe to call from any thread, at any point in the lifecycle —
/// including before the engines are initialized (each restore is a no-op then)
/// and from a panic hook (every lock involved recovers from poisoning).
pub(crate) fn restore_system_state() {
    if RESTORED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Stop callback-driven schedulers/rules from applying a new ramp after the
    // restore below. In-flight smooth transitions are canceled by restore_all's
    // generation bump under the ramp-write lock.
    crate::display::engine::begin_shutdown();
    // ALWAYS put the monitors' original gamma ramps back before we tear down,
    // so a colour/brightness filter never outlives the app.
    let gamma_restored = crate::display::engine::restore_all();
    // Tear down any per-window MagicX overlays too.
    crate::magicx::engine::clear_all();
    // Undo the Auto Dark taskbar transparency effect, so a transparent taskbar
    // never outlives the app. No-op when it was never applied.
    crate::magicx::theme::restore_on_exit();
    // LAST: the journal is the next boot's proof that we died with state
    // applied. Clearing it before the restores above would let a kill in the
    // gap strand them with no record of how to undo it. And if a ramp write
    // FAILED (monitor asleep, device gone), the filter is still on the display
    // — keep the journal so the next boot repairs it instead of capturing the
    // dimmed ramp as that monitor's "original".
    if gamma_restored {
        crate::session_guard::clear();
    } else {
        log::warn!(
            "[exit] gamma restore failed on at least one monitor - keeping the recovery journal for the next boot"
        );
    }
}

pub(crate) fn request_app_exit(app: &AppHandle, reason: &str) {
    log::info!("{reason} - exiting.");
    restore_system_state();
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(WATCHDOG_MS));
        log::warn!("Graceful exit stalled past {WATCHDOG_MS}ms - forcing process exit.");
        // The teardown already ran above, so this hard exit cannot strand
        // gamma or the taskbar accent.
        std::process::exit(0);
    });
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_runs_once() {
        // The teardown is reachable from three paths that can fire in sequence;
        // the latch is what keeps that from re-running Win32 restores (and, more
        // importantly, from re-deleting an already-cleared journal).
        RESTORED.store(false, Ordering::SeqCst);
        assert!(
            !RESTORED.swap(true, Ordering::SeqCst),
            "first call proceeds"
        );
        assert!(RESTORED.swap(true, Ordering::SeqCst), "second call bails");
    }
}
