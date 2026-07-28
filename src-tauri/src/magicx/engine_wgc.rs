//! HDR-capable per-window effect backend (Windows.Graphics.Capture).
//!
//! The Magnification backend ([`super::engine::backend`], `engine_win.rs`) is
//! the cheap path: one composition-time colour matrix, no capture, no GPU work
//! of our own. It simply does not exist on an HDR desktop — `MagSetColorEffect`
//! returns `ERROR_NOT_SUPPORTED` there. This backend is the replacement for
//! those targets:
//!
//!   1. `IGraphicsCaptureItemInterop::CreateForWindow` on the target,
//!   2. a `Direct3D11CaptureFramePool` in `R16G16B16A16_FLOAT` — Microsoft's
//!      documented format for HD-colour capture; `B8G8R8A8_UNORM` clips HDR
//!      content to a washed-out mess,
//!   3. a pixel shader applying the Dark / Gray transform (see [`SHADER`] for
//!      why the SDR matrices in [`super::engine`] can NOT be reused),
//!   4. presented through a DirectComposition visual on a click-through,
//!      non-activating overlay pinned over the target — DirectComposition
//!      preserves HDR content, a layered window would not.
//!
//! ## Cost, and why this is not the default
//! This trades a free composition-time matrix for a capture + shader + present
//! loop per effected window. [`MAX_CAPTURES`] caps how many can run at once;
//! past that the effect is refused loudly rather than quietly melting the GPU.
//!
//! ## Known limits
//! - Exclusive-fullscreen windows bypass desktop composition and are not
//!   reliably capturable. Borderless fullscreen is fine.
//! - `SetIsBorderRequired(false)` removes the yellow capture border; on builds
//!   that refuse it the border is visible and we log once.
//!
//! Everything here is Windows-only and thread-affine to the worker: the
//! capture, D3D and DirectComposition objects are created and destroyed on the
//! single thread [`worker`] owns. The seam ([`apply`] / [`clear_all`]) only
//! forwards commands over an `mpsc` channel.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCOMPILE_OPTIMIZATION_LEVEL3, D3DCompile};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_PRIMITIVE_TOPOLOGY};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_CONSTANT_BUFFER, D3D11_BUFFER_DESC, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_FILTER_MIN_MAG_MIP_POINT, D3D11_SAMPLER_DESC, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT, D3D11CreateDevice,
    ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_PREMULTIPLIED, DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709,
    DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
    DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, IDXGISwapChain3,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GW_HWNDPREV, GetMessageW,
    GetWindow, HTTRANSPARENT, HWND_TOP, IsIconic, IsWindow, KillTimer, MSG, PM_NOREMOVE,
    PeekMessageW, PostThreadMessageW, RegisterClassExW, SET_WINDOW_POS_FLAGS, SW_HIDE,
    SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SetTimer, SetWindowPos, ShowWindow,
    TranslateMessage, WM_APP, WM_NCHITTEST, WM_TIMER, WM_USER, WNDCLASSEXW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{Interface, PCSTR, w};

use super::Effect;
use crate::magicx::Hwnd;

/// Present cadence for the capture pump (~60 Hz).
const FRAME_INTERVAL_MS: u32 = 16;

/// Upper bound on simultaneously effected windows. Each one costs a capture
/// session plus a shader pass per frame, so this is a real budget, not a
/// formality — beyond it the effect is refused and logged.
const MAX_CAPTURES: usize = 4;

/// Posted (thread) message that wakes the pump to drain the command channel.
const WM_APP_WAKE: u32 = WM_APP + 1;

/// The Dark / Gray transform.
///
/// This CANNOT reuse [`super::engine::INVERT_MATRIX`] /
/// [`super::engine::GRAYSCALE_MATRIX`]: those operate on non-linear sRGB in
/// `[0, 1]`, while the capture pool hands us LINEAR scRGB where a highlight
/// legitimately exceeds 1.0 (measured up to 3.0 on a real HDR desktop). Two
/// colour spaces, two sets of maths.
const SHADER: &str = r#"
Texture2D srcTex : register(t0);
SamplerState srcSmp : register(s0);
cbuffer Cfg : register(b0) { float4 cfg; };   // cfg.x: 0 = dark, 1 = gray

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut vs_main(uint vid : SV_VertexID) {
    VSOut o;
    float2 uv = float2((vid << 1) & 2, vid & 2);
    o.uv = uv;
    o.pos = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
    return o;
}

float4 ps_main(VSOut input) : SV_TARGET {
    float4 c = srcTex.Sample(srcSmp, input.uv);
    float a = c.a;
    // Window capture is PREMULTIPLIED (rounded corners arrive transparent);
    // un-premultiply so the transform sees real colour, then restore.
    float3 rgb = (a > 0.0001) ? c.rgb / a : c.rgb;

    if (cfg.x < 0.5) {
        // Dark: invert around SDR white. 1.0 - 3.0 = -2.0 is out-of-gamut
        // garbage, so saturate: anything brighter than SDR white lands on
        // black, which is exactly what a dark mode should do to a bright window.
        rgb = saturate(1.0 - rgb);
    } else {
        // Gray: Rec.709 luma because scRGB is LINEAR (the SDR path's Rec.601
        // weights assume non-linear input). Unclamped, so HDR highlights keep
        // their headroom instead of being crushed to SDR white.
        float y = dot(rgb, float3(0.2126, 0.7152, 0.0722));
        rgb = float3(y, y, y);
    }
    return float4(rgb * a, a);
}
"#;

/// Window class for the capture overlay.
///
/// Answers `WM_NCHITTEST` with `HTTRANSPARENT`, which a predefined class like
/// `"Static"` does not — it claims hits with `HTCLIENT`. This is belt-and-braces
/// only: `HTTRANSPARENT` forwards a hit solely to windows in the SAME thread, so
/// it cannot carry a click across to another process on its own. The real
/// click-through comes from `WS_EX_LAYERED | WS_EX_TRANSPARENT` on the window
/// itself (see [`create_capture`]).
const OVERLAY_CLASS: windows::core::PCWSTR = w!("DimReadMagicXOverlay");

/// One-shot class registration guard; `false` means registration failed and the
/// backend must not create overlays.
static OVERLAY_CLASS_READY: OnceLock<bool> = OnceLock::new();

/// Refuse every hit so clicks, drags and scrolls reach the window underneath.
unsafe extern "system" fn overlay_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        return LRESULT(HTTRANSPARENT as isize);
    }
    // SAFETY: standard default handling for every other message.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Register [`OVERLAY_CLASS`] once. Returns whether the class is usable.
fn ensure_overlay_class() -> bool {
    *OVERLAY_CLASS_READY.get_or_init(|| {
        // SAFETY: a null module handle is valid for a class owned by this exe.
        let instance = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
        let class = WNDCLASSEXW {
            cbSize: core::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(overlay_wndproc),
            hInstance: instance.into(),
            lpszClassName: OVERLAY_CLASS,
            ..Default::default()
        };
        // SAFETY: `class` is fully initialised and lives across the call.
        let atom = unsafe { RegisterClassExW(&class) };
        if atom == 0 {
            log::warn!(
                "[magicx/wgc] overlay class registration failed: {:?}",
                std::io::Error::last_os_error()
            );
            return false;
        }
        true
    })
}

/// A command sent to the worker thread.
enum Cmd {
    /// Set (`Some`) or clear (`None`) the effect on one window.
    Set(Hwnd, Option<Effect>),
    /// Tear down every capture.
    ClearAll,
}

static SENDER: OnceLock<Sender<Cmd>> = OnceLock::new();
static WORKER_TID: AtomicU32 = AtomicU32::new(0);

/// Set (or clear) the effect on one window through the capture backend.
pub fn apply(hwnd: Hwnd, effect: Option<Effect>) {
    send(Cmd::Set(hwnd, effect));
}

/// Tear down every live capture.
pub fn clear_all() {
    send(Cmd::ClearAll);
}

fn send(cmd: Cmd) {
    if sender().send(cmd).is_ok() {
        wake();
    }
}

fn sender() -> &'static Sender<Cmd> {
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Cmd>();
        if let Err(err) = thread::Builder::new()
            .name("magicx-wgc".into())
            .spawn(move || worker(rx))
        {
            log::warn!("[magicx/wgc] failed to start capture worker: {err}");
        }
        tx
    })
}

fn wake() {
    let tid = WORKER_TID.load(Ordering::SeqCst);
    if tid != 0 {
        // SAFETY: async wake to the worker queue; payload unused, failure means
        // the process-lifetime worker is gone.
        let _ = unsafe { PostThreadMessageW(tid, WM_APP_WAKE, WPARAM(0), LPARAM(0)) };
    }
}

/// Process-wide GPU objects, built once on the worker thread.
struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    capture_device: IDirect3DDevice,
    dcomp: IDCompositionDevice,
    factory: IDXGIFactory2,
    vertex_shader: ID3D11VertexShader,
    pixel_shader: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    dark_cb: ID3D11Buffer,
    gray_cb: ID3D11Buffer,
}

/// One live capture overlay pinned to a target window.
struct Capture {
    target: HWND,
    overlay: HWND,
    /// Kept alive for the session's lifetime: the capture stops if the item is
    /// dropped, even though nothing reads it again.
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    swap: IDXGISwapChain1,
    rtv: Option<ID3D11RenderTargetView>,
    /// Kept alive for the lifetime of the overlay: dropping either tears the
    /// composition tree down and the overlay goes blank.
    _dcomp_target: IDCompositionTarget,
    _visual: IDCompositionVisual,
    effect: Effect,
    size: SizeInt32,
    bounds: RECT,
    visible: bool,
    above: isize,
    /// Frames presented so far, and when the capture started.
    ///
    /// Every frame taken from the pool must be `Close`d or the pool starves
    /// after `BufferCount` frames and the overlay freezes on its last present —
    /// which looks like the captured window has stopped responding, not like a
    /// bug in this file. [`report_throughput`] turns that failure into one log
    /// line instead of a bug report.
    frames: u32,
    started: Instant,
    throughput_reported: bool,
}

/// How long to watch a new capture before judging whether frames are flowing.
const THROUGHPUT_WINDOW: Duration = Duration::from_secs(5);

/// A pool that starves stops after roughly its buffer count; anything above
/// this in the first [`THROUGHPUT_WINDOW`] means frames are genuinely flowing.
const STARVATION_CEILING: u32 = 2;

impl Capture {
    fn close(&self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
        // SAFETY: `overlay` is a window we created and still own.
        unsafe {
            let _ = DestroyWindow(self.overlay);
        }
    }
}

fn worker(rx: Receiver<Cmd>) {
    // Materialize the queue before publishing the id so a wake posted the
    // instant after publication cannot be dropped.
    let mut probe = MSG::default();
    // SAFETY: PM_NOREMOVE peek only creates the queue; nothing is consumed.
    unsafe {
        let _ = PeekMessageW(&mut probe, None, WM_USER, WM_USER, PM_NOREMOVE);
    }
    // SAFETY: WinRT activation (GraphicsCaptureItem) needs an initialised
    // apartment on this thread.
    if let Err(err) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        log::warn!("[magicx/wgc] RoInitialize failed: {err}; capture backend unavailable");
        return;
    }
    // SAFETY: no arguments; returns the current thread id.
    WORKER_TID.store(
        unsafe { windows::Win32::System::Threading::GetCurrentThreadId() },
        Ordering::SeqCst,
    );

    let gpu = match build_gpu() {
        Ok(gpu) => {
            log::debug!("[magicx/wgc] capture backend ready (D3D11 + DirectComposition)");
            gpu
        }
        Err(err) => {
            log::warn!("[magicx/wgc] GPU init failed: {err}; HDR per-window effects unavailable");
            return;
        }
    };

    let mut captures: HashMap<Hwnd, Capture> = HashMap::new();
    let mut frame_timer: usize = 0;
    drain(&rx, &gpu, &mut captures);
    manage_timer(&captures, &mut frame_timer);

    let mut msg = MSG::default();
    loop {
        // SAFETY: standard blocking pump; `msg` is a valid out-param.
        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if ret.0 <= 0 {
            break;
        }
        match msg.message {
            WM_APP_WAKE => {
                drain(&rx, &gpu, &mut captures);
                manage_timer(&captures, &mut frame_timer);
            }
            WM_TIMER => {
                track(&gpu, &mut captures);
                pump_frames(&gpu, &mut captures);
                manage_timer(&captures, &mut frame_timer);
            }
            _ => unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            },
        }
    }
}

fn build_gpu() -> windows::core::Result<Gpu> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    // SAFETY: standard device creation; out-params are live for the call.
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    let device = device.expect("D3D11CreateDevice succeeded without a device");
    let context = context.expect("D3D11CreateDevice succeeded without a context");

    let dxgi: IDXGIDevice = device.cast()?;
    // SAFETY: wraps the DXGI device for WinRT capture interop.
    let capture_device: IDirect3DDevice =
        unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    // SAFETY: creates the composition device bound to the same adapter.
    let dcomp: IDCompositionDevice = unsafe { DCompositionCreateDevice(&dxgi)? };
    // SAFETY: adapter -> factory walk on a live DXGI device.
    let factory: IDXGIFactory2 = unsafe { dxgi.GetAdapter()?.GetParent()? };

    let vs_blob = compile(SHADER, c"vs_main", c"vs_5_0")?;
    let ps_blob = compile(SHADER, c"ps_main", c"ps_5_0")?;
    let mut vertex_shader = None;
    let mut pixel_shader = None;
    // SAFETY: blobs outlive the calls; the slices describe their own bytecode.
    unsafe {
        device.CreateVertexShader(blob_bytes(&vs_blob), None, Some(&mut vertex_shader))?;
        device.CreatePixelShader(blob_bytes(&ps_blob), None, Some(&mut pixel_shader))?;
    }

    let sampler_desc = D3D11_SAMPLER_DESC {
        Filter: D3D11_FILTER_MIN_MAG_MIP_POINT,
        AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
        MaxLOD: f32::MAX,
        ..Default::default()
    };
    let mut sampler = None;
    // SAFETY: descriptor is live for the call.
    unsafe { device.CreateSamplerState(&sampler_desc, Some(&mut sampler))? };

    Ok(Gpu {
        dark_cb: constant_buffer(&device, 0.0)?,
        gray_cb: constant_buffer(&device, 1.0)?,
        device,
        context,
        capture_device,
        dcomp,
        factory,
        vertex_shader: vertex_shader.expect("vertex shader"),
        pixel_shader: pixel_shader.expect("pixel shader"),
        sampler: sampler.expect("sampler"),
    })
}

/// A 16-byte constant buffer carrying the mode selector in `cfg.x`.
fn constant_buffer(device: &ID3D11Device, mode: f32) -> windows::core::Result<ID3D11Buffer> {
    let data = [mode, 0.0, 0.0, 0.0];
    let desc = D3D11_BUFFER_DESC {
        ByteWidth: std::mem::size_of_val(&data) as u32,
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
        CPUAccessFlags: 0,
        ..Default::default()
    };
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: data.as_ptr().cast(),
        ..Default::default()
    };
    let mut buffer = None;
    // SAFETY: descriptor and initial data are live for the call.
    unsafe { device.CreateBuffer(&desc, Some(&init), Some(&mut buffer))? };
    Ok(buffer.expect("constant buffer"))
}

fn compile(
    source: &str,
    entry: &std::ffi::CStr,
    target: &std::ffi::CStr,
) -> windows::core::Result<windows::Win32::Graphics::Direct3D::ID3DBlob> {
    let mut code = None;
    let mut errors = None;
    // SAFETY: `source` outlives the call; both out-params are live.
    let hr = unsafe {
        D3DCompile(
            source.as_ptr().cast(),
            source.len(),
            PCSTR::null(),
            None,
            None,
            PCSTR(entry.as_ptr().cast()),
            PCSTR(target.as_ptr().cast()),
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if let Err(err) = hr {
        if let Some(errors) = errors {
            // SAFETY: the error blob is a NUL-terminated ASCII buffer.
            let text = unsafe {
                std::ffi::CStr::from_ptr(errors.GetBufferPointer().cast())
                    .to_string_lossy()
                    .into_owned()
            };
            log::warn!("[magicx/wgc] shader compile failed: {text}");
        }
        return Err(err);
    }
    Ok(code.expect("shader bytecode"))
}

fn blob_bytes(blob: &windows::Win32::Graphics::Direct3D::ID3DBlob) -> &[u8] {
    // SAFETY: the blob owns a contiguous buffer of the reported size.
    unsafe { std::slice::from_raw_parts(blob.GetBufferPointer().cast(), blob.GetBufferSize()) }
}

fn drain(rx: &Receiver<Cmd>, gpu: &Gpu, captures: &mut HashMap<Hwnd, Capture>) {
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            Cmd::Set(hwnd, Some(effect)) => set_effect(hwnd, effect, gpu, captures),
            Cmd::Set(hwnd, None) => remove(hwnd, captures),
            Cmd::ClearAll => {
                for capture in captures.values() {
                    capture.close();
                }
                captures.clear();
            }
        }
    }
    track(gpu, captures);
}

fn set_effect(hwnd: Hwnd, effect: Effect, gpu: &Gpu, captures: &mut HashMap<Hwnd, Capture>) {
    if let Some(capture) = captures.get_mut(&hwnd) {
        capture.effect = effect;
        return;
    }
    if captures.len() >= MAX_CAPTURES {
        log::warn!(
            "[magicx/wgc] refusing {effect:?} on {hwnd:#x}: already running {MAX_CAPTURES} captures"
        );
        super::abandon(hwnd);
        return;
    }
    let target = HWND(hwnd as *mut core::ffi::c_void);
    // SAFETY: IsWindow tolerates any handle.
    if !unsafe { IsWindow(Some(target)) }.as_bool() {
        super::abandon(hwnd);
        return;
    }
    match create_capture(target, effect, gpu) {
        Ok(capture) => {
            log::debug!(
                "[magicx/wgc] capturing {hwnd:#x} for {effect:?} ({}x{})",
                capture.size.Width,
                capture.size.Height
            );
            captures.insert(hwnd, capture);
        }
        Err(err) => {
            log::warn!("[magicx/wgc] capture setup failed for {hwnd:#x}: {err}");
            super::abandon(hwnd);
        }
    }
}

fn remove(hwnd: Hwnd, captures: &mut HashMap<Hwnd, Capture>) {
    if let Some(capture) = captures.remove(&hwnd) {
        capture.close();
    }
}

fn create_capture(target: HWND, effect: Effect, gpu: &Gpu) -> windows::core::Result<Capture> {
    let bounds = super::frame_bounds_of(target).ok_or_else(|| {
        windows::core::Error::new(
            windows::Win32::Foundation::E_FAIL,
            "target has no usable frame bounds",
        )
    })?;
    let (x, y, width, height) =
        super::rect_xywh(bounds.left, bounds.top, bounds.right, bounds.bottom);

    if !ensure_overlay_class() {
        return Err(windows::core::Error::new(
            windows::Win32::Foundation::E_FAIL,
            "overlay window class unavailable",
        ));
    }
    // Overlay: no redirection bitmap (required for a composition swapchain),
    // never activated, absent from the taskbar, and CLICK-THROUGH.
    //
    // Click-through needs `WS_EX_LAYERED | WS_EX_TRANSPARENT` TOGETHER. On a
    // non-layered window `WS_EX_TRANSPARENT` only governs paint order, and the
    // class's `HTTRANSPARENT` reply forwards a hit solely to windows in the
    // SAME thread — so across processes the click is simply swallowed. Measured
    // on a counter window under a live overlay: transparent-only ate both
    // clicks and wheel events; adding `WS_EX_LAYERED` let both through.
    //
    // Nothing calls `SetLayeredWindowAttributes`/`UpdateLayeredWindow` here: the
    // flag is present for its hit-testing semantics only, and the pixels still
    // come from the DirectComposition visual.
    let ex = WS_EX_LAYERED
        | WS_EX_NOREDIRECTIONBITMAP
        | WS_EX_TRANSPARENT
        | WS_EX_NOACTIVATE
        | WS_EX_TOOLWINDOW;
    // SAFETY: our own registered class; all handle params are null.
    let overlay = unsafe {
        CreateWindowExW(
            ex,
            OVERLAY_CLASS,
            windows::core::PCWSTR::null(),
            WS_POPUP,
            x,
            y,
            width,
            height,
            None,
            None,
            None,
            None,
        )
    }?;

    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    // SAFETY: `target` is a live top-level window.
    let item: GraphicsCaptureItem = match unsafe { interop.CreateForWindow(target) } {
        Ok(item) => item,
        Err(err) => {
            // SAFETY: the overlay is owned here and unreachable on this path.
            unsafe {
                let _ = DestroyWindow(overlay);
            }
            return Err(err);
        }
    };
    let size = item.Size()?;

    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &gpu.capture_device,
        DirectXPixelFormat::R16G16B16A16Float,
        2,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    // Best-effort polish: the cursor must not be baked into the effect, and the
    // yellow capture border would be a visible artefact of the implementation.
    let _ = session.SetIsCursorCaptureEnabled(false);
    if session.SetIsBorderRequired(false).is_err() {
        log::debug!("[magicx/wgc] capture border cannot be disabled on this build");
    }

    let desc = DXGI_SWAP_CHAIN_DESC1 {
        Width: size.Width.max(1) as u32,
        Height: size.Height.max(1) as u32,
        Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
        BufferCount: 2,
        Scaling: DXGI_SCALING_STRETCH,
        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
        ..Default::default()
    };
    // SAFETY: descriptor is live for the call.
    let swap = unsafe {
        gpu.factory
            .CreateSwapChainForComposition(&gpu.device, &desc, None)?
    };
    // Tell the compositor these float16 values are scRGB, not SDR-clamped.
    if let Ok(swap3) = swap.cast::<IDXGISwapChain3>() {
        // SAFETY: colour-space support is queried by the runtime; an
        // unsupported space is reported through the Result.
        if let Err(err) = unsafe { swap3.SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709) } {
            log::debug!("[magicx/wgc] scRGB colour space rejected: {err}");
        }
    }

    // SAFETY: the overlay is a live HWND we own; visual + target live in the
    // returned Capture for as long as the overlay does.
    let (dcomp_target, visual) = unsafe {
        let dcomp_target = gpu.dcomp.CreateTargetForHwnd(overlay, true)?;
        let visual = gpu.dcomp.CreateVisual()?;
        visual.SetContent(&swap)?;
        dcomp_target.SetRoot(&visual)?;
        gpu.dcomp.Commit()?;
        (dcomp_target, visual)
    };

    session.StartCapture()?;
    // SAFETY: show without activating so focus stays with the target.
    unsafe {
        let _ = ShowWindow(overlay, SW_SHOWNOACTIVATE);
    }

    Ok(Capture {
        target,
        overlay,
        _item: item,
        pool,
        session,
        swap,
        rtv: None,
        _dcomp_target: dcomp_target,
        _visual: visual,
        effect,
        size,
        bounds,
        visible: true,
        above: isize::MIN,
        frames: 0,
        started: Instant::now(),
        throughput_reported: false,
    })
}

/// Follow each target: reposition/restack the overlay, hide while minimized,
/// resize the capture when the window does, drop dead targets.
fn track(gpu: &Gpu, captures: &mut HashMap<Hwnd, Capture>) {
    let overlay_ids: Vec<isize> = captures.values().map(|c| c.overlay.0 as isize).collect();
    let mut dead: Vec<Hwnd> = Vec::new();
    for (&key, capture) in captures.iter_mut() {
        // SAFETY: IsWindow tolerates a stale handle.
        if !unsafe { IsWindow(Some(capture.target)) }.as_bool() {
            dead.push(key);
            continue;
        }
        // SAFETY: the target is a live window.
        if unsafe { IsIconic(capture.target) }.as_bool() {
            if capture.visible {
                // SAFETY: hide the overlay while the target is minimized.
                unsafe {
                    let _ = ShowWindow(capture.overlay, SW_HIDE);
                }
                capture.visible = false;
            }
            continue;
        }
        if !capture.visible {
            // SAFETY: restore alongside the target.
            unsafe {
                let _ = ShowWindow(capture.overlay, SW_SHOWNOACTIVATE);
            }
            capture.visible = true;
        }
        let Some(bounds) = super::frame_bounds_of(capture.target) else {
            continue;
        };
        let above = window_above(capture.target, &overlay_ids);
        let above_id = above.map_or(0, |w| w.0 as isize);
        if bounds != capture.bounds || above_id != capture.above {
            let (x, y, width, height) =
                super::rect_xywh(bounds.left, bounds.top, bounds.right, bounds.bottom);
            // SAFETY: reposition + restack directly above the target without
            // activating it.
            unsafe {
                let _ = SetWindowPos(
                    capture.overlay,
                    Some(above.unwrap_or(HWND_TOP)),
                    x,
                    y,
                    width,
                    height,
                    SET_WINDOW_POS_FLAGS(SWP_NOACTIVATE.0 | SWP_NOOWNERZORDER.0),
                );
            }
            capture.bounds = bounds;
            capture.above = above_id;
            resize(gpu, capture, width, height);
        }
    }
    for key in dead {
        if let Some(capture) = captures.remove(&key) {
            capture.close();
        }
        super::forget_target(key);
    }
}

/// Re-point the swapchain and frame pool at a new window size.
fn resize(gpu: &Gpu, capture: &mut Capture, width: i32, height: i32) {
    let size = SizeInt32 {
        Width: width.max(1),
        Height: height.max(1),
    };
    if size.Width == capture.size.Width && size.Height == capture.size.Height {
        return;
    }
    capture.rtv = None;
    // SAFETY: no outstanding references to the back buffer remain (rtv dropped).
    if let Err(err) = unsafe {
        capture.swap.ResizeBuffers(
            0,
            size.Width as u32,
            size.Height as u32,
            DXGI_FORMAT_R16G16B16A16_FLOAT,
            windows::Win32::Graphics::Dxgi::DXGI_SWAP_CHAIN_FLAG(0),
        )
    } {
        log::debug!("[magicx/wgc] swapchain resize failed: {err}");
        return;
    }
    if let Err(err) = capture.pool.Recreate(
        &gpu.capture_device,
        DirectXPixelFormat::R16G16B16A16Float,
        2,
        size,
    ) {
        log::debug!("[magicx/wgc] frame-pool recreate failed: {err}");
        return;
    }
    capture.size = size;
}

/// Pull the newest frame for each capture and re-present it through the shader.
fn pump_frames(gpu: &Gpu, captures: &mut HashMap<Hwnd, Capture>) {
    for capture in captures.values_mut() {
        if !capture.visible {
            continue;
        }
        // Drain to the newest available frame so a slow tick doesn't present
        // stale content.
        //
        // EVERY frame taken from the pool must be Closed, including the ones
        // skipped over. `Direct3D11CaptureFrame` is an `IClosable` holding a
        // pool buffer: dropping the Rust wrapper releases the COM reference but
        // does NOT return the buffer, so with `BufferCount: 2` the pool starves
        // after two frames and `TryGetNextFrame` fails forever — the overlay
        // then sits frozen on the last presented frame, which looks exactly like
        // the captured window has stopped responding.
        let mut newest: Option<Direct3D11CaptureFrame> = None;
        while let Ok(frame) = capture.pool.TryGetNextFrame() {
            if let Some(skipped) = newest.replace(frame) {
                let _ = skipped.Close();
            }
        }
        let Some(frame) = newest else {
            continue;
        };
        if let Err(err) = render(gpu, capture, &frame) {
            log::debug!("[magicx/wgc] frame render failed: {err}");
        }
        let _ = frame.Close();
        capture.frames = capture.frames.saturating_add(1);
        report_throughput(capture);
    }
}

/// Report once, [`THROUGHPUT_WINDOW`] after a capture starts, whether frames are
/// actually flowing. A frozen overlay is otherwise indistinguishable from a
/// working one in the logs — the pixels are the only evidence, and nothing here
/// can see them.
fn report_throughput(capture: &mut Capture) {
    if capture.throughput_reported || capture.started.elapsed() < THROUGHPUT_WINDOW {
        return;
    }
    capture.throughput_reported = true;
    let frames = capture.frames;
    if frames > STARVATION_CEILING {
        log::debug!(
            "[magicx/wgc] {frames} frames in the first {}s — capture is live",
            THROUGHPUT_WINDOW.as_secs()
        );
    } else {
        log::warn!(
            "[magicx/wgc] only {frames} frames in {}s — the frame pool is starved and the \
             overlay is frozen on its last present (are all frames being Closed?)",
            THROUGHPUT_WINDOW.as_secs()
        );
    }
}

fn render(
    gpu: &Gpu,
    capture: &mut Capture,
    frame: &Direct3D11CaptureFrame,
) -> windows::core::Result<()> {
    let surface = frame.Surface()?;
    let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
    // SAFETY: the frame owns the texture for the duration of this call.
    let source: ID3D11Texture2D = unsafe { access.GetInterface()? };

    if capture.rtv.is_none() {
        // SAFETY: buffer 0 of a flip-model swapchain is the back buffer.
        let back: ID3D11Texture2D = unsafe { capture.swap.GetBuffer(0)? };
        let mut rtv = None;
        // SAFETY: default RTV over the back buffer.
        unsafe {
            gpu.device
                .CreateRenderTargetView(&back, None, Some(&mut rtv))?
        };
        capture.rtv = rtv;
    }
    let Some(rtv) = capture.rtv.clone() else {
        return Ok(());
    };

    let mut srv: Option<ID3D11ShaderResourceView> = None;
    // SAFETY: default SRV over the captured texture.
    unsafe {
        gpu.device
            .CreateShaderResourceView(&source, None, Some(&mut srv))?
    };

    let viewport = D3D11_VIEWPORT {
        TopLeftX: 0.0,
        TopLeftY: 0.0,
        Width: capture.size.Width as f32,
        Height: capture.size.Height as f32,
        MinDepth: 0.0,
        MaxDepth: 1.0,
    };
    let cb = match capture.effect {
        Effect::Dark => &gpu.dark_cb,
        Effect::Gray => &gpu.gray_cb,
    };
    // SAFETY: every bound object outlives the draw; the context is only touched
    // from this thread.
    unsafe {
        gpu.context.OMSetRenderTargets(Some(&[Some(rtv)]), None);
        gpu.context.RSSetViewports(Some(&[viewport]));
        gpu.context
            .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY(4)); // TRIANGLELIST
        gpu.context.VSSetShader(&gpu.vertex_shader, None);
        gpu.context.PSSetShader(&gpu.pixel_shader, None);
        gpu.context.PSSetShaderResources(0, Some(&[srv]));
        gpu.context
            .PSSetSamplers(0, Some(&[Some(gpu.sampler.clone())]));
        gpu.context
            .PSSetConstantBuffers(0, Some(&[Some(cb.clone())]));
        gpu.context.Draw(3, 0);
        // Unbind so the next frame's SRV can alias the same texture slot.
        gpu.context.PSSetShaderResources(0, Some(&[None]));
        capture
            .swap
            .Present(1, windows::Win32::Graphics::Dxgi::DXGI_PRESENT(0))
            .ok()?;
    }
    Ok(())
}

/// The window directly above `target`, skipping our own overlays.
fn window_above(target: HWND, overlay_ids: &[isize]) -> Option<HWND> {
    let mut cur = target;
    loop {
        // SAFETY: GetWindow on a valid window; Err/null means nothing above.
        match unsafe { GetWindow(cur, GW_HWNDPREV) } {
            Ok(prev) if !prev.is_invalid() => {
                if overlay_ids.contains(&(prev.0 as isize)) {
                    cur = prev;
                    continue;
                }
                return Some(prev);
            }
            _ => return None,
        }
    }
}

fn manage_timer(captures: &HashMap<Hwnd, Capture>, frame_timer: &mut usize) {
    let want = !captures.is_empty();
    if want && *frame_timer == 0 {
        // SAFETY: thread timer (null hwnd); its id comes back for KillTimer.
        *frame_timer = unsafe { SetTimer(None, 0, FRAME_INTERVAL_MS, None) };
    } else if !want && *frame_timer != 0 {
        // SAFETY: stop the pump by the id SetTimer returned.
        unsafe {
            let _ = KillTimer(None, *frame_timer);
        }
        *frame_timer = 0;
    }
}
