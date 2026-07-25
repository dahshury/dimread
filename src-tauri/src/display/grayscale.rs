//! Full-screen grayscale via the Windows Magnification API (Reading mode).
//!
//! `MagInitialize` + `MagSetFullscreenColorEffect` install a process-set,
//! system-wide 5×5 colour-effect matrix applied to the whole desktop at
//! composition time. We feed it a luminance matrix to render everything in
//! grayscale (e-ink-like Reading mode) and the identity matrix to clear it.
//!
//! This is best-effort: failures are reported to the engine so its live state
//! never claims grayscale was applied when it was not. macOS and Linux do not
//! expose a reliable public compositor-wide colour-matrix API; Reading mode
//! still applies its gamma preset there and reports the missing grayscale
//! capability explicitly.

/// Enable or disable full-screen grayscale. Returns whether the requested state
/// is in effect.
#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> bool {
    windows_impl::set_enabled(enabled)
}

#[cfg(not(windows))]
pub fn set_enabled(enabled: bool) -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};

    static WARNED: AtomicBool = AtomicBool::new(false);
    if enabled && !WARNED.swap(true, Ordering::Relaxed) {
        log::warn!(
            "[grayscale] this platform has no reliable public full-screen colour-matrix API; Reading mode is running without grayscale"
        );
    }
    !enabled
}

/// Clear the effect regardless of what this process believes is applied.
///
/// [`set_enabled`] short-circuits when the requested state already matches its
/// `ACTIVE` flag, which is correct in a running process but wrong at boot after
/// an unclean shutdown: `ACTIVE` starts `false` while the desktop may still be
/// grayscale, so `set_enabled(false)` would no-op. This writes the identity
/// matrix unconditionally.
#[cfg(windows)]
pub fn force_clear() -> bool {
    windows_impl::force_clear()
}

#[cfg(not(windows))]
pub fn force_clear() -> bool {
    true
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::UI::Magnification::{
        MAGCOLOREFFECT, MagInitialize, MagSetFullscreenColorEffect,
    };

    /// True once `MagInitialize` has succeeded for this process.
    static INITIALIZED: AtomicBool = AtomicBool::new(false);
    /// True while the grayscale effect is currently applied.
    static ACTIVE: AtomicBool = AtomicBool::new(false);

    /// Rec. 601 luminance weights broadcast across R/G/B → grayscale. Column-
    /// major 5×5 matrix in the layout `MAGCOLOREFFECT` expects.
    #[rustfmt::skip]
    const GRAYSCALE: MAGCOLOREFFECT = MAGCOLOREFFECT {
        transform: [
            0.299, 0.299, 0.299, 0.0, 0.0,
            0.587, 0.587, 0.587, 0.0, 0.0,
            0.114, 0.114, 0.114, 0.0, 0.0,
            0.0,   0.0,   0.0,   1.0, 0.0,
            0.0,   0.0,   0.0,   0.0, 1.0,
        ],
    };

    /// Identity colour effect — clears any full-screen tint.
    #[rustfmt::skip]
    const IDENTITY: MAGCOLOREFFECT = MAGCOLOREFFECT {
        transform: [
            1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 1.0,
        ],
    };

    fn ensure_initialized() -> bool {
        if INITIALIZED.load(Ordering::SeqCst) {
            return true;
        }
        // SAFETY: MagInitialize takes no arguments and is safe to call once per
        // process; repeated calls are guarded by the atomic above.
        let ok = unsafe { MagInitialize() };
        if ok.as_bool() {
            INITIALIZED.store(true, Ordering::SeqCst);
            true
        } else {
            log::warn!("[grayscale] MagInitialize failed; Reading-mode grayscale disabled");
            false
        }
    }

    pub fn force_clear() -> bool {
        if !ensure_initialized() {
            return false;
        }
        // SAFETY: `IDENTITY` is a valid MAGCOLOREFFECT for the duration of the
        // call; MagSetFullscreenColorEffect copies it.
        let ok = unsafe { MagSetFullscreenColorEffect(&IDENTITY) };
        if ok.as_bool() {
            ACTIVE.store(false, Ordering::SeqCst);
            true
        } else {
            log::warn!("[grayscale] force_clear: MagSetFullscreenColorEffect failed");
            false
        }
    }

    pub fn set_enabled(enabled: bool) -> bool {
        if enabled == ACTIVE.load(Ordering::SeqCst) {
            return true;
        }
        if !ensure_initialized() {
            return false;
        }
        let effect = if enabled { &GRAYSCALE } else { &IDENTITY };
        // SAFETY: `effect` is a valid MAGCOLOREFFECT for the duration of the
        // call; MagSetFullscreenColorEffect copies it.
        let ok = unsafe { MagSetFullscreenColorEffect(effect) };
        if ok.as_bool() {
            ACTIVE.store(enabled, Ordering::SeqCst);
            true
        } else {
            log::warn!("[grayscale] MagSetFullscreenColorEffect failed (enabled={enabled})");
            false
        }
    }
}
