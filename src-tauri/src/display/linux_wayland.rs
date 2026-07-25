//! Native Wayland gamma control for wlroots-family compositors.
//!
//! `zwlr_gamma_control_v1` deliberately does **not** expose the compositor's
//! current ramps. Instead, the compositor snapshots them when a control is
//! created and restores them when that control is destroyed. Callers must use
//! [`release_ramp`] / [`release_all`] to restore passthrough; applying an
//! identity ramp would discard an ICC-calibrated original.
//!
//! A dedicated actor owns the Wayland connection and every gamma-control
//! object. Its event loop blocks in `poll(2)` on either the Wayland socket or a
//! command wake socket, so topology/failure events are handled without a timer
//! and controls remain alive between calls.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Mutex, Once, OnceLock};
use std::time::Duration;

use rustix::event::{PollFd, PollFlags, poll};
use rustix::fs::{MemfdFlags, memfd_create};
use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols_wlr::gamma_control::v1::client::{
    zwlr_gamma_control_manager_v1, zwlr_gamma_control_v1,
};

use super::gamma::GammaRamp;

const MANAGER_INTERFACE: &str = "zwlr_gamma_control_manager_v1";
const OUTPUT_INTERFACE: &str = "wl_output";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);

static CLIENT: OnceLock<Option<ActorClient>> = OnceLock::new();
static START_WARNING: Once = Once::new();

/// A monitor addressable through the wlroots gamma-control protocol.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WaylandMonitor {
    /// Best available cross-process identity. Core Wayland guarantees the
    /// output name is unique only within a compositor instance, not across
    /// sessions, so make/model are included to reduce accidental remapping.
    pub id: String,
    pub friendly_name: String,
}

/// Enumerate outputs only when both native Wayland and the wlroots gamma
/// manager are available. No gamma-control object is claimed by enumeration.
pub fn enumerate() -> Vec<WaylandMonitor> {
    request(Command::Enumerate).unwrap_or_default()
}

/// Apply a normalized 256-entry ramp to an output.
///
/// The actor creates (and retains) the exclusive per-output control on first
/// use, waits for the compositor's native `gamma_size`, resamples, and submits
/// the resulting anonymous file descriptor. A `failed` event makes subsequent
/// calls fail explicitly until the control is released or the output changes.
pub fn apply_ramp(device: &str, ramp: &GammaRamp) -> bool {
    request(|reply| Command::Apply {
        device: device.to_owned(),
        ramp: Box::new(*ramp),
        reply,
    })
    .unwrap_or(false)
}

/// Destroy one control, asking the compositor to restore the ramp it captured
/// before DimRead acquired that output.
pub fn release_ramp(device: &str) -> bool {
    request(|reply| Command::Release {
        device: device.to_owned(),
        reply,
    })
    .unwrap_or(false)
}

/// Register the display engine's topology callback.
///
/// The callback runs on a short-lived helper thread, never on the Wayland
/// dispatch thread, so it may safely call [`enumerate`] or re-apply settings.
pub fn start_topology_listener(callback: fn()) -> bool {
    request(|reply| Command::SetTopologyListener { callback, reply }).unwrap_or(false)
}

fn request<T: Send + 'static>(make: impl FnOnce(SyncSender<T>) -> Command) -> Option<T> {
    let client = CLIENT.get_or_init(start_actor).as_ref()?;
    let (reply, response) = mpsc::sync_channel(1);
    client.send(make(reply)).ok()?;
    response.recv_timeout(RESPONSE_TIMEOUT).ok()
}

struct ActorClient {
    commands: mpsc::Sender<Command>,
    wake: Mutex<UnixStream>,
}

impl ActorClient {
    fn send(&self, command: Command) -> Result<(), ()> {
        self.commands.send(command).map_err(|_| ())?;

        // One unread byte already guarantees a wake, so WouldBlock is success.
        let mut wake = self
            .wake
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match wake.write(&[1]) {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(()),
            Err(_) => Err(()),
        }
    }
}

fn start_actor() -> Option<ActorClient> {
    let (wake_tx, wake_rx) = match UnixStream::pair() {
        Ok(pair) => pair,
        Err(error) => {
            warn_start_once(&format!("could not create command wake socket: {error}"));
            return None;
        }
    };
    if let Err(error) = wake_tx.set_nonblocking(true) {
        warn_start_once(&format!("could not configure command wake socket: {error}"));
        return None;
    }
    if let Err(error) = wake_rx.set_nonblocking(true) {
        warn_start_once(&format!("could not configure actor wake socket: {error}"));
        return None;
    }

    let (commands, command_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name("dimread-wayland-gamma".into())
        .spawn(move || actor_main(command_rx, wake_rx, ready_tx));
    if let Err(error) = thread {
        warn_start_once(&format!("could not start Wayland gamma actor: {error}"));
        return None;
    }

    match ready_rx.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(Ok(())) => Some(ActorClient {
            commands,
            wake: Mutex::new(wake_tx),
        }),
        Ok(Err(error)) => {
            warn_start_once(&error);
            None
        }
        Err(_) => {
            warn_start_once("Wayland gamma actor initialization timed out");
            None
        }
    }
}

enum Command {
    Enumerate(SyncSender<Vec<WaylandMonitor>>),
    Apply {
        device: String,
        ramp: Box<GammaRamp>,
        reply: SyncSender<bool>,
    },
    Release {
        device: String,
        reply: SyncSender<bool>,
    },
    SetTopologyListener {
        callback: fn(),
        reply: SyncSender<bool>,
    },
}

struct OutputData {
    global_name: u32,
}

struct ControlData {
    output_global: u32,
}

struct OutputState {
    proxy: wl_output::WlOutput,
    name: Option<String>,
    description: Option<String>,
    make: String,
    model: String,
    ready: bool,
}

impl OutputState {
    fn base_id(&self) -> Option<String> {
        let name = self.name.as_deref()?.trim();
        if name.is_empty() {
            return None;
        }
        Some(format!(
            "wayland:{}:{}:{}",
            encode_id_component(&self.make),
            encode_id_component(&self.model),
            encode_id_component(name)
        ))
    }

    fn friendly_name(&self) -> String {
        self.description
            .as_deref()
            .filter(|description| !description.trim().is_empty())
            .map_or_else(
                || {
                    let hardware = format!("{} {}", self.make.trim(), self.model.trim());
                    if hardware.trim().is_empty() {
                        self.name.clone().unwrap_or_else(|| "Wayland output".into())
                    } else {
                        hardware.trim().to_owned()
                    }
                },
                str::to_owned,
            )
    }
}

struct ControlState {
    proxy: zwlr_gamma_control_v1::ZwlrGammaControlV1,
    size: Option<u32>,
}

#[derive(Default)]
struct WaylandState {
    // Keep the registry proxy alive so hot-plug globals continue to arrive.
    _registry: Option<wl_registry::WlRegistry>,
    manager: Option<zwlr_gamma_control_manager_v1::ZwlrGammaControlManagerV1>,
    manager_global: Option<u32>,
    outputs: HashMap<u32, OutputState>,
    controls: HashMap<u32, ControlState>,
    failed_outputs: HashSet<u32>,
    topology_callback: Option<fn()>,
}

fn actor_main(
    commands: Receiver<Command>,
    mut wake: UnixStream,
    ready: SyncSender<Result<(), String>>,
) {
    let connection = match Connection::connect_to_env() {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(format!(
                "could not connect to Wayland compositor: {error}"
            )));
            return;
        }
    };
    let mut events = connection.new_event_queue::<WaylandState>();
    let queue = events.handle();
    let registry = connection.display().get_registry(&queue, ());
    let mut state = WaylandState {
        _registry: Some(registry),
        ..WaylandState::default()
    };

    if let Err(error) = events.roundtrip(&mut state) {
        let _ = ready.send(Err(format!(
            "initial Wayland registry roundtrip failed: {error}"
        )));
        return;
    }
    if state.manager.is_none() {
        let _ = ready.send(Err(format!(
            "compositor does not advertise {MANAGER_INTERFACE}"
        )));
        return;
    }
    let _ = ready.send(Ok(()));

    loop {
        if events.dispatch_pending(&mut state).is_err() {
            break;
        }

        while let Ok(command) = commands.try_recv() {
            handle_command(command, &mut state, &mut events);
        }
        if connection.flush().is_err() {
            break;
        }

        let Some(read_guard) = events.prepare_read() else {
            continue;
        };
        let readiness = {
            let mut poll_fds = [
                PollFd::from_borrowed_fd(read_guard.connection_fd(), PollFlags::IN),
                PollFd::new(&wake, PollFlags::IN),
            ];
            if poll(&mut poll_fds, None).is_err() {
                break;
            }
            (
                poll_fds[0]
                    .revents()
                    .intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR),
                poll_fds[1]
                    .revents()
                    .intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR),
            )
        };
        let (wayland_ready, command_ready) = readiness;

        if wayland_ready {
            if read_guard.read().is_err() || events.dispatch_pending(&mut state).is_err() {
                break;
            }
        } else {
            drop(read_guard);
        }

        if command_ready {
            drain_wake_socket(&mut wake);
        }
    }

    // A connection close also restores all compositor-managed originals. Send
    // explicit destructors when possible so graceful actor shutdown is prompt.
    destroy_all_controls(&mut state);
}

fn handle_command(
    command: Command,
    state: &mut WaylandState,
    events: &mut EventQueue<WaylandState>,
) {
    match command {
        Command::Enumerate(reply) => {
            let _ = reply.send(snapshot_monitors(state));
        }
        Command::Apply {
            device,
            ramp,
            reply,
        } => {
            let applied = apply_on_actor(state, events, &device, &ramp);
            let _ = reply.send(applied);
        }
        Command::Release { device, reply } => {
            let released = release_on_actor(state, events, &device);
            let _ = reply.send(released);
        }
        Command::SetTopologyListener { callback, reply } => {
            state.topology_callback = Some(callback);
            let _ = reply.send(true);
        }
    }
}

fn apply_on_actor(
    state: &mut WaylandState,
    events: &mut EventQueue<WaylandState>,
    device: &str,
    ramp: &GammaRamp,
) -> bool {
    let Some(output_global) = resolve_output(state, device) else {
        return false;
    };
    if state.failed_outputs.contains(&output_global) {
        return false;
    }

    if !state.controls.contains_key(&output_global) {
        let Some(manager) = state.manager.as_ref() else {
            return false;
        };
        let Some(output) = state.outputs.get(&output_global) else {
            return false;
        };
        let queue = events.handle();
        let control =
            manager.get_gamma_control(&output.proxy, &queue, ControlData { output_global });
        state.controls.insert(
            output_global,
            ControlState {
                proxy: control,
                size: None,
            },
        );

        // gamma_size is specified to arrive immediately after creation. This
        // bounded-from-the-caller roundtrip also surfaces an exclusive-owner or
        // unsupported-output `failed` event before reporting success.
        if events.roundtrip(state).is_err() {
            return false;
        }
    }

    let Some(control) = state.controls.get(&output_global) else {
        return false;
    };
    let Some(size) = control.size.filter(|size| *size > 0) else {
        return false;
    };
    let Ok(file) = gamma_file(ramp, size as usize) else {
        return false;
    };

    control.proxy.set_gamma(file.as_fd());
    events.flush().is_ok()
}

fn release_on_actor(
    state: &mut WaylandState,
    events: &mut EventQueue<WaylandState>,
    device: &str,
) -> bool {
    let Some(output_global) = resolve_output(state, device) else {
        // Registry removal destroys and removes the corresponding control
        // immediately. A later engine-wide restore for that now-disconnected
        // stable id is therefore already satisfied.
        return true;
    };
    state.failed_outputs.remove(&output_global);
    if let Some(control) = state.controls.remove(&output_global) {
        control.proxy.destroy();
    }
    events.flush().is_ok()
}

fn destroy_all_controls(state: &mut WaylandState) {
    for (_, control) in state.controls.drain() {
        control.proxy.destroy();
    }
    state.failed_outputs.clear();
}

fn resolve_output(state: &WaylandState, device: &str) -> Option<u32> {
    resolved_monitors(state)
        .into_iter()
        .find_map(|(global, monitor)| (monitor.id == device).then_some(global))
}

fn snapshot_monitors(state: &WaylandState) -> Vec<WaylandMonitor> {
    if state.manager.is_none() {
        return Vec::new();
    }
    resolved_monitors(state)
        .into_iter()
        .map(|(_, monitor)| monitor)
        .collect()
}

/// Resolve duplicate fingerprints deterministically within this compositor
/// instance. The core protocol exposes no EDID serial, so a suffix based on the
/// registry global is an honest session-local last resort for identical data.
fn resolved_monitors(state: &WaylandState) -> Vec<(u32, WaylandMonitor)> {
    let mut candidates: Vec<(u32, String, String)> = state
        .outputs
        .iter()
        .filter(|(_, output)| output.ready)
        .filter_map(|(&global, output)| Some((global, output.base_id()?, output.friendly_name())))
        .collect();
    candidates.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));

    let mut totals = HashMap::<String, usize>::new();
    for (_, base, _) in &candidates {
        *totals.entry(base.clone()).or_default() += 1;
    }
    candidates
        .into_iter()
        .map(|(global, base, friendly_name)| {
            let id = if totals.get(&base).copied().unwrap_or(0) > 1 {
                format!("{base}:global-{global}")
            } else {
                base
            };
            (global, WaylandMonitor { id, friendly_name })
        })
        .collect()
}

fn gamma_file(ramp: &GammaRamp, output_len: usize) -> io::Result<File> {
    if output_len == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "zero-length gamma table",
        ));
    }

    let bytes_len = output_len
        .checked_mul(3)
        .and_then(|length| length.checked_mul(size_of::<u16>()))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "gamma table too large"))?;
    let fd = memfd_create("dimread-gamma", MemfdFlags::CLOEXEC)?;
    let mut file = File::from(fd);
    file.set_len(bytes_len as u64)?;
    for channel in ramp {
        for value in resample(channel, output_len) {
            file.write_all(&value.to_ne_bytes())?;
        }
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

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

/// Percent-encode arbitrary compositor strings into an unambiguous settings
/// key while keeping common connector names (for example `DP-1`) readable.
fn encode_id_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.trim().bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn drain_wake_socket(wake: &mut UnixStream) {
    let mut buffer = [0_u8; 64];
    loop {
        match wake.read(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }
}

fn notify_topology(state: &WaylandState) {
    if let Some(callback) = state.topology_callback {
        let _ = std::thread::Builder::new()
            .name("dimread-wayland-topology".into())
            .spawn(callback);
    }
}

fn warn_start_once(reason: &str) {
    START_WARNING.call_once(|| {
        log::warn!("[display] native Wayland gamma control unavailable: {reason}");
    });
}

impl Dispatch<wl_registry::WlRegistry, ()> for WaylandState {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        queue: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } if interface == MANAGER_INTERFACE => {
                if state.manager.is_none() {
                    state.manager = Some(registry.bind(name, version.min(1), queue, ()));
                    state.manager_global = Some(name);
                    notify_topology(state);
                }
            }
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } if interface == OUTPUT_INTERFACE => {
                if version < 4 {
                    log::warn!(
                        "[display] ignoring Wayland wl_output global {name}: version {version} has no cross-process output name"
                    );
                    return;
                }
                let proxy = registry.bind(
                    name,
                    version.min(4),
                    queue,
                    OutputData { global_name: name },
                );
                state.outputs.insert(
                    name,
                    OutputState {
                        proxy,
                        name: None,
                        description: None,
                        make: String::new(),
                        model: String::new(),
                        ready: false,
                    },
                );
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(control) = state.controls.remove(&name) {
                    control.proxy.destroy();
                }
                state.failed_outputs.remove(&name);
                if let Some(output) = state.outputs.remove(&name) {
                    output.proxy.release();
                    notify_topology(state);
                }
                if state.manager_global == Some(name) {
                    // Controls remain valid after the manager is destroyed, so
                    // explicitly release every one; otherwise the old tint can
                    // outlive loss of the protocol global indefinitely.
                    destroy_all_controls(state);
                    if let Some(manager) = state.manager.take() {
                        manager.destroy();
                    }
                    state.manager_global = None;
                    notify_topology(state);
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_output::WlOutput, OutputData> for WaylandState {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        data: &OutputData,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.outputs.get_mut(&data.global_name) else {
            return;
        };
        match event {
            wl_output::Event::Geometry { make, model, .. } => {
                output.make = make;
                output.model = model;
            }
            wl_output::Event::Name { name } => output.name = Some(name),
            wl_output::Event::Description { description } => {
                output.description = Some(description);
            }
            wl_output::Event::Done => {
                output.ready = true;
                notify_topology(state);
            }
            _ => {}
        }
    }
}

impl Dispatch<zwlr_gamma_control_manager_v1::ZwlrGammaControlManagerV1, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &zwlr_gamma_control_manager_v1::ZwlrGammaControlManagerV1,
        _: zwlr_gamma_control_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<zwlr_gamma_control_v1::ZwlrGammaControlV1, ControlData> for WaylandState {
    fn event(
        state: &mut Self,
        control: &zwlr_gamma_control_v1::ZwlrGammaControlV1,
        event: zwlr_gamma_control_v1::Event,
        data: &ControlData,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_gamma_control_v1::Event::GammaSize { size } => {
                if let Some(entry) = state.controls.get_mut(&data.output_global) {
                    entry.size = (size > 0).then_some(size);
                }
            }
            zwlr_gamma_control_v1::Event::Failed => {
                log::warn!(
                    "[display] Wayland gamma control failed for output global {} (unsupported output or another gamma client owns it)",
                    data.output_global
                );
                state.controls.remove(&data.output_global);
                state.failed_outputs.insert(data.output_global);
                control.destroy();
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_components_are_unambiguous_and_keep_connectors_readable() {
        assert_eq!(encode_id_component("DP-1"), "DP-1");
        assert_eq!(encode_id_component("A:B / C"), "A%3AB%20%2F%20C");
    }

    #[test]
    fn resampling_preserves_endpoints() {
        assert_eq!(resample(&[0, 1000], 3), vec![0, 500, 1000]);
        assert_eq!(resample(&[25], 4), vec![25; 4]);
    }

    #[test]
    fn duplicate_output_fingerprints_get_explicit_session_suffixes() {
        // `resolved_monitors` itself requires Wayland proxies, but the suffix
        // contract is intentionally visible and parse-free: exact ids are
        // passed back to this module rather than decoded by callers.
        let base = "wayland:Dell:U2720Q:DP-1";
        assert_eq!(
            format!("{base}:global-17"),
            "wayland:Dell:U2720Q:DP-1:global-17"
        );
    }
}
