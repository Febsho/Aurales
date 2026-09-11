use crate::core::addon_catalog::{self, LoadAddonCatalogRequest, LoadAddonCatalogResponse};
use crate::core::addon_meta::{self, LoadAddonMetaRequest, LoadAddonMetaResponse};
use crate::core::anime::{
    self, AnimeEpisodeResolution, AnimeEpisodeResolutionRequest, AnimeSeasonTitle,
    AnimeSeasonTitleRequest, AnimeStructureRequest, AnimeStructureValidation, AnimeTitleSelection,
    AnimeTitleSelectionRequest,
};
use crate::core::anime_lookup::{
    self, LookupAnimeMappingsRequest, LookupAnimeMappingsResponse, ResolveAnimeIdsRequest,
    ResolveAnimeIdsResponse,
};
use crate::core::anime_season::{self, LoadAnimeSeasonRequest};
use crate::core::cache;
use crate::core::cache::CacheEntry;
use crate::core::catalog;
use crate::core::catalog::{AddonRecord, HomeRow};
use crate::core::detail_page::{
    self, DetailPageCoordinator, LoadDetailPageRequest, LoadDetailPageResponse,
};
use crate::core::discord;
use crate::core::metadata::{self, AppMediaItem, MetadataLookup, NormalizeProviderMetadataRequest};
use crate::core::platform;
use crate::core::player;
use crate::core::providers;
use crate::core::request;
use crate::core::request::ProxyResponse;
use crate::core::request::StreamProbeResponse;
use crate::core::settings;
use crate::core::settings::Setting;
use crate::core::stream_candidates::{
    self, LoadStreamCandidatesRequest, LoadStreamCandidatesResponse,
};
use crate::core::streams::{self, RankStreamCandidatesRequest, RankStreamCandidatesResponse};
use crate::core::subtitles;
use crate::core::sync;
use crate::core::sync::{SyncBatchRequest, SyncBatchResponse, WatchProgress};
use crate::db::Database;
use crate::libmpv_player::{self, LibMpvPlayer};
use serde::Serialize;
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "windows")]
use std::sync::atomic::AtomicIsize;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager, State};

#[tauri::command]
pub async fn load_detail_page(
    request: LoadDetailPageRequest,
    db: State<'_, Database>,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<LoadDetailPageResponse, String> {
    detail_page::load_detail_page(&coordinator, &db, request).await
}

#[tauri::command]
pub async fn load_anime_season(
    request: LoadAnimeSeasonRequest,
    db: State<'_, Database>,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<LoadDetailPageResponse, String> {
    anime_season::load_anime_season(&coordinator, &db, request).await
}

#[tauri::command]
pub async fn rank_stream_candidates(
    request: RankStreamCandidatesRequest,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<RankStreamCandidatesResponse, String> {
    streams::rank_stream_candidates(&coordinator, request).await
}

#[tauri::command]
pub async fn load_stream_candidates(
    request: LoadStreamCandidatesRequest,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<LoadStreamCandidatesResponse, String> {
    stream_candidates::load_stream_candidates(&coordinator, request).await
}

#[tauri::command]
pub async fn load_addon_catalog(
    request: LoadAddonCatalogRequest,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<LoadAddonCatalogResponse, String> {
    addon_catalog::load_addon_catalog(&coordinator, request).await
}

#[tauri::command]
pub async fn load_addon_meta(
    request: LoadAddonMetaRequest,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<LoadAddonMetaResponse, String> {
    addon_meta::load_addon_meta(&coordinator, request).await
}

/// Compatibility adapter for the frontend metadata normalizer. It deliberately
/// owns no provider/network/cache work; those remain on their legacy paths
/// until their behavior has separate parity coverage.
#[tauri::command]
pub fn normalize_provider_metadata(
    request: NormalizeProviderMetadataRequest,
) -> Result<AppMediaItem, String> {
    Ok(metadata::normalize_provider_metadata(request))
}

#[tauri::command]
pub fn validate_anime_tvdb_structure(
    request: AnimeStructureRequest,
) -> Result<AnimeStructureValidation, String> {
    Ok(anime::validate_structure(request))
}

#[tauri::command]
pub fn select_anime_title(
    request: AnimeTitleSelectionRequest,
) -> Result<AnimeTitleSelection, String> {
    Ok(anime::select_title(request))
}

#[tauri::command]
pub fn resolve_anime_season_title(
    request: AnimeSeasonTitleRequest,
) -> Result<AnimeSeasonTitle, String> {
    Ok(anime::resolve_season_title(request))
}

/// Compatibility adapter for deterministic Fribb cour/episode arithmetic.
/// The frontend still owns its browser-worker-backed Fribb index and retains a
/// local fallback while provider/network mapping is migrated separately.
#[tauri::command]
pub fn resolve_anime_episode_mapping(
    request: AnimeEpisodeResolutionRequest,
) -> Result<Option<AnimeEpisodeResolution>, String> {
    Ok(anime::resolve_episode_mapping(request))
}

#[tauri::command]
pub async fn lookup_anime_mappings(
    request: LookupAnimeMappingsRequest,
    db: State<'_, Database>,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<LookupAnimeMappingsResponse, String> {
    anime_lookup::lookup_anime_mappings(&coordinator, &db, request).await
}

#[tauri::command]
pub async fn resolve_anime_ids(
    request: ResolveAnimeIdsRequest,
    db: State<'_, Database>,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<ResolveAnimeIdsResponse, String> {
    anime_lookup::resolve_anime_ids(&coordinator, &db, request).await
}

#[tauri::command]
pub fn sync_password_store(email: String, password: String) -> Result<(), String> {
    sync::store_password(email, password)
}

#[tauri::command]
pub fn sync_password_load(email: String) -> Result<Option<String>, String> {
    sync::load_password(email)
}

#[tauri::command]
pub fn sync_password_delete(email: String) -> Result<(), String> {
    sync::delete_password(email)
}

#[tauri::command]
pub async fn sync_batch(
    request: SyncBatchRequest,
    coordinator: State<'_, DetailPageCoordinator>,
) -> Result<SyncBatchResponse, String> {
    sync::sync_batch(&coordinator, request).await
}

// Async + spawn_blocking: these commands do blocking pipe I/O. As sync
// commands they ran on the webview main thread, so a stale Discord pipe
// froze the entire app (reproducibly on pause, which re-sets presence).
#[tauri::command]
pub async fn discord_set_activity(
    details: Option<String>,
    state: Option<String>,
    large_image: Option<String>,
    large_text: Option<String>,
    small_image: Option<String>,
    small_text: Option<String>,
    start_timestamp: Option<u64>,
    end_timestamp: Option<u64>,
    activity_type: Option<u32>,
) -> Result<(), String> {
    let activity = discord::Activity {
        details,
        state,
        large_image,
        large_text,
        small_image,
        small_text,
        start_timestamp,
        end_timestamp,
        activity_type,
    };
    tauri::async_runtime::spawn_blocking(move || discord::set_activity(activity))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn discord_clear_activity() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(discord::clear_activity)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn discord_disconnect() -> Result<(), String> {
    discord::disconnect();
    Ok(())
}

// ─── WNDPROC subclass for the mpv host ────────────────────────────────────────
//
// When mpv is given a `--wid=HWND`, it installs its own WndProc on that window
// to handle rendering (D3D11 swap-chain etc.).  mpv's WndProc handles
// WM_NCHITTEST and returns HTCLIENT, so WS_EX_TRANSPARENT is silently ignored —
// the OS sends mouse messages to mpv, not to WebView2.
//
// We re-subclass the host window here to unconditionally return HTTRANSPARENT
// for WM_NCHITTEST, forwarding all other messages to whatever proc mpv left.
// Result: the host is a ghost — mouse events fall through to WebView2 and
// JavaScript controls work correctly.

#[cfg(target_os = "windows")]
static MPV_HOST_ORIG_PROC: AtomicIsize = AtomicIsize::new(0);
static MPV_PIPE_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(target_os = "windows")]
unsafe extern "system" fn transparent_host_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::{CallWindowProcW, DefWindowProcW};

    // WM_NCHITTEST = 0x0084; HTTRANSPARENT = -1
    if msg == 0x0084 {
        return LRESULT(-1);
    }

    let orig = MPV_HOST_ORIG_PROC.load(Ordering::SeqCst);
    if orig != 0 {
        // Safety: orig came from SetWindowLongPtrW(GWLP_WNDPROC), so it is a
        // valid WNDPROC pointer.
        let orig_fn: unsafe extern "system" fn(
            windows::Win32::Foundation::HWND,
            u32,
            windows::Win32::Foundation::WPARAM,
            windows::Win32::Foundation::LPARAM,
        ) -> windows::Win32::Foundation::LRESULT = std::mem::transmute(orig as usize);
        CallWindowProcW(Some(orig_fn), hwnd, msg, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

enum NativePlayerBackend {
    Process {
        child: Child,
        ipc_path: String,
        writer: Option<Arc<Mutex<std::fs::File>>>,
    },
    LibMpv {
        player: Arc<LibMpvPlayer>,
    },
}

/// Launch-time options that cannot change on a live libmpv instance. A new
/// launch request may only reuse the running player when these match.
#[derive(Clone, PartialEq)]
struct LibMpvLaunchConfig {
    hwdec_mode: Option<String>,
    video_cache_mode: Option<String>,
    mpv_custom_args: Option<String>,
}

struct NativePlayerState {
    host_hwnd: isize,
    video_hwnd: isize,
    session_id: String,
    backend: NativePlayerBackend,
    launch_config: Option<LibMpvLaunchConfig>,
}

impl NativePlayerState {
    fn process_child_mut(&mut self) -> Option<&mut Child> {
        match &mut self.backend {
            NativePlayerBackend::Process { child, .. } => Some(child),
            NativePlayerBackend::LibMpv { .. } => None,
        }
    }

    fn process_pid(&self) -> Option<u32> {
        match &self.backend {
            NativePlayerBackend::Process { child, .. } => Some(child.id()),
            NativePlayerBackend::LibMpv { .. } => None,
        }
    }
}

static NATIVE_PLAYER: OnceLock<Mutex<Option<NativePlayerState>>> = OnceLock::new();

#[derive(Default)]
struct PlayerDebugState {
    session_id: Option<String>,
    stream_hash: Option<String>,
    started_at_ms: Option<u128>,
    logs: Vec<String>,
}

static PLAYER_DEBUG_STATE: OnceLock<Mutex<PlayerDebugState>> = OnceLock::new();

fn player_debug_state() -> &'static Mutex<PlayerDebugState> {
    PLAYER_DEBUG_STATE.get_or_init(|| Mutex::new(PlayerDebugState::default()))
}

pub(crate) fn player_debug_log(message: impl Into<String>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let message_str = message.into();
    let message = format!(
        "[{:02}:{:02}:{:02}.{:03}] {}",
        (secs / 3600) % 24,
        (secs / 60) % 60,
        secs % 60,
        now.subsec_millis(),
        message_str
    );
    eprintln!("{}", message);
    if let Ok(mut state) = player_debug_state().lock() {
        state.logs.push(message.clone());
        if state.logs.len() > 2_000 {
            state.logs.drain(..500);
        }
    }
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("aurales-player-debug.log"))
    {
        let _ = writeln!(file, "{}", message);
    }
}

fn native_player_state() -> &'static Mutex<Option<NativePlayerState>> {
    NATIVE_PLAYER.get_or_init(|| Mutex::new(None))
}

static PROPERTY_CACHE: OnceLock<
    std::sync::RwLock<std::collections::HashMap<String, serde_json::Value>>,
> = OnceLock::new();

fn get_property_cache(
) -> &'static std::sync::RwLock<std::collections::HashMap<String, serde_json::Value>> {
    PROPERTY_CACHE.get_or_init(|| std::sync::RwLock::new(std::collections::HashMap::new()))
}

pub(crate) fn cache_mpv_property(name: String, value: serde_json::Value) {
    if let Ok(mut cache) = get_property_cache().write() {
        cache.insert(name, value);
    }
}

pub(crate) fn clear_player_if_session(session_id: &str) -> Result<(), String> {
    let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
    let should_clear = state
        .as_ref()
        .map(|player| player.session_id == session_id)
        .unwrap_or(false);
    if should_clear {
        if let Some(mut player) = state.take() {
            if let NativePlayerBackend::LibMpv { player: libmpv } = &mut player.backend {
                #[cfg(target_os = "linux")]
                crate::linux_render_surface::detach(libmpv);
            }
            cleanup_player_windows(player.host_hwnd, player.video_hwnd);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_setting(key: String, db: State<Database>) -> Option<String> {
    settings::get_setting(&db, key)
}

#[tauri::command]
pub fn set_setting(key: String, value: String, db: State<Database>) -> Result<(), String> {
    settings::set_setting(&db, key, value)
}

#[tauri::command]
pub fn get_all_settings(db: State<Database>) -> Vec<Setting> {
    settings::get_all_settings(&db)
}

#[tauri::command]
pub fn save_watch_progress(progress: WatchProgress, db: State<Database>) -> Result<(), String> {
    sync::save_watch_progress(&db, progress)
}

#[tauri::command]
pub fn get_watch_progress(media_id: String, db: State<Database>) -> Option<WatchProgress> {
    sync::get_watch_progress(&db, media_id)
}

#[tauri::command]
pub fn save_home_rows(rows: Vec<HomeRow>, db: State<Database>) -> Result<(), String> {
    catalog::save_home_rows(&db, rows)
}

#[tauri::command]
pub fn get_home_rows(db: State<Database>) -> Vec<HomeRow> {
    catalog::get_home_rows(&db)
}

#[tauri::command]
pub fn save_addon(addon: AddonRecord, db: State<Database>) -> Result<(), String> {
    catalog::save_addon(&db, addon)
}

#[tauri::command]
pub fn remove_addon(addon_id: String, db: State<Database>) -> Result<(), String> {
    catalog::remove_addon(&db, addon_id)
}

#[tauri::command]
pub fn get_addons(db: State<Database>) -> Vec<AddonRecord> {
    catalog::get_addons(&db)
}

#[tauri::command]
pub fn cache_metadata(key: String, data: String, db: State<Database>) -> Result<(), String> {
    cache::metadata_set(&db, key, data)
}

#[tauri::command]
pub fn get_cached_metadata(key: String, db: State<Database>) -> Option<String> {
    cache::metadata_get(&db, key)
}

#[tauri::command]
pub fn clear_cache(db: State<Database>) -> Result<(), String> {
    cache::clear_metadata(&db)
}

#[tauri::command]
pub fn save_app_metadata(
    media_json: String,
    addon_id: String,
    addon_item_id: String,
    media_type: String,
    db: State<Database>,
) -> Result<(), String> {
    metadata::save_persisted_metadata(&db, media_json, addon_id, addon_item_id, media_type)
}

#[tauri::command]
pub fn get_app_metadata_for_addon(
    addon_id: String,
    addon_item_id: String,
    db: State<Database>,
) -> Option<String> {
    metadata::get_persisted_for_addon(&db, addon_id, addon_item_id)
}

#[tauri::command]
pub fn get_app_metadata_by_ids(
    id: Option<String>,
    imdb_id: Option<String>,
    tmdb_id: Option<i64>,
    tvdb_id: Option<i64>,
    anilist_id: Option<i64>,
    db: State<Database>,
) -> Option<String> {
    metadata::get_persisted_by_ids(
        &db,
        &MetadataLookup {
            id,
            imdb_id,
            tmdb_id,
            tvdb_id,
            anilist_id,
        },
    )
}

#[tauri::command]
pub fn get_app_metadata_by_ids_batch(
    items: Vec<MetadataLookup>,
    db: State<Database>,
) -> Vec<Option<String>> {
    metadata::get_persisted_by_ids_batch(&db, items)
}

#[tauri::command]
pub fn delete_app_metadata(
    addon_id: String,
    addon_item_id: String,
    db: State<Database>,
) -> Result<(), String> {
    metadata::delete_persisted_metadata(&db, addon_id, addon_item_id)
}

#[tauri::command]
pub fn hard_reset_anime_metadata(
    local_media_id: String,
    db: State<Database>,
) -> Result<(), String> {
    metadata::hard_reset_anime_metadata(&db, local_media_id)
}

#[tauri::command]
pub fn clear_app_metadata(db: State<Database>) -> Result<(), String> {
    metadata::clear_persisted_metadata(&db)
}

#[tauri::command]
pub fn launch_mpv(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    start_time: Option<f64>,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let mut args: Vec<String> = vec![
        "--force-window=yes".to_string(),
        "--fullscreen".to_string(),
        "--osc=yes".to_string(),
        "--osd-bar=yes".to_string(),
        "--input-default-bindings=yes".to_string(),
        "--terminal=yes".to_string(),
        "--hwdec=auto-safe".to_string(),
    ];
    if let Some(t) = title {
        args.push(format!("--force-media-title={}", t));
    }
    if let Some(s) = start_time {
        args.push(format!("--start={}", s));
    }
    args.push(url);

    let shell = app.shell();
    if let Ok(sidecar) = shell.sidecar("binaries/mpv") {
        if sidecar.args(&args).spawn().is_ok() {
            return Ok(());
        }
    }

    if let Some(mpv) = player::find_mpv() {
        Command::new(&mpv)
            .args(&args)
            .spawn()
            .map_err(|e| format!("Failed to launch mpv at {}: {}", mpv.display(), e))?;
        return Ok(());
    }

    Err("Failed to launch mpv: no mpv executable was found (bundled or on PATH). Reinstall Aurales or install mpv.".to_string())
}

// Resolves a YouTube video to direct stream URLs via the bundled yt-dlp
// (1080p video + audio; yt-dlp handles YouTube's anti-bot measures and keeps
// itself current). Returns the printed URLs: [video] or [video, audio].
#[tauri::command]
pub async fn ytdlp_resolve(
    video_id: String,
    max_height: Option<u32>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || player::resolve_ytdlp(video_id, max_height))
        .await
        .map_err(|e| format!("yt-dlp task failed: {e}"))?
}

/// Reuse a live libmpv instance for a new stream instead of tearing it down.
/// Returns Ok(true) when the running player took over playback of `url`;
/// Ok(false) means the caller must do a full stop + relaunch (no live libmpv
/// player, launch options differ, or the in-place swap failed).
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn try_reuse_libmpv_player(
    _app: &tauri::AppHandle,
    url: &str,
    title: Option<&str>,
    start_time: Option<f64>,
    volume: Option<f64>,
    config: &LibMpvLaunchConfig,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<bool, String> {
    let (player, host_hwnd, video_hwnd, session_id) = {
        let state = native_player_state().lock().map_err(|e| e.to_string())?;
        match state.as_ref() {
            Some(current) => match &current.backend {
                NativePlayerBackend::LibMpv { player }
                    if !player.is_destroyed() && current.launch_config.as_ref() == Some(config) =>
                {
                    (
                        Arc::clone(player),
                        current.host_hwnd,
                        current.video_hwnd,
                        current.session_id.clone(),
                    )
                }
                _ => return Ok(false),
            },
            None => return Ok(false),
        }
    };
    #[cfg(target_os = "linux")]
    let _ = (host_hwnd, video_hwnd);

    // Stale observed values (duration, tracks, eof) belong to the old file.
    if let Ok(mut cache) = get_property_cache().write() {
        cache.clear();
    }

    // Per-file options: `start` only applies to the next loadfile; the rest
    // are plain runtime properties.
    let set = |name: &str, value: serde_json::Value| {
        if let Err(error) =
            player.command("set", &[serde_json::Value::String(name.to_string()), value])
        {
            player_debug_log(format!("[PLAYER REUSE] set {} failed: {}", name, error));
        }
    };
    set(
        "start",
        serde_json::Value::String(match start_time.filter(|value| *value > 0.0) {
            Some(seconds) => seconds.to_string(),
            None => "none".to_string(),
        }),
    );
    set(
        "force-media-title",
        serde_json::Value::String(title.unwrap_or("").to_string()),
    );
    set("pause", serde_json::Value::String("no".to_string()));
    if let Some(v) = volume {
        set(
            "volume",
            serde_json::Value::String(v.max(0.0).min(130.0).to_string()),
        );
    }

    if let (Some(w), Some(h)) = (width, height) {
        if w > 0 && h > 0 {
            #[cfg(target_os = "windows")]
            libmpv_player::resize_video_child(
                host_hwnd,
                video_hwnd,
                x.unwrap_or(0),
                y.unwrap_or(0),
                w,
                h,
            );
            #[cfg(target_os = "linux")]
            crate::linux_render_surface::resize(
                _app,
                x.unwrap_or(0),
                y.unwrap_or(0),
                w,
                h,
            )?;
        }
    }

    player_debug_log(format!(
        "[PLAYER START] session={} stream={} backend=libmpv reuse=in-place",
        session_id,
        player::stable_stream_hash(url)
    ));

    if let Err(error) = player.command(
        "loadfile",
        &[
            serde_json::Value::String(url.to_string()),
            serde_json::Value::String("replace".to_string()),
        ],
    ) {
        player_debug_log(format!(
            "[PLAYER REUSE] loadfile failed, falling back to full relaunch: {}",
            error
        ));
        return Ok(false);
    }

    Ok(true)
}

#[tauri::command]
pub fn launch_embedded_mpv(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    start_time: Option<f64>,
    volume: Option<f64>,
    hwdec_mode: Option<String>,
    video_cache_mode: Option<String>,
    mpv_custom_args: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<(), String> {
    // Deduplicate rapid double-launches (React re-running the mount effect
    // fires two identical launches ~20ms apart; the second used to kill the
    // just-spawned mpv and start another one).
    {
        static LAST_LAUNCH: OnceLock<Mutex<(String, std::time::Instant)>> = OnceLock::new();
        let guard = LAST_LAUNCH.get_or_init(|| {
            Mutex::new((
                String::new(),
                std::time::Instant::now() - std::time::Duration::from_secs(60),
            ))
        });
        if let Ok(mut last) = guard.lock() {
            if last.0 == url && last.1.elapsed() < std::time::Duration::from_millis(700) {
                let running = native_player_state()
                    .lock()
                    .map(|state| state.is_some())
                    .unwrap_or(false);
                if running {
                    player_debug_log("[PLAYER START] duplicate launch within 700ms ignored");
                    return Ok(());
                }
                player_debug_log(
                    "[PLAYER START] duplicate launch window hit but no player is running; continuing",
                );
            }
            *last = (url.clone(), std::time::Instant::now());
        }
    }

    // Fast path: a live libmpv instance with identical launch options can
    // swap files in place (loadfile replace) — no teardown, no window flash,
    // no GPU/hwdec re-init between episodes or sources.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let launch_config = LibMpvLaunchConfig {
            hwdec_mode: hwdec_mode.clone(),
            video_cache_mode: video_cache_mode.clone(),
            mpv_custom_args: mpv_custom_args.clone(),
        };
        if try_reuse_libmpv_player(
            &app,
            &url,
            title.as_deref(),
            start_time,
            volume,
            &launch_config,
            x,
            y,
            width,
            height,
        )? {
            return Ok(());
        }
    }

    stop_embedded_mpv()?;

    #[cfg(target_os = "windows")]
    let hwnd = main_window_hwnd(&app)?;

    #[cfg(target_os = "linux")]
    // Linux uses libmpv's Render API inside GTK and does not require a native
    // X11 window ID. Keep a non-zero host marker for shared player state.
    let hwnd = 1;

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let hwnd: isize = {
        return Err("Embedded mpv playback is only implemented on Windows and Linux.".to_string());
    };

    launch_mpv_with_window(
        app,
        hwnd,
        url,
        title,
        start_time,
        volume,
        hwdec_mode,
        video_cache_mode,
        mpv_custom_args,
        x,
        y,
        width,
        height,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimalPlayerInfo {
    pub session_id: String,
    pub pid: u32,
    pub stream_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimalPlayerStateResponse {
    pub running: bool,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub stream_hash: Option<String>,
    pub started_at_ms: Option<u128>,
}

/// Diagnostic player path. It intentionally avoids property observation,
/// metadata, custom arguments, reconnect loops, and automatic restarts.
#[tauri::command]
pub fn launch_minimal_mpv(
    _app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    start_time: Option<f64>,
    hwdec_mode: Option<String>,
) -> Result<MinimalPlayerInfo, String> {
    stop_embedded_mpv()?;

    let mpv =
        player::find_mpv().ok_or_else(|| "Bundled mpv executable was not found.".to_string())?;
    let stream_hash = player::stable_stream_hash(&url);
    let session_id = format!(
        "minimal-{}-{}",
        std::process::id(),
        MPV_PIPE_COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    let hwdec = if hwdec_mode.as_deref() == Some("no") {
        "no"
    } else {
        "auto-safe"
    };

    let mut args = vec![
        "--force-window=yes".to_string(),
        "--idle=no".to_string(),
        "--keep-open=no".to_string(),
        "--no-config".to_string(),
        "--terminal=yes".to_string(),
        format!("--hwdec={}", hwdec),
        "--cache=yes".to_string(),
        "--cache-secs=120".to_string(),
        "--demuxer-readahead-secs=60".to_string(),
        "--demuxer-max-bytes=512MiB".to_string(),
        "--demuxer-max-back-bytes=128MiB".to_string(),
        "--network-timeout=30".to_string(),
        "--hr-seek=yes".to_string(),
    ];
    if let Some(value) = title {
        args.push(format!("--force-media-title={}", value));
    }
    if let Some(value) = start_time.filter(|value| *value > 0.0) {
        args.push(format!("--start={}", value));
    }
    args.push(url);

    player_debug_log(format!(
        "[PLAYER START] session={} stream={} hwdec={} args=safe-minimal",
        session_id, stream_hash, hwdec
    ));

    let mut child = Command::new(&mpv)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to launch minimal mpv: {}", error))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
        *state = Some(NativePlayerState {
            host_hwnd: 0,
            video_hwnd: 0,
            session_id: session_id.clone(),
            backend: NativePlayerBackend::Process {
                child,
                ipc_path: session_id.clone(),
                writer: None,
            },
            launch_config: None,
        });
    }
    {
        let mut debug = player_debug_state().lock().map_err(|e| e.to_string())?;
        debug.session_id = Some(session_id.clone());
        debug.stream_hash = Some(stream_hash.clone());
        debug.started_at_ms = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        );
    }

    if let Some(stderr) = stderr {
        let stderr_session = session_id.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                player_debug_log(format!("[MPV STDERR] session={} {}", stderr_session, line));
            }
        });
    }

    if let Some(stdout) = stdout {
        let stdout_session = session_id.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                player_debug_log(format!("[MPV OUTPUT] session={} {}", stdout_session, line));
            }
        });
    }

    let monitor_session = session_id.clone();
    let monitor_identity = session_id.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let exit = {
            let mut state = match native_player_state().lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let Some(player) = state.as_mut() else { return };
            if player.session_id != monitor_identity {
                return;
            }
            let Some(child) = player.process_child_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    *state = None;
                    Some(format!("{}", status))
                }
                Ok(None) => None,
                Err(error) => Some(format!("wait-error: {}", error)),
            }
        };
        if let Some(status) = exit {
            player_debug_log(format!(
                "[PLAYER EXIT] session={} status={}",
                monitor_session, status
            ));
            return;
        }
    });

    Ok(MinimalPlayerInfo {
        session_id,
        pid,
        stream_hash,
    })
}

#[tauri::command]
pub fn minimal_mpv_command(
    command: String,
    args: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let _ = args;
    player_debug_log(format!(
        "[PLAYER CONTROL IGNORED] command={} reason=ipc-disabled-in-isolation",
        command
    ));
    Err("Player controls are disabled in isolated playback. Use mpv's native controls.".to_string())
}

#[tauri::command]
pub fn stop_minimal_mpv(reason: Option<String>) -> Result<(), String> {
    player_debug_log(format!(
        "[PLAYER STOP CALLED] reason={}",
        reason.unwrap_or_else(|| "unspecified".to_string())
    ));
    stop_embedded_mpv()
}

#[tauri::command]
pub fn get_minimal_player_state() -> Result<MinimalPlayerStateResponse, String> {
    let (running, pid) = {
        let state = native_player_state().lock().map_err(|e| e.to_string())?;
        (
            state.is_some(),
            state.as_ref().and_then(|player| player.process_pid()),
        )
    };
    let debug = player_debug_state().lock().map_err(|e| e.to_string())?;
    Ok(MinimalPlayerStateResponse {
        running,
        session_id: debug.session_id.clone(),
        pid,
        stream_hash: debug.stream_hash.clone(),
        started_at_ms: debug.started_at_ms,
    })
}

#[tauri::command]
pub fn get_embedded_player_running() -> Result<bool, String> {
    Ok(native_player_state()
        .lock()
        .map_err(|e| e.to_string())?
        .is_some())
}

#[tauri::command]
pub fn get_player_debug_logs() -> Result<Vec<String>, String> {
    Ok(player_debug_state()
        .lock()
        .map_err(|e| e.to_string())?
        .logs
        .clone())
}

#[tauri::command]
pub fn clear_player_debug_logs() -> Result<(), String> {
    player_debug_state()
        .lock()
        .map_err(|e| e.to_string())?
        .logs
        .clear();
    Ok(())
}

#[tauri::command]
pub fn select_local_video_file() -> Option<String> {
    platform::select_local_video_file()
}

#[cfg(target_os = "windows")]
fn main_window_hwnd(app: &tauri::AppHandle) -> Result<isize, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Main Aurales window was not found.".to_string())?;
    let hwnd = main
        .hwnd()
        .map_err(|e| format!("Failed to get main window handle: {}", e))?;
    Ok(hwnd.0 as isize)
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    maximized: bool,
}

#[cfg(target_os = "windows")]
static PLAYER_WINDOWED_BOUNDS: OnceLock<Mutex<Option<WindowBounds>>> = OnceLock::new();
/// Fullscreen handling for the transparent, decorationless player window.
/// Native physical coordinates avoid work-area/taskbar and DPI restore bugs.
#[tauri::command]
pub fn set_native_player_fullscreen(app: tauri::AppHandle, fullscreen: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClientRect, GetWindowPlacement, GetWindowRect, IsZoomed, SetWindowPos, ShowWindow,
            HWND_NOTOPMOST, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_SHOWWINDOW, SW_MAXIMIZE,
            SW_RESTORE, WINDOWPLACEMENT,
        };

        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "Main Aurales window was not found.".to_string())?;
        let hwnd = HWND(main_window_hwnd(&app)? as *mut _);
        let bounds = PLAYER_WINDOWED_BOUNDS.get_or_init(|| Mutex::new(None));
        let mut saved = bounds.lock().map_err(|e| e.to_string())?;

        if fullscreen {
            if saved.is_none() {
                let mut rect = RECT::default();
                let maximized = unsafe { IsZoomed(hwnd) }.as_bool();
                if maximized {
                    let mut placement = WINDOWPLACEMENT {
                        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                        ..Default::default()
                    };
                    unsafe { GetWindowPlacement(hwnd, &mut placement) }
                        .map_err(|e| format!("Failed to read maximized window bounds: {e}"))?;
                    rect = placement.rcNormalPosition;
                } else {
                    unsafe { GetWindowRect(hwnd, &mut rect) }
                        .map_err(|e| format!("Failed to read window bounds: {e}"))?;
                }
                *saved = Some(WindowBounds {
                    x: rect.left,
                    y: rect.top,
                    width: rect.right - rect.left,
                    height: rect.bottom - rect.top,
                    maximized,
                });
                // SetWindowPos only changes the restore rectangle while a window
                // is maximized. Restore it first so monitor-sized fullscreen is
                // applied to the visible HWND.
                let _ = unsafe { ShowWindow(hwnd, SW_RESTORE) };
            }

            // Enter the actual OS/Tauri fullscreen state. The native bounds
            // below only compensate for transparent borderless Windows windows.
            main.set_fullscreen(true)
                .map_err(|e| format!("Failed to enter OS fullscreen: {e}"))?;

            let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            unsafe { GetMonitorInfoW(monitor, &mut info) }
                .ok()
                .map_err(|e| format!("Failed to read monitor bounds: {e}"))?;
            let rect = info.rcMonitor;
            unsafe {
                SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    SWP_FRAMECHANGED | SWP_SHOWWINDOW,
                )
            }
            .map_err(|e| format!("Failed to enter fullscreen: {e}"))?;
        } else {
            main.set_fullscreen(false)
                .map_err(|e| format!("Failed to leave OS fullscreen: {e}"))?;
            if let Some(rect) = saved.take() {
                let _ = unsafe { ShowWindow(hwnd, SW_RESTORE) };
                unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(HWND_NOTOPMOST),
                        rect.x,
                        rect.y,
                        rect.width,
                        rect.height,
                        SWP_FRAMECHANGED | SWP_SHOWWINDOW,
                    )
                }
                .map_err(|e| format!("Failed to restore window: {e}"))?;
                if rect.maximized {
                    let _ = unsafe { ShowWindow(hwnd, SW_MAXIMIZE) };
                }
            }
        }

        // mpv renders in a separate native HWND, so size it from the exact
        // Win32 client rectangle instead of delayed WebView/DPI dimensions.
        let mut client = RECT::default();
        unsafe { GetClientRect(hwnd, &mut client) }
            .map_err(|e| format!("Failed to read fullscreen client bounds: {e}"))?;
        let video_hwnd = native_player_state()
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|state| state.video_hwnd)
            .unwrap_or(0);
        if video_hwnd != 0 {
            libmpv_player::resize_video_child(
                hwnd.0 as isize,
                video_hwnd,
                0,
                0,
                client.right - client.left,
                client.bottom - client.top,
            );
        }
    }

    #[cfg(target_os = "linux")]
    {
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "Main Aurales window was not found.".to_string())?;
        // Let GTK request fullscreen through the active display backend. This
        // maps to xdg_toplevel on Wayland and EWMH on X11, so no compositor-
        // specific positioning or XWayland fallback is required.
        main.set_fullscreen(fullscreen)
            .map_err(|e| format!("Failed to change Linux fullscreen state: {e}"))?;
        crate::linux_render_surface::resize(&app, 0, 0, 0, 0)?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "Main Aurales window was not found.".to_string())?;
        main.set_fullscreen(fullscreen)
            .map_err(|e| format!("Failed to change fullscreen state: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_embedded_player_supported(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        return main_window_hwnd(&app).is_ok();
    }

    #[cfg(target_os = "linux")]
    {
        return app.get_webview_window("main").is_some() && libmpv_player::find_libmpv().is_some();
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        false
    }
}

fn apply_custom_libmpv_args(
    player: &LibMpvPlayer,
    custom: Option<String>,
    option_log: &mut Vec<String>,
) {
    let Some(custom) = custom else {
        return;
    };

    let parts: Vec<String> = custom.split_whitespace().map(str::to_string).collect();
    let mut index = 0;
    while index < parts.len() {
        let arg = &parts[index];
        index += 1;

        #[cfg(target_os = "windows")]
        if arg == "--ao" || arg == "-ao" {
            if index < parts.len() {
                index += 1;
            }
            player_debug_log("[PLAYER CONFIG] ignored custom --ao; embedded player uses wasapi");
            continue;
        }
        #[cfg(target_os = "windows")]
        if arg.starts_with("--ao=") || arg.starts_with("-ao=") {
            player_debug_log(format!(
                "[PLAYER CONFIG] ignored custom audio output arg: {}",
                arg
            ));
            continue;
        }

        let Some(trimmed) = arg.strip_prefix("--") else {
            player_debug_log(format!(
                "[PLAYER CONFIG] ignored unsupported custom arg: {}",
                arg
            ));
            continue;
        };

        let (name, value) = if let Some((name, value)) = trimmed.split_once('=') {
            (name.to_string(), value.to_string())
        } else if let Some(name) = trimmed.strip_prefix("no-") {
            (name.to_string(), "no".to_string())
        } else if index < parts.len() && !parts[index].starts_with('-') {
            let value = parts[index].clone();
            index += 1;
            (trimmed.to_string(), value)
        } else {
            (trimmed.to_string(), "yes".to_string())
        };

        option_log.push(format!("--{}={}", name, value));
        if let Err(error) = player.set_option(&name, &value) {
            player_debug_log(format!(
                "[PLAYER CONFIG] custom option --{} failed: {}",
                name, error
            ));
        }
    }
}

fn cleanup_player_windows(host_hwnd: isize, video_hwnd: isize) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_WNDPROC};

        let orig = MPV_HOST_ORIG_PROC.swap(0, Ordering::SeqCst);
        if orig != 0 {
            let target = if video_hwnd != 0 {
                video_hwnd
            } else {
                host_hwnd
            };
            if target != 0 {
                unsafe {
                    SetWindowLongPtrW(HWND(target as *mut _), GWLP_WNDPROC, orig);
                }
            }
        }
        libmpv_player::destroy_video_child(video_hwnd);
    }

    #[cfg(target_os = "linux")]
    {
        let _ = host_hwnd;
        libmpv_player::destroy_video_child(video_hwnd);
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = (host_hwnd, video_hwnd);
}

fn launch_mpv_with_window(
    app: tauri::AppHandle,
    hwnd: isize,
    url: String,
    title: Option<String>,
    start_time: Option<f64>,
    volume: Option<f64>,
    hwdec_mode: Option<String>,
    video_cache_mode: Option<String>,
    mpv_custom_args: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (
            hwnd,
            app,
            url,
            title,
            start_time,
            volume,
            hwdec_mode,
            video_cache_mode,
            mpv_custom_args,
            x,
            y,
            width,
            height,
        );
        return Err("Embedded mpv playback is only implemented on Windows and Linux.".to_string());
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let launch_config = LibMpvLaunchConfig {
            hwdec_mode: hwdec_mode.clone(),
            video_cache_mode: video_cache_mode.clone(),
            mpv_custom_args: mpv_custom_args.clone(),
        };

        if let Ok(mut cache) = get_property_cache().write() {
            cache.clear();
        }

        let libmpv = libmpv_player::find_libmpv().ok_or_else(|| {
            let candidates = libmpv_player::libmpv_candidates()
                .into_iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "Failed to launch embedded mpv: libmpv was not found. Expected one of: {}",
                candidates
            )
        })?;

        let session_id = format!(
            "libmpv-{}-{}",
            std::process::id(),
            MPV_PIPE_COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let hwdec = match hwdec_mode.as_deref() {
            Some("no") => "no",
            Some("d3d11va") => "d3d11va",
            Some("nvdec") => "nvdec",
            Some("vaapi") => "vaapi",
            Some("videotoolbox") => "videotoolbox",
            _ => "auto-safe",
        };
        let cache_secs = 60;
        let requested_network_timeout = 60;
        // Torrent-backed HTTP gateways can accept the TCP/TLS connection
        // immediately while taking longer to produce the first byte for a
        // cold stream. A 15 second timeout made every cold source look broken
        // on Linux, even though retrying the same URL succeeded moments later.
        #[cfg(target_os = "linux")]
        let network_timeout = requested_network_timeout.max(60);
        #[cfg(not(target_os = "linux"))]
        let network_timeout = requested_network_timeout;
        let (max_bytes, max_back_bytes) = ("150MiB", "75MiB");
        let (cache_on_disk, effective_cache_secs, effective_max_bytes, effective_max_back_bytes) =
            match video_cache_mode.as_deref() {
                // Store the seekable stream cache on disk rather than retaining a
                // feature-length stream in RAM.
                // Disk cache should make seeking resilient without eagerly
                // downloading a feature-length remote stream in the background.
                Some("disk") => ("yes", 1_800, "1GiB", "512MiB"),
                // Auto keeps disk-backed seeking, but limits its working set to
                // reduce write activity and heat on portable devices.
                Some("auto") => ("yes", cache_secs, "256MiB", "256MiB"),
                _ => ("no", cache_secs, max_bytes, max_back_bytes),
            };
        let video_x = x.unwrap_or(0);
        let video_y = y.unwrap_or(0);
        let video_width = width.unwrap_or(1).max(1);
        let video_height = height.unwrap_or(1).max(1);
        #[cfg(target_os = "windows")]
        let video_hwnd =
            libmpv_player::create_video_child(hwnd, video_x, video_y, video_width, video_height)?;
        #[cfg(target_os = "linux")]
        let video_hwnd = 0;
        let player = match LibMpvPlayer::create(&libmpv, session_id.clone()) {
            Ok(player) => player,
            Err(error) => {
                libmpv_player::destroy_video_child(video_hwnd);
                return Err(error);
            }
        };

        player_debug_log(format!(
            "[PLAYER START] session={} stream={} hwdec={} backend=libmpv dll={}",
            session_id,
            player::stable_stream_hash(&url),
            hwdec,
            libmpv.display()
        ));

        let mut option_log: Vec<String> = Vec::new();
        {
            // Options that only exist in some libmpv versions. `--osc` and
            // `--ytdl` are declared by mpv's builtin Lua scripts, and mpv 0.41
            // dropped them from the option table entirely, so setting them
            // fails with "option not found" on newer runtimes (the Flatpak
            // ships 0.41, the AppImage still ships 0.34). Both are redundant
            // next to `--load-scripts=no`, so a failure here is never fatal.
            for (name, value) in [("osc", "no"), ("ytdl", "no")] {
                option_log.push(format!("--{}={}", name, value));
                if let Err(error) = player.set_option(name, value) {
                    player_debug_log(format!(
                        "[PLAYER CONFIG] skipped --{}={} ({})",
                        name, value, error
                    ));
                }
            }

            let mut set_option = |name: &str, value: String| -> Result<(), String> {
                option_log.push(format!("--{}={}", name, value));
                player
                    .set_option(name, &value)
                    .map_err(|error| format!("--{}={}: {}", name, value, error))
            };

            #[cfg(target_os = "windows")]
            set_option("wid", video_hwnd.to_string())?;
            #[cfg(target_os = "windows")]
            set_option("force-window", "immediate".to_string())?;
            set_option("osd-bar", "no".to_string())?;
            set_option("config", "no".to_string())?;
            set_option("load-scripts", "no".to_string())?;
            set_option("cursor-autohide", "1000".to_string())?;
            set_option("input-default-bindings", "no".to_string())?;
            set_option("input-builtin-bindings", "no".to_string())?;
            set_option("hwdec", hwdec.to_string())?;
            #[cfg(target_os = "windows")]
            set_option("vo", "gpu-next".to_string())?;
            #[cfg(target_os = "linux")]
            set_option("vo", "libmpv".to_string())?;
            #[cfg(target_os = "windows")]
            {
                set_option("gpu-api", "d3d11".to_string())?;
                set_option("d3d11-flip", "no".to_string())?;
            }
            set_option("vd-lavc-dr", "yes".to_string())?;
            set_option("terminal", "no".to_string())?;
            set_option(
                "log-file",
                std::env::temp_dir()
                    .join("aurales-mpv.log")
                    .display()
                    .to_string(),
            )?;
            set_option("msg-level", "all=info".to_string())?;
            #[cfg(target_os = "windows")]
            set_option("ao", "wasapi".to_string())?;
            #[cfg(target_os = "linux")]
            set_option("ao", "pipewire,pulse,alsa".to_string())?;
            set_option("term-osd-bar", "no".to_string())?;
            set_option("term-status-msg", "".to_string())?;
            set_option("keep-open", "no".to_string())?;
            set_option("sub-fix-timing", "yes".to_string())?;
            set_option("demuxer-mkv-subtitle-preroll", "yes".to_string())?;
            set_option("cache", "yes".to_string())?;
            set_option("cache-on-disk", cache_on_disk.to_string())?;
            // Start as soon as mpv has a decodable frame. The cache continues
            // to fill in the background, rather than making a cold stream wait
            // for its initial readahead target before playback is visible.
            set_option("cache-pause-initial", "no".to_string())?;
            set_option("cache-secs", effective_cache_secs.to_string())?;
            set_option("demuxer-max-bytes", effective_max_bytes.to_string())?;
            set_option(
                "demuxer-max-back-bytes",
                effective_max_back_bytes.to_string(),
            )?;
            set_option(
                "demuxer-readahead-secs",
                (effective_cache_secs / 2).to_string(),
            )?;
            set_option("demuxer-seekable-cache", "yes".to_string())?;
            set_option("network-timeout", network_timeout.to_string())?;
            set_option("hr-seek", "yes".to_string())?;
            set_option("hr-seek-framedrop", "yes".to_string())?;
            set_option(
                "stream-lavf-o",
                "reconnect=1,reconnect_streamed=1,reconnect_at_eof=1,reconnect_on_network_error=1,reconnect_delay_max=10".to_string(),
            )?;
            set_option("subs-with-matching-audio", "no".to_string())?;
            set_option("secondary-sub-visibility", "no".to_string())?;
            set_option("sub-auto", "fuzzy".to_string())?;

            if let Some(t) = title {
                set_option("force-media-title", t)?;
            }
            if let Some(s) = start_time.filter(|value| *value > 0.0) {
                set_option("start", s.to_string())?;
            }
            if let Some(v) = volume {
                set_option("volume", v.max(0.0).min(130.0).to_string())?;
            }

            // These are deliberately best-effort: older bundled libmpv builds
            // may not expose them, but current builds can keep video running
            // after a hardware-decoder failure and keep playback alive when an
            // audio device disappears. Neither changes media quality.
            for (name, value) in [
                ("hwdec-software-fallback", "1"),
                ("audio-fallback-to-null", "yes"),
            ] {
                option_log.push(format!("--{}={}", name, value));
                if let Err(error) = player.set_option(name, value) {
                    player_debug_log(format!(
                        "[PLAYER CONFIG] skipped optional --{}={} ({})",
                        name, value, error
                    ));
                }
            }
        }

        apply_custom_libmpv_args(&player, mpv_custom_args, &mut option_log);
        player_debug_log(format!("[PLAYER ARGS] {}", option_log.join(" ")));

        if let Err(error) = player.initialize() {
            player.shutdown();
            libmpv_player::destroy_video_child(video_hwnd);
            return Err(error);
        }
        #[cfg(target_os = "linux")]
        if let Err(error) = crate::linux_render_surface::attach(
            &app,
            Arc::clone(&player),
            video_x,
            video_y,
            video_width,
            video_height,
        ) {
            player_debug_log(format!(
                "[LINUX RENDER] initialization failed: {error}"
            ));
            player.shutdown();
            return Err(error);
        }
        player.request_log_messages("warn");
        player_debug_log("[THUMBNAILS] timeline previews use the independent ffmpeg sprite worker");
        player.observe_properties(&[
            "time-pos",
            "duration",
            "volume",
            "pause",
            "track-list",
            "sub-text",
            "buffering",
            "cache-buffering-state",
            "demuxer-cache-duration",
            "eof-reached",
            "idle-active",
            "core-idle",
            "secondary-sub-text",
            "secondary-sub-start",
            "secondary-sub-end",
            "sub-start",
            "sub-end",
            "chapter-list",
        ]);
        player.start_event_loop(app);
        if let Err(error) = player.command("loadfile", &[serde_json::Value::String(url)]) {
            #[cfg(target_os = "linux")]
            crate::linux_render_surface::detach(&player);
            player.shutdown();
            libmpv_player::destroy_video_child(video_hwnd);
            return Err(error);
        }

        {
            let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
            *state = Some(NativePlayerState {
                host_hwnd: hwnd,
                video_hwnd,
                session_id,
                backend: NativePlayerBackend::LibMpv { player },
                launch_config: Some(launch_config),
            });
        }

        Ok(())
    }
}

#[cfg(any())]
fn launch_mpv_with_window(
    hwnd: isize,
    url: String,
    title: Option<String>,
    start_time: Option<f64>,
    volume: Option<f64>,
    hwdec_mode: Option<String>,
    cache_buffer_size: Option<String>,
    mpv_cache_secs: Option<u32>,
    mpv_network_timeout: Option<u32>,
    mpv_custom_args: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<(), String> {
    {
        if let Ok(mut cache) = get_property_cache().write() {
            cache.clear();
        }
    }

    let mpv = player::find_mpv().ok_or_else(|| {
        "Failed to launch embedded mpv: bundled mpv executable was not found. Reinstall with the NSIS setup exe.".to_string()
    })?;

    let ipc_path = format!(
        r"\\.\pipe\aurales-mpv-{}-{}",
        std::process::id(),
        MPV_PIPE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );

    let hwdec = match hwdec_mode.as_deref() {
        Some("no") => "no",
        Some("d3d11va") => "d3d11va",
        Some("nvdec") => "nvdec",
        Some("vaapi") => "vaapi",
        Some("videotoolbox") => "videotoolbox",
        _ => "auto-safe",
    };

    let cache_secs = mpv_cache_secs.unwrap_or(60);
    let network_timeout = mpv_network_timeout.unwrap_or(60);

    let (max_bytes, max_back_bytes) = match cache_buffer_size.as_deref() {
        Some("large") => ("256MiB", "128MiB"),
        Some("aggressive") => ("512MiB", "256MiB"),
        _ => ("150MiB", "75MiB"),
    };

    let mut args: Vec<String> = vec![
        format!("--wid={}", hwnd),
        "--force-window=immediate".to_string(),
        "--osc=no".to_string(),
        "--osd-bar=no".to_string(),
        "--no-config".to_string(),
        // This mpv build bundles Lua scripts (ytdl_hook, auto_profiles,
        // osc/menu) that run even with --no-config. Inside the app they
        // malfunction ("client removed during hook handling" on every
        // launch), and scripts react to pause events — a wedged script
        // client deadlocks mpv's core. Standalone bisection (2026-07-05)
        // proved audio/codecs/D3D11/--wid embedding all pause/resume fine
        // on this machine without scripts; the app needs none of them.
        "--load-scripts=no".to_string(),
        "--no-ytdl".to_string(),
        "--cursor-autohide=1000".to_string(),
        "--input-default-bindings=no".to_string(),
        "--input-builtin-bindings=no".to_string(),
        format!("--hwdec={}", hwdec),
        // NOTE (2026-07-05): pause/resume wedges in this embedded setup with
        // EVERY renderer (gpu-next, gpu, direct3d — direct3d doesn't even
        // display under the transparent webview) and every AO/hwdec/script
        // combination, while all of them work standalone incl. --wid into a
        // plain host window. The composited transparent-overlay architecture
        // itself is the trigger; no mpv option fixes it. gpu-next/d3d11 is
        // the best-behaved (correct display, occasional wedge handled by the
        // watchdog + auto-restart). Real fix: in-process libmpv migration.
        "--vo=gpu-next".to_string(),
        "--gpu-api=d3d11".to_string(),
        "--d3d11-flip=no".to_string(),
        "--vd-lavc-dr=yes".to_string(),
        format!("--input-ipc-server={}", ipc_path),
        // terminal=no: mpv must never block writing terminal output into our
        // stdout/stderr pipes (a full pipe stalls mpv's core). Diagnostics
        // come from --log-file instead, which mpv writes itself.
        "--terminal=no".to_string(),
        format!(
            "--log-file={}",
            std::env::temp_dir().join("aurales-mpv.log").display()
        ),
        "--msg-level=all=info".to_string(),
        // WASAPI is fine — standalone pause/resume passes on it; and this
        // mpv build doesn't ship a dsound AO anyway.
        "--ao=wasapi".to_string(),
        "--term-osd-bar=no".to_string(),
        "--term-status-msg=".to_string(),
        "--keep-open=no".to_string(),
        "--sub-fix-timing=yes".to_string(),
        "--demuxer-mkv-subtitle-preroll=yes".to_string(),
        "--cache=yes".to_string(),
        format!("--cache-secs={}", cache_secs),
        format!("--demuxer-max-bytes={}", max_bytes),
        format!("--demuxer-max-back-bytes={}", max_back_bytes),
        format!("--demuxer-readahead-secs={}", cache_secs / 2),
        "--demuxer-seekable-cache=yes".to_string(),
        format!("--network-timeout={}", network_timeout),
        "--hr-seek=yes".to_string(),
        "--hr-seek-framedrop=yes".to_string(),
        "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_at_eof=1,reconnect_on_network_error=1,reconnect_delay_max=10".to_string(),
        "--subs-with-matching-audio=no".to_string(),
        "--secondary-sub-visibility=no".to_string(),
        "--sub-auto=fuzzy".to_string(),
    ];

    if let Some(t) = title {
        args.push(format!("--force-media-title={}", t));
    }
    if let Some(s) = start_time {
        args.push(format!("--start={}", s));
    }
    if let Some(v) = volume {
        args.push(format!("--volume={}", v.max(0.0).min(130.0)));
    }

    if let Some(custom) = mpv_custom_args {
        let mut skip_next = false;
        for arg in custom.split_whitespace() {
            if skip_next {
                skip_next = false;
                continue;
            }
            if arg == "--ao" || arg == "-ao" {
                skip_next = true;
                player_debug_log(
                    "[PLAYER CONFIG] ignored custom --ao; embedded player uses wasapi,dsound"
                        .to_string(),
                );
                continue;
            }
            if arg.starts_with("--ao=") || arg.starts_with("-ao=") {
                player_debug_log(format!(
                    "[PLAYER CONFIG] ignored custom audio output arg: {}",
                    arg
                ));
                continue;
            }
            if !arg.is_empty() {
                args.push(arg.to_string());
            }
        }
    }

    args.push(url);

    let mut child = Command::new(&mpv)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch embedded mpv at {}: {}", mpv.display(), e))?;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let normal_session = format!("embedded-{}", child.id());

    player_debug_log(format!(
        "[PLAYER START] session={} stream={} hwdec={} args=embedded-buffered",
        normal_session,
        player::stable_stream_hash(args.last().map(String::as_str).unwrap_or_default()),
        hwdec
    ));
    // Full argument list (minus the stream URL) — shows which settings-derived
    // flags (passthrough, custom args, cache sizes) were actually in effect.
    player_debug_log(format!(
        "[PLAYER ARGS] {}",
        args[..args.len().saturating_sub(1)].join(" ")
    ));

    if let Some(stderr) = stderr {
        let stderr_session = normal_session.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                player_debug_log(format!("[MPV STDERR] session={} {}", stderr_session, line));
            }
        });
    }

    if let Some(stdout) = stdout {
        let stdout_session = normal_session.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                player_debug_log(format!("[MPV OUTPUT] session={} {}", stdout_session, line));
            }
        });
    }

    {
        let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
        *state = Some(NativePlayerState {
            host_hwnd: hwnd,
            child,
            ipc_path: ipc_path.clone(),
            writer: None,
        });
    }

    let monitor_session = normal_session.clone();
    let monitor_ipc_path = ipc_path.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let exit = {
            let mut state = match native_player_state().lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            // No player at all means this session was stopped/killed — exit
            // instead of looping forever (the old `continue` leaked threads
            // and swallowed the PLAYER EXIT log for killed sessions).
            let Some(player) = state.as_mut() else {
                return;
            };
            if player.ipc_path != monitor_ipc_path {
                return;
            }
            match player.child.try_wait() {
                Ok(Some(status)) => {
                    *state = None;
                    Some(status.to_string())
                }
                Ok(None) => None,
                Err(error) => Some(format!("wait-error: {}", error)),
            }
        };
        if let Some(status) = exit {
            player_debug_log(format!(
                "[PLAYER EXIT] session={} status={}",
                monitor_session, status
            ));
            return;
        }
    });

    let ipc_path_clone = ipc_path.clone();
    std::thread::spawn(move || {
        use std::io::Write;
        let mut pipe_file = None;
        let start_time = std::time::Instant::now();
        while start_time.elapsed() < std::time::Duration::from_secs(5) {
            if let Ok(file) = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&ipc_path_clone)
            {
                pipe_file = Some(file);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let Some(file) = pipe_file else {
            return;
        };

        let reader_file = match file.try_clone() {
            Ok(r) => r,
            Err(_) => return,
        };

        let writer = Arc::new(Mutex::new(file));

        if let Ok(mut state_lock) = native_player_state().lock() {
            if let Some(player) = state_lock.as_mut() {
                if player.ipc_path == ipc_path_clone {
                    player.writer = Some(Arc::clone(&writer));
                }
            }
        }

        let observe_cmds = [
            r#"{"command":["observe_property",1,"time-pos"]}"#,
            r#"{"command":["observe_property",2,"duration"]}"#,
            r#"{"command":["observe_property",3,"volume"]}"#,
            r#"{"command":["observe_property",4,"pause"]}"#,
            r#"{"command":["observe_property",5,"track-list"]}"#,
            r#"{"command":["observe_property",6,"sub-text"]}"#,
            r#"{"command":["observe_property",7,"buffering"]}"#,
            r#"{"command":["observe_property",8,"cache-buffering-state"]}"#,
            r#"{"command":["observe_property",9,"demuxer-cache-duration"]}"#,
            r#"{"command":["observe_property",10,"eof-reached"]}"#,
            r#"{"command":["observe_property",11,"idle-active"]}"#,
            r#"{"command":["observe_property",12,"core-idle"]}"#,
            r#"{"command":["observe_property",13,"secondary-sub-text"]}"#,
            r#"{"command":["observe_property",14,"secondary-sub-start"]}"#,
            r#"{"command":["observe_property",15,"secondary-sub-end"]}"#,
            r#"{"command":["observe_property",16,"sub-start"]}"#,
            r#"{"command":["observe_property",17,"sub-end"]}"#,
        ];
        if let Ok(mut writer_guard) = writer.lock() {
            for cmd in observe_cmds {
                let _ = writeln!(writer_guard, "{}", cmd);
            }
            let _ = writer_guard.flush();
        }

        let reader = std::io::BufReader::new(reader_file);
        use std::io::BufRead;
        for line_res in reader.lines() {
            let line = match line_res {
                Ok(l) => l,
                Err(e) => {
                    player_debug_log(format!("[MPV IPC] reader error: {}", e));
                    break;
                }
            };
            // Any line from mpv proves its IPC thread is alive — feed the
            // hang watchdog.
            LAST_IPC_LINE_MS.store(epoch_ms(), Ordering::SeqCst);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                match json.get("event").and_then(|v| v.as_str()) {
                    Some("property-change") => {
                        if let (Some(name), Some(data)) = (
                            json.get("name").and_then(|v| v.as_str()),
                            json.get("data").cloned(),
                        ) {
                            if let Ok(mut cache) = get_property_cache().write() {
                                cache.insert(name.to_string(), data);
                            }
                        }
                    }
                    // Core lifecycle events (pause/unpause/seek/playback-restart/
                    // end-file/...) are rare and pinpoint what mpv actually did
                    // with our commands.
                    Some(_) => {
                        player_debug_log(format!("[MPV EVENT] {}", line));
                    }
                    None => {}
                }
                // Surface command failures — replies carry "error" != "success".
                if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
                    if err != "success" {
                        player_debug_log(format!("[MPV IPC ERROR] {}", line));
                    }
                }
            }
        }
        player_debug_log("[MPV IPC] reader disconnected — commands can no longer reach mpv");
    });

    // ── Hang watchdog ──────────────────────────────────────────────────────
    // mpv is embedded as a cross-process child window (`--wid`), which ties
    // its input queue to the main window's. If mpv's window thread hangs,
    // the next input interaction freezes the ENTIRE app. A hung mpv cannot
    // be detected from the UI thread (it's the one that freezes), so this
    // background thread pings mpv over IPC and kills the process when it
    // stops responding — killing it detaches the queues and unfreezes the UI.
    let watchdog_session = normal_session.clone();
    let watchdog_ipc_path = ipc_path.clone();
    LAST_IPC_LINE_MS.store(epoch_ms(), Ordering::SeqCst);
    std::thread::spawn(move || {
        // Grace period so slow stream startup is never treated as a hang.
        std::thread::sleep(std::time::Duration::from_secs(10));
        loop {
            std::thread::sleep(std::time::Duration::from_millis(2000));

            let writer_opt = {
                let mut state = match native_player_state().lock() {
                    Ok(state) => state,
                    Err(_) => return,
                };
                let Some(player) = state.as_mut() else { return };
                if player.ipc_path != watchdog_ipc_path {
                    return; // a newer session took over
                }

                let silent_ms = epoch_ms().saturating_sub(LAST_IPC_LINE_MS.load(Ordering::SeqCst));
                if silent_ms > 8_000 {
                    player_debug_log(format!(
                        "[PLAYER WATCHDOG] session={} mpv unresponsive for {}ms — killing process to unfreeze the app",
                        watchdog_session, silent_ms
                    ));
                    let _ = player.child.kill();
                    *state = None;
                    return;
                }
                player.writer.as_ref().map(Arc::clone)
            };

            // Ping so a healthy-but-paused mpv keeps producing IPC lines.
            // Detached thread + try_lock: if the pipe is clogged the blocked
            // write parks here instead of wedging the watchdog loop.
            if let Some(writer) = writer_opt {
                std::thread::spawn(move || {
                    use std::io::Write;
                    if let Ok(mut guard) = writer.try_lock() {
                        let _ = writeln!(guard, r#"{{"command":["get_property","pid"]}}"#);
                        let _ = guard.flush();
                    }
                });
            }
        }
    });

    Ok(())
}

// Async + spawn_blocking: the pipe write blocks if mpv stops draining its
// IPC pipe (hung decoder/audio device). As a sync command that blocked the
// webview main thread and froze the whole app.
#[tauri::command]
pub async fn mpv_command(
    command: String,
    args: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;

        let args = args.unwrap_or_default();
        let command_name = command.clone();
        let payload = serde_json::json!({
            "command": std::iter::once(serde_json::Value::String(command))
                .chain(args.clone())
                .collect::<Vec<_>>()
        });

        enum Target {
            LibMpv(Arc<LibMpvPlayer>),
            Ipc {
                writer: Option<Arc<Mutex<std::fs::File>>>,
                ipc_path: String,
            },
        }

        let target = {
            let state = native_player_state().lock().map_err(|e| e.to_string())?;
            match state.as_ref() {
                Some(player) => match &player.backend {
                    NativePlayerBackend::LibMpv { player } => Target::LibMpv(Arc::clone(player)),
                    NativePlayerBackend::Process {
                        writer, ipc_path, ..
                    } => Target::Ipc {
                        writer: writer.as_ref().map(Arc::clone),
                        ipc_path: ipc_path.clone(),
                    },
                },
                None => return Err("No player is running".to_string()),
            }
        };

        // Commands are rare (user actions), so logging them is cheap and
        // makes "the command never arrived" bugs visible in Player Logs.
        player_debug_log(format!("[MPV CMD] {}", payload));

        match target {
            Target::LibMpv(player) => {
                // Stop ThumbFast from scheduling more preview work before a
                // user seek. `clear` only cancels its timers and is immediate;
                // do not use `stop` here because writing to the helper socket
                // can wait on a wedged decoder and delay the real seek.
                if command_name == "seek" {
                    let _ = player.command(
                        "script-message-to",
                        &[
                            serde_json::Value::String("thumbfast".to_string()),
                            serde_json::Value::String("clear".to_string()),
                        ],
                    );
                }
                player.command(&command_name, &args)
            }
            Target::Ipc { writer, ipc_path } => {
                if let Some(writer) = writer {
                    let write_result =
                        writer
                            .lock()
                            .map_err(|e| e.to_string())
                            .and_then(|mut writer_guard| {
                                writeln!(writer_guard, "{}", payload)
                                    .and_then(|_| writer_guard.flush())
                                    .map_err(|e| e.to_string())
                            });

                    if let Err(e) = write_result {
                        player_debug_log(format!("[MPV CMD] write failed: {}", e));
                        if let Ok(mut state) = native_player_state().lock() {
                            if let Some(player) = state.as_mut() {
                                if let NativePlayerBackend::Process {
                                    ipc_path: current_ipc_path,
                                    writer,
                                    ..
                                } = &mut player.backend
                                {
                                    if *current_ipc_path == ipc_path {
                                        *writer = None;
                                    }
                                }
                            }
                        }
                        return Err(format!("Failed to send mpv command: {}", e));
                    }
                    Ok(())
                } else {
                    player_debug_log("[MPV CMD] dropped: IPC writer not ready");
                    Err("mpv IPC not ready yet".to_string())
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn request_player_thumbnail(time: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !time.is_finite() || time < 0.0 {
            return Err("Invalid thumbnail time".to_string());
        }

        let player = {
            let state = native_player_state().lock().map_err(|e| e.to_string())?;
            match state.as_ref() {
                Some(player) => match &player.backend {
                    NativePlayerBackend::LibMpv { player } => Arc::clone(player),
                    NativePlayerBackend::Process { .. } => {
                        return Err(
                            "Timeline thumbnails require the embedded libmpv player.".to_string()
                        )
                    }
                },
                None => return Err("No player is running".to_string()),
            }
        };

        let target = player.client_target();
        player.command(
            "script-message-to",
            &[
                serde_json::Value::String("thumbfast".to_string()),
                serde_json::Value::String("thumb".to_string()),
                serde_json::Value::String(format!("{:.3}", time)),
                serde_json::Value::String(String::new()),
                serde_json::Value::String(String::new()),
                serde_json::Value::String(target),
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_player_thumbnail() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let player = {
            let state = native_player_state().lock().map_err(|e| e.to_string())?;
            match state.as_ref() {
                Some(player) => match &player.backend {
                    NativePlayerBackend::LibMpv { player } => Some(Arc::clone(player)),
                    NativePlayerBackend::Process { .. } => None,
                },
                None => None,
            }
        };

        if let Some(player) = player {
            let _ = player.command(
                "script-message-to",
                &[
                    serde_json::Value::String("thumbfast".to_string()),
                    // `clear` only cancels the pending ThumbFast request. It
                    // does not wait on the helper decoder, so releasing the
                    // timeline can never hold up the actual playback seek.
                    serde_json::Value::String("clear".to_string()),
                ],
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn start_thumbnail_generation(
    app: tauri::AppHandle,
    request: crate::thumbnails::ThumbnailStartRequest,
) -> Result<Option<crate::thumbnails::ThumbnailMetadata>, String> {
    crate::thumbnails::start_thumbnail_generation(app, request)
}

#[tauri::command]
pub fn get_thumbnail_metadata(
    app: tauri::AppHandle,
    cache_key: String,
) -> Result<Option<crate::thumbnails::ThumbnailMetadata>, String> {
    crate::thumbnails::get_thumbnail_metadata(app, cache_key)
}

#[tauri::command]
pub fn get_or_queue_scrub_thumbnail(
    app: tauri::AppHandle,
    request: crate::thumbnails::ScrubThumbnailRequest,
) -> Result<crate::thumbnails::ScrubThumbnailResponse, String> {
    crate::thumbnails::get_or_queue_scrub_thumbnail(app, request)
}

#[tauri::command]
pub fn prefetch_thumbnail_sprite(path: String) -> Result<(), String> {
    crate::thumbnails::prefetch_thumbnail_sprite(path)
}

#[tauri::command]
pub fn get_thumbnail_debug_state() -> crate::thumbnails::ThumbnailDebugState {
    crate::thumbnails::get_thumbnail_debug_state()
}

#[tauri::command]
pub fn mpv_get_property(property: String) -> Result<serde_json::Value, String> {
    if let Ok(cache) = get_property_cache().read() {
        if let Some(val) = cache.get(&property) {
            return Ok(val.clone());
        }
    }
    Ok(serde_json::Value::Null)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub time_pos: Option<f64>,
    pub duration: Option<f64>,
    pub paused: Option<bool>,
    pub buffering: Option<bool>,
    pub cache_buffering_state: Option<f64>,
    pub demuxer_cache_duration: Option<f64>,
    pub eof_reached: Option<bool>,
    pub idle_active: Option<bool>,
    pub core_idle: Option<bool>,
}

/// Returns the high-frequency playback state under one cache read and one IPC
/// call. libmpv keeps PROPERTY_CACHE current through observed property events.
#[tauri::command]
pub fn get_player_snapshot() -> Result<PlayerSnapshot, String> {
    let cache = get_property_cache().read().map_err(|e| e.to_string())?;
    let number = |name: &str| cache.get(name).and_then(serde_json::Value::as_f64);
    let boolean = |name: &str| cache.get(name).and_then(serde_json::Value::as_bool);
    Ok(PlayerSnapshot {
        time_pos: number("time-pos"),
        duration: number("duration"),
        paused: boolean("pause"),
        buffering: boolean("buffering"),
        cache_buffering_state: number("cache-buffering-state"),
        demuxer_cache_duration: number("demuxer-cache-duration"),
        eof_reached: boolean("eof-reached"),
        idle_active: boolean("idle-active"),
        core_idle: boolean("core-idle"),
    })
}

/// Resize mpv's child HWND to fill (x, y, width, height) within the host window.
///
/// mpv does NOT auto-resize when its parent window is resized (child windows
/// never do on Win32).  We find mpv's window by matching the mpv process ID
/// among the host's child windows, then call SetWindowPos to move/resize it.
#[tauri::command]
pub fn resize_embedded_mpv(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

        let (host_hwnd, video_hwnd) = {
            let state = native_player_state().lock().map_err(|e| e.to_string())?;
            match state.as_ref() {
                Some(s) => (s.host_hwnd, s.video_hwnd),
                None => return Ok(()),
            }
        };
        if host_hwnd == 0 || video_hwnd == 0 {
            return Ok(());
        }

        let host = HWND(host_hwnd as *mut _);
        let (w, h) = if width > 0 && height > 0 {
            (width, height)
        } else {
            let mut rect = RECT::default();
            unsafe {
                let _ = GetClientRect(host, &mut rect);
            }
            (rect.right - rect.left, rect.bottom - rect.top)
        };
        if w > 0 && h > 0 {
            libmpv_player::resize_video_child(host_hwnd, video_hwnd, x, y, w, h);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let running = native_player_state()
            .lock()
            .map_err(|e| e.to_string())?
            .is_some();
        if running {
            crate::linux_render_surface::resize(&app, x, y, width, height)?;
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = (app, x, y, width, height);

    #[cfg(target_os = "windows")]
    let _ = app;

    Ok(())
}

#[cfg(any())]
#[tauri::command]
pub fn resize_embedded_mpv(x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, RECT};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumChildWindows, GetClientRect, GetWindowThreadProcessId, SetWindowPos,
            SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER,
        };

        let (host_hwnd, mpv_pid) = {
            let state = native_player_state().lock().map_err(|e| e.to_string())?;
            match state.as_ref() {
                Some(s) => (s.host_hwnd, s.child.id()),
                None => return Ok(()),
            }
        };
        if host_hwnd == 0 {
            return Ok(());
        }

        let host = HWND(host_hwnd as *mut _);

        // Prefer the caller-supplied dimensions (already DPI-scaled).
        // Fall back to GetClientRect if they look wrong (both 0 on some calls).
        let (w, h) = if width > 0 && height > 0 {
            (width, height)
        } else {
            let mut rect = RECT::default();
            unsafe {
                let _ = GetClientRect(host, &mut rect);
            }
            (rect.right - rect.left, rect.bottom - rect.top)
        };
        if w <= 0 || h <= 0 {
            return Ok(());
        }

        // Walk child windows and find the one owned by the mpv process.
        struct FindCtx {
            pid: u32,
            hwnd: isize,
        }
        let mut ctx = FindCtx {
            pid: mpv_pid,
            hwnd: 0,
        };

        unsafe extern "system" fn find_by_pid(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = &mut *(lparam.0 as *mut FindCtx);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == ctx.pid {
                ctx.hwnd = hwnd.0 as isize;
                return BOOL(0); // stop enumeration (FALSE)
            }
            BOOL(1) // continue (TRUE)
        }

        unsafe {
            let _ = EnumChildWindows(
                Some(host),
                Some(find_by_pid),
                LPARAM(&mut ctx as *mut _ as isize),
            );
        }

        if ctx.hwnd != 0 {
            let mpv_hwnd = HWND(ctx.hwnd as *mut _);
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, SWP_FRAMECHANGED,
                    WS_CLIPSIBLINGS,
                };
                // WS_CLIPSIBLINGS: the transparent WebView2 overlay is a
                // SIBLING of mpv's child window. Without sibling clipping,
                // every webview repaint (pause icon, controls) invalidates
                // mpv's window, forcing paused-frame redraws — the observed
                // deadlock trigger when paused.
                let style = GetWindowLongPtrW(mpv_hwnd, GWL_STYLE);
                if style != 0 && (style as u32) & WS_CLIPSIBLINGS.0 == 0 {
                    SetWindowLongPtrW(mpv_hwnd, GWL_STYLE, style | WS_CLIPSIBLINGS.0 as isize);
                }
                // SWP_ASYNCWINDOWPOS: mpv's window lives on another process's
                // thread. Without this flag SetWindowPos waits synchronously
                // on that thread and freezes our UI thread if mpv is hung.
                let _ = SetWindowPos(
                    mpv_hwnd,
                    None, // HWND_TOP equivalent (no z-order change with SWP_NOZORDER)
                    x,
                    y,
                    w,
                    h,
                    SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS | SWP_FRAMECHANGED,
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = (x, y, width, height);

    Ok(())
}

/// Re-subclasses the mpv host HWND so that WM_NCHITTEST always returns
/// HTTRANSPARENT.  This is necessary because mpv installs its own WndProc on
/// the host (for D3D11 / overlay rendering) which unconditionally returns
/// HTCLIENT, overriding WS_EX_TRANSPARENT and swallowing all mouse input.
///
/// Safe to call multiple times — the guard on MPV_HOST_ORIG_PROC prevents
/// double-subclassing.
#[tauri::command]
pub fn setup_player_click_through() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_WNDPROC};

        let target_hwnd = {
            let state = native_player_state().lock().map_err(|e| e.to_string())?;
            state
                .as_ref()
                .map(|s| {
                    if s.video_hwnd != 0 {
                        s.video_hwnd
                    } else {
                        s.host_hwnd
                    }
                })
                .unwrap_or(0)
        };

        if target_hwnd != 0 {
            let current_proc = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                    HWND(target_hwnd as *mut _),
                    GWLP_WNDPROC,
                )
            };

            let transparent_proc = transparent_host_proc as *const () as isize;

            if current_proc != 0 && current_proc != transparent_proc {
                let prev = unsafe {
                    SetWindowLongPtrW(HWND(target_hwnd as *mut _), GWLP_WNDPROC, transparent_proc)
                };
                if prev != 0 && prev != transparent_proc {
                    MPV_HOST_ORIG_PROC.store(prev, Ordering::SeqCst);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stop_embedded_mpv() -> Result<(), String> {
    let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
    if let Some(mut player) = state.take() {
        let session_id = player.session_id.clone();
        let host_hwnd = player.host_hwnd;
        let video_hwnd = player.video_hwnd;
        match &mut player.backend {
            NativePlayerBackend::LibMpv { player } => {
                #[cfg(target_os = "linux")]
                crate::linux_render_surface::detach(player);
                cleanup_player_windows(host_hwnd, video_hwnd);
                player_debug_log(format!(
                    "[PLAYER EXIT] session={} status=terminated-by-stop",
                    session_id
                ));
                player.shutdown();
            }
            NativePlayerBackend::Process { child, .. } => {
                cleanup_player_windows(host_hwnd, video_hwnd);
                player_debug_log(format!(
                    "[PLAYER EXIT] session={} pid={} status=killed-by-stop",
                    session_id,
                    child.id()
                ));
                let _ = child.kill();
            }
        }
    }
    Ok(())
}

// ─── Generic PMDB proxy (bypasses CORS) ──────────────────────────────────────
//
// All PMDB API calls go through this command so that the request originates from
// the Rust process (no browser origin header) rather than from the WebView.
// This is identical in spirit to how Simkl auth is handled via ureq.

#[tauri::command]
pub async fn pmdb_request(
    method: String,
    url: String,
    api_key: String,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let (method, api_key) = request::normalize_pmdb_request(method, api_key);

    tokio::task::spawn_blocking(move || request::pmdb_request(method, url, api_key, body))
        .await
        .map_err(|e| format!("PMDB request task panicked: {e}"))?
}

// ─── TorBox proxy (bypasses WebView CORS) ───────────────────────────────────

#[tauri::command]
pub async fn torbox_request(
    method: String,
    path: String,
    token: Option<String>,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<ProxyResponse, String> {
    let (method, path, token, content_type) =
        request::normalize_torbox_request(method, path, token, content_type)?;

    tokio::task::spawn_blocking(move || {
        request::torbox_request(method, path, token, body, content_type)
    })
    .await
    .map_err(|error| format!("TorBox request task failed: {error}"))?
}

// How this copy of Aurales was installed, so the UI knows whether the built-in
// updater can actually install anything.
//
// The Flatpak is assembled from the .deb bundle, so its binary carries the
// bundler's Debian marker. The updater therefore routes the downloaded
// AppImage through `dpkg -i` and bails out with "invalid updater binary
// format" — and even if the format matched, /app is read-only inside the
// sandbox. Flatpak installs update through `flatpak update` instead.
#[tauri::command]
pub fn install_kind() -> &'static str {
    platform::install_kind()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlatpakUpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    stage: &'static str,
}

/// Downloads and reinstalls a standalone Flatpak bundle without blocking the
/// WebView. The sandbox cannot modify /app, so installation is delegated to
/// the host through flatpak-spawn after the bundle has been downloaded into
/// the app cache (which is host-visible below ~/.var/app).
#[tauri::command]
pub async fn install_flatpak_update(app: tauri::AppHandle, version: String) -> Result<(), String> {
    if platform::install_kind() != "flatpak" {
        return Err("The Flatpak update path is only available inside Flatpak.".to_string());
    }

    let url = platform::flatpak_release_asset_url(&version)?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to resolve the update cache: {error}"))?
        .join("updates");
    let bundle_path = cache_dir.join(format!("Aurales_{version}_amd64.flatpak"));
    let worker_app = app.clone();
    let worker_bundle = bundle_path.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::io::{Read, Write};

        std::fs::create_dir_all(&cache_dir)
            .map_err(|error| format!("Failed to prepare the update cache: {error}"))?;
        let _ = worker_app.emit(
            "flatpak-update-progress",
            FlatpakUpdateProgress {
                downloaded: 0,
                total: None,
                stage: "downloading",
            },
        );

        let response = ureq::get(&url)
            .set("Accept", "application/octet-stream")
            .set("User-Agent", "Aurales-Updater")
            .call()
            .map_err(|error| format!("Failed to download the Flatpak update: {error}"))?;
        let total = response
            .header("Content-Length")
            .and_then(|value| value.parse::<u64>().ok());
        let mut reader = response.into_reader();
        let mut output = std::fs::File::create(&worker_bundle)
            .map_err(|error| format!("Failed to create the update bundle: {error}"))?;
        let mut buffer = [0_u8; 128 * 1024];
        let mut downloaded = 0_u64;
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| format!("Failed while downloading the update: {error}"))?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| format!("Failed to save the update bundle: {error}"))?;
            downloaded += count as u64;
            let _ = worker_app.emit(
                "flatpak-update-progress",
                FlatpakUpdateProgress {
                    downloaded,
                    total,
                    stage: "downloading",
                },
            );
        }
        output
            .sync_all()
            .map_err(|error| format!("Failed to finish the update download: {error}"))?;
        if downloaded == 0 {
            return Err("The downloaded Flatpak bundle was empty.".to_string());
        }

        let _ = worker_app.emit(
            "flatpak-update-progress",
            FlatpakUpdateProgress {
                downloaded,
                total: Some(downloaded),
                stage: "installing",
            },
        );
        let install = Command::new("flatpak-spawn")
            .args([
                "--host",
                "flatpak",
                "install",
                "--user",
                "-y",
                "--reinstall",
            ])
            .arg(&worker_bundle)
            .output()
            .map_err(|error| format!("Failed to start the host Flatpak installer: {error}"))?;
        let _ = std::fs::remove_file(&worker_bundle);
        if !install.status.success() {
            let stderr = String::from_utf8_lossy(&install.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("Flatpak installation failed with {}.", install.status)
            } else {
                format!("Flatpak installation failed: {stderr}")
            });
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Flatpak update task failed: {error}"))??;

    // Start the newly installed deployment after this sandbox has exited.
    Command::new("flatpak-spawn")
        .args([
            "--host",
            "sh",
            "-c",
            "sleep 1; flatpak run com.aurales.app >/dev/null 2>&1 &",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("The update was installed, but restart failed: {error}"))?;
    app.exit(0);
    Ok(())
}

// Fetches the latest GitHub release (tag, name, body markdown) so the update
// prompt can show real patch notes. Uses the same build-time PAT as the
// updater since the repo is private.
#[tauri::command]
pub async fn github_release_notes() -> Result<String, String> {
    tokio::task::spawn_blocking(request::github_release_notes)
        .await
        .map_err(|e| format!("GitHub release task failed: {e}"))?
}

#[tauri::command]
pub async fn ytproxy_port() -> Result<u16, String> {
    crate::ytproxy::ensure_started().await
}

// Innertube player API call routed through the ytproxy agent so the returned
// stream URLs are bound to the same IP family the proxy fetches chunks with.
#[tauri::command]
pub async fn innertube_player(body: String, user_agent: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || request::innertube_player(body, user_agent))
        .await
        .map_err(|e| format!("Innertube task failed: {e}"))?
}

#[tauri::command]
pub async fn http_get_text(url: String) -> Result<String, String> {
    request::validate_http_url(&url)?;
    tokio::task::spawn_blocking(move || request::get_text(url))
        .await
        .map_err(|e| format!("HTTP request task failed: {e}"))?
}

// Lightweight warm-up for a prepared direct stream: a small ranged GET (many
// CDNs reject HEAD) measures first-byte/transfer responsiveness and resolves
// the final redirect without pulling a meaningful portion of the media.
#[tauri::command]
pub async fn http_probe_stream(
    url: String,
    timeout_ms: Option<u64>,
) -> Result<StreamProbeResponse, String> {
    request::validate_http_url(&url)?;
    tokio::task::spawn_blocking(move || request::probe_stream(url, timeout_ms))
        .await
        .map_err(|e| format!("Stream probe task failed: {e}"))?
}

#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    request::validate_http_url(&url)?;
    tokio::task::spawn_blocking(move || request::request_text(method, url, headers, body))
        .await
        .map_err(|e| format!("HTTP request task failed: {e}"))?
}

#[tauri::command]
pub async fn openrouter_chat(
    api_key: String,
    request_body: serde_json::Value,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || request::openrouter_chat(api_key, request_body))
        .await
        .map_err(|error| format!("OpenRouter request task failed: {error}"))?
}

#[tauri::command]
pub async fn download_subtitle(url: String, file_name: String) -> Result<String, String> {
    request::validate_http_url(&url)?;
    tokio::task::spawn_blocking(move || subtitles::download(url, file_name))
        .await
        .map_err(|e| format!("Subtitle download task failed: {e}"))?
}

#[tauri::command]
pub async fn write_temp_subtitle(content: String, extension: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || subtitles::write_temp(content, extension))
        .await
        .map_err(|e| format!("Subtitle write task failed: {e}"))?
}

#[tauri::command]
pub async fn read_temp_subtitle(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || subtitles::read_temp(path))
        .await
        .map_err(|e| format!("Subtitle read task failed: {e}"))?
}

#[tauri::command]
pub async fn update_temp_subtitle(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || subtitles::update_temp(path, content))
        .await
        .map_err(|e| format!("Subtitle update task failed: {e}"))?
}

/// Extracts a single embedded subtitle stream from `url` to SRT text using
/// ffmpeg. `sub_index` is the RELATIVE subtitle-stream index (0 = first subtitle
/// track), mapped as `0:s:<sub_index>` — mapping by absolute stream index is
/// unreliable across sources and can select a non-subtitle stream. Used to
/// pre-translate embedded subtitles ahead of playback.
#[tauri::command]
pub async fn extract_embedded_subtitle(url: String, sub_index: u32) -> Result<String, String> {
    tokio::task::spawn_blocking(move || subtitles::extract_embedded(url, sub_index))
        .await
        .map_err(|e| format!("Subtitle extract task failed: {e}"))?
}

// ─── Simkl OAuth commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn request_simkl_pin(client_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || providers::request_simkl_pin(client_id))
        .await
        .map_err(|e| format!("Simkl PIN request task panicked: {}", e))?
}

#[tauri::command]
pub async fn check_simkl_pin(user_code: String, client_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || providers::check_simkl_pin(user_code, client_id))
        .await
        .map_err(|e| format!("Simkl PIN check task panicked: {}", e))?
}

#[tauri::command]
pub async fn fetch_simkl_user(access_token: String, client_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || providers::fetch_simkl_user(access_token, client_id))
        .await
        .map_err(|e| format!("Simkl user fetch task panicked: {}", e))?
}

/// Starts a one-shot TCP server on 127.0.0.1:42814 and waits for Simkl's
/// OAuth redirect.  Returns the `code` query parameter from the redirect URL.
///
/// The frontend calls this *before* opening the browser so the server is
/// ready when Simkl redirects back.
#[tauri::command]
pub async fn start_simkl_callback_server() -> Result<String, String> {
    providers::wait_for_simkl_callback().await
}

/// Exchanges a Simkl authorization code for an access token.
///
/// The `SIMKL_CLIENT_SECRET` must be present as an environment variable at
/// **build time** (no `VITE_` prefix → never bundled into the JS bundle).
/// The secret value is baked into the binary via `option_env!`; it is never
/// read from the JS side.
#[tauri::command]
pub async fn exchange_simkl_token(
    code: String,
    client_id: String,
    redirect_uri: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        providers::exchange_simkl_token(code, client_id, redirect_uri)
    })
    .await
    .map_err(|e| format!("Simkl token exchange task panicked: {}", e))?
}

/// Opens the Simkl OAuth authorisation URL in the user's default browser.
#[tauri::command]
#[allow(deprecated)] // tauri-plugin-shell::Shell::open is deprecated in favour of
                     // tauri-plugin-opener; switch once opener is added to Cargo.toml.
pub fn open_simkl_auth(app: tauri::AppHandle, url: String) -> Result<(), String> {
    request::validate_http_url(&url)?;
    // Some Linux browser launchers keep the `open` process alive until the
    // browser window closes. Never let that block the Tauri command queue:
    // OAuth/device-code polling must be able to continue while the browser is
    // still open.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_shell::ShellExt;
        if let Err(error) = app.shell().open(&url, None) {
            log::error!("Failed to open authorization URL in browser: {error}");
        }
    });
    Ok(())
}

/// Starts a one-shot TCP server on 127.0.0.1:42814 and waits for AniList's
/// OAuth redirect. Returns the `code` query parameter from the redirect URL.
#[tauri::command]
pub async fn start_anilist_callback_server() -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let (listener, _guard) = providers::begin_anilist_callback().await?;

    let mut stream = providers::accept_oauth_callback(
        &listener,
        120,
        "Timed out waiting for OAuth callback.",
        "Failed to accept OAuth callback",
    )
    .await?;

    let request = providers::read_oauth_callback(&mut stream, "AniList").await?;
    if let Some(token) = providers::parse_oauth_param(&request, "access_token") {
        providers::write_oauth_success_response(&mut stream, "Connected!").await;
        return Ok(token);
    }
    if let Some(code) = providers::parse_oauth_code(&request) {
        providers::write_oauth_success_response(&mut stream, "Authorization received").await;
        return Ok(code);
    }

    let html = concat!(
        "<html><head><meta charset=\"utf-8\"><title>Aurales</title></head>",
        "<script>",
        "const params = new URLSearchParams(location.hash.slice(1));",
        "const token = params.get('access_token');",
        "if (token) fetch('/token?access_token=' + encodeURIComponent(token)).then(() => {",
        "document.body.innerHTML = '<h2>Connected!</h2><p>You can close this tab and return to Aurales.</p>';",
        "});",
        "</script>",
        "<body style=\"font-family:sans-serif;text-align:center;padding:60px\">",
        "<h2>Finishing connection...</h2>",
        "</body></html>",
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html,
    );
    let _ = stream.write_all(response.as_bytes()).await;

    let mut stream = providers::accept_oauth_callback(
        &listener,
        15,
        "Timed out waiting for AniList access token relay.",
        "Failed to accept AniList token relay",
    )
    .await?;

    let request = providers::read_oauth_callback(&mut stream, "AniList token relay").await?;
    let token = providers::parse_oauth_param(&request, "access_token")
        .ok_or_else(|| "AniList OAuth callback did not contain an access token.".to_string())?;
    providers::write_oauth_success_response(&mut stream, "Connected!").await;
    Ok(token)
}

/// Exchanges an AniList authorization code for an access token.
#[allow(dead_code)]
#[tauri::command]
pub async fn exchange_anilist_token(
    code: String,
    client_id: String,
    redirect_uri: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        providers::exchange_anilist_token(code, client_id, redirect_uri)
    })
    .await
    .map_err(|e| format!("AniList token exchange task panicked: {}", e))?
}

#[cfg(test)]
mod anilist_callback_tests {
    use crate::core::providers::parse_oauth_code;

    #[test]
    fn parses_authorization_callback_code() {
        let request = "GET /?code=abc%2B123 HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(parse_oauth_code(request).as_deref(), Some("abc+123"));
    }
}

// ─── Cache Entries ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn cache_entry_set(
    key: String,
    value: String,
    category: String,
    ttl_seconds: Option<i64>,
    db: State<Database>,
) -> Result<(), String> {
    cache::entry_set(&db, key, value, category, ttl_seconds)
}

#[tauri::command]
pub fn cache_entry_get(key: String, db: State<Database>) -> Option<CacheEntry> {
    cache::entry_get(&db, key)
}

#[tauri::command]
pub fn cache_entry_get_many(keys: Vec<String>, db: State<Database>) -> Vec<CacheEntry> {
    cache::entry_get_many(&db, keys)
}

#[tauri::command]
pub fn cache_entry_clear_category(category: String, db: State<Database>) -> Result<u64, String> {
    let cleared = cache::clear_category(&db, category.clone())?;
    if category == "anime_mapping" {
        anime_lookup::clear_memory_cache();
    }
    Ok(cleared)
}

#[tauri::command]
pub fn cache_entry_clear_expired(db: State<Database>) -> Result<u64, String> {
    cache::clear_expired(&db)
}

#[tauri::command]
pub fn cache_entry_stats(db: State<Database>) -> Result<serde_json::Value, String> {
    cache::stats(&db)
}

#[tauri::command]
pub fn get_mpv_info() -> Result<serde_json::Value, String> {
    Ok(player::diagnostics(
        player::find_mpv(),
        libmpv_player::find_libmpv(),
        player::mpv_candidates(),
        libmpv_player::libmpv_candidates(),
    ))
}
