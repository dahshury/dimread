//! Display engine — colour-temperature / brightness / grayscale / invert control
//! driven off `settings.display`.
//!
//! Module map:
//!   * [`monitors`] — physical-monitor enumeration and stable platform ids.
//!   * [`gamma`] — Kelvin→RGB + brightness + invert ramp composition and native
//!     display-ramp I/O.
//!   * [`grayscale`] — full-screen grayscale where the platform exposes a
//!     compositor colour-matrix API (Reading mode).
//!   * [`scheduler`] — day/night interpolation factor.
//!   * [`engine`] — the orchestrator + the `display_*` IPC commands. This is the
//!     stable seam other agents build on.
//!
//! Native display control is implemented with GDI on Windows, CoreGraphics on
//! macOS, and RandR on Linux/X11. There is deliberately no catch-all no-op
//! backend: adding another desktop target requires implementing its display
//! contract instead of silently shipping controls that do nothing.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod linux_wayland;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
compile_error!("the DimRead display engine needs a native backend for this target");

pub mod engine;
pub mod gamma;
pub mod grayscale;
pub mod monitors;
pub mod scheduler;
pub mod suncalc;
pub mod values;

pub use engine::{
    DisplayOutput, display_current, display_list_monitors, display_preview, display_preview_end,
};
pub use monitors::MonitorInfo;
