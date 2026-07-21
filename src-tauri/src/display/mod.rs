//! Display engine — colour-temperature / brightness / grayscale / invert control
//! driven off `settings.display`.
//!
//! Module map:
//!   * [`monitors`] — physical-monitor enumeration (GDI device name = stable id).
//!   * [`gamma`] — Kelvin→RGB + brightness + invert ramp composition and the
//!     `Get`/`SetDeviceGammaRamp` I/O.
//!   * [`grayscale`] — full-screen grayscale via the Magnification API (Reading
//!     mode).
//!   * [`scheduler`] — day/night interpolation factor (**STUB**, Agent B).
//!   * [`engine`] — the orchestrator + the `display_*` IPC commands. This is the
//!     stable seam other agents build on.
//!
//! All Win32 code is `cfg(windows)`-gated; non-Windows builds compile with no-op
//! implementations so the crate still builds everywhere.

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
