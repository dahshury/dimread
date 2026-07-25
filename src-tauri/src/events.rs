//! Specta-typed events the backend emits. Each derives `specta::Type` (for the
//! generated TypeScript payload type) and implements `tauri_specta::Event`
//! MANUALLY so the wire name can carry the `scope:action` convention
//! (`settings:changed`, `download:update`, …) — the `#[derive(Event)]` macro
//! always kebab-cases the struct name and offers no rename attribute.
//!
//! Every event here must be registered in `commands_registry::make_specta_builder`'s
//! `collect_events![]` so it lands in the generated `src/bindings.ts`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::display::{MonitorInfo, engine::DisplayOutput};
use crate::downloads::DownloadSnapshot;
use crate::focus::FocusState;
use crate::overlay::OverlayNotification;
use crate::settings::AppSettings;

/// `settings:changed` — broadcast to ALL windows after every durable settings
/// save so each renderer replaces its snapshot (and revision) with the
/// authoritative one.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChangedEvent {
    pub revision: u32,
    pub settings: AppSettings,
}

impl tauri_specta::Event for SettingsChangedEvent {
    const NAME: &'static str = "settings:changed";
}

/// `download:update` — one download's full snapshot, emitted on every state
/// change plus throttled (~10 Hz) progress while downloading.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct DownloadUpdateEvent(pub DownloadSnapshot);

impl tauri_specta::Event for DownloadUpdateEvent {
    const NAME: &'static str = "download:update";
}

/// `picker:anchor` — the WINDOW-LOCAL rect of the visible picker panel inside
/// the full-work-area transparent backdrop window. The picker renderer stays
/// invisible until this lands, then draws the panel at the given rect.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PickerAnchorEvent {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl tauri_specta::Event for PickerAnchorEvent {
    const NAME: &'static str = "picker:anchor";
}

/// `picker:closing` — the close animation is starting; the renderer plays its
/// fade-out and acknowledges its actual completion (see `windows::placement`).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
pub struct PickerClosingEvent {}

impl tauri_specta::Event for PickerClosingEvent {
    const NAME: &'static str = "picker:closing";
}

/// `hotkey:triggered` — a registered global hotkey fired (key-down edge).
/// Built-in behaviors (e.g. `toggleMain`) run Rust-side BEFORE this broadcast;
/// renderers subscribe for app-level reactions (demos, toasts, custom ids).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyTriggeredEvent {
    /// The caller-chosen registration id (e.g. `"toggleMain"`).
    pub id: String,
    /// The accelerator the id is bound to (e.g. `"Ctrl+Shift+Space"`).
    pub accelerator: String,
}

impl tauri_specta::Event for HotkeyTriggeredEvent {
    const NAME: &'static str = "hotkey:triggered";
}

/// `overlay:notify` — show a notification in the overlay pill window. The
/// payload is the RESOLVED notification (tone/duration defaults filled in).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct OverlayNotifyEvent(pub OverlayNotification);

impl tauri_specta::Event for OverlayNotifyEvent {
    const NAME: &'static str = "overlay:notify";
}

/// `overlay:dismiss` — the overlay is being dismissed; the renderer plays its
/// exit animation and acknowledges its real completion to the backend.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverlayDismissEvent {
    pub sequence: u64,
}

impl tauri_specta::Event for OverlayDismissEvent {
    const NAME: &'static str = "overlay:dismiss";
}

/// `display:state` — the display engine's current output (Kelvin / brightness% /
/// mode / phase), emitted on every applied change so the UI badge and any
/// per-window readout stay live without polling `display_current`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct DisplayStateEvent(pub DisplayOutput);

impl tauri_specta::Event for DisplayStateEvent {
    const NAME: &'static str = "display:state";
}

/// `display:topology` — the set of displays changed after a native hot-plug,
/// disconnect, or display reconfiguration notification. Renderers subscribe to
/// this instead of periodically re-enumerating monitors.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct DisplayTopologyEvent(pub Vec<MonitorInfo>);

impl tauri_specta::Event for DisplayTopologyEvent {
    const NAME: &'static str = "display:topology";
}

/// `focus:state` — the combined Focus Read / Focus Blur activation, emitted on
/// every toggle so the `focus-overlay` renderer knows which tint mode to draw
/// (or to hide when both are off).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
pub struct FocusStateEvent(pub FocusState);

impl tauri_specta::Event for FocusStateEvent {
    const NAME: &'static str = "focus:state";
}

/// `focus:cursor` — the cursor position (physical px) while Focus Read is
/// active, so the renderer moves the clear band with the pointer.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FocusCursorEvent {
    pub x: i32,
    pub y: i32,
}

impl tauri_specta::Event for FocusCursorEvent {
    const NAME: &'static str = "focus:cursor";
}

/// One shadeable region in window-local physical px — a monitor's dimmable area,
/// already resolved to the work area (taskbar excluded) or the full monitor rect
/// (taskbar included) by the backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// `focus:anchor` — the foreground-window rect + its monitor bounds (physical
/// px) while Focus Blur is active, so the renderer cuts a hole for the active
/// window in the tint. `taskbar` is true when the taskbar is included in the
/// dimmed area.
///
/// `monitors` carries EVERY monitor's dimmable region (see [`AnchorRect`]), which
/// is what the whole-virtual-screen mode shades: the union of those rects rather
/// than the raw viewport. That is how `include_taskbar` is honoured with more
/// than one monitor (each region is the work area when the taskbar is excluded),
/// and it also leaves the gaps between non-contiguous monitors untinted.
/// `monitor_*` stays the ACTIVE window's monitor, used by `only_current_monitor`.
///
/// `window_id` is the platform window handle (the `HWND` as a `u64` on Windows,
/// 0 where the platform has no durable handle). It exists so the renderer can
/// tell a MOVE of the focused window apart from a SWITCH to a different one: a
/// move must snap the cutout (springing after a dragged window reads as lag),
/// while a switch should glide. Handles comfortably fit a JS `number` — the
/// bindings export `u64` via `BigIntExportBehavior::Number`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FocusAnchorEvent {
    /// Process-monotonic ordering for the renderer's subscribe-then-snapshot
    /// handshake. The snapshot is applied only when it is newer than every live
    /// event already observed by that renderer.
    pub sequence: u64,
    pub window_id: u64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub monitor_left: i32,
    pub monitor_top: i32,
    pub monitor_right: i32,
    pub monitor_bottom: i32,
    pub taskbar: bool,
    pub monitors: Vec<AnchorRect>,
}

impl tauri_specta::Event for FocusAnchorEvent {
    const NAME: &'static str = "focus:anchor";
}

/// `magictoolbar:show` — position (physical px) the Magic Toolbar was shown at,
/// plus the current effect flags of its target window (so the toolbar highlights
/// the active Dark/Gray buttons).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MagicToolbarShowEvent {
    pub x: i32,
    pub y: i32,
    pub target_dark: bool,
    pub target_gray: bool,
}

impl tauri_specta::Event for MagicToolbarShowEvent {
    const NAME: &'static str = "magictoolbar:show";
}

/// `magictoolbar:hide` — the Magic Toolbar left its target window; the renderer
/// plays its exit and Rust hides the `magic-toolbar` window.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
pub struct MagicToolbarHideEvent {}

impl tauri_specta::Event for MagicToolbarHideEvent {
    const NAME: &'static str = "magictoolbar:hide";
}

/// `autodark:changed` — the Auto Dark scheduler applied new theme state; the
/// boolean is the resolved dark flag for the Windows system theme.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoDarkChangedEvent {
    pub system_dark: bool,
}

impl tauri_specta::Event for AutoDarkChangedEvent {
    const NAME: &'static str = "autodark:changed";
}
