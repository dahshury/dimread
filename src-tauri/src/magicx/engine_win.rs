//! Windows backend for the per-window MagicX engine (FEATURE-PARITY F9.1).
//!
//! Owns a dedicated thread that runs the **Windowed Magnification API**: for each
//! target window it creates a layered, click-through host window pinned over the
//! target's DWM extended frame bounds, hosting a `WC_MAGNIFIER` child at 1.0×
//! zoom. The child carries an invert (Dark) or Rec. 601 luminance (Gray) colour
//! matrix. A message pump drives the only periodic work the backend needs: the
//! ~60 Hz `MagSetWindowSource` + `InvalidateRect` animation loop. Narrow WinEvent
//! hooks wake a coalesced tracker when a target moves, changes z-order, is
//! minimized/restored, or is destroyed.
//!
//! The Magnification API is thread-affine (it needs a message loop on the thread
//! that owns the magnifier windows), so all Win32 work happens on that one
//! thread; the seam ([`apply`] / [`clear_all`]) only forwards commands over an
//! `mpsc` channel and wakes the thread with a posted message. Every Win32 call is
//! best-effort: on `MagInitialize` or window-creation failure the engine logs
//! once and the affected target simply stays un-effected.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::InvalidateRect;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::Magnification::{
    MAGCOLOREFFECT, MW_FILTERMODE_EXCLUDE, MagInitialize, MagSetColorEffect,
    MagSetWindowFilterList, MagSetWindowSource, WC_MAGNIFIER,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CHILDID_SELF, CreateWindowExW, DestroyWindow, DispatchMessageW, EVENT_OBJECT_DESTROY,
    EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_REORDER, EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND,
    EVENT_SYSTEM_MOVESIZESTART, GW_HWNDPREV, GetMessageW, GetWindow, GetWindowRect, HWND_TOP,
    IsIconic, IsWindow, KillTimer, LWA_ALPHA, MSG, MoveWindow, OBJID_WINDOW, PM_NOREMOVE,
    PeekMessageW, PostThreadMessageW, SET_WINDOW_POS_FLAGS, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_NOACTIVATE, SWP_NOOWNERZORDER, SetLayeredWindowAttributes, SetTimer, SetWindowPos,
    ShowWindow, TranslateMessage, WINDOW_EX_STYLE, WINEVENT_OUTOFCONTEXT, WM_APP, WM_TIMER,
    WM_USER, WS_CHILD, WS_CLIPCHILDREN, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TRANSPARENT, WS_POPUP, WS_VISIBLE,
};
use windows::core::{PCWSTR, w};

use super::Effect;
use crate::magicx::Hwnd;

/// Refresh cadence for `MagSetWindowSource` + `InvalidateRect` (≈60 Hz), so live
/// target content keeps re-magnifying.
const FRAME_INTERVAL_MS: u32 = 16;

/// Posted (thread) message that wakes the pump to drain the command channel.
const WM_APP_WAKE: u32 = WM_APP + 1;

/// Posted once for a burst of accessibility callbacks. The worker clears the
/// latch before tracking, so an event racing the refresh schedules another pass.
const WM_APP_TRACK: u32 = WM_APP + 2;

/// A command sent to the worker thread.
enum Cmd {
    /// Set (`Some`) or clear (`None`) the effect on one window.
    Set(Hwnd, Option<Effect>),
    /// Tear down every host.
    ClearAll,
}

/// Sender half of the worker channel, lazily created with the thread.
static SENDER: OnceLock<Sender<Cmd>> = OnceLock::new();

/// Worker thread id, for [`PostThreadMessageW`] wakes (`0` until published).
static WORKER_TID: AtomicU32 = AtomicU32::new(0);

/// Coalesces high-frequency move/resize WinEvents into one queued tracker pass.
static TRACK_PENDING: AtomicU32 = AtomicU32::new(0);

/// Set (or clear) the effect on one window.
pub fn apply(hwnd: Hwnd, effect: Option<Effect>) {
    send(Cmd::Set(hwnd, effect));
}

/// Tear down every live host.
pub fn clear_all() {
    send(Cmd::ClearAll);
}

/// Enqueue a command and wake the worker thread.
fn send(cmd: Cmd) {
    if sender().send(cmd).is_ok() {
        wake();
    }
}

/// The worker channel, spawning the thread on first use.
fn sender() -> &'static Sender<Cmd> {
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Cmd>();
        if let Err(err) = thread::Builder::new()
            .name("magicx-engine".into())
            .spawn(move || worker(rx))
        {
            log::warn!("[magicx] failed to start effect worker: {err}");
        }
        tx
    })
}

/// Nudge the worker's message queue so a queued command is drained promptly.
fn wake() {
    let tid = WORKER_TID.load(Ordering::SeqCst);
    if tid != 0 {
        // SAFETY: posts an async wake message to the worker thread; the payload
        // is unused. Failure (thread gone) is ignored.
        let _ = unsafe { PostThreadMessageW(tid, WM_APP_WAKE, WPARAM(0), LPARAM(0)) };
    }
}

/// One live magnifier overlay pinned to a target window.
struct Host {
    /// The window being magnified.
    target: HWND,
    /// The layered, click-through host positioned over the target.
    host: HWND,
    /// The `WC_MAGNIFIER` child filling the host.
    mag: HWND,
    /// The currently-applied effect.
    effect: Effect,
    /// Last-known target frame bounds (screen coords).
    bounds: RECT,
    /// Whether the host is currently shown (hidden while target is minimized).
    visible: bool,
    /// Handle of the window directly above the target (skipping our own hosts),
    /// tracked so z-order is only restacked when it changes.
    above: isize,
}

/// The worker thread: init the Magnification runtime, then pump messages while
/// tracking every host. Runs for the process lifetime.
fn worker(rx: Receiver<Cmd>) {
    // Force the thread message queue to exist before publishing our id, so a
    // wake posted the instant after publication cannot be dropped.
    let mut probe = MSG::default();
    // SAFETY: PM_NOREMOVE peek only materialises the queue; nothing is consumed.
    unsafe {
        let _ = PeekMessageW(&mut probe, None, WM_USER, WM_USER, PM_NOREMOVE);
    }
    // SAFETY: no arguments; simply returns the current thread id.
    WORKER_TID.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);

    // SAFETY: MagInitialize takes no arguments. On failure host creation fails
    // gracefully below, so we only log.
    if unsafe { MagInitialize() }.as_bool() {
        log::debug!("[magicx] MagInitialize ok; effect worker ready");
    } else {
        log::warn!(
            "[magicx] MagInitialize failed ({:?}); per-window effects unavailable",
            std::io::Error::last_os_error()
        );
    }

    let mut hosts: HashMap<Hwnd, Host> = HashMap::new();
    let mut host_ids: HashSet<isize> = HashSet::new();
    let mut frame_timer: usize = 0;
    let hooks = install_hooks();

    drain(&rx, &mut hosts, &mut host_ids);
    manage_timer(&hosts, &mut frame_timer);

    let mut msg = MSG::default();
    loop {
        // SAFETY: standard blocking message pump; `msg` is a valid out-param.
        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if ret.0 <= 0 {
            break; // 0 = WM_QUIT, -1 = error
        }
        match msg.message {
            WM_APP_WAKE => {
                drain(&rx, &mut hosts, &mut host_ids);
                manage_timer(&hosts, &mut frame_timer);
            }
            WM_APP_TRACK => {
                TRACK_PENDING.store(0, Ordering::Release);
                track(&mut hosts, &mut host_ids);
                manage_timer(&hosts, &mut frame_timer);
            }
            WM_TIMER => {
                refresh(&hosts);
            }
            _ => {
                // SAFETY: dispatch host / magnifier window messages normally.
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
    }

    for hook in hooks {
        // SAFETY: every handle came from `SetWinEventHook` on this thread and is
        // removed exactly once after the pump stops.
        unsafe {
            let _ = UnhookWinEvent(hook);
        }
    }
}

/// Subscribe only to changes that can affect target lifetime, visibility,
/// geometry, or stacking. The hooks are global because MagicX can target any
/// process; callbacks are delivered on this message-pump thread.
fn install_hooks() -> Vec<HWINEVENTHOOK> {
    const RANGES: [(u32, u32); 6] = [
        (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
        (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND),
        (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
        (EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY),
        (EVENT_OBJECT_REORDER, EVENT_OBJECT_REORDER),
        (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
    ];
    let mut hooks = Vec::with_capacity(RANGES.len());
    for (min, max) in RANGES {
        // SAFETY: `win_event_proc` is static and all hooks are unregistered
        // before the worker exits. A null module is correct out-of-context.
        let hook = unsafe {
            SetWinEventHook(
                min,
                max,
                None,
                Some(win_event_proc),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.0.is_null() {
            log::warn!("[magicx] SetWinEventHook failed for range {min:#x}..={max:#x}");
        } else {
            hooks.push(hook);
        }
    }
    hooks
}

/// Accessibility callback: validate object events, then schedule one coalesced
/// tracker pass. System events use object id 0 and bypass the object filter.
unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    _hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if matches!(
        event,
        EVENT_OBJECT_DESTROY | EVENT_OBJECT_REORDER | EVENT_OBJECT_LOCATIONCHANGE
    ) && (id_object != OBJID_WINDOW.0 || id_child != CHILDID_SELF as i32)
    {
        return;
    }
    request_track();
}

fn request_track() {
    if TRACK_PENDING.swap(1, Ordering::AcqRel) != 0 {
        return;
    }
    let tid = WORKER_TID.load(Ordering::Acquire);
    if tid == 0 || unsafe { PostThreadMessageW(tid, WM_APP_TRACK, WPARAM(0), LPARAM(0)) }.is_err() {
        TRACK_PENDING.store(0, Ordering::Release);
    }
}

/// Drain every pending command, then re-track so new hosts are positioned and
/// stacked immediately (rather than on the next tracker tick).
fn drain(rx: &Receiver<Cmd>, hosts: &mut HashMap<Hwnd, Host>, host_ids: &mut HashSet<isize>) {
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            Cmd::Set(hwnd, Some(effect)) => set_effect(hwnd, effect, hosts, host_ids),
            Cmd::Set(hwnd, None) => remove_host(hwnd, hosts, host_ids),
            Cmd::ClearAll => clear_hosts(hosts, host_ids),
        }
    }
    track(hosts, host_ids);
}

/// Create a host for `hwnd` (or swap the colour matrix on an existing one).
fn set_effect(
    hwnd: Hwnd,
    effect: Effect,
    hosts: &mut HashMap<Hwnd, Host>,
    host_ids: &mut HashSet<isize>,
) {
    if let Some(host) = hosts.get_mut(&hwnd) {
        if host.effect != effect {
            if !apply_color(host.mag, effect) {
                // Swapping Dark→Gray (or back) was refused: the host would keep
                // rendering the OLD effect while the UI claims the new one.
                remove_host(hwnd, hosts, host_ids);
                crate::magicx::engine_wgc::apply(hwnd, Some(effect));
                return;
            }
            host.effect = effect;
            invalidate(host.mag);
        }
        return;
    }
    let target = HWND(hwnd as *mut core::ffi::c_void);
    // SAFETY: IsWindow tolerates any handle; a dead target is forgotten.
    if !unsafe { IsWindow(Some(target)) }.as_bool() {
        log::warn!("[magicx] target {hwnd:#x} is not a window; dropping effect");
        super::forget(hwnd);
        return;
    }
    // An advanced-colour (HDR) display refuses `MagSetColorEffect` outright, so
    // skip the doomed host and go straight to the capture backend.
    if crate::magicx::hdr::advanced_color_active(target) {
        log::debug!("[magicx] {hwnd:#x} is on an HDR display; using the capture backend");
        crate::magicx::engine_wgc::apply(hwnd, Some(effect));
        return;
    }
    let Some(bounds) = frame_bounds(target) else {
        log::warn!("[magicx] no usable frame bounds for target {hwnd:#x}");
        return;
    };
    if let Some(host) = create_host(target, bounds, effect) {
        log::debug!(
            "[magicx] host {:#x} created for target {hwnd:#x} at ({}, {})-({}, {})",
            host.host.0 as isize,
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom
        );
        host_ids.insert(host.host.0 as isize);
        hosts.insert(hwnd, host);
    } else {
        // The Magnification path refused this target for a reason HDR detection
        // didn't predict (a driver quirk, a remote session). The capture backend
        // does not depend on that pipeline, so hand off rather than give up.
        log::debug!("[magicx] {hwnd:#x} refused by Magnification; falling back to capture");
        crate::magicx::engine_wgc::apply(hwnd, Some(effect));
    }
}

/// Tear down the host for one window.
///
/// A target may be running on EITHER backend (HDR displays never get a
/// Magnification host), so clearing has to reach both — the caller doesn't know
/// which one owns it.
fn remove_host(hwnd: Hwnd, hosts: &mut HashMap<Hwnd, Host>, host_ids: &mut HashSet<isize>) {
    if let Some(host) = hosts.remove(&hwnd) {
        host_ids.remove(&(host.host.0 as isize));
        destroy(&host);
    }
    crate::magicx::engine_wgc::apply(hwnd, None);
}

/// Tear down every host on both backends.
fn clear_hosts(hosts: &mut HashMap<Hwnd, Host>, host_ids: &mut HashSet<isize>) {
    for host in hosts.values() {
        destroy(host);
    }
    hosts.clear();
    host_ids.clear();
    crate::magicx::engine_wgc::clear_all();
}

/// Build a layered click-through host + magnifier child over `bounds`.
fn create_host(target: HWND, bounds: RECT, effect: Effect) -> Option<Host> {
    let (x, y, w, h) = super::rect_xywh(bounds.left, bounds.top, bounds.right, bounds.bottom);
    let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
    // SAFETY: create a top-level "Static" host; all handle params are null.
    let host = unsafe {
        CreateWindowExW(
            ex,
            w!("Static"),
            PCWSTR::null(),
            WS_POPUP | WS_CLIPCHILDREN,
            x,
            y,
            w,
            h,
            None,
            None,
            None,
            None,
        )
    }
    .inspect_err(|err| log::warn!("[magicx] host window creation failed: {err}"))
    .ok()?;
    // SAFETY: make the layered host fully opaque so the child renders. On
    // failure, tear the half-built host back down.
    if let Err(err) = unsafe { SetLayeredWindowAttributes(host, COLORREF(0), 255, LWA_ALPHA) } {
        log::warn!("[magicx] SetLayeredWindowAttributes failed: {err}");
        // SAFETY: `host` was just created and is owned here.
        unsafe {
            let _ = DestroyWindow(host);
        }
        return None;
    }
    // SAFETY: WC_MAGNIFIER child parented to the host; destroyed with it.
    let mag = match unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            WC_MAGNIFIER,
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            w,
            h,
            Some(host),
            None,
            None,
            None,
        )
    } {
        Ok(mag) => mag,
        Err(err) => {
            log::warn!("[magicx] WC_MAGNIFIER child creation failed: {err}");
            // SAFETY: `host` is owned here; drop it (and any child) on failure.
            unsafe {
                let _ = DestroyWindow(host);
            }
            return None;
        }
    };
    // SAFETY: point the magnifier at the target's screen rect at 1.0× zoom.
    if !unsafe { MagSetWindowSource(mag, bounds) }.as_bool() {
        log::warn!("[magicx] MagSetWindowSource failed");
    }
    // SAFETY: show without activating so focus/input stay with the target.
    // The magnifier only builds its composition surface once the host is on
    // screen, so every effect-bearing call below has to come AFTER this.
    unsafe {
        let _ = ShowWindow(host, SW_SHOWNOACTIVATE);
    }
    // Exclude our own overlay windows so the magnifier never captures itself.
    let mut exclude = [host, mag];
    // SAFETY: `exclude` is a live 2-element array for the duration of the call.
    if !unsafe {
        MagSetWindowFilterList(
            mag,
            MW_FILTERMODE_EXCLUDE,
            exclude.len() as i32,
            exclude.as_mut_ptr(),
        )
    }
    .as_bool()
    {
        // Non-fatal: the magnification window excludes itself automatically, so
        // this only costs us the host's own exclusion.
        log::debug!(
            "[magicx] MagSetWindowFilterList unavailable: {:?}",
            std::io::Error::last_os_error()
        );
    }
    if !apply_color(mag, effect) {
        // The colour matrix IS the effect. Without it the host is a
        // pixel-identical 1:1 copy of the target that still burns a 60 Hz
        // re-magnify loop over the whole window — strictly worse than nothing,
        // and it makes the toolbar button lie about being active. Tear it down.
        // SAFETY: `host` is owned here; its magnifier child dies with it.
        unsafe {
            let _ = DestroyWindow(host);
        }
        return None;
    }
    Some(Host {
        target,
        host,
        mag,
        effect,
        bounds,
        visible: true,
        above: isize::MIN, // sentinel: force the first z-order restack
    })
}

/// Re-magnify every visible host (per-frame), reflecting live target content.
fn refresh(hosts: &HashMap<Hwnd, Host>) {
    for host in hosts.values() {
        if !host.visible {
            continue;
        }
        // SAFETY: re-point the magnifier at its source and invalidate so the
        // child repaints from the current target pixels.
        unsafe {
            let _ = MagSetWindowSource(host.mag, host.bounds);
            let _ = InvalidateRect(Some(host.mag), None, true);
        }
    }
}

/// Follow each target: reposition + restack the host, hide while minimized, and
/// tear down hosts whose target has been destroyed.
fn track(hosts: &mut HashMap<Hwnd, Host>, host_ids: &mut HashSet<isize>) {
    let mut dead: Vec<Hwnd> = Vec::new();
    for (&key, host) in hosts.iter_mut() {
        // SAFETY: IsWindow tolerates a stale handle.
        if !unsafe { IsWindow(Some(host.target)) }.as_bool() {
            dead.push(key);
            continue;
        }
        // SAFETY: `host.target` is a live window.
        if unsafe { IsIconic(host.target) }.as_bool() {
            if host.visible {
                // SAFETY: hide the overlay while the target is minimized.
                unsafe {
                    let _ = ShowWindow(host.host, SW_HIDE);
                }
                host.visible = false;
            }
            continue;
        }
        if !host.visible {
            // SAFETY: re-show the overlay when the target is restored.
            unsafe {
                let _ = ShowWindow(host.host, SW_SHOWNOACTIVATE);
            }
            host.visible = true;
        }
        let bounds = frame_bounds(host.target).unwrap_or(host.bounds);
        let above = window_above(host.target, host_ids);
        let above_id = above.map_or(0, |w| w.0 as isize);
        if bounds != host.bounds || above_id != host.above {
            let (x, y, w, h) =
                super::rect_xywh(bounds.left, bounds.top, bounds.right, bounds.bottom);
            let insert_after = above.unwrap_or(HWND_TOP);
            // SAFETY: reposition + restack the host directly above its target
            // without activating it, then resize the child + re-aim the source.
            unsafe {
                let _ = SetWindowPos(
                    host.host,
                    Some(insert_after),
                    x,
                    y,
                    w,
                    h,
                    SET_WINDOW_POS_FLAGS(SWP_NOACTIVATE.0 | SWP_NOOWNERZORDER.0),
                );
                let _ = MoveWindow(host.mag, 0, 0, w, h, true);
                let _ = MagSetWindowSource(host.mag, bounds);
            }
            host.bounds = bounds;
            host.above = above_id;
        }
    }
    for key in dead {
        if let Some(host) = hosts.remove(&key) {
            host_ids.remove(&(host.host.0 as isize));
            destroy(&host);
        }
        super::forget(key);
    }
}

/// The window directly above `target` in z-order, skipping our own host windows
/// (so the host is stacked just above the target, not above itself). `None` when
/// the target is at the top of its band.
fn window_above(target: HWND, host_ids: &HashSet<isize>) -> Option<HWND> {
    let mut cur = target;
    loop {
        // SAFETY: GetWindow on a valid window; Err/null means nothing above.
        match unsafe { GetWindow(cur, GW_HWNDPREV) } {
            Ok(prev) if !prev.is_invalid() => {
                if host_ids.contains(&(prev.0 as isize)) {
                    cur = prev;
                    continue;
                }
                return Some(prev);
            }
            _ => return None,
        }
    }
}

/// The target's on-screen bounds, preferring the DWM extended frame bounds
/// (which exclude the drop shadow) and falling back to `GetWindowRect`.
fn frame_bounds(target: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    // SAFETY: DWM writes a RECT into `r`; the size is that of `r`.
    let dwm = unsafe {
        DwmGetWindowAttribute(
            target,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut r as *mut RECT).cast(),
            core::mem::size_of::<RECT>() as u32,
        )
    };
    if dwm.is_ok() && super::rect_is_valid(r.left, r.top, r.right, r.bottom) {
        return Some(r);
    }
    let mut fallback = RECT::default();
    // SAFETY: GetWindowRect writes the window rect into `fallback`.
    if unsafe { GetWindowRect(target, &mut fallback) }.is_ok()
        && super::rect_is_valid(fallback.left, fallback.top, fallback.right, fallback.bottom)
    {
        Some(fallback)
    } else {
        None
    }
}

/// Apply the colour matrix for `effect` to a magnifier window. `false` means the
/// platform refused the transform, in which case the caller must NOT keep the
/// host — see [`create_host`].
///
/// The common refusal is `ERROR_NOT_SUPPORTED` while the display is in HDR
/// (advanced colour) mode: the Magnification API's colour pipeline needs the
/// WDDM path that HDR composition takes away, which is also why the built-in
/// Windows Magnifier greys out "Invert colours" on an HDR display.
fn apply_color(mag: HWND, effect: Effect) -> bool {
    let mut matrix = MAGCOLOREFFECT {
        transform: match effect {
            Effect::Dark => super::INVERT_MATRIX,
            Effect::Gray => super::GRAYSCALE_MATRIX,
        },
    };
    // SAFETY: `matrix` outlives the call; MagSetColorEffect copies it.
    if unsafe { MagSetColorEffect(mag, &mut matrix) }.as_bool() {
        return true;
    }
    let err = std::io::Error::last_os_error();
    log::warn!(
        "[magicx] MagSetColorEffect refused {effect:?}: {err:?} \
         (per-window effects are unavailable while the display is in HDR mode)"
    );
    false
}

/// Force a magnifier window to repaint.
fn invalidate(mag: HWND) {
    // SAFETY: invalidate the whole client area of a valid window.
    unsafe {
        let _ = InvalidateRect(Some(mag), None, true);
    }
}

/// Destroy a host (its magnifier child is destroyed along with it).
fn destroy(host: &Host) {
    // SAFETY: `host.host` is a window we created and still own.
    unsafe {
        let _ = DestroyWindow(host.host);
    }
}

/// Start the refresh timer when there are hosts, stop it when there are none.
fn manage_timer(hosts: &HashMap<Hwnd, Host>, frame_timer: &mut usize) {
    let want = !hosts.is_empty();
    if want && *frame_timer == 0 {
        // SAFETY: thread timer (null hwnd) — its id is returned for KillTimer.
        *frame_timer = unsafe { SetTimer(None, 0, FRAME_INTERVAL_MS, None) };
    } else if !want && *frame_timer != 0 {
        // SAFETY: stop the active frame-refresh timer by the id SetTimer returned.
        unsafe {
            let _ = KillTimer(None, *frame_timer);
        }
        *frame_timer = 0;
    }
}
