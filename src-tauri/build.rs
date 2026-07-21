fn main() {
    #[cfg(target_os = "windows")]
    configure_windows_test_delay_load();

    tauri_build::build()
}

#[cfg(target_os = "windows")]
fn configure_windows_test_delay_load() {
    // The lib test harness links the full Tauri/native app graph. Delay-load
    // non-CRT app/native DLLs so pure unit tests do not abort at load
    // (STATUS_ENTRYPOINT_NOT_FOUND) before the Rust harness starts; tests that
    // exercise those paths still load them on use.
    for dll in [
        "user32.dll",
        "ole32.dll",
        "comctl32.dll",
        "ADVAPI32.dll",
        "shlwapi.dll",
        "api-ms-win-core-synch-l1-2-0.dll",
        "gdi32.dll",
        "crypt32.dll",
        "dwmapi.dll",
        "shell32.dll",
        "combase.dll",
        "propsys.dll",
        "bcryptprimitives.dll",
        "ws2_32.dll",
        "oleaut32.dll",
        "userenv.dll",
        "iphlpapi.dll",
        "psapi.dll",
        "dbghelp.dll",
        "api-ms-win-core-path-l1-1-0.dll",
        "setupapi.dll",
    ] {
        println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
    }
    println!("cargo:rustc-link-arg=delayimp.lib");
}
