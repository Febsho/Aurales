// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // This must run before Tauri/GTK constructs its application. A dev
        // shell can retain GDK_BACKEND=x11 from an old troubleshooting launch;
        // changing it later in app_lib::run is too late on some GTK builds.
        let requested_x11 = std::env::var("AURALES_FORCE_X11")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let wayland_session = std::env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
        let requested_wayland = std::env::var("AURALES_NATIVE_WAYLAND")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        if !requested_x11 && (wayland_session || requested_wayland) {
            std::env::set_var("GDK_BACKEND", "wayland");
        }
    }
    app_lib::run();
}
