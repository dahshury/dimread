//! Window-management commands for DimRead's window topology. Each window is a
//! Tauri WebviewWindow loading its own HTML entry (the PRIMARY window at "/",
//! secondary windows at "windows/<name>.html"), created PROGRAMMATICALLY
//! (tauri.conf.json has `"windows": []`) so portable mode can redirect the
//! WebView2 user-data folder.
//!
//! There is deliberately NO separate "main" window. DimRead is a tray app whose
//! ONE visible surface is the settings window: it hosts the live quick controls
//! (monitor strip, sliders, preset modes) at the top of its Display tab and
//! every configuration surface behind the sidebar rail. The tray flyout is the
//! only other control surface. Do not reintroduce a second top-level window for
//! "quick" controls — that split is what this topology removed.
//!
//! Creation policy:
//!   - `settings` (== {@link PRIMARY_WINDOW}) is created eagerly in lib.rs setup
//!     and HIDDEN on close, so re-open preserves renderer state.
//!   - Every other window is PREWARMED hidden shortly after startup and shown
//!     on demand by the feature that owns it (focus, magicx, the tray flyout).
//!
//! GOTCHAS carried from WinSTT:
//!   - Every webview in the process MUST share ONE WebView2 user-data folder
//!     (see `ensure_window`); a second webview requesting a different folder
//!     silently loads nothing (blank window).
//!   - Transparent windows pin `background_color(0, 0, 0, 0)`; without it a
//!     transparent window repaints its transparent regions with the webview's
//!     opaque default (white) the moment it gains focus.

use std::sync::OnceLock;
use std::time::Instant;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) mod placement;

use placement::center_window;
pub use placement::virtual_screen_bounds;

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

/// The app's ONE top-level window. It is built eagerly in lib.rs setup, shown
/// by the tray / the `toggleMain` hotkey, and hidden (or the app quits) on
/// close — the role the removed `main` window used to play.
pub const PRIMARY_WINDOW: &str = "settings";

/// Window specs. `PRIMARY_WINDOW` is built from its spec during setup rather
/// than on a renderer's `open_window` call; everything else is lazy/prewarmed.
const WINDOW_SPECS: &[WindowSpec] = &[
    // Settings — the app window. Frameless and TRANSPARENT: the renderer draws
    // the entire window visual (rounded card + border + shadow) and animates it
    // as ONE unit. `shadow: false` — a DWM shadow on a transparent undecorated
    // window draws a SQUARE outline that ignores the CSS rounding.
    //
    // `skip_taskbar: false`: this is the only window the user ever sees, so it
    // owns the taskbar button (it used to be `main`'s).
    WindowSpec {
        label: "settings",
        url: "/",
        title: "DimRead",
        width: 940.0,
        height: 680.0,
        min_width: 940.0,
        min_height: 680.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: false,
        skip_taskbar: false,
        shadow: false,
        click_through: false,
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
            // The tray flyout's "Settings" row surfaces the app window — the
            // tray's only cross-window reach.
            "settings" => caller == "tray-menu",
            _ => false,
        },
        WindowOperation::Close => match target {
            // The app window closes through `close_self_window`, which routes
            // to the hide-to-tray / quit decision. A generic `close_window`
            // would hide it and skip that, so it is not allowed here.
            "settings" => false,
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

/// Ensure the labelled window exists (creating it lazily from its spec) and
/// return a handle.
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

    // The app window seeds centered on the primary display; `lib.rs` then
    // overrides that with the remembered position while it is still hidden.
    if spec.label == PRIMARY_WINDOW {
        builder = builder.center();
    }

    if let Some(data_dir) = crate::portable::data_dir() {
        // CRITICAL: every webview in the process MUST share ONE WebView2
        // user-data folder — WebView2 allows only a single user-data-folder per
        // process, and a second webview requesting a DIFFERENT folder silently
        // fails to load its content (blank window). Every window is built
        // through this function, so they all share `data_dir/webview` — never
        // give one a per-label dir.
        builder = builder.data_directory(data_dir.join("webview"));
    }

    let window = builder.build().map_err(|e| {
        log::error!("ensure_window: failed to build '{label}': {e}");
        e.to_string()
    })?;

    // Mouse events fall through to whatever is underneath. On Linux, Tao
    // unwraps the native GTK window for cursor-ignore requests and a hidden
    // prewarmed window is not realized yet — so the feature that shows the
    // window re-asserts this after `show()`.
    if spec.click_through {
        #[cfg(not(target_os = "linux"))]
        let _ = window.set_ignore_cursor_events(true);
    }

    Ok(window)
}

// ── Prewarm ─────────────────────────────────────────────────────────────────

static POST_STARTUP_PREWARMED: OnceLock<()> = OnceLock::new();

/// Secondary windows prewarmed shortly after first paint.
///
/// EVERY secondary window is on this list. A webview built lazily inside a
/// command's `run_on_main_thread` hop can come up wedged at `about:blank` and
/// ignore navigation (WebView2 created from a nested dispatch context). Prewarm
/// at idle is the reliable creation path; keep any new window on this list
/// unless it is truly rare AND you have verified its lazy build navigates.
const POST_STARTUP_PREWARM_LABELS: &[&str] = &["focus-overlay", "magic-toolbar", "tray-menu"];

/// Pre-create hidden secondary windows after the app window paints. WebView2
/// creation happens on the main thread (required) but off the first-paint path.
/// Idempotent: `ensure_window` early-returns for existing windows.
fn prewarm_windows(app: &AppHandle) {
    for label in POST_STARTUP_PREWARM_LABELS {
        let started = Instant::now();
        match ensure_window(app, label) {
            Ok(window) => {
                log::debug!(
                    "[prewarm] '{label}' pre-created (hidden) in {} ms",
                    started.elapsed().as_millis()
                );
                // The tray flyout warms differently: it is PARKED off-screen
                // and left shown for the whole app lifetime, so its
                // composition surface and self-reported size are ready before
                // the first tray click.
                if *label == crate::tray_menu::TRAY_MENU_LABEL {
                    crate::tray_menu::prewarm(&window);
                }
            }
            Err(e) => log::warn!("[prewarm] '{label}' failed: {e}"),
        }
    }
}

/// App-window page-load callback: pre-create noncritical secondary WebViews
/// only after the primary document has finished loading. The builder's
/// `on_page_load` callback calls this for the app window's
/// `PageLoadEvent::Finished`, replacing the old arbitrary post-startup sleep.
/// Idempotent across reloads.
pub(crate) fn on_primary_page_loaded(app: &AppHandle) {
    if POST_STARTUP_PREWARMED.set(()).is_err() {
        return;
    }
    // `on_page_load` runs inside WebView2's NavigationCompleted dispatch.
    // Building more WebViews re-entrantly from that callback can wedge them at
    // about:blank, so hop off the callback and queue creation on Tauri's main
    // thread after the current dispatch returns.
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("prewarm-dispatch".into())
        .spawn(move || {
            let dispatch_app = app.clone();
            if let Err(error) = app.run_on_main_thread(move || prewarm_windows(&dispatch_app)) {
                log::warn!("post-load prewarm dispatch failed: {error}");
            }
        });
    if let Err(error) = spawned {
        log::warn!("failed to spawn post-load prewarm dispatcher: {error}");
    }
}

// NOTE: the tray used to open Settings through a Rust-side
// `open_settings_window_internal` that bypassed command authorization. The tray
// flyout is a renderer now, so it opens Settings through the ordinary
// `open_window("settings")` command — `is_window_operation_allowed` allow-lists
// `tray-menu` as a caller, keeping every settings open on one audited path.

// ── Commands ────────────────────────────────────────────────────────────────

/// `open_window` — create-if-needed, then show + focus the labelled window.
#[tauri::command]
#[specta::specta]
pub fn open_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    label: String,
) -> Result<(), String> {
    log::debug!("open_window('{label}') invoked");
    let label = known_window_label(&label)?;
    authorize_window_operation(&webview, WindowOperation::Open, label)?;
    let window = ensure_window(&app, label)
        .inspect_err(|e| log::error!("open_window('{label}') ensure_window failed: {e}"))?;

    // The app window keeps whatever position the user last dragged it to, so
    // re-opening it from the tray must NOT recenter.
    if label == PRIMARY_WINDOW {
        crate::window_state::show_primary_window(&app);
        return Ok(());
    }
    center_window(&app, &window, true);
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

/// Internal Rust lifecycle close path. Use this for native close events and
/// backend-owned cleanup after the caller has already been established by code.
pub(crate) fn close_window_internal(app: &AppHandle, label: &str) -> Result<(), String> {
    let label = known_window_label(label)?;
    if label == PRIMARY_WINDOW {
        return Err("the app window closes through close_primary_window".into());
    }
    if let Some(window) = app.get_webview_window(label) {
        window.hide().map_err(|e| e.to_string())?;
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
/// label). Self-closing windows route their close button here instead of a bare
/// webview hide so each label's real teardown runs — above all the APP window,
/// whose close is a hide-to-tray or an app quit depending on the user's
/// `general.minimizeToTray` setting.
#[tauri::command]
#[specta::specta]
pub fn close_self_window(app: AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    match webview.label() {
        PRIMARY_WINDOW => {
            crate::window_state::close_primary_window(&app);
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
        PRIMARY_WINDOW, WINDOW_SPECS, WindowOperation, is_window_operation_allowed,
        known_window_label, spec_for,
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

    /// The app has exactly ONE top-level window. A reintroduced `main` — or any
    /// second taskbar-visible spec — would resurrect the split-surface topology
    /// this app deliberately removed.
    #[test]
    fn the_app_window_is_the_only_top_level_window() {
        assert!(spec_for("main").is_none());
        let top_level: Vec<&str> = WINDOW_SPECS
            .iter()
            .filter(|spec| !spec.skip_taskbar)
            .map(|spec| spec.label)
            .collect();
        assert_eq!(top_level, vec![PRIMARY_WINDOW]);
    }

    #[test]
    fn known_labels_resolve() {
        for label in ["settings", "focus-overlay", "magic-toolbar", "tray-menu"] {
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
            PRIMARY_WINDOW,
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
        let spec = spec_for(PRIMARY_WINDOW).expect("settings spec");
        assert!(!spec.decorations);
        assert!(spec.transparent);
        assert!(!spec.shadow);
        // The app window owns the taskbar button — nothing else is visible.
        assert!(!spec.skip_taskbar);
        assert!(spec.background.is_none());
        assert_eq!((spec.width, spec.height), (940.0, 680.0));
        // Served from the Vite ROOT entry, so the dev server's "/" is the app.
        assert_eq!(spec.url, "/");
    }

    #[test]
    fn only_the_engine_owned_overlays_are_click_through() {
        assert!(spec_for("focus-overlay").unwrap().click_through);
        // Every window the user actually interacts with keeps normal input.
        for label in ["settings", "tray-menu", "magic-toolbar"] {
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
        assert_window_rules(&[("tray-menu", WindowOperation::Open, "settings")], true);
    }

    #[test]
    fn window_authorization_blocks_cross_window_control() {
        assert_window_rules(
            &[
                ("magic-toolbar", WindowOperation::Open, "settings"),
                // Only the tray flyout may surface the app window; it must not
                // be able to re-open itself into a second show path.
                ("settings", WindowOperation::Open, "settings"),
                // The app window's close is a hide-to-tray/quit decision that
                // only `close_self_window` makes.
                ("settings", WindowOperation::Close, "settings"),
                // The engine-owned overlays are shown and hidden by the feature
                // that drives them, never by renderer window commands.
                ("settings", WindowOperation::Open, "focus-overlay"),
                ("settings", WindowOperation::Close, "focus-overlay"),
                ("settings", WindowOperation::Open, "magic-toolbar"),
                ("settings", WindowOperation::Close, "tray-menu"),
            ],
            false,
        );
    }
}
