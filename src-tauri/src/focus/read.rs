//! Focus Read (FEATURE-PARITY F8.1) — a horizontal clear band that tracks the
//! cursor while the rest of the screen is dimmed by `settings.focus_read`
//! (`transparency` %, `color`, band `height`).
//!
//! ## Seam (frozen)
//! - [`toggle`] — flip active; returns the new state.
//! - [`is_active`] — current activation.
//! - [`start`] / [`stop`] — force on/off (used by [`toggle`], the hotkey action,
//!   and Blur's mutual-exclusion stop).
//!
//! ## What this slice implements
//! [`start`]:
//!   1. Shows the shared `focus-overlay` window sized/positioned to the whole
//!      virtual screen (see [`crate::windows::virtual_screen_bounds`]) so the
//!      renderer draws the Read shade across every monitor.
//!   2. Registers **Escape** as a global shortcut (via the global-shortcut
//!      plugin) so the user can quit the preview from anywhere without focusing
//!      the click-through overlay.
//!   3. Installs a `WH_MOUSE_LL` callback on a dedicated Windows message-loop
//!      thread. Mouse moves wake a separate emitter thread, which publishes
//!      `focus:cursor { x, y }` ([`crate::events::FocusCursorEvent`]) without
//!      doing Tauri work inside the time-sensitive hook callback. One initial
//!      `GetCursorPos` read snaps the band into place immediately.
//!
//! [`stop`] hides the overlay (unless Blur is taking it over), unregisters
//! Escape, posts `WM_QUIT` to the hook thread, and joins the emitter during
//! hook teardown.
//!
//! Off-Windows the cursor tracker is a no-op, so the crate still builds and the
//! seam stays inert (no band motion) rather than wrong.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::{AppHandle, PhysicalPosition, PhysicalSize};

/// Whether Focus Read currently owns the overlay.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Bumped on every [`start`]/[`stop`] so a superseded cursor tracker cannot emit
/// even across a rapid stop→start.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Whether THIS slice armed the global Escape shortcut (so [`stop`] only
/// unregisters an Escape it actually owns — never one bound by the user).
static ESC_ARMED: AtomicBool = AtomicBool::new(false);

/// The shared full-virtual-screen tint window (see `windows::WINDOW_SPECS`).
const FOCUS_OVERLAY_LABEL: &str = "focus-overlay";

/// Per-sub-engine init hook. No-op in this slice (all state is lazy). Called
/// from [`super::init`].
pub fn init(_app: &AppHandle) {}

/// Whether Focus Read is active.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

/// Flip Focus Read on/off; returns the new active state.
pub fn toggle() -> bool {
    if is_active() {
        stop();
        false
    } else {
        start();
        true
    }
}

/// Force Focus Read on. Stops Focus Blur first (they share the overlay), sets
/// the flag, shows the overlay + arms Escape + starts the cursor tracker, then
/// emits `focus:state`.
pub fn start() {
    // Mutually exclusive with Blur — release the overlay before we claim it.
    super::blur::stop();
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(app) = super::app() {
        show_overlay(&app);
        register_escape(&app);
        start_cursor_tracker(app, generation);
    }
    super::emit_state();
}

/// Force Focus Read off. Idempotent; emits `focus:state` only on a real change.
pub fn stop() {
    if !ACTIVE.swap(false, Ordering::SeqCst) {
        return;
    }
    // Supersede queued hook work before asking the message loop to exit.
    GENERATION.fetch_add(1, Ordering::SeqCst);
    stop_cursor_tracker();
    if let Some(app) = super::app() {
        unregister_escape(&app);
        // Hide the shared overlay unless Blur is taking it over.
        if !super::blur::is_active() {
            hide_overlay(&app);
        }
    }
    super::emit_state();
}

// ── Overlay window ───────────────────────────────────────────────────────────

/// Show the `focus-overlay` window spanning the whole virtual screen (all
/// monitors), kept click-through and always-on-top. Creating it if the prewarm
/// has not landed yet.
fn show_overlay(app: &AppHandle) {
    let window = match crate::windows::ensure_window(app, FOCUS_OVERLAY_LABEL) {
        Ok(window) => window,
        Err(err) => {
            log::warn!("[focus-read] focus-overlay window unavailable: {err}");
            return;
        }
    };
    let (left, top, width, height) = crate::windows::virtual_screen_bounds();
    let _ = window.set_position(PhysicalPosition::new(left, top));
    let _ = window.set_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
    // Re-assert passthrough: creation sets it on Windows, but Linux defers it to
    // after the first show, and it must hold on every show path anyway.
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    // Deliberately NO set_focus(): the overlay must never steal keyboard focus.
}

/// Hide the shared overlay window.
fn hide_overlay(app: &AppHandle) {
    if let Some(window) = tauri::Manager::get_webview_window(app, FOCUS_OVERLAY_LABEL) {
        let _ = window.hide();
    }
}

// ── Escape-to-quit global shortcut ───────────────────────────────────────────

/// Arm Escape as a global shortcut that stops Focus Read from anywhere. Skips
/// arming (leaving it untouched) when something already owns Escape, so a
/// user-bound Escape is never clobbered.
fn register_escape(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let Ok(esc) = "Escape".parse::<Shortcut>() else {
        return;
    };
    if app.global_shortcut().is_registered(esc) {
        return;
    }
    let armed = app
        .global_shortcut()
        .on_shortcut(esc, move |app, fired, event| {
            if fired == &esc && event.state == ShortcutState::Pressed {
                // Defer off the shortcut handler so we never mutate the shortcut
                // registration (unregister Escape) from inside its own callback.
                let _ = app.run_on_main_thread(stop);
            }
        });
    match armed {
        Ok(()) => ESC_ARMED.store(true, Ordering::SeqCst),
        Err(err) => log::warn!("[focus-read] failed to register Escape: {err}"),
    }
}

/// Disarm the Escape shortcut, but only if this slice armed it.
fn unregister_escape(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    if !ESC_ARMED.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Ok(esc) = "Escape".parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(esc);
    }
}

// ── Cursor tracker ───────────────────────────────────────────────────────────

#[cfg(windows)]
use windows_impl::{start_cursor_tracker, stop_cursor_tracker};

#[cfg(not(windows))]
fn start_cursor_tracker(_app: AppHandle, _generation: u64) {}

#[cfg(not(windows))]
fn stop_cursor_tracker() {}

/// Whether the cursor position changed since the last emitted event (the first
/// event, with no prior value, always counts as a move so the band snaps to the
/// pointer immediately on start).
fn cursor_moved(last: Option<(i32, i32)>, current: (i32, i32)) -> bool {
    last != Some(current)
}

#[cfg(windows)]
mod windows_impl {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use tauri::AppHandle;
    use tauri_specta::Event as _;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, HC_ACTION, HHOOK, MSG,
        MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WM_MOUSEMOVE, WM_QUIT,
    };

    use crate::events::FocusCursorEvent;

    /// The published hook thread, tagged with its activation generation so an
    /// old thread cannot clear or replace a rapid restart's live tracker.
    #[derive(Default)]
    struct TrackerSlot {
        generation: u64,
        thread_id: u32,
    }

    static TRACKER: Mutex<TrackerSlot> = Mutex::new(TrackerSlot {
        generation: 0,
        thread_id: 0,
    });

    /// Latest callback position plus a park token for the emitter. Packing both
    /// signed coordinates into one atomic prevents torn x/y pairs without making
    /// the low-level hook acquire a lock.
    struct CursorSignal {
        packed_position: AtomicU64,
        dirty: AtomicBool,
        shutdown: AtomicBool,
    }

    impl CursorSignal {
        fn new() -> Self {
            Self {
                packed_position: AtomicU64::new(0),
                dirty: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
            }
        }

        fn update(&self, position: (i32, i32), emitter: &std::thread::Thread) {
            self.packed_position
                .store(pack_position(position), Ordering::Release);
            self.dirty.store(true, Ordering::Release);
            emitter.unpark();
        }

        fn take_position(&self) -> Option<(i32, i32)> {
            self.dirty
                .swap(false, Ordering::AcqRel)
                .then(|| unpack_position(self.packed_position.load(Ordering::Acquire)))
        }

        fn shut_down(&self, emitter: &std::thread::Thread) {
            self.shutdown.store(true, Ordering::Release);
            emitter.unpark();
        }
    }

    /// State accessed only by the hook callback on its owning message-loop
    /// thread. The callback performs atomics + `unpark` and returns immediately;
    /// Tauri event emission happens on the separate worker.
    struct HookState {
        signal: Arc<CursorSignal>,
        emitter: std::thread::Thread,
    }

    thread_local! {
        static STATE: RefCell<Option<HookState>> = const { RefCell::new(None) };
    }

    pub(super) fn start_cursor_tracker(app: AppHandle, generation: u64) {
        let spawned = std::thread::Builder::new()
            .name("focus-read-hook".into())
            .spawn(move || hook_thread(app, generation));
        if let Err(err) = spawned {
            log::warn!("[focus-read] failed to start mouse hook thread: {err}");
        }
    }

    pub(super) fn stop_cursor_tracker() {
        let thread_id = {
            let mut tracker = TRACKER
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let thread_id = tracker.thread_id;
            *tracker = TrackerSlot::default();
            thread_id
        };
        if thread_id == 0 {
            return;
        }
        // SAFETY: posting WM_QUIT is valid even if the target exited after the
        // registry lookup; failure just means teardown already completed.
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }

    fn hook_thread(app: AppHandle, generation: u64) {
        // Create the queue before publishing the thread id, otherwise stop could
        // race an early PostThreadMessageW against the first GetMessageW.
        let mut queue_probe = MSG::default();
        // SAFETY: `queue_probe` is a valid out-param; PM_NOREMOVE only ensures
        // the calling thread owns a message queue.
        unsafe {
            let _ = PeekMessageW(&mut queue_probe, None, 0, 0, PM_NOREMOVE);
        }

        let hook = match install_hook() {
            Ok(hook) => hook,
            Err(err) => {
                log::warn!("[focus-read] failed to install low-level mouse hook: {err}");
                return;
            }
        };

        let signal = Arc::new(CursorSignal::new());
        let emitter_signal = Arc::clone(&signal);
        let emitter = match std::thread::Builder::new()
            .name("focus-read-emitter".into())
            .spawn(move || emitter_loop(app, generation, &emitter_signal))
        {
            Ok(emitter) => emitter,
            Err(err) => {
                log::warn!("[focus-read] failed to start cursor emitter: {err}");
                unhook(hook);
                return;
            }
        };
        let emitter_thread = emitter.thread().clone();
        STATE.set(Some(HookState {
            signal: Arc::clone(&signal),
            emitter: emitter_thread.clone(),
        }));

        // SAFETY: always succeeds and returns the calling thread's id.
        let thread_id = unsafe { GetCurrentThreadId() };
        if !publish_tracker(generation, thread_id) {
            finish_hook_thread(hook, signal, emitter_thread, emitter);
            return;
        }

        // The hook only reports future movement, so seed the current position
        // once to preserve the old tracker's immediate snap-on-start behavior.
        if let Some(position) = cursor_position() {
            signal.update(position, &emitter_thread);
        }
        pump_messages();

        clear_tracker(generation, thread_id);
        finish_hook_thread(hook, signal, emitter_thread, emitter);
    }

    fn install_hook() -> windows::core::Result<HHOOK> {
        // SAFETY: NULL names the current executable module. Its handle remains
        // valid for the process lifetime and contains the static callback.
        let module = unsafe { GetModuleHandleW(None) }?;
        // SAFETY: `low_level_mouse_proc` is static, the current module stays
        // loaded, and this thread pumps messages until the hook is removed.
        unsafe {
            SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(low_level_mouse_proc),
                Some(HINSTANCE(module.0)),
                0,
            )
        }
    }

    fn publish_tracker(generation: u64, thread_id: u32) -> bool {
        let mut tracker = TRACKER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !super::is_active() || super::GENERATION.load(Ordering::SeqCst) != generation {
            return false;
        }
        *tracker = TrackerSlot {
            generation,
            thread_id,
        };
        true
    }

    fn clear_tracker(generation: u64, thread_id: u32) {
        let mut tracker = TRACKER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tracker.generation == generation && tracker.thread_id == thread_id {
            *tracker = TrackerSlot::default();
        }
    }

    fn finish_hook_thread(
        hook: HHOOK,
        signal: Arc<CursorSignal>,
        emitter_thread: std::thread::Thread,
        emitter: std::thread::JoinHandle<()>,
    ) {
        unhook(hook);
        STATE.set(None);
        signal.shut_down(&emitter_thread);
        if emitter.join().is_err() {
            log::warn!("[focus-read] cursor emitter panicked during teardown");
        }
    }

    fn unhook(hook: HHOOK) {
        // SAFETY: the handle came from SetWindowsHookExW and this is its sole
        // teardown path.
        if let Err(err) = unsafe { UnhookWindowsHookEx(hook) } {
            log::warn!("[focus-read] failed to remove low-level mouse hook: {err}");
        }
    }

    fn pump_messages() {
        let mut msg = MSG::default();
        loop {
            // SAFETY: `msg` is a live out-param. Retrieving messages on the hook
            // thread is what dispatches low-level mouse callbacks.
            let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };
            if result.0 <= 0 {
                return;
            }
            // SAFETY: GetMessageW initialized `msg`.
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    fn emitter_loop(app: AppHandle, generation: u64, signal: &CursorSignal) {
        let mut last = None;
        loop {
            std::thread::park();
            if signal.shutdown.load(Ordering::Acquire)
                || !super::is_active()
                || super::GENERATION.load(Ordering::SeqCst) != generation
            {
                return;
            }
            let Some(position) = signal.take_position() else {
                continue;
            };
            if !super::cursor_moved(last, position) {
                continue;
            }
            last = Some(position);
            let (x, y) = position;
            if let Err(err) = (FocusCursorEvent { x, y }).emit(&app) {
                log::warn!("[focus-read] failed to emit focus:cursor: {err}");
            }
        }
    }

    unsafe extern "system" fn low_level_mouse_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 && wparam.0 == WM_MOUSEMOVE as usize {
            // SAFETY: for HC_ACTION on a WH_MOUSE_LL callback, Windows defines
            // lParam as a valid pointer to MSLLHOOKSTRUCT for this call.
            let event = unsafe { (lparam.0 as *const MSLLHOOKSTRUCT).as_ref() };
            if let Some(event) = event {
                let _ = STATE.try_with(|slot| {
                    if let Ok(slot) = slot.try_borrow()
                        && let Some(state) = slot.as_ref()
                    {
                        state
                            .signal
                            .update((event.pt.x, event.pt.y), &state.emitter);
                    }
                });
            }
        }
        // SAFETY: forwarding every event preserves the rest of the hook chain;
        // the hook handle is intentionally omitted because this API ignores it.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    fn cursor_position() -> Option<(i32, i32)> {
        let mut point = POINT::default();
        // SAFETY: `point` is a live out-param and no pointer escapes the call.
        unsafe { GetCursorPos(&mut point) }
            .is_ok()
            .then_some((point.x, point.y))
    }

    fn pack_position((x, y): (i32, i32)) -> u64 {
        ((x as u32 as u64) << 32) | y as u32 as u64
    }

    fn unpack_position(packed: u64) -> (i32, i32) {
        ((packed >> 32) as u32 as i32, packed as u32 as i32)
    }

    #[cfg(test)]
    mod tests {
        use super::{pack_position, unpack_position};

        #[test]
        fn packed_cursor_position_round_trips_signed_coordinates() {
            for position in [(0, 0), (-1, 1), (i32::MIN, i32::MAX), (i32::MAX, i32::MIN)] {
                assert_eq!(unpack_position(pack_position(position)), position);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::cursor_moved;

    #[test]
    fn first_sample_always_counts_as_moved() {
        assert!(cursor_moved(None, (0, 0)));
        assert!(cursor_moved(None, (10, 20)));
    }

    #[test]
    fn same_position_is_not_a_move() {
        assert!(!cursor_moved(Some((10, 20)), (10, 20)));
    }

    #[test]
    fn any_axis_change_is_a_move() {
        assert!(cursor_moved(Some((10, 20)), (11, 20)));
        assert!(cursor_moved(Some((10, 20)), (10, 21)));
        assert!(cursor_moved(Some((10, 20)), (0, 0)));
    }
}
