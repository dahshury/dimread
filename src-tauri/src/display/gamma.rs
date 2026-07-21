//! Per-monitor gamma-ramp composition + application.
//!
//! A gamma ramp is three 256-entry `u16` LUTs (R/G/B). The GPU maps every
//! output pixel channel `c` through `ramp[channel][c]`, so adjusting the ramp
//! tints/dims/inverts the whole display at the scan-out stage — screenshots and
//! text stay pristine (the CareUEyes "no yellow screenshots" property).
//!
//! Composition pipeline (all pure, platform-independent — see [`compose`]):
//!   1. colour temperature (Kelvin) → an RGB white point via the Tanner Helland
//!      approximation,
//!   2. a brightness factor `0.0..=1.0` scales every channel,
//!   3. an `invert` flag mirrors the LUT (`out = max - out`) for Editing mode.
//!
//! The Win32 I/O ([`read_ramp`] / [`apply_ramp`]) opens a device context on the
//! GDI device name (`\\.\DISPLAY1`) and calls `Get`/`SetDeviceGammaRamp`. The
//! engine snapshots each monitor's original ramp at startup and restores it on
//! exit / pause.

/// Three 256-entry channel LUTs: `[R, G, B]`, each `[u16; 256]`. Wire-compatible
/// with the `WORD ramp[3][256]` buffer `Get`/`SetDeviceGammaRamp` expect.
pub type GammaRamp = [[u16; 256]; 3];

/// Tanner Helland's Kelvin → RGB approximation. Returns each channel in
/// `0.0..=1.0`. Valid roughly across `1000..=40000` K; the input is clamped.
pub fn kelvin_to_rgb(kelvin: f64) -> (f64, f64, f64) {
    let temp = kelvin.clamp(1000.0, 40000.0) / 100.0;

    let red = if temp <= 66.0 {
        255.0
    } else {
        329.698_727_446 * (temp - 60.0).powf(-0.133_204_759_2)
    };

    let green = if temp <= 66.0 {
        99.470_802_586_1 * temp.ln() - 161.119_568_166_1
    } else {
        288.122_169_528_3 * (temp - 60.0).powf(-0.075_514_849_2)
    };

    let blue = if temp >= 66.0 {
        255.0
    } else if temp <= 19.0 {
        0.0
    } else {
        138.517_731_223_1 * (temp - 10.0).ln() - 305.044_792_730_7
    };

    (
        (red / 255.0).clamp(0.0, 1.0),
        (green / 255.0).clamp(0.0, 1.0),
        (blue / 255.0).clamp(0.0, 1.0),
    )
}

/// Compose a full gamma ramp from a colour temperature, a brightness factor
/// (`0.0..=1.0`), and an `invert` flag (Editing mode reverses the LUT).
///
/// `invert` flips the LUT's INPUT (`i → 255 - i`) and then applies the tint
/// and brightness to the flipped value — NOT `out = max - out`, which mirrors
/// the already-scaled output. Mirroring the output pins black pixels at
/// full-scale white regardless of brightness, lifts "black" backgrounds to a
/// gray floor of `1 - scale`, and applies the tint backwards (a warm setting
/// pushes the inverted image bluer, since the tint only scales the subtracted
/// term). Flipping the input keeps Editing mode a true black-background /
/// dimmed-warm-text negative: brightness dims it and Kelvin warms it exactly
/// like the non-inverted path.
pub fn compose(kelvin: f64, brightness: f64, invert: bool) -> GammaRamp {
    let (r, g, b) = kelvin_to_rgb(kelvin);
    let brightness = brightness.clamp(0.0, 1.0);
    let channel_scale = [r * brightness, g * brightness, b * brightness];

    let mut ramp: GammaRamp = [[0u16; 256]; 3];
    for (channel, scale) in channel_scale.iter().enumerate() {
        for (i, slot) in ramp[channel].iter_mut().enumerate() {
            let index = if invert { 255 - i } else { i };
            let value = (index as f64) / 255.0 * scale * 65535.0;
            *slot = value.round().clamp(0.0, 65535.0) as u16;
        }
    }
    ramp
}

/// Whether a ramp is believable as a monitor's TRUE pre-filter state.
///
/// A real "original" — identity, an ICC calibration curve, even another tool's
/// warm tint — always keeps at least one channel's peak near full scale (a
/// tint suppresses blue/green but never red). A ramp whose EVERY channel peaks
/// well below full scale is a brightness cut: almost certainly a stranded
/// filter (ours, after a dirty shutdown the session journal failed to cover).
/// Trusting it would launder the dimming into the captured originals, making
/// `pause`/exit "restore" a dim screen permanently. An inverted (Editing-mode)
/// leftover fails the same test, since its peak sits at index 0.
pub fn plausible_original(ramp: &GammaRamp) -> bool {
    // 75% of full scale — far below any calibration, far above a stranded dim.
    const MIN_PEAK: u16 = 49151;
    ramp.iter().any(|channel| channel[255] >= MIN_PEAK)
}

/// The identity ramp (`ramp[c][i] = i * 257`) — a no-op scan-out mapping. Used
/// as a fallback "original" when a monitor's real ramp cannot be read.
pub fn identity() -> GammaRamp {
    let mut ramp: GammaRamp = [[0u16; 256]; 3];
    for channel in ramp.iter_mut() {
        for (i, slot) in channel.iter_mut().enumerate() {
            *slot = (i as u16).saturating_mul(257);
        }
    }
    ramp
}

/// Read a monitor's current gamma ramp (`None` if the device context or
/// `GetDeviceGammaRamp` fails, or off-Windows).
#[cfg(windows)]
pub fn read_ramp(device: &str) -> Option<GammaRamp> {
    windows_impl::read_ramp(device)
}

/// Apply a gamma ramp to a monitor. Returns `true` on success (always `false`
/// off-Windows).
#[cfg(windows)]
pub fn apply_ramp(device: &str, ramp: &GammaRamp) -> bool {
    windows_impl::apply_ramp(device, ramp)
}

#[cfg(not(windows))]
pub fn read_ramp(_device: &str) -> Option<GammaRamp> {
    None
}

#[cfg(not(windows))]
pub fn apply_ramp(_device: &str, _ramp: &GammaRamp) -> bool {
    false
}

#[cfg(windows)]
mod windows_impl {
    use super::GammaRamp;
    use windows::Win32::Graphics::Gdi::{CreateDCW, DeleteDC, HDC};
    use windows::Win32::UI::ColorSystem::{GetDeviceGammaRamp, SetDeviceGammaRamp};
    use windows::core::PCWSTR;

    /// A device context on a GDI display device, released on drop.
    struct DeviceContext(HDC);

    impl DeviceContext {
        fn create(device: &str) -> Option<Self> {
            let wide: Vec<u16> = device.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: CreateDCW with a valid NUL-terminated device name; a null
            // HDC (device gone) is checked immediately below.
            let hdc =
                unsafe { CreateDCW(PCWSTR::null(), PCWSTR(wide.as_ptr()), PCWSTR::null(), None) };
            if hdc.is_invalid() {
                None
            } else {
                Some(Self(hdc))
            }
        }
    }

    impl Drop for DeviceContext {
        fn drop(&mut self) {
            // SAFETY: `self.0` is a live DC created by CreateDCW.
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }

    pub fn read_ramp(device: &str) -> Option<GammaRamp> {
        let dc = DeviceContext::create(device)?;
        let mut ramp: GammaRamp = [[0u16; 256]; 3];
        // SAFETY: `ramp` is a 3×256 WORD buffer, exactly what GetDeviceGammaRamp
        // writes; `dc.0` is a live DC.
        let ok = unsafe { GetDeviceGammaRamp(dc.0, ramp.as_mut_ptr() as *mut core::ffi::c_void) };
        ok.as_bool().then_some(ramp)
    }

    pub fn apply_ramp(device: &str, ramp: &GammaRamp) -> bool {
        let Some(dc) = DeviceContext::create(device) else {
            return false;
        };
        // SAFETY: `ramp` is a 3×256 WORD buffer, exactly what SetDeviceGammaRamp
        // reads; `dc.0` is a live DC.
        let ok = unsafe { SetDeviceGammaRamp(dc.0, ramp.as_ptr() as *const core::ffi::c_void) };
        ok.as_bool()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_temp_full_brightness_is_near_identity_top() {
        let ramp = compose(6500.0, 1.0, false);
        // Top of each channel should reach (near) full scale at neutral temp.
        for (channel, ch) in ramp.iter().enumerate() {
            assert!(ch[255] > 60000, "channel {channel} too dim");
            assert_eq!(ch[0], 0);
        }
    }

    #[test]
    fn brightness_scales_down() {
        let full = compose(6500.0, 1.0, false);
        let half = compose(6500.0, 0.5, false);
        assert!(half[1][255] < full[1][255]);
    }

    #[test]
    fn invert_reverses_endpoints() {
        let ramp = compose(6500.0, 1.0, true);
        // Inverted: index 0 maps high, index 255 maps low.
        assert!(ramp[1][0] > ramp[1][255]);
    }

    #[test]
    fn invert_still_honours_brightness_and_tint() {
        // Brightness dims the inverted image's whites; blacks stay true black.
        let half = compose(6500.0, 0.5, true);
        assert!(
            half[0][0] < 34000 && half[0][0] > 31000,
            "inverted white should sit at ~half scale, got {}",
            half[0][0]
        );
        assert_eq!(half[0][255], 0, "inverted black must stay black");
        // A warm tint must warm the inverted image too (suppress blue), not
        // push it bluer as the old mirror-the-output composition did.
        let warm = compose(2000.0, 1.0, true);
        assert!(
            warm[2][0] < warm[0][0],
            "warm invert should suppress blue relative to red ({} vs {})",
            warm[2][0],
            warm[0][0]
        );
    }

    #[test]
    fn plausible_original_accepts_calibrations_and_tints_but_rejects_brightness_cuts() {
        assert!(plausible_original(&identity()));
        // A warm tint (f.lux-style) keeps red at full scale.
        assert!(plausible_original(&compose(3400.0, 1.0, false)));
        // A stranded 50% brightness filter cuts EVERY channel's peak.
        assert!(!plausible_original(&compose(6500.0, 0.5, false)));
        // A stranded inverted (Editing-mode) ramp peaks at index 0, not 255.
        assert!(!plausible_original(&compose(6500.0, 1.0, true)));
    }

    #[test]
    fn warm_temp_drops_blue() {
        let (_, _, blue) = kelvin_to_rgb(2000.0);
        assert!(blue < 0.6, "warm light should suppress blue, got {blue}");
    }
}
