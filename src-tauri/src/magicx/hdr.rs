//! Advanced-colour (HDR) detection for the monitor a window lives on.
//!
//! This is the switch that picks a MagicX effect backend. The Magnification API
//! refuses `MagSetColorEffect` with `ERROR_NOT_SUPPORTED` (50) while a display
//! is in advanced-colour mode — the colour pipeline needs the WDDM path HDR
//! composition takes away, which is also why the built-in Windows Magnifier
//! greys out "Invert colours" on an HDR display. Those targets go through
//! [`crate::magicx::engine_wgc`] instead.
//!
//! Detection reads the output's DXGI colour space rather than the display-config
//! advanced-colour flags: `IDXGIOutput6::GetDesc1` reports both the `HMONITOR`
//! and the colour space in one call, so a window maps to its monitor's state
//! without walking `QueryDisplayConfig` paths.
//!
//! Off Windows the whole module is absent; the seam is `cfg`-gated at the call
//! sites.

#![cfg(windows)]
// The capture backend (this module's only caller) is not built under
// `cfg(test)`, so the Win32 probing is dead there by construction. The pure
// colour-space classifier below still compiles and is unit-tested.
#![cfg_attr(test, allow(dead_code))]

use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709, DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020,
    DXGI_COLOR_SPACE_TYPE,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput6,
};
use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
use windows::core::Interface;

/// How long a probe result stays good. Enumerating adapters/outputs on every
/// toggle would be wasteful, but the answer changes when the user flips HDR, so
/// it can't be cached for the process lifetime either.
const CACHE_TTL: Duration = Duration::from_secs(2);

/// `(HMONITOR as isize, advanced_colour_active)` per attached output.
type MonitorStates = Vec<(isize, bool)>;

static CACHE: Mutex<Option<(Instant, MonitorStates)>> = Mutex::new(None);

/// Whether the monitor showing `target` is in advanced-colour (HDR) mode.
///
/// Returns `false` when the state can't be determined — the Magnification path
/// is then attempted and falls back on refusal, so an unknown answer degrades
/// to "try the cheap backend first" rather than to a broken effect.
pub fn advanced_color_active(target: HWND) -> bool {
    // SAFETY: `MonitorFromWindow` tolerates any handle and never fails; the
    // NEAREST flag guarantees a monitor even for an off-screen window.
    let monitor = unsafe { MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_invalid() {
        return false;
    }
    let handle = monitor.0 as isize;
    monitor_states()
        .into_iter()
        .find(|&(candidate, _)| candidate == handle)
        .is_some_and(|(_, hdr)| hdr)
}

/// Every output's advanced-colour state, re-probed at most once per
/// [`CACHE_TTL`].
fn monitor_states() -> MonitorStates {
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((probed, states)) = guard.as_ref()
        && probed.elapsed() < CACHE_TTL
    {
        return states.clone();
    }
    let states = probe_monitors();
    *guard = Some((Instant::now(), states.clone()));
    states
}

fn probe_monitors() -> MonitorStates {
    let mut states = MonitorStates::new();
    // SAFETY: creates a DXGI factory; failure is reported through the Result.
    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(factory) => factory,
        Err(err) => {
            log::debug!("[magicx] DXGI factory unavailable, assuming SDR: {err}");
            return states;
        }
    };
    for adapter_index in 0.. {
        // SAFETY: enumeration terminates with DXGI_ERROR_NOT_FOUND.
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(adapter) => adapter,
            Err(err) if err.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(_) => break,
        };
        for output_index in 0.. {
            // SAFETY: enumeration terminates with DXGI_ERROR_NOT_FOUND.
            let Ok(output) = (unsafe { adapter.EnumOutputs(output_index) }) else {
                break;
            };
            let Ok(output6) = output.cast::<IDXGIOutput6>() else {
                continue;
            };
            // SAFETY: returns the output descriptor, including its HMONITOR and
            // the colour space it is currently presenting.
            let Ok(desc) = (unsafe { output6.GetDesc1() }) else {
                continue;
            };
            states.push((desc.Monitor.0 as isize, is_advanced_color(desc.ColorSpace)));
        }
    }
    states
}

/// Whether a DXGI colour space means the output is presenting HDR.
///
/// `G2084_P2020` is HDR10; `G10_P709` is scRGB (linear, values above 1.0 are
/// legal) — Windows uses the latter for HD-colour desktops. Everything else is
/// an SDR transfer function.
fn is_advanced_color(space: DXGI_COLOR_SPACE_TYPE) -> bool {
    space == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020
        || space == DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdr_colour_spaces_are_recognised() {
        assert!(is_advanced_color(
            DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020
        ));
        assert!(is_advanced_color(DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709));
    }

    #[test]
    fn sdr_colour_spaces_are_not_advanced() {
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_RGB_STUDIO_G22_NONE_P709,
        };
        assert!(!is_advanced_color(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709));
        assert!(!is_advanced_color(
            DXGI_COLOR_SPACE_RGB_STUDIO_G22_NONE_P709
        ));
    }

    #[test]
    fn an_unknown_monitor_reports_sdr() {
        // A handle that belongs to no output must not claim HDR — the caller
        // uses `false` to mean "try the cheap Magnification backend first".
        let states: MonitorStates = [(0x1234_isize, true)].into();
        assert!(
            !states
                .into_iter()
                .find(|&(candidate, _)| candidate == 0x9999)
                .is_some_and(|(_, hdr)| hdr)
        );
    }
}
