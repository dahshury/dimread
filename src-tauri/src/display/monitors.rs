//! Physical-monitor enumeration.
//!
//! On Windows we walk `EnumDisplayMonitors` → `GetMonitorInfoW`
//! (`MONITORINFOEXW.szDevice` gives the GDI device name, e.g. `\\.\DISPLAY1`,
//! which is the STABLE per-monitor id the rest of the display engine keys on)
//! → `EnumDisplayDevicesW` for the human-readable monitor string.
//! macOS uses CoreGraphics display UUIDs; Linux/X11 uses stable RandR output
//! connector names and resolves the current CRTC only for each native call.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A physical monitor as seen by the display engine.
///
/// `id` is a stable, backend-owned identifier — the key used everywhere else
/// (native gamma handles, per-monitor override maps, `display_preview`). It is
/// stable across a session and is what `display_list_monitors` returns to the
/// UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// Native backend id, e.g. `\\.\DISPLAY1`, `macos:uuid:…`, or
    /// `x11-output:edid-<hash>:DP-1`.
    pub id: String,
    /// 0-based enumeration index (paint order convenience for the UI strip).
    pub index: u32,
    /// Human-readable monitor/adapter name for display in the UI.
    pub friendly_name: String,
    /// Whether this is the OS primary monitor.
    pub is_primary: bool,
}

/// Register the native display-topology callback used by the engine's
/// reconciliation worker. Windows topology notifications are delivered by the
/// scheduler's hidden message window, so no second native hook is needed there.
#[cfg(windows)]
pub fn start_topology_listener(_callback: fn()) -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn start_topology_listener(callback: fn()) -> bool {
    super::macos::start_topology_listener(callback)
}

#[cfg(target_os = "linux")]
pub fn start_topology_listener(callback: fn()) -> bool {
    super::linux::start_topology_listener(callback)
}

#[cfg(windows)]
pub fn enumerate() -> Vec<MonitorInfo> {
    windows_impl::enumerate()
}

#[cfg(target_os = "macos")]
pub fn enumerate() -> Vec<MonitorInfo> {
    super::macos::enumerate()
}

#[cfg(target_os = "linux")]
pub fn enumerate() -> Vec<MonitorInfo> {
    super::linux::enumerate()
}

#[cfg(windows)]
mod windows_impl {
    use super::MonitorInfo;
    use windows::Win32::Foundation::{LPARAM, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::{
        DISPLAY_DEVICEW, EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR,
        MONITORINFO, MONITORINFOEXW,
    };
    use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;
    use windows::core::{BOOL, PCWSTR};

    /// Decode a NUL-terminated UTF-16 fixed array into a `String`.
    fn wide_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// `EnumDisplayMonitors` callback — collects raw `HMONITOR` handles into the
    /// `Vec<HMONITOR>` handed through `dwdata`.
    unsafe extern "system" fn collect_proc(
        monitor: HMONITOR,
        _hdc: HDC,
        _clip: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        // SAFETY: `data` is the `&mut Vec<HMONITOR>` pointer we passed to
        // `EnumDisplayMonitors`; the callback runs synchronously on this thread
        // for the lifetime of that borrow.
        let monitors = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        monitors.push(monitor);
        TRUE
    }

    pub fn enumerate() -> Vec<MonitorInfo> {
        let mut handles: Vec<HMONITOR> = Vec::new();
        // SAFETY: standard EnumDisplayMonitors invocation; `collect_proc` only
        // pushes into the `handles` vec pointed to by the LPARAM.
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(collect_proc),
                LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
            );
        }

        let mut out = Vec::with_capacity(handles.len());
        for (index, monitor) in handles.into_iter().enumerate() {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            // SAFETY: `info` is a correctly-sized MONITORINFOEXW; GetMonitorInfoW
            // fills it in place.
            let ok = unsafe {
                GetMonitorInfoW(
                    monitor,
                    &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
                )
            };
            if !ok.as_bool() {
                continue;
            }
            let device = wide_to_string(&info.szDevice);
            let is_primary = (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
            let friendly_name = friendly_name_for(&info.szDevice).unwrap_or_else(|| device.clone());
            out.push(MonitorInfo {
                id: device,
                index: index as u32,
                friendly_name,
                is_primary,
            });
        }
        out
    }

    /// Resolve the human-readable monitor name for a GDI device name via
    /// `EnumDisplayDevicesW(device, 0, …)` (the connected monitor's DeviceString).
    fn friendly_name_for(device_wide: &[u16]) -> Option<String> {
        let mut dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        // SAFETY: `device_wide` is a NUL-terminated UTF-16 device name and `dd`
        // is a correctly-sized DISPLAY_DEVICEW.
        let ok = unsafe { EnumDisplayDevicesW(PCWSTR(device_wide.as_ptr()), 0, &mut dd, 0) };
        if !ok.as_bool() {
            return None;
        }
        let name = wide_to_string(&dd.DeviceString);
        if name.trim().is_empty() {
            None
        } else {
            Some(name)
        }
    }
}
