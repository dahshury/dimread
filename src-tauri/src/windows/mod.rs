//! Window-management commands for the starter's window topology. Each window
//! is a Tauri WebviewWindow loading its own HTML entry (main at "/", secondary
//! windows at "windows/<name>.html"), created PROGRAMMATICALLY (tauri.conf.json
//! has `"windows": []`) so portable mode can redirect the WebView2 user-data
//! folder.
//!
//! Creation policy:
//!   - `main` is created eagerly in lib.rs setup (NOT here).
//!   - `settings` / `gallery` are created LAZILY on first `open_window` and
//!     HIDDEN (not destroyed) on close, so re-open preserves renderer state.
//!   - `picker` is PREWARMED hidden shortly after startup (plus a compositor
//!     warm cycle) so its first open animates instead of cold-compositing.
//!
//! Two placement regimes:
//!   - PLAIN windows (settings/gallery): fixed size, centered (settings on the
//!     main window — it is a MODAL CHILD of it), shown + focused, hide-on-close.
//!   - The PICKER: a frameless transparent popup. The renderer sends the
//!     trigger's viewport rect in `open_window`; we convert it to screen space
//!     via the OPENER window's bounds, resize the picker window to fill the
//!     display work area (a click-to-dismiss backdrop), and EMIT `picker:anchor`
//!     with the window-local panel rect so the renderer draws the visible panel
//!     there (it stays invisible until that event lands).
//!
//! GOTCHAS carried from WinSTT:
//!   - Every webview in the process MUST share ONE WebView2 user-data folder
//!     (see `ensure_window`); a second webview requesting a different folder
//!     silently loads nothing (blank window).
//!   - Transparent windows pin `background_color(0, 0, 0, 0)`; without it a
//!     transparent window repaints its transparent regions with the webview's
//!     opaque default (white) the moment it gains focus.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) mod placement;

pub use placement::virtual_screen_bounds;
use placement::{
    anchor_from_rect, center_window, close_picker_with_animation, place_picker, resolve_opener,
    warm_picker_compositor,
};

/// Per-window chrome/geometry spec.
struct WindowSpec {
    /// Tauri window label == the Vite entry key == the renderer's window name.
    label: &'static str,
    /// HTML entry relative to the frontendDist root ("windows/<x>.html").
    url: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    resizable: bool,
    decorations: bool,
    transparent: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    shadow: bool,
    /// Purely-presentational popup: built non-focusable and with mouse events
    /// passing through to whatever is underneath (overlay + focus-overlay).
    click_through: bool,
    /// Built non-focusable (never steals foreground focus) but STILL receives
    /// mouse events — for the Magic Toolbar, whose Dark/Gray/Close buttons must
    /// be clickable without activating the toolbar window. (`click_through`
    /// implies non-focusable already, so it is mutually exclusive with this.)
    non_activating: bool,
    /// Opaque background color (None for transparent popups). Prevents a white
    /// flash before the renderer paints on the framed/opaque windows.
    background: Option<(u8, u8, u8, u8)>,
}

/// Dark substrate (`#09090b`) used as the opaque window background to kill the
/// white flash on opaque windows. Matches the renderer's page background.
const SUBSTRATE: Option<(u8, u8, u8, u8)> = Some((9, 9, 11, 255));

/// Window specs (main is created in lib.rs setup; listed here for reference —
/// `open_window` rejects it).
const WINDOW_SPECS: &[WindowSpec] = &[
    // Main — the compact quick-control panel: custom titlebar over a single
    // scrolling column (monitor strip, live readout, temperature + brightness
    // sliders, the eight preset modes, and the instant feature switches).
    // Frameless, opaque, fixed size. Every configuration surface lives in the
    // `settings` window instead, which is why this one is narrow and tall —
    // sized for the sliders, not for a tab rail.
    WindowSpec {
        label: "main",
        url: "/",
        title: "DimRead",
        width: 440.0,
        height: 600.0,
        min_width: 440.0,
        min_height: 600.0,
        resizable: false,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        click_through: false,
        non_activating: false,
        background: SUBSTRATE,
    },
    // Settings — frameless TRANSPARENT window centered on the main window; the
    // renderer draws the entire window visual (rounded card + border + shadow)
    // and animates it as ONE unit. It is a MODAL CHILD of main (owner set in
    // `ensure_window`): it sits above it and main is input-disabled while it's
    // open (`set_main_modal`). `shadow: false` — a DWM shadow on a transparent
    // undecorated window draws a SQUARE outline that ignores the CSS rounding.
    WindowSpec {
        label: "settings",
        url: "windows/settings.html",
        title: "DimRead — Settings",
        width: 940.0,
        height: 680.0,
        min_width: 940.0,
        min_height: 680.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: false,
        skip_taskbar: true,
        shadow: false,
        click_through: false,
        non_activating: false,
        background: None,
    },
    // Picker — full-work-area transparent backdrop; the visible anchored panel
    // is positioned by the renderer via the `picker:anchor` event. The listed
    // size is only the seed footprint before the first open resizes it.
    WindowSpec {
        label: "picker",
        url: "windows/picker.html",
        title: "DimRead — Picker",
        width: 360.0,
        height: 420.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        click_through: false,
        non_activating: false,
        background: None,
    },
    // Gallery — resizable opaque window demoing every shared/ui primitive.
    WindowSpec {
        label: "gallery",
        url: "windows/gallery.html",
        title: "DimRead — Component Gallery",
        width: 1000.0,
        height: 720.0,
        min_width: 640.0,
        min_height: 480.0,
        resizable: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        click_through: false,
        non_activating: false,
        background: SUBSTRATE,
    },
    // Overlay — the notification pill: a transparent, click-through,
    // NON-FOCUSABLE always-on-top strip docked top-center of the work area
    // (placement in `crate::overlay`). Never opened via `open_window`; the
    // `overlay_notify` command shows it and a Rust timer hides it. Prewarmed
    // hidden post-startup so the first notification animates instead of
    // cold-compositing.
    WindowSpec {
        label: "overlay",
        url: "windows/overlay.html",
        title: "DimRead — Overlay",
        width: 720.0,
        height: 140.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        click_through: true,
        non_activating: false,
        background: None,
    },
    // Focus overlay — the Focus tab's full-virtual-screen tint surface (F8): a
    // transparent, click-through, NON-FOCUSABLE always-on-top window that spans
    // EVERY monitor. It hosts BOTH the Focus Read clear band and the Focus Blur
    // shade (mutually exclusive; the renderer draws whichever mode `focus:state`
    // reports). The listed size is only a seed — the focus engine resizes it to
    // `virtual_screen_bounds()` on show. Prewarmed hidden.
    WindowSpec {
        label: "focus-overlay",
        url: "windows/focus-overlay.html",
        title: "DimRead — Focus",
        width: 1920.0,
        height: 1080.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        click_through: true,
        non_activating: false,
        background: None,
    },
    // Tray menu — the tray flyout that REPLACES the native context menu, so
    // the tray can host real controls (the brightness / temperature sliders)
    // rather than quick-set submenus. Transparent, frameless, always-on-top and
    // FOCUSABLE: it takes focus on open so losing focus is the click-away
    // dismiss (see `crate::tray_menu`). The listed size is only a seed — the
    // renderer resizes the window to its measured content via
    // `tray_menu_resize`. `shadow: false` — a DWM shadow on a transparent
    // undecorated window draws a SQUARE outline ignoring the CSS rounding.
    WindowSpec {
        label: "tray-menu",
        url: "windows/tray-menu.html",
        title: "DimRead — Tray",
        width: 300.0,
        height: 460.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        click_through: false,
        non_activating: false,
        background: None,
    },
    // Magic toolbar — the MagicX hover toolbar (F9.2): a tiny transparent
    // always-on-top strip (Dark / Gray / Close). NON-ACTIVATING (never steals
    // focus) but still clickable, and skip-taskbar. Positioned near the top of
    // the hovered window by the toolbar tracker. Prewarmed hidden.
    WindowSpec {
        label: "magic-toolbar",
        url: "windows/magic-toolbar.html",
        title: "DimRead — Magic Toolbar",
        width: 132.0,
        height: 36.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        click_through: false,
        non_activating: true,
        background: None,
    },
];

fn spec_for(label: &str) -> Option<&'static WindowSpec> {
    WINDOW_SPECS.iter().find(|s| s.label == label)
}

fn known_window_label(label: &str) -> Result<&'static str, String> {
    spec_for(label)
        .map(|s| s.label)
        .ok_or_else(|| format!("unknown window '{label}'"))
}

#[derive(Clone, Copy, Debug)]
enum WindowOperation {
    Open,
    Close,
}

impl WindowOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Close => "close",
        }
    }
}

/// Renderer-caller allow-list: which window may open/close which. Native paths
/// (tray, lib.rs close events) use the `*_internal` functions and bypass this.
fn is_window_operation_allowed(caller: &str, operation: WindowOperation, target: &str) -> bool {
    match operation {
        WindowOperation::Open => match target {
            // The tray flyout's "Settings" row opens the same modal the main
            // window's gear does — it is the tray's only cross-window reach.
            "settings" => matches!(caller, "main" | "tray-menu"),
            "gallery" => caller == "main",
            "picker" => matches!(caller, "main" | "settings" | "gallery"),
            _ => false,
        },
        WindowOperation::Close => match target {
            "main" => false,
            "settings" | "gallery" => caller == target,
            "picker" => matches!(caller, "main" | "settings" | "gallery" | "picker"),
            // The flyout dismisses itself through `tray_menu_hide` (a park, not
            // a hide) — never through the generic window commands.
            _ => false,
        },
    }
}

fn authorize_window_operation(
    caller: &tauri::WebviewWindow,
    operation: WindowOperation,
    target: &str,
) -> Result<(), String> {
    let caller_label = caller.label();
    if is_window_operation_allowed(caller_label, operation, target) {
        return Ok(());
    }
    log::warn!(
        "blocked window {}: caller='{caller_label}' target='{target}'",
        operation.as_str()
    );
    Err(format!(
        "window '{caller_label}' may not {} '{target}'",
        operation.as_str()
    ))
}

// ── Picker placement state ──────────────────────────────────────────────────

/// Anchor = the screen-space rect of the trigger that opened the picker.
#[derive(Clone, Copy)]
pub(crate) struct PickerAnchor {
    pub(crate) screen_left: f64,
    pub(crate) screen_right: f64,
    pub(crate) screen_top: f64,
    pub(crate) screen_bottom: f64,
}

#[derive(Clone)]
pub(crate) struct PickerState {
    anchor: Option<PickerAnchor>,
    /// Desired panel footprint (logical px). Fixed for the starter's single
    /// generic picker; widened to the trigger width at placement time.
    width: f64,
    height: f64,
    /// True from close-animation start until the next anchored open (the hide
    /// is delayed so the faded frame composits — placement must not re-show
    /// the window during that grace).
    closing: bool,
}

static PICKER_STATE: Mutex<Option<PickerState>> = Mutex::new(None);

/// Default panel footprint (the seed size in `WINDOW_SPECS` matches).
const PICKER_PANEL_SIZE: (f64, f64) = (360.0, 420.0);

pub(crate) fn with_picker_state<R>(f: impl FnOnce(&mut PickerState) -> R) -> R {
    let mut guard = PICKER_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = guard.get_or_insert_with(|| PickerState {
        anchor: None,
        width: PICKER_PANEL_SIZE.0,
        height: PICKER_PANEL_SIZE.1,
        closing: false,
    });
    f(entry)
}

/// Ensure the labelled window exists (creating it lazily from its spec) and
/// return a handle. `main` is never (re)created here — it's owned by setup.
/// The tao event-loop thread, recorded in `setup`. Window CREATION must happen
/// there (wry/tao constraint on Windows): building a webview window from a
/// command thread deadlocks the event loop — the app keeps painting but every
/// window operation and input queues forever behind the stuck build.
static MAIN_THREAD_ID: OnceLock<std::thread::ThreadId> = OnceLock::new();

pub(crate) fn record_main_thread() {
    let _ = MAIN_THREAD_ID.set(std::thread::current().id());
}

fn on_main_thread() -> bool {
    MAIN_THREAD_ID.get().copied() == Some(std::thread::current().id())
}

pub(crate) fn ensure_window(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(label) {
        return Ok(existing);
    }
    if on_main_thread() {
        return build_window(app, label);
    }
    // Hop to the main thread for the build and wait for the result. The main
    // thread is free while a command runs (commands execute off it), so this
    // cannot self-deadlock.
    let (tx, rx) = std::sync::mpsc::channel();
    let app_for_build = app.clone();
    let label_owned = label.to_string();
    app.run_on_main_thread(move || {
        let _ = tx.send(build_window(&app_for_build, &label_owned));
    })
    .map_err(|e| format!("failed to dispatch window build to main thread: {e}"))?;
    rx.recv()
        .map_err(|e| format!("window build on main thread dropped: {e}"))?
}

fn build_window(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(label) {
        return Ok(existing);
    }
    let spec = spec_for(label).ok_or_else(|| format!("unknown window '{label}'"))?;
    if label == "main" {
        return Err("main window must already exist".into());
    }

    let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .resizable(spec.resizable)
        .maximizable(false)
        .decorations(spec.decorations)
        .transparent(spec.transparent)
        .always_on_top(spec.always_on_top)
        .skip_taskbar(spec.skip_taskbar)
        .shadow(spec.shadow)
        .focused(false)
        .visible(false);

    // Click-through popups are purely presentational: build them non-focusable
    // so showing one never pulls keyboard focus off the user's active app. The
    // non-activating Magic Toolbar is also non-focusable but keeps mouse input
    // (its buttons must be clickable without activating the window).
    if spec.click_through || spec.non_activating {
        builder = builder.focusable(false);
    }

    if let Some((r, g, b, a)) = spec.background {
        builder = builder.background_color(tauri::webview::Color(r, g, b, a));
    } else if spec.transparent {
        // Pin the WebView2 default background fully transparent. Without an
        // explicit alpha-0 color, a transparent window repaints its transparent
        // regions with the webview's opaque default (white) the moment it
        // gains focus.
        builder = builder.background_color(tauri::webview::Color(0, 0, 0, 0));
    }

    // Settings is a modal child owned by the main window. On Windows `parent()`
    // sets `main` as the OWNER window: the modal is always above it in the
    // z-order, is hidden when main is minimized, and is destroyed with it.
    if spec.label == "settings" {
        match app.get_webview_window("main") {
            Some(main) => {
                builder = builder
                    .parent(&main)
                    .map_err(|e| format!("parent {} to main failed: {e}", spec.label))?;
            }
            None => log::warn!(
                "ensure_window: main window missing; {} created without owner",
                spec.label
            ),
        }
    }

    if let Some(data_dir) = crate::portable::data_dir() {
        // CRITICAL: every webview in the process MUST share ONE WebView2
        // user-data folder — WebView2 allows only a single user-data-folder per
        // process, and a second webview requesting a DIFFERENT folder silently
        // fails to load its content (blank window). The main window uses
        // `data_dir/webview` (lib.rs setup), so every secondary window MUST use
        // the SAME path, NOT a per-label dir.
        builder = builder.data_directory(data_dir.join("webview"));
    }

    let window = builder.build().map_err(|e| {
        log::error!("ensure_window: failed to build '{label}': {e}");
        e.to_string()
    })?;

    // Mouse events fall through to whatever is underneath. On Linux, Tao
    // unwraps the native GTK window for cursor-ignore requests and a hidden
    // prewarmed window is not realized yet — so the show path
    // (`overlay::notify`) re-asserts this after `show()`.
    if spec.click_through {
        #[cfg(not(target_os = "linux"))]
        let _ = window.set_ignore_cursor_events(true);
    }

    // Click-to-dismiss: hide the picker (with its close animation) when it
    // loses focus.
    if spec.label == "picker" {
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Focused(false)) {
                return;
            }
            let Some(window) = app_handle.get_webview_window("picker") else {
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            close_picker_with_animation(&app_handle, &window);
        });
    }

    Ok(window)
}

// ── Prewarm ─────────────────────────────────────────────────────────────────

const POST_STARTUP_PREWARM_DELAY_MS: u64 = 250;
static POST_STARTUP_PREWARM_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// Secondary windows worth prewarming shortly after first paint. The picker
/// gets an extra compositor warm cycle (see `warm_picker_compositor`); settings
/// is pre-created hidden so its first open shows an already-loaded webview;
/// the overlay is pre-created so the first notification only has to reveal an
/// already-loaded transparent webview.
///
/// The gallery is prewarmed too — EVERY secondary window is. A webview built
/// lazily inside a command's `run_on_main_thread` hop can come up wedged at
/// `about:blank` and ignore navigation (WebView2 created from a nested
/// dispatch context). Prewarm at idle is the reliable creation path; keep any
/// new window on this list unless it is truly rare AND you have verified its
/// lazy build navigates.
const POST_STARTUP_PREWARM_LABELS: &[&str] = &[
    "picker",
    "settings",
    "overlay",
    "gallery",
    "focus-overlay",
    "magic-toolbar",
    "tray-menu",
];

/// Pre-create hidden secondary windows after the main window paints. WebView2
/// creation happens on the main thread (required) but off the first-paint path.
/// Idempotent: `ensure_window` early-returns for existing windows.
fn prewarm_windows(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for label in POST_STARTUP_PREWARM_LABELS {
            let started = Instant::now();
            match ensure_window(&app, label) {
                Ok(window) => {
                    log::debug!(
                        "[prewarm] '{label}' pre-created (hidden) in {} ms",
                        started.elapsed().as_millis()
                    );
                    // The picker also needs its COMPOSITOR warmed (an
                    // off-screen show/hide cycle), or the first user open eats
                    // the open animation during WebView2's cold-composite.
                    if *label == "picker" {
                        warm_picker_compositor(&app, &window);
                    }
                    // The tray flyout warms differently: it is PARKED
                    // off-screen and left shown for the whole app lifetime, so
                    // its composition surface (and its self-reported content
                    // size) are ready before the first tray click.
                    if *label == crate::tray_menu::TRAY_MENU_LABEL {
                        crate::tray_menu::prewarm(&window);
                    }
                }
                Err(e) => log::warn!("[prewarm] '{label}' failed: {e}"),
            }
        }
    });
}

/// Schedule noncritical secondary WebView2 creation after the main window is
/// visible. Idempotent.
pub(crate) fn schedule_post_startup_prewarm(app: &AppHandle) {
    if POST_STARTUP_PREWARM_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(POST_STARTUP_PREWARM_DELAY_MS));
        if let Err(e) = app
            .clone()
            .run_on_main_thread(move || prewarm_windows(&app))
        {
            log::warn!("post-startup prewarm scheduling failed: {e}");
        }
    });
}

// ── Settings modal (main-window input gate) ─────────────────────────────────

/// Enable/disable the main window's input while the Settings modal is up, so
/// the two read as one window.
pub(crate) fn set_main_modal(app: &AppHandle, modal_active: bool) {
    if let Some(main) = app.get_webview_window("main")
        && let Err(e) = main.set_enabled(!modal_active)
    {
        log::warn!("set_main_modal({modal_active}): {e}");
    }
}

/// Close a modal child of the main window: re-enable the owner BEFORE hiding
/// the child (the Win32 modal teardown order), then return focus to main.
///
/// There is deliberately NO native window-opacity animation here: any exit
/// animation is done in the renderer (CSS) — a native `WS_EX_LAYERED` alpha
/// fade is not honored on a window's first show on Windows.
pub(crate) fn close_main_modal_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    set_main_modal(app, false);
    let _ = window.hide();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    Ok(())
}

// NOTE: the tray used to open Settings through a Rust-side
// `open_settings_window_internal` that bypassed command authorization. The tray
// flyout is a renderer now, so it opens Settings through the ordinary
// `open_window("settings")` command — `is_window_operation_allowed` allow-lists
// `tray-menu` as a caller, keeping every settings open on one audited path.

// ── Commands ────────────────────────────────────────────────────────────────

/// `open_window` — create-if-needed, then show + focus the labelled window.
///
/// For the picker the renderer passes the trigger's viewport rect
/// (`anchor_x`/`anchor_y`/`anchor_w`/`anchor_h`); we convert it to a screen
/// anchor via the CALLING window and place the popup. For the plain windows
/// the rect is absent and we center + show.
#[tauri::command]
#[specta::specta]
pub fn open_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    label: String,
    anchor_x: Option<f64>,
    anchor_y: Option<f64>,
    anchor_w: Option<f64>,
    anchor_h: Option<f64>,
) -> Result<(), String> {
    log::debug!("open_window('{label}') invoked");
    let label = known_window_label(&label)?;
    authorize_window_operation(&webview, WindowOperation::Open, label)?;
    let window = ensure_window(&app, label)
        .inspect_err(|e| log::error!("open_window('{label}') ensure_window failed: {e}"))?;

    if label == "picker" {
        // Stash the trigger anchor (converted to screen space via the opener =
        // the calling window).
        if let (Some(x), Some(y), Some(w), Some(h)) = (anchor_x, anchor_y, anchor_w, anchor_h)
            && let Some(opener) = resolve_opener(&app, &webview, label)
        {
            let anchor = anchor_from_rect(&opener, x, y, w, h);
            with_picker_state(|s| s.anchor = Some(anchor));
        }
        place_picker(&app, &window);
        return Ok(());
    }

    // Plain window: center (settings on the main window, gallery on the
    // primary display), then show + focus.
    center_window(&app, &window, label == "settings");
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    // The settings modal disables main after taking focus so it cannot be
    // focused/clicked underneath. Close paths re-enable it.
    if label == "settings" {
        set_main_modal(&app, true);
    }
    Ok(())
}

/// Internal Rust lifecycle close path. Use this for native close events and
/// backend-owned cleanup after the caller has already been established by code.
pub(crate) fn close_window_internal(app: &AppHandle, label: &str) -> Result<(), String> {
    let label = known_window_label(label)?;
    if label == "main" {
        return Err("main window cannot be closed through close_window".into());
    }
    if label == "settings" {
        if let Some(window) = app.get_webview_window(label) {
            return close_main_modal_window(app, &window);
        }
        set_main_modal(app, false);
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(label) {
        if label == "picker" {
            close_picker_with_animation(app, &window);
            return Ok(());
        }
        window.hide().map_err(|e| e.to_string())?;
    }
    // A closed picker forgets its anchor so a stray open can't reuse it.
    if label == "picker" {
        with_picker_state(|s| s.anchor = None);
    }
    Ok(())
}

/// `close_window` — HIDE the labelled keep-alive window so re-open keeps its
/// renderer state.
#[tauri::command]
#[specta::specta]
pub fn close_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    label: String,
) -> Result<(), String> {
    let label = known_window_label(&label)?;
    authorize_window_operation(&webview, WindowOperation::Close, label)?;
    close_window_internal(&app, label)
}

/// `close_self_window` — hide the CALLING window (resolved from its own webview
/// label). Self-closing secondary windows route their close button here instead
/// of a bare webview hide so the settings modal can release the main-window
/// input lock as it closes.
#[tauri::command]
#[specta::specta]
pub fn close_self_window(app: AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    match webview.label() {
        "settings" => close_main_modal_window(&app, &webview),
        "picker" => {
            close_picker_with_animation(&app, &webview);
            Ok(())
        }
        // The flyout is parked off-screen, never hidden — a bare `hide()` here
        // would break its open-state test and flash the stale frame on reopen.
        "tray-menu" => {
            crate::tray_menu::hide(&app);
            Ok(())
        }
        _ => webview.hide().map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        WINDOW_SPECS, WindowOperation, is_window_operation_allowed, known_window_label, spec_for,
    };

    /// Tauri v2 scopes capabilities BY WINDOW LABEL: a window missing from the
    /// capability's `windows` array gets no capability at all, so core plugin
    /// commands — `core:event:allow-listen` above all — are denied for it. The
    /// renderer sees `listen()` reject and nothing else; the window renders
    /// perfectly and simply never receives another event.
    ///
    /// That shipped: `tray-menu`, `focus-overlay` and `magic-toolbar` were in
    /// `WINDOW_SPECS` but not in the capability, so the tray flyout froze on
    /// whatever it seeded at prewarm and silently diverged from every other
    /// window. Keep the two rosters in lockstep.
    #[test]
    fn every_window_spec_is_granted_the_default_capability() {
        let raw = include_str!("../../capabilities/default.json");
        let capability: serde_json::Value =
            serde_json::from_str(raw).expect("capabilities/default.json must be valid JSON");
        let granted: Vec<&str> = capability["windows"]
            .as_array()
            .expect("capability must list `windows`")
            .iter()
            .map(|v| v.as_str().expect("window labels must be strings"))
            .collect();

        let missing: Vec<&str> = WINDOW_SPECS
            .iter()
            .map(|spec| spec.label)
            .filter(|label| !granted.contains(label))
            .collect();

        assert!(
            missing.is_empty(),
            "these windows would silently receive no events: {missing:?} — add them to capabilities/default.json"
        );
    }

    #[test]
    fn known_labels_resolve() {
        for label in [
            "main",
            "settings",
            "picker",
            "gallery",
            "overlay",
            "focus-overlay",
            "magic-toolbar",
        ] {
            assert!(spec_for(label).is_some(), "missing spec for {label}");
        }
        assert!(spec_for("nope").is_none());
        assert!(known_window_label("arbitrary-window").is_err());
    }

    #[test]
    fn focus_overlay_spans_transparent_and_click_through() {
        let spec = spec_for("focus-overlay").expect("focus-overlay spec");
        assert!(spec.transparent);
        assert!(spec.click_through);
        assert!(spec.always_on_top);
        assert!(spec.skip_taskbar);
        assert!(!spec.decorations);
        assert!(!spec.shadow);
        assert!(spec.background.is_none());
        // Never opened via renderer window commands (engine-owned).
        assert!(!is_window_operation_allowed(
            "main",
            WindowOperation::Open,
            "focus-overlay"
        ));
    }

    #[test]
    fn magic_toolbar_is_non_activating_transparent_strip() {
        let spec = spec_for("magic-toolbar").expect("magic-toolbar spec");
        assert_eq!((spec.width, spec.height), (132.0, 36.0));
        assert!(spec.transparent);
        assert!(spec.non_activating);
        assert!(!spec.click_through);
        assert!(spec.always_on_top);
        assert!(spec.skip_taskbar);
        assert!(spec.background.is_none());
    }

    #[test]
    fn settings_uses_renderer_owned_transparent_chrome() {
        let spec = spec_for("settings").expect("settings spec");
        assert!(!spec.decorations);
        assert!(spec.transparent);
        assert!(!spec.shadow);
        assert!(spec.skip_taskbar);
        assert!(spec.background.is_none());
        assert_eq!((spec.width, spec.height), (940.0, 680.0));
    }

    #[test]
    fn main_matches_spec_roster() {
        let spec = spec_for("main").expect("main spec");
        // Compact quick-control panel — narrow and tall. Configuration lives in
        // the settings window, so main must stay far smaller than it.
        assert_eq!((spec.width, spec.height), (440.0, 600.0));
        assert!(!spec.decorations);
        assert!(!spec.transparent);
        assert!(!spec.resizable);
        assert!(spec.shadow);
    }

    #[test]
    fn main_stays_smaller_than_settings() {
        let main = spec_for("main").expect("main spec");
        let settings = spec_for("settings").expect("settings spec");
        assert!(main.width < settings.width);
        assert!(main.width * main.height < settings.width * settings.height);
    }

    #[test]
    fn gallery_is_a_resizable_opaque_window() {
        let spec = spec_for("gallery").expect("gallery spec");
        assert_eq!((spec.width, spec.height), (1000.0, 720.0));
        assert!(spec.resizable);
        assert!(!spec.transparent);
        assert!(spec.background.is_some());
    }

    #[test]
    fn overlay_is_a_click_through_notification_strip() {
        let spec = spec_for("overlay").expect("overlay spec");
        assert_eq!((spec.width, spec.height), (720.0, 140.0));
        assert!(spec.transparent);
        assert!(spec.always_on_top);
        assert!(spec.skip_taskbar);
        assert!(spec.click_through);
        assert!(!spec.shadow);
        assert!(spec.background.is_none());
        // Every OTHER window keeps normal input handling.
        for label in ["main", "settings", "picker", "gallery"] {
            assert!(!spec_for(label).unwrap().click_through, "{label}");
        }
    }

    fn assert_window_rules(rules: &[(&str, WindowOperation, &str)], expected: bool) {
        for (caller, operation, target) in rules {
            assert_eq!(
                is_window_operation_allowed(caller, *operation, target),
                expected,
                "{caller} should {}be allowed to {} {target}",
                if expected { "" } else { "not " },
                operation.as_str()
            );
        }
    }

    #[test]
    fn window_open_authorization_allows_renderer_flows() {
        assert_window_rules(
            &[
                ("main", WindowOperation::Open, "settings"),
                ("main", WindowOperation::Open, "gallery"),
                ("main", WindowOperation::Open, "picker"),
                ("settings", WindowOperation::Open, "picker"),
                ("gallery", WindowOperation::Open, "picker"),
            ],
            true,
        );
    }

    #[test]
    fn window_authorization_blocks_cross_window_control() {
        assert_window_rules(
            &[
                ("picker", WindowOperation::Open, "settings"),
                ("settings", WindowOperation::Open, "gallery"),
                ("gallery", WindowOperation::Close, "settings"),
                ("settings", WindowOperation::Close, "main"),
                ("main", WindowOperation::Close, "main"),
                // The overlay is backend-owned: shown by `overlay_notify`,
                // hidden by its timer / `overlay_dismiss` — never by
                // renderer window commands.
                ("main", WindowOperation::Open, "overlay"),
                ("main", WindowOperation::Close, "overlay"),
            ],
            false,
        );
    }

    #[test]
    fn window_close_authorization_allows_renderer_flows() {
        assert_window_rules(
            &[
                ("settings", WindowOperation::Close, "settings"),
                ("gallery", WindowOperation::Close, "gallery"),
                ("picker", WindowOperation::Close, "picker"),
                ("main", WindowOperation::Close, "picker"),
                ("settings", WindowOperation::Close, "picker"),
            ],
            true,
        );
    }
}
