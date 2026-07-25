//! Linux display backend.
//!
//! X11 sessions use RandR 1.2 output discovery and per-CRTC gamma ramps. The
//! persisted monitor id combines an EDID fingerprint with the connector name
//! (`x11-output:edid-<hash>:DP-1`) rather than a session-local CRTC XID; every
//! operation resolves the output's current CRTC before touching its LUT. A
//! connector-only id is the explicit fallback when a driver exposes no EDID.
//!
//! Native Wayland delegates to the persistent wlroots gamma-control actor in
//! [`super::linux_wayland`] when that compositor protocol is available. We do
//! not use XWayland's RandR objects as a fallback because that would affect only
//! XWayland surfaces (if anything) while falsely claiming physical-display
//! control.

use std::collections::HashMap;
use std::env;
use std::slice;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once, OnceLock};
use std::thread;

use x11_dl::xlib;
use x11_dl::xrandr::{self, RRCrtc, RROutput};

use super::gamma::GammaRamp;
use super::monitors::MonitorInfo;

const OUTPUT_ID_PREFIX: &str = "x11-output:";

static BACKEND: OnceLock<Mutex<Option<X11Backend>>> = OnceLock::new();
static WAYLAND_WARNING: Once = Once::new();
static BACKEND_WARNING: Once = Once::new();
static TOPOLOGY_LISTENER_STARTED: AtomicBool = AtomicBool::new(false);

/// An X11 connection and its dynamically loaded function tables.
///
/// The display pointer is stored as an integer so the backend can live behind
/// the process-wide mutex. It is converted back only while that mutex is held;
/// no Xlib call made by this module can overlap another one.
struct X11Backend {
    xlib: xlib::Xlib,
    xrandr: xrandr::Xrandr,
    display: usize,
    randr_event_base: i32,
    original_ramps: HashMap<String, NativeRamp>,
}

struct NativeRamp {
    channels: [Vec<u16>; 3],
    normalized: GammaRamp,
}

impl X11Backend {
    fn open() -> Option<Self> {
        let xlib = xlib::Xlib::open().map_err(|error| error.to_string());
        let xrandr = xrandr::Xrandr::open().map_err(|error| error.to_string());
        let (xlib, xrandr) = match (xlib, xrandr) {
            (Ok(xlib), Ok(xrandr)) => (xlib, xrandr),
            (Err(error), _) => {
                warn_backend_once(&format!("could not load Xlib: {error}"));
                return None;
            }
            (_, Err(error)) => {
                warn_backend_once(&format!("could not load XRandR: {error}"));
                return None;
            }
        };

        // SAFETY: A null name asks Xlib to use DISPLAY. The returned pointer is
        // checked and then retained for the process lifetime.
        let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
        if display.is_null() {
            warn_backend_once("could not open the X11 display");
            return None;
        }

        let mut event_base = 0;
        let mut error_base = 0;
        let mut major = 0;
        let mut minor = 0;
        // SAFETY: `display` is live and all output pointers refer to initialized
        // stack integers. RandR 1.2 introduced the output/CRTC API used below.
        let supported = unsafe {
            (xrandr.XRRQueryExtension)(display, &mut event_base, &mut error_base) != 0
                && (xrandr.XRRQueryVersion)(display, &mut major, &mut minor) != 0
                && (major > 1 || (major == 1 && minor >= 2))
        };
        if !supported {
            // SAFETY: `display` came from XOpenDisplay and has not been closed.
            unsafe {
                (xlib.XCloseDisplay)(display);
            }
            warn_backend_once("the X server does not expose RandR 1.2 or newer");
            return None;
        }

        Some(Self {
            xlib,
            xrandr,
            display: display as usize,
            randr_event_base: event_base,
            original_ramps: HashMap::new(),
        })
    }

    fn display(&self) -> *mut xlib::Display {
        self.display as *mut xlib::Display
    }

    fn root(&self) -> xlib::Window {
        // SAFETY: The backend owns a live X display connection.
        unsafe { (self.xlib.XDefaultRootWindow)(self.display()) }
    }
}

impl Drop for X11Backend {
    fn drop(&mut self) {
        if self.display != 0 {
            // SAFETY: This backend exclusively owns the XOpenDisplay result.
            unsafe {
                (self.xlib.XCloseDisplay)(self.display());
            }
            self.display = 0;
        }
    }
}

/// Enumerate connected, active RandR outputs.
pub fn enumerate() -> Vec<MonitorInfo> {
    if reject_native_wayland() {
        return super::linux_wayland::enumerate()
            .into_iter()
            .enumerate()
            .map(|(index, monitor)| MonitorInfo {
                id: monitor.id,
                index: index as u32,
                friendly_name: monitor.friendly_name,
                // Wayland has no universal primary-output concept. The first
                // compositor-advertised output is the deterministic fallback.
                is_primary: index == 0,
            })
            .collect();
    }

    with_backend(|backend| enumerate_x11(backend)).unwrap_or_default()
}

/// Read the current LUT for an X11 output and normalize it to 256 entries.
pub fn read_ramp(device: &str) -> Option<GammaRamp> {
    if reject_native_wayland() {
        return None;
    }
    let connector = parse_output_id(device)?;

    with_backend(|backend| read_ramp_x11(backend, device, connector)).flatten()
}

/// Apply a normalized 256-entry LUT to an X11 output.
pub fn apply_ramp(device: &str, ramp: &GammaRamp) -> bool {
    if is_wayland_id(device) {
        return super::linux_wayland::apply_ramp(device, ramp);
    }
    if reject_native_wayland() {
        return false;
    }
    let Some(connector) = parse_output_id(device) else {
        return false;
    };

    with_backend(|backend| apply_ramp_x11(backend, device, connector, ramp)).unwrap_or(false)
}

/// Start the callback-driven RandR topology listener.
///
/// A dedicated X connection blocks in `XNextEvent`; there is no timer or
/// periodic rescan. Calls after a listener is already active are idempotent and
/// return `true` (the callback supplied by the first call remains registered).
pub fn start_topology_listener(callback: fn()) -> bool {
    if reject_native_wayland() {
        return super::linux_wayland::start_topology_listener(callback);
    }
    if TOPOLOGY_LISTENER_STARTED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return true;
    }

    let Some(backend) = X11Backend::open() else {
        TOPOLOGY_LISTENER_STARTED.store(false, Ordering::Release);
        return false;
    };
    match thread::Builder::new()
        .name("display-xrandr-events".into())
        .spawn(move || run_topology_listener(backend, callback))
    {
        Ok(_) => true,
        Err(error) => {
            TOPOLOGY_LISTENER_STARTED.store(false, Ordering::Release);
            log::warn!("[display] failed to start XRandR topology listener: {error}");
            false
        }
    }
}

/// Whether this output's compositor owns the original ramp and restores it
/// when DimRead releases its gamma-control object.
pub fn compositor_managed(device: &str) -> bool {
    is_wayland_id(device)
}

/// Release a compositor-managed output, restoring the exact pre-DimRead state.
pub fn release_ramp(device: &str) -> bool {
    is_wayland_id(device) && super::linux_wayland::release_ramp(device)
}

/// Drop backend-local state for a disconnected output so a later monitor on
/// the same connector gets a fresh native-original capture.
pub fn forget_device(device: &str) {
    if parse_output_id(device).is_none() {
        return;
    }
    let _ = with_backend(|backend| backend.original_ramps.remove(device));
}

fn run_topology_listener(backend: X11Backend, callback: fn()) {
    let display = backend.display();
    let root = backend.root();
    let mask = xrandr::RRScreenChangeNotifyMask
        | xrandr::RRCrtcChangeNotifyMask
        | xrandr::RROutputChangeNotifyMask;
    // SAFETY: This thread exclusively owns `backend` and its X connection.
    unsafe {
        (backend.xrandr.XRRSelectInput)(display, root, mask);
        (backend.xlib.XSync)(display, xlib::False);
    }

    loop {
        // SAFETY: XEvent is a C union where all-zero is a valid initial buffer;
        // XNextEvent fills it before it is inspected.
        let mut event: xlib::XEvent = unsafe { std::mem::zeroed() };
        // SAFETY: This is the sole consumer of the listener connection. The
        // blocking wait is the desired callback source, not a polling loop.
        let status = unsafe { (backend.xlib.XNextEvent)(display, &mut event) };
        if status != 0 {
            log::warn!("[display] XRandR topology listener stopped: XNextEvent failed");
            break;
        }

        let event_type = event.get_type();
        let screen_change = backend.randr_event_base + xrandr::RRScreenChangeNotify;
        let resource_change = backend.randr_event_base + xrandr::RRNotify;
        if event_type != screen_change && event_type != resource_change {
            continue;
        }
        if event_type == screen_change {
            // SAFETY: This is an XRandR screen-change event from the connection
            // on which RandR events were selected.
            unsafe {
                (backend.xrandr.XRRUpdateConfiguration)(&mut event);
            }
        }
        if std::panic::catch_unwind(callback).is_err() {
            log::warn!("[display] XRandR topology callback panicked; listener remains active");
        }
    }

    TOPOLOGY_LISTENER_STARTED.store(false, Ordering::Release);
}

fn with_backend<T>(operation: impl FnOnce(&mut X11Backend) -> T) -> Option<T> {
    let backend = BACKEND.get_or_init(|| Mutex::new(X11Backend::open()));
    let mut guard = backend
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.as_mut().map(operation)
}

fn enumerate_x11(backend: &X11Backend) -> Vec<MonitorInfo> {
    let display = backend.display();
    let root = backend.root();
    // SAFETY: The connection and root window are valid for the duration of the
    // process-wide backend lock.
    let resources = unsafe { (backend.xrandr.XRRGetScreenResourcesCurrent)(display, root) };
    if resources.is_null() {
        return Vec::new();
    }

    // SAFETY: `resources` is live until XRRFreeScreenResources below.
    let primary = unsafe { (backend.xrandr.XRRGetOutputPrimary)(display, root) };
    // SAFETY: RandR owns an array of `noutput` output XIDs. A negative count is
    // treated as empty rather than converted to a huge usize.
    let outputs = unsafe {
        let count = (*resources).noutput.max(0) as usize;
        if count == 0 || (*resources).outputs.is_null() {
            &[]
        } else {
            slice::from_raw_parts((*resources).outputs, count)
        }
    };

    let mut monitors = Vec::with_capacity(outputs.len());
    for &output in outputs {
        // SAFETY: The output belongs to `resources`, which remains live.
        let info = unsafe { (backend.xrandr.XRRGetOutputInfo)(display, resources, output) };
        if info.is_null() {
            continue;
        }

        // SAFETY: `info` is live until XRRFreeOutputInfo immediately below.
        let active =
            unsafe { (*info).connection == xrandr::RR_Connected as u16 && (*info).crtc != 0 };
        let connector = if active {
            // SAFETY: RandR owns `nameLen` bytes at `name`. Invalid/empty data
            // is rejected so it can never become a persisted monitor id.
            unsafe { output_name(info) }
        } else {
            None
        };

        if let Some(connector) = connector {
            let id = output_device_id(&connector, read_edid(backend, output).as_deref());
            monitors.push(MonitorInfo {
                id,
                index: monitors.len() as u32,
                friendly_name: connector,
                is_primary: output == primary,
            });
        }

        // SAFETY: `info` was returned by XRRGetOutputInfo exactly once.
        unsafe {
            (backend.xrandr.XRRFreeOutputInfo)(info);
        }
    }

    // SAFETY: `resources` was returned by XRRGetScreenResourcesCurrent once.
    unsafe {
        (backend.xrandr.XRRFreeScreenResources)(resources);
    }
    monitors
}

fn read_ramp_x11(backend: &mut X11Backend, device: &str, connector: &str) -> Option<GammaRamp> {
    let crtc = resolve_crtc(backend, connector)?;
    let display = backend.display();
    // SAFETY: `crtc` was resolved on this live connection while holding the
    // backend lock.
    let native = unsafe { (backend.xrandr.XRRGetCrtcGamma)(display, crtc) };
    if native.is_null() {
        return None;
    }

    // SAFETY: `native` remains owned by RandR until XRRFreeGamma below.
    let result = unsafe {
        let size = (*native).size.max(0) as usize;
        if size == 0
            || (*native).red.is_null()
            || (*native).green.is_null()
            || (*native).blue.is_null()
        {
            None
        } else {
            let channels = [
                slice::from_raw_parts((*native).red, size).to_vec(),
                slice::from_raw_parts((*native).green, size).to_vec(),
                slice::from_raw_parts((*native).blue, size).to_vec(),
            ];
            let normalized = [
                resample_to_array(&channels[0]),
                resample_to_array(&channels[1]),
                resample_to_array(&channels[2]),
            ];
            Some((normalized, channels))
        }
    };

    // SAFETY: `native` was returned by XRRGetCrtcGamma exactly once.
    unsafe {
        (backend.xrandr.XRRFreeGamma)(native);
    }
    let (normalized, channels) = result?;
    backend
        .original_ramps
        .entry(device.to_owned())
        .or_insert_with(|| NativeRamp {
            channels,
            normalized,
        });
    Some(normalized)
}

fn apply_ramp_x11(
    backend: &mut X11Backend,
    device: &str,
    connector: &str,
    ramp: &GammaRamp,
) -> bool {
    let Some(crtc) = resolve_crtc(backend, connector) else {
        return false;
    };
    let display = backend.display();
    // SAFETY: `crtc` is active on this connection.
    let size = unsafe { (backend.xrandr.XRRGetCrtcGammaSize)(display, crtc) };
    if size <= 0 {
        return false;
    }

    // SAFETY: Positive size is the native LUT size reported for this CRTC.
    let native = unsafe { (backend.xrandr.XRRAllocGamma)(size) };
    if native.is_null() {
        return false;
    }

    let native_size = size as usize;
    // SAFETY: XRRAllocGamma returns three writable `size`-element arrays. Null
    // pointers are checked before copying.
    let valid = unsafe {
        !(*native).red.is_null() && !(*native).green.is_null() && !(*native).blue.is_null()
    };
    if !valid {
        // SAFETY: `native` was allocated by XRRAllocGamma.
        unsafe {
            (backend.xrandr.XRRFreeGamma)(native);
        }
        return false;
    }

    let channels = backend
        .original_ramps
        .get(device)
        .filter(|original| original.normalized == *ramp)
        .map_or_else(
            || {
                [
                    resample(&ramp[0], native_size),
                    resample(&ramp[1], native_size),
                    resample(&ramp[2], native_size),
                ]
            },
            |original| {
                [
                    resample(&original.channels[0], native_size),
                    resample(&original.channels[1], native_size),
                    resample(&original.channels[2], native_size),
                ]
            },
        );
    // SAFETY: Every source and destination contains exactly `native_size`
    // elements and the three RandR channel buffers do not overlap.
    unsafe {
        std::ptr::copy_nonoverlapping(channels[0].as_ptr(), (*native).red, native_size);
        std::ptr::copy_nonoverlapping(channels[1].as_ptr(), (*native).green, native_size);
        std::ptr::copy_nonoverlapping(channels[2].as_ptr(), (*native).blue, native_size);
        (backend.xrandr.XRRSetCrtcGamma)(display, crtc, native);
        // Force the request through the server before reporting success.
        (backend.xlib.XSync)(display, xlib::False);
        (backend.xrandr.XRRFreeGamma)(native);
    }
    true
}

fn resolve_crtc(backend: &X11Backend, connector: &str) -> Option<RRCrtc> {
    let display = backend.display();
    // SAFETY: The backend owns a live connection and root window.
    let resources =
        unsafe { (backend.xrandr.XRRGetScreenResourcesCurrent)(display, backend.root()) };
    if resources.is_null() {
        return None;
    }

    // SAFETY: The resource output array is valid until it is freed below.
    let outputs = unsafe {
        let count = (*resources).noutput.max(0) as usize;
        if count == 0 || (*resources).outputs.is_null() {
            &[]
        } else {
            slice::from_raw_parts((*resources).outputs, count)
        }
    };
    let mut resolved = None;
    for &output in outputs {
        // SAFETY: The output belongs to the live resource set.
        let info = unsafe { (backend.xrandr.XRRGetOutputInfo)(display, resources, output) };
        if info.is_null() {
            continue;
        }
        // SAFETY: `info` remains live through these field reads.
        let matches = unsafe {
            (*info).connection == xrandr::RR_Connected as u16
                && (*info).crtc != 0
                && output_name(info).as_deref() == Some(connector)
        };
        if matches {
            // SAFETY: Field read from the still-live output info.
            resolved = Some(unsafe { (*info).crtc });
        }
        // SAFETY: `info` was returned by XRRGetOutputInfo exactly once.
        unsafe {
            (backend.xrandr.XRRFreeOutputInfo)(info);
        }
        if resolved.is_some() {
            break;
        }
    }

    // SAFETY: `resources` was returned by XRRGetScreenResourcesCurrent once.
    unsafe {
        (backend.xrandr.XRRFreeScreenResources)(resources);
    }
    resolved
}

/// Read an output connector name from a live RandR output-info allocation.
unsafe fn output_name(info: *mut xrandr::XRROutputInfo) -> Option<String> {
    // SAFETY: The caller guarantees `info` is a live XRR output-info pointer.
    let (name, length) = unsafe { ((*info).name, (*info).nameLen) };
    if name.is_null() || length <= 0 {
        return None;
    }
    // SAFETY: RandR promises `nameLen` readable bytes at `name`.
    let bytes = unsafe { slice::from_raw_parts(name.cast::<u8>(), length as usize) };
    let name = String::from_utf8_lossy(bytes).into_owned();
    (!name.trim().is_empty()).then_some(name)
}

fn parse_output_id(device: &str) -> Option<&str> {
    let remainder = device.strip_prefix(OUTPUT_ID_PREFIX)?;
    let connector = remainder
        .strip_prefix("edid-")
        .and_then(|tagged| tagged.split_once(':'))
        .filter(|(hash, connector)| {
            hash.len() == 16
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                && !connector.is_empty()
        })
        .map_or(remainder, |(_, connector)| connector);
    (!connector.is_empty()).then_some(connector)
}

fn output_device_id(connector: &str, edid: Option<&[u8]>) -> String {
    edid.map_or_else(
        || format!("{OUTPUT_ID_PREFIX}{connector}"),
        |bytes| {
            format!(
                "{OUTPUT_ID_PREFIX}edid-{:016x}:{connector}",
                fnv1a_64(bytes)
            )
        },
    )
}

/// Read the complete EDID property advertised for one RandR output.
fn read_edid(backend: &X11Backend, output: RROutput) -> Option<Vec<u8>> {
    let display = backend.display();
    // SAFETY: `display` is live and the C string is statically NUL-terminated.
    let property = unsafe { (backend.xlib.XInternAtom)(display, c"EDID".as_ptr(), xlib::True) };
    if property == 0 {
        return None;
    }

    let mut actual_type = 0;
    let mut actual_format = 0;
    let mut item_count = 0;
    let mut bytes_after = 0;
    let mut property_data = std::ptr::null_mut();
    // Property length is measured in 32-bit units. 8192 units covers the
    // protocol's maximum 256 EDID blocks while keeping the allocation bounded.
    // SAFETY: All result pointers are valid stack locations; RandR allocates
    // `property_data`, which is released with XFree below.
    let status = unsafe {
        (backend.xrandr.XRRGetOutputProperty)(
            display,
            output,
            property,
            0,
            8192,
            xlib::False,
            xlib::False,
            xlib::AnyPropertyType as xlib::Atom,
            &mut actual_type,
            &mut actual_format,
            &mut item_count,
            &mut bytes_after,
            &mut property_data,
        )
    };

    let edid = if status == i32::from(xlib::Success)
        && actual_type != 0
        && actual_format == 8
        && bytes_after == 0
        && item_count >= 128
        && !property_data.is_null()
    {
        // SAFETY: With format 8, `item_count` is the exact readable byte count
        // of the Xlib-owned property allocation.
        let bytes = unsafe { slice::from_raw_parts(property_data, item_count as usize) };
        is_edid(bytes).then(|| bytes.to_vec())
    } else {
        None
    };

    if !property_data.is_null() {
        // SAFETY: XRRGetOutputProperty allocated this buffer with Xlib.
        unsafe {
            (backend.xlib.XFree)(property_data.cast());
        }
    }
    edid
}

fn is_edid(bytes: &[u8]) -> bool {
    const HEADER: [u8; 8] = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
    bytes.len() >= 128 && bytes.len().is_multiple_of(128) && bytes.starts_with(&HEADER)
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn is_wayland_id(device: &str) -> bool {
    device.starts_with("wayland:")
}

fn reject_native_wayland() -> bool {
    if !is_native_wayland_session() {
        return false;
    }
    WAYLAND_WARNING.call_once(|| {
        log::warn!(
            "[display] native Wayland session detected; using compositor gamma control when zwlr_gamma_control_manager_v1 is available and refusing false XWayland RandR fallback"
        );
    });
    true
}

fn is_native_wayland_session() -> bool {
    env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
        || (env::var_os("WAYLAND_DISPLAY").is_some()
            && !env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("x11")))
}

fn warn_backend_once(reason: &str) {
    BACKEND_WARNING.call_once(|| {
        log::warn!("[display] X11 display control unavailable: {reason}");
    });
}

fn resample_to_array(source: &[u16]) -> [u16; 256] {
    let values = resample(source, 256);
    let mut result = [0; 256];
    result.copy_from_slice(&values);
    result
}

/// Linearly resample a LUT while preserving both endpoints exactly.
fn resample(source: &[u16], output_len: usize) -> Vec<u16> {
    if source.is_empty() || output_len == 0 {
        return Vec::new();
    }
    if source.len() == 1 {
        return vec![source[0]; output_len];
    }
    if output_len == 1 {
        return vec![source[0]];
    }

    let denominator = (output_len - 1) as u64;
    let source_span = (source.len() - 1) as u64;
    (0..output_len)
        .map(|index| {
            let numerator = index as u64 * source_span;
            let lower = (numerator / denominator) as usize;
            let remainder = numerator % denominator;
            let upper = (lower + 1).min(source.len() - 1);
            let weighted = u64::from(source[lower]) * (denominator - remainder)
                + u64::from(source[upper]) * remainder;
            ((weighted + denominator / 2) / denominator) as u16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_non_empty_x11_output_ids() {
        assert_eq!(parse_output_id("x11-output:DP-1"), Some("DP-1"));
        assert_eq!(
            parse_output_id("x11-output:edid-a430d84680aabd0b:DP-1"),
            Some("DP-1")
        );
        assert_eq!(
            parse_output_id("x11-output:edid-not-a-hash:DP-1"),
            Some("edid-not-a-hash:DP-1")
        );
        assert_eq!(parse_output_id("x11-output:"), None);
        assert_eq!(parse_output_id("DP-1"), None);
    }

    #[test]
    fn edid_ids_include_connector_and_stable_hash() {
        assert_eq!(fnv1a_64(b"hello"), 0xa430_d846_80aa_bd0b);
        assert_eq!(
            output_device_id("DP-1", Some(b"hello")),
            "x11-output:edid-a430d84680aabd0b:DP-1"
        );
        assert_eq!(output_device_id("DP-1", None), "x11-output:DP-1");
    }

    #[test]
    fn validates_complete_edid_blocks() {
        let mut valid = vec![0; 128];
        valid[..8].copy_from_slice(&[0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
        assert!(is_edid(&valid));
        assert!(!is_edid(&valid[..127]));
        valid[1] = 0;
        assert!(!is_edid(&valid));
    }

    #[test]
    fn resampling_preserves_endpoints_and_interpolates() {
        assert_eq!(resample(&[0, 1000], 3), vec![0, 500, 1000]);
        assert_eq!(resample(&[25], 4), vec![25, 25, 25, 25]);
        assert_eq!(resample(&[1, 2], 1), vec![1]);
    }

    #[test]
    fn round_trip_between_common_gamma_sizes_is_close() {
        let identity: Vec<u16> = (0..256).map(|index| index * 257).collect();
        let native = resample(&identity, 1024);
        let restored = resample(&native, 256);
        assert_eq!(restored.first(), identity.first());
        assert_eq!(restored.last(), identity.last());
        assert!(
            restored
                .iter()
                .zip(identity.iter())
                .all(|(actual, expected)| actual.abs_diff(*expected) <= 1)
        );
    }
}
