//! macOS display discovery and gamma-table I/O.
//!
//! CoreGraphics exposes each active display as a [`CGDirectDisplayID`] and
//! provides public APIs for reading and setting its transfer table. The rest
//! of the display engine uses a fixed 256-entry [`GammaRamp`], while a display
//! may advertise a different native table capacity, so this backend linearly
//! resamples at both sides of that boundary.

#![cfg(target_os = "macos")]

use std::ffi::{c_int, c_void};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

use super::{gamma::GammaRamp, monitors::MonitorInfo};

type CGDirectDisplayId = u32;
type CGError = c_int;
type CGGammaValue = f32;

const CG_ERROR_SUCCESS: CGError = 0;
const UUID_PREFIX: &str = "macos:uuid:";
const HARDWARE_PREFIX: &str = "macos:hardware:";
const SESSION_PREFIX: &str = "macos:session:";

// A corrupt/buggy driver must not be able to make us allocate an unbounded
// table. Real CoreGraphics capacities are tiny (typically 256 or 1024).
const MAX_GAMMA_TABLE_CAPACITY: usize = 65_536;
const CG_DISPLAY_BEGIN_CONFIGURATION_FLAG: u32 = 1;

static TOPOLOGY_CALLBACK: Mutex<Option<fn()>> = Mutex::new(None);
static TOPOLOGY_REGISTRATION_LOCK: Mutex<()> = Mutex::new(());
static TOPOLOGY_REGISTERED: AtomicBool = AtomicBool::new(false);

type CFTypeRef = *const c_void;
type CFUUIDRef = *const c_void;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
struct CFUUIDBytes {
    byte0: u8,
    byte1: u8,
    byte2: u8,
    byte3: u8,
    byte4: u8,
    byte5: u8,
    byte6: u8,
    byte7: u8,
    byte8: u8,
    byte9: u8,
    byte10: u8,
    byte11: u8,
    byte12: u8,
    byte13: u8,
    byte14: u8,
    byte15: u8,
}

impl CFUUIDBytes {
    fn as_array(self) -> [u8; 16] {
        [
            self.byte0,
            self.byte1,
            self.byte2,
            self.byte3,
            self.byte4,
            self.byte5,
            self.byte6,
            self.byte7,
            self.byte8,
            self.byte9,
            self.byte10,
            self.byte11,
            self.byte12,
            self.byte13,
            self.byte14,
            self.byte15,
        ]
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGGetActiveDisplayList(
        max_displays: u32,
        active_displays: *mut CGDirectDisplayId,
        display_count: *mut u32,
    ) -> CGError;
    fn CGMainDisplayID() -> CGDirectDisplayId;
    fn CGDisplayIsBuiltin(display: CGDirectDisplayId) -> u32;
    fn CGDisplayVendorNumber(display: CGDirectDisplayId) -> u32;
    fn CGDisplayModelNumber(display: CGDirectDisplayId) -> u32;
    fn CGDisplaySerialNumber(display: CGDirectDisplayId) -> u32;
    fn CGDisplayGammaTableCapacity(display: CGDirectDisplayId) -> u32;
    fn CGDisplayRegisterReconfigurationCallback(
        callback: unsafe extern "C" fn(CGDirectDisplayId, u32, *mut c_void),
        user_info: *mut c_void,
    ) -> CGError;
    fn CGGetDisplayTransferByTable(
        display: CGDirectDisplayId,
        capacity: u32,
        red_table: *mut CGGammaValue,
        green_table: *mut CGGammaValue,
        blue_table: *mut CGGammaValue,
        sample_count: *mut u32,
    ) -> CGError;
    fn CGSetDisplayTransferByTable(
        display: CGDirectDisplayId,
        table_size: u32,
        red_table: *const CGGammaValue,
        green_table: *const CGGammaValue,
        blue_table: *const CGGammaValue,
    ) -> CGError;
}

// `CGDisplayCreateUUIDFromDisplayID` is supplied by the ColorSync
// subframework. Link ApplicationServices so the symbol is also available on
// pre-10.13 macOS versions where ColorSync was not yet a public framework.
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGDisplayCreateUUIDFromDisplayID(display: CGDirectDisplayId) -> CFUUIDRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFUUIDGetUUIDBytes(uuid: CFUUIDRef) -> CFUUIDBytes;
    fn CFRelease(value: CFTypeRef);
}

/// Enumerate displays that are active in the current macOS display session.
///
/// The engine-facing id uses CoreGraphics' persistent display UUID. The live
/// `CGDirectDisplayID` is intentionally not persisted because macOS may assign
/// a different numeric id after reconnect or reboot. If CoreGraphics cannot
/// produce a UUID, vendor/model/serial is used; the session id is the final
/// fallback for displays that expose no durable hardware identity.
pub fn enumerate() -> Vec<MonitorInfo> {
    let mut display_count = 0;
    // SAFETY: CoreGraphics accepts a null output buffer when max_displays is
    // zero and writes only the required count to `display_count`.
    if unsafe { CGGetActiveDisplayList(0, std::ptr::null_mut(), &mut display_count) }
        != CG_ERROR_SUCCESS
        || display_count == 0
    {
        return Vec::new();
    }

    let mut displays = vec![0; display_count as usize];
    let mut actual_count = display_count;
    // SAFETY: `displays` has room for `display_count` ids, and
    // `actual_count` is a valid out pointer.
    if unsafe { CGGetActiveDisplayList(display_count, displays.as_mut_ptr(), &mut actual_count) }
        != CG_ERROR_SUCCESS
    {
        return Vec::new();
    }
    displays.truncate((actual_count as usize).min(displays.len()));

    // Make enumeration deterministic and keep the primary display first.
    let primary = unsafe { CGMainDisplayID() };
    displays.sort_unstable_by_key(|display| (*display != primary, *display));

    displays
        .into_iter()
        .enumerate()
        .map(|(index, display)| MonitorInfo {
            id: device_key(display),
            index: index as u32,
            friendly_name: friendly_name(display, index),
            is_primary: display == primary,
        })
        .collect()
}

/// Read a display's current CoreGraphics transfer table into the engine's
/// fixed-size ramp. Returns `None` for an invalid id, a disconnected display,
/// an unsupported display, or an invalid table returned by the OS.
pub fn read_ramp(device: &str) -> Option<GammaRamp> {
    let display = resolve_display(device)?;
    let capacity = gamma_capacity(display)?;
    let mut red = vec![0.0; capacity];
    let mut green = vec![0.0; capacity];
    let mut blue = vec![0.0; capacity];
    let mut sample_count = 0;

    // SAFETY: all three vectors have `capacity` writable entries, and
    // `sample_count` is a valid out pointer.
    if unsafe {
        CGGetDisplayTransferByTable(
            display,
            capacity as u32,
            red.as_mut_ptr(),
            green.as_mut_ptr(),
            blue.as_mut_ptr(),
            &mut sample_count,
        )
    } != CG_ERROR_SUCCESS
    {
        return None;
    }

    let sample_count = sample_count as usize;
    if sample_count == 0 || sample_count > capacity {
        return None;
    }
    red.truncate(sample_count);
    green.truncate(sample_count);
    blue.truncate(sample_count);

    Some([
        resample_gamma_values(&red)?,
        resample_gamma_values(&green)?,
        resample_gamma_values(&blue)?,
    ])
}

/// Apply an engine ramp to a display's native CoreGraphics transfer table.
/// Returns `false` when the display id is stale or gamma tables are unsupported.
pub fn apply_ramp(device: &str, ramp: &GammaRamp) -> bool {
    let Some(display) = resolve_display(device) else {
        return false;
    };
    let Some(capacity) = gamma_capacity(display) else {
        return false;
    };

    let red = resample_channel(&ramp[0], capacity);
    let green = resample_channel(&ramp[1], capacity);
    let blue = resample_channel(&ramp[2], capacity);

    // SAFETY: all three vectors contain exactly `capacity` readable entries.
    unsafe {
        CGSetDisplayTransferByTable(
            display,
            capacity as u32,
            red.as_ptr(),
            green.as_ptr(),
            blue.as_ptr(),
        ) == CG_ERROR_SUCCESS
    }
}

/// Restore a previously captured transfer table.
///
/// This is deliberately the same operation as applying a composed ramp: the
/// caller supplies the exact [`GammaRamp`] it captured with [`read_ramp`].
pub fn restore_ramp(device: &str, original: &GammaRamp) -> bool {
    apply_ramp(device, original)
}

/// Register a process-lifetime listener for native display-topology changes.
///
/// CoreGraphics invokes this callback when displays are connected,
/// disconnected, moved, mirrored, or reconfigured. Calling this function
/// again replaces the Rust callback without registering a second native hook.
/// The callback may run on a CoreGraphics-managed thread and must return
/// promptly; callers should signal their own worker rather than doing display
/// I/O inline.
pub fn start_topology_listener(callback: fn()) -> bool {
    *TOPOLOGY_CALLBACK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(callback);

    let _registration = TOPOLOGY_REGISTRATION_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if TOPOLOGY_REGISTERED.load(Ordering::Acquire) {
        return true;
    }

    // SAFETY: `topology_changed` has the exact callback ABI and remains valid
    // for the process lifetime; no user-info pointer is needed.
    let registered = unsafe {
        CGDisplayRegisterReconfigurationCallback(topology_changed, std::ptr::null_mut())
            == CG_ERROR_SUCCESS
    };
    if registered {
        TOPOLOGY_REGISTERED.store(true, Ordering::Release);
    }
    registered
}

unsafe extern "C" fn topology_changed(
    _display: CGDirectDisplayId,
    flags: u32,
    _user_info: *mut c_void,
) {
    // CoreGraphics first emits a begin marker and then the completed change.
    // Waiting for the latter keeps consumers from enumerating half-applied
    // display configurations.
    if flags & CG_DISPLAY_BEGIN_CONFIGURATION_FLAG != 0 {
        return;
    }
    let callback = *TOPOLOGY_CALLBACK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(callback) = callback {
        callback();
    }
}

fn active_displays() -> Vec<CGDirectDisplayId> {
    let mut display_count = 0;
    // SAFETY: count-only CoreGraphics query; see `enumerate`.
    if unsafe { CGGetActiveDisplayList(0, std::ptr::null_mut(), &mut display_count) }
        != CG_ERROR_SUCCESS
        || display_count == 0
    {
        return Vec::new();
    }
    let mut displays = vec![0; display_count as usize];
    let mut actual_count = display_count;
    // SAFETY: the vector has `display_count` writable entries.
    if unsafe { CGGetActiveDisplayList(display_count, displays.as_mut_ptr(), &mut actual_count) }
        != CG_ERROR_SUCCESS
    {
        return Vec::new();
    }
    displays.truncate((actual_count as usize).min(displays.len()));
    displays
}

fn resolve_display(device: &str) -> Option<CGDirectDisplayId> {
    if let Some(expected_uuid) = device.strip_prefix(UUID_PREFIX).and_then(parse_uuid) {
        return active_displays()
            .into_iter()
            .find(|display| display_uuid(*display) == Some(expected_uuid));
    }

    if let Some(identity) = device
        .strip_prefix(HARDWARE_PREFIX)
        .and_then(parse_hardware_identity)
    {
        return active_displays()
            .into_iter()
            .find(|display| hardware_identity(*display) == identity);
    }

    let session_id = device
        .strip_prefix(SESSION_PREFIX)?
        .parse::<CGDirectDisplayId>()
        .ok()?;
    active_displays()
        .into_iter()
        .find(|display| *display == session_id)
}

fn device_key(display: CGDirectDisplayId) -> String {
    if let Some(uuid) = display_uuid(display) {
        return format!("{UUID_PREFIX}{}", format_uuid(uuid));
    }
    let (vendor, model, serial) = hardware_identity(display);
    if vendor != 0 || model != 0 || serial != 0 {
        return format!("{HARDWARE_PREFIX}{vendor:08x}:{model:08x}:{serial:08x}");
    }
    format!("{SESSION_PREFIX}{display}")
}

fn display_uuid(display: CGDirectDisplayId) -> Option<[u8; 16]> {
    // SAFETY: this create-rule CoreGraphics API accepts any display id. A null
    // return indicates that no UUID is available. The retained object is
    // released after copying its value bytes.
    let uuid = unsafe { CGDisplayCreateUUIDFromDisplayID(display) };
    if uuid.is_null() {
        return None;
    }
    let bytes = unsafe { CFUUIDGetUUIDBytes(uuid) }.as_array();
    unsafe { CFRelease(uuid) };
    Some(bytes)
}

fn format_uuid(bytes: [u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn parse_uuid(value: &str) -> Option<[u8; 16]> {
    if value.len() != 36
        || !value.as_bytes().iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    let hex: String = value
        .chars()
        .filter(|character| *character != '-')
        .collect();
    let mut bytes = [0; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

fn parse_hardware_identity(value: &str) -> Option<(u32, u32, u32)> {
    let mut components = value.split(':');
    let vendor = u32::from_str_radix(components.next()?, 16).ok()?;
    let model = u32::from_str_radix(components.next()?, 16).ok()?;
    let serial = u32::from_str_radix(components.next()?, 16).ok()?;
    components
        .next()
        .is_none()
        .then_some((vendor, model, serial))
}

fn hardware_identity(display: CGDirectDisplayId) -> (u32, u32, u32) {
    // SAFETY: CoreGraphics returns zero for unavailable properties.
    unsafe {
        (
            CGDisplayVendorNumber(display),
            CGDisplayModelNumber(display),
            CGDisplaySerialNumber(display),
        )
    }
}

fn gamma_capacity(display: CGDirectDisplayId) -> Option<usize> {
    // SAFETY: CoreGraphics accepts any display id and returns zero when a
    // transfer table is unavailable.
    let capacity = unsafe { CGDisplayGammaTableCapacity(display) } as usize;
    (capacity > 0 && capacity <= MAX_GAMMA_TABLE_CAPACITY).then_some(capacity)
}

fn friendly_name(display: CGDirectDisplayId, index: usize) -> String {
    // SAFETY: these CoreGraphics property functions accept a display id and
    // return zero when the property is unavailable.
    if unsafe { CGDisplayIsBuiltin(display) } != 0 {
        return "Built-in Display".to_owned();
    }
    let vendor = unsafe { CGDisplayVendorNumber(display) };
    let model = unsafe { CGDisplayModelNumber(display) };
    if vendor == 0 && model == 0 {
        format!("External Display {}", index + 1)
    } else {
        format!("External Display {vendor:04X}:{model:04X}")
    }
}

fn resample_gamma_values(source: &[CGGammaValue]) -> Option<[u16; 256]> {
    if source.is_empty() || source.iter().any(|value| !value.is_finite()) {
        return None;
    }

    let mut target = [0; 256];
    let target_len = target.len();
    for (index, value) in target.iter_mut().enumerate() {
        let sample = interpolate(source, index, target_len);
        *value = (sample.clamp(0.0, 1.0) * u16::MAX as f32).round() as u16;
    }
    Some(target)
}

fn resample_channel(source: &[u16; 256], target_len: usize) -> Vec<CGGammaValue> {
    let normalized: Vec<_> = source
        .iter()
        .map(|value| *value as f32 / u16::MAX as f32)
        .collect();
    (0..target_len)
        .map(|index| interpolate(&normalized, index, target_len))
        .collect()
}

fn interpolate(source: &[f32], target_index: usize, target_len: usize) -> f32 {
    if source.len() == 1 || target_len <= 1 {
        return source[0];
    }

    let position = target_index as f64 * (source.len() - 1) as f64 / (target_len - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        source[lower]
    } else {
        let fraction = (position - lower as f64) as f32;
        source[lower] + (source[upper] - source[lower]) * fraction
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_round_trips() {
        let bytes = [
            0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
            0x77, 0x88,
        ];
        let encoded = format_uuid(bytes);
        assert_eq!(encoded, "12345678-9abc-def0-1122-334455667788");
        assert_eq!(parse_uuid(&encoded), Some(bytes));
        assert_eq!(parse_uuid("1234"), None);
    }

    #[test]
    fn hardware_identity_parser_is_strict() {
        assert_eq!(
            parse_hardware_identity("00000001:00000002:00000003"),
            Some((1, 2, 3))
        );
        assert_eq!(parse_hardware_identity("1:2"), None);
        assert_eq!(parse_hardware_identity("1:2:3:4"), None);
    }

    #[test]
    fn resampling_preserves_endpoints_and_midpoint() {
        let values = resample_gamma_values(&[0.0, 0.5, 1.0]).unwrap();
        assert_eq!(values[0], 0);
        assert!((values[128] as i32 - 32_896).abs() <= 1);
        assert_eq!(values[255], u16::MAX);
    }

    #[test]
    fn applying_resample_preserves_identity_endpoints() {
        let channel = super::super::gamma::identity()[0];
        let values = resample_channel(&channel, 1024);
        assert_eq!(values.len(), 1024);
        assert_eq!(values[0], 0.0);
        assert_eq!(values[1023], 1.0);
    }

    #[test]
    fn rejects_non_finite_os_values() {
        assert!(resample_gamma_values(&[0.0, f32::NAN, 1.0]).is_none());
    }
}
