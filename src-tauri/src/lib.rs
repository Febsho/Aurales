mod commands;
mod db;

use db::Database;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
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
            commands::delete_app_metadata,
            commands::hard_reset_anime_metadata,
            commands::clear_app_metadata,
            commands::launch_mpv,
            commands::launch_embedded_mpv,
            commands::launch_minimal_mpv,
            commands::minimal_mpv_command,
            commands::stop_minimal_mpv,
            commands::get_minimal_player_state,
            commands::get_embedded_player_running,
            commands::get_player_debug_logs,
            commands::clear_player_debug_logs,
            commands::select_local_video_file,
            commands::mpv_command,
            commands::mpv_get_property,
            commands::resize_embedded_mpv,
            commands::setup_player_click_through,
            commands::stop_embedded_mpv,
            commands::pmdb_request,
            commands::http_get_text,
            commands::openrouter_chat,
            commands::download_subtitle,
            commands::write_temp_subtitle,
            commands::read_temp_subtitle,
            commands::update_temp_subtitle,
            commands::request_simkl_pin,
            commands::check_simkl_pin,
            commands::start_simkl_callback_server,
            commands::exchange_simkl_token,
            commands::open_simkl_auth,
            commands::start_anilist_callback_server,
            commands::exchange_anilist_token,
            commands::discord_set_activity,
            commands::discord_clear_activity,
            commands::discord_disconnect,
            commands::get_mpv_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
