mod commands;
mod db;
mod image_cache;
mod libmpv_player;
#[cfg(target_os = "linux")]
mod linux_render_surface;
mod thumbnails;
mod ytproxy;

use db::Database;
use tauri::Manager;

#[cfg(target_os = "linux")]
enum RenderNodeChoice {
    NonNvidia(String),
    NvidiaOnly,
    None,
}

/// Pick the DRM render node WebKit should draw with. NVIDIA nodes reject
/// WebKit's GBM buffer allocation, so any other vendor's node wins.
#[cfg(target_os = "linux")]
fn preferred_webkit_render_node() -> RenderNodeChoice {
    const NVIDIA_VENDOR: &str = "0x10de";
    let mut nvidia_seen = false;
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return RenderNodeChoice::None;
    };
    let mut nodes: Vec<_> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("renderD")
        })
        .collect();
    nodes.sort_by_key(|entry| entry.file_name());
    for entry in nodes {
        let name = entry.file_name().to_string_lossy().into_owned();
        let vendor = std::fs::read_to_string(entry.path().join("device/vendor"))
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if vendor == NVIDIA_VENDOR {
            nvidia_seen = true;
        } else if std::path::Path::new("/dev/dri").join(&name).exists() {
            return RenderNodeChoice::NonNvidia(format!("/dev/dri/{name}"));
        }
    }
    if nvidia_seen {
        RenderNodeChoice::NvidiaOnly
    } else {
        RenderNodeChoice::None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // WebKit's GPU (DMA-BUF) renderer is required for correct rendering of
        // the transparent player window: the software fallback repaints only
        // damaged regions (closed menus ghost over the video) and drops CSS
        // filter effects (the blurred hero backdrop renders sharp). NVIDIA's
        // driver cannot allocate WebKit's GBM buffers ("Failed to create GBM
        // buffer", invisible window), so route rendering to a non-NVIDIA DRM
        // node when one exists, and fall back to shared-memory buffer
        // transport on NVIDIA-only machines. AURALES_DISABLE_DMABUF_RENDERER=1
        // opts back into the old software path.
        let disable_dmabuf = std::env::var("AURALES_DISABLE_DMABUF_RENDERER")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let webkit_env_untouched = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
            && std::env::var_os("WEBKIT_WEB_RENDER_DEVICE_FILE").is_none()
            && std::env::var_os("WEBKIT_DMABUF_RENDERER_FORCE_SHM").is_none();
        if disable_dmabuf {
            if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
            // Without the GPU renderer, forced compositing at least prevents
            // stale-pixel ghosting on the transparent player window.
            if std::env::var_os("WEBKIT_FORCE_COMPOSITING_MODE").is_none() {
                std::env::set_var("WEBKIT_FORCE_COMPOSITING_MODE", "1");
            }
        } else if webkit_env_untouched {
            match preferred_webkit_render_node() {
                RenderNodeChoice::NonNvidia(node) => {
                    std::env::set_var("WEBKIT_WEB_RENDER_DEVICE_FILE", node);
                }
                RenderNodeChoice::NvidiaOnly => {
                    std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
                }
                RenderNodeChoice::None => {
                    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
                    std::env::set_var("WEBKIT_FORCE_COMPOSITING_MODE", "1");
                }
            }
        }

        // The Linux player renders through GTK's GLArea and libmpv's Render
        // API, so video/UI composition no longer depends on X11 window
        // stacking. WebKitGTK itself still crashes on some native-Wayland GPU
        // combinations (notably transparent hybrid-GPU windows). Prefer its
        // mature XWayland backend when available; pure Wayland systems remain
        // supported, and AURALES_NATIVE_WAYLAND=1 opts in explicitly.
        let native_wayland = std::env::var("AURALES_NATIVE_WAYLAND")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        if !native_wayland && std::env::var_os("DISPLAY").is_some() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin({
            let mut updater = tauri_plugin_updater::Builder::new();
            let token = option_env!("AURALES_UPDATE_TOKEN").unwrap_or("");
            if !token.is_empty() {
                updater = updater
                    .header("Authorization", format!("token {}", token))
                    .unwrap();
                updater = updater
                    .header("Accept", "application/octet-stream")
                    .unwrap();
            }
            updater.build()
        })
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("imgcache", |ctx, request, responder| {
            image_cache::handle_request(ctx.app_handle().clone(), request, responder);
        })
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if let Err(error) = libmpv_player::initialize_numeric_locale() {
                log::error!("[MPV LIB] {error}");
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");

            let database = Database::new(app_dir).expect("failed to initialize database");
            app.manage(database);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_setting,
            commands::set_setting,
            commands::get_all_settings,
            commands::save_watch_progress,
            commands::get_watch_progress,
            commands::save_home_rows,
            commands::get_home_rows,
            commands::save_addon,
            commands::remove_addon,
            commands::get_addons,
            commands::cache_metadata,
            commands::get_cached_metadata,
            commands::clear_cache,
            commands::save_app_metadata,
            commands::get_app_metadata_for_addon,
            commands::get_app_metadata_by_ids,
            commands::get_app_metadata_by_ids_batch,
            commands::delete_app_metadata,
            commands::hard_reset_anime_metadata,
            commands::clear_app_metadata,
            commands::launch_mpv,
            commands::launch_embedded_mpv,
            commands::launch_minimal_mpv,
            commands::minimal_mpv_command,
            commands::stop_minimal_mpv,
            commands::get_minimal_player_state,
            commands::get_embedded_player_supported,
            commands::get_embedded_player_running,
            commands::get_player_debug_logs,
            commands::clear_player_debug_logs,
            commands::select_local_video_file,
            commands::mpv_command,
            commands::request_player_thumbnail,
            commands::clear_player_thumbnail,
            commands::start_thumbnail_generation,
            commands::get_thumbnail_metadata,
            commands::get_or_queue_scrub_thumbnail,
            commands::prefetch_thumbnail_sprite,
            commands::get_thumbnail_debug_state,
            commands::mpv_get_property,
            commands::get_player_snapshot,
            commands::resize_embedded_mpv,
            commands::setup_player_click_through,
            commands::set_native_player_fullscreen,
            commands::stop_embedded_mpv,
            commands::pmdb_request,
            commands::http_get_text,
            commands::http_probe_stream,
            commands::http_request,
            commands::ytproxy_port,
            commands::innertube_player,
            commands::github_release_notes,
            commands::ytdlp_resolve,
            commands::openrouter_chat,
            commands::download_subtitle,
            commands::write_temp_subtitle,
            commands::read_temp_subtitle,
            commands::update_temp_subtitle,
            commands::extract_embedded_subtitle,
            commands::request_simkl_pin,
            commands::check_simkl_pin,
            commands::fetch_simkl_user,
            commands::start_simkl_callback_server,
            commands::exchange_simkl_token,
            commands::open_simkl_auth,
            commands::start_anilist_callback_server,
            commands::exchange_anilist_token,
            commands::discord_set_activity,
            commands::discord_clear_activity,
            commands::discord_disconnect,
            commands::get_mpv_info,
            commands::cache_entry_set,
            commands::cache_entry_get,
            commands::cache_entry_get_many,
            commands::cache_entry_clear_category,
            commands::cache_entry_clear_expired,
            commands::cache_entry_stats,
            image_cache::image_cache_configure,
            image_cache::image_cache_stats,
            image_cache::image_cache_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
