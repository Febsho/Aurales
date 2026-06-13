use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Manager, State};

// ─── Discord Rich Presence (local IPC) ──────────────────────────────────────

static DISCORD_PIPE: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();

fn discord_pipe() -> &'static Mutex<Option<std::fs::File>> {
    DISCORD_PIPE.get_or_init(|| Mutex::new(None))
}

const DISCORD_APP_ID: &str = "1514350347227893951";

fn discord_ipc_encode(opcode: u32, payload: &str) -> Vec<u8> {
    let len = payload.len() as u32;
    let mut buf = Vec::with_capacity(8 + payload.len());
    buf.extend_from_slice(&opcode.to_le_bytes());
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(payload.as_bytes());
    buf
}

fn discord_ipc_connect() -> Result<(), String> {
    use std::io::{Read, Write};

    let mut guard = discord_pipe().lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    let pipe_path = r"\\.\pipe\discord-ipc-0";
    let mut pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(pipe_path)
        .map_err(|e| format!("Discord not running or IPC unavailable: {}", e))?;

    let handshake = serde_json::json!({
        "v": 1,
        "client_id": DISCORD_APP_ID
    })
    .to_string();

    pipe.write_all(&discord_ipc_encode(0, &handshake))
        .map_err(|e| format!("Failed to send Discord handshake: {}", e))?;

    // Read response (DISPATCH with READY event)
    let mut header = [0u8; 8];
    pipe.read_exact(&mut header)
        .map_err(|e| format!("Failed to read Discord handshake response: {}", e))?;
    let response_len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    let mut body = vec![0u8; response_len];
    pipe.read_exact(&mut body)
        .map_err(|e| format!("Failed to read Discord response body: {}", e))?;

    *guard = Some(pipe);
    Ok(())
}

fn discord_ipc_set_activity(activity: serde_json::Value) -> Result<(), String> {
    use std::io::Write;

    discord_ipc_connect()?;
    let mut guard = discord_pipe().lock().map_err(|e| e.to_string())?;
    let pipe = guard
        .as_mut()
        .ok_or_else(|| "Discord IPC not connected".to_string())?;

    let nonce = format!("{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let payload = serde_json::json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": activity
        },
        "nonce": nonce
    })
    .to_string();

    if let Err(e) = pipe.write_all(&discord_ipc_encode(1, &payload)) {
        *guard = None;
        return Err(format!("Failed to send Discord activity: {}", e));
    }

    // Drain response (we don't need it but must read to keep pipe healthy)
    // Use non-blocking approach — set pipe to NOWAIT, read what's there, restore
    #[cfg(target_os = "windows")]
    {
        use std::io::Read;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_WAIT};
        use windows::Win32::Foundation::HANDLE;
        let handle = HANDLE(pipe.as_raw_handle());
        let mut mode = PIPE_NOWAIT;
        unsafe { let _ = SetNamedPipeHandleState(handle, Some(&mut mode), None, None); }
        std::thread::sleep(std::time::Duration::from_millis(10));
        let mut drain = [0u8; 4096];
        let _ = pipe.read(&mut drain);
        let mut mode = PIPE_WAIT;
        unsafe { let _ = SetNamedPipeHandleState(handle, Some(&mut mode), None, None); }
    }

    Ok(())
}

fn discord_ipc_clear_activity() -> Result<(), String> {
    discord_ipc_set_activity(serde_json::json!(null))
}

fn discord_ipc_disconnect() {
    if let Ok(mut guard) = discord_pipe().lock() {
        *guard = None;
    }
}

#[tauri::command]
pub fn discord_set_activity(
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
    let mut activity = serde_json::json!({});

    // 0=Playing, 1=Streaming, 2=Listening, 3=Watching, 5=Competing
    activity["type"] = serde_json::json!(activity_type.unwrap_or(0));

    if let Some(d) = details {
        activity["details"] = serde_json::json!(d);
    }
    if let Some(s) = state {
        activity["state"] = serde_json::json!(s);
    }

    let mut assets = serde_json::json!({});
    if let Some(li) = large_image {
        assets["large_image"] = serde_json::json!(li);
    }
    if let Some(lt) = large_text {
        assets["large_text"] = serde_json::json!(lt);
    }
    if let Some(si) = small_image {
        assets["small_image"] = serde_json::json!(si);
    }
    if let Some(st) = small_text {
        assets["small_text"] = serde_json::json!(st);
    }
    if assets != serde_json::json!({}) {
        activity["assets"] = assets;
    }

    let mut timestamps = serde_json::json!({});
    if let Some(ts) = start_timestamp {
        timestamps["start"] = serde_json::json!(ts);
    }
    if let Some(ts) = end_timestamp {
        timestamps["end"] = serde_json::json!(ts);
    }
    if timestamps != serde_json::json!({}) {
        activity["timestamps"] = timestamps;
    }

    discord_ipc_set_activity(activity)
}

#[tauri::command]
pub fn discord_clear_activity() -> Result<(), String> {
    discord_ipc_clear_activity()
}

#[tauri::command]
pub fn discord_disconnect() -> Result<(), String> {
    discord_ipc_disconnect();
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

static MPV_HOST_ORIG_PROC: AtomicIsize = AtomicIsize::new(0);
static MPV_PIPE_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static SIMKL_CALLBACK_ACTIVE: AtomicBool = AtomicBool::new(false);
static ANILIST_CALLBACK_ACTIVE: AtomicBool = AtomicBool::new(false);

struct SimklCallbackGuard;

impl Drop for SimklCallbackGuard {
    fn drop(&mut self) {
        SIMKL_CALLBACK_ACTIVE.store(false, Ordering::SeqCst);
    }
}

struct AnilistCallbackGuard;

impl Drop for AnilistCallbackGuard {
    fn drop(&mut self) {
        ANILIST_CALLBACK_ACTIVE.store(false, Ordering::SeqCst);
    }
}

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

struct NativePlayerState {
    host_hwnd: isize,
    child: Child,
    ipc_path: String,
    writer: Option<std::fs::File>,
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

fn player_debug_log(message: impl Into<String>) {
    let message = message.into();
    eprintln!("{}", message);
    if let Ok(mut state) = player_debug_state().lock() {
        state.logs.push(message);
        if state.logs.len() > 2_000 {
            state.logs.drain(..500);
        }
    }
}

fn stable_stream_hash(value: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn native_player_state() -> &'static Mutex<Option<NativePlayerState>> {
    NATIVE_PLAYER.get_or_init(|| Mutex::new(None))
}

static PROPERTY_CACHE: OnceLock<std::sync::RwLock<std::collections::HashMap<String, serde_json::Value>>> = OnceLock::new();

fn get_property_cache() -> &'static std::sync::RwLock<std::collections::HashMap<String, serde_json::Value>> {
    PROPERTY_CACHE.get_or_init(|| std::sync::RwLock::new(std::collections::HashMap::new()))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WatchProgress {
    pub id: String,
    pub media_type: String,
    pub media_id: String,
    pub season: Option<i32>,
    pub episode: Option<i32>,
    pub progress_seconds: f64,
    pub duration_seconds: f64,
    pub completed: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HomeRow {
    pub id: String,
    pub title: String,
    pub addon_id: Option<String>,
    pub catalog_type: Option<String>,
    pub catalog_id: Option<String>,
    pub layout: String,
    pub enabled: bool,
    pub sort_order: i32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AddonRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub url: String,
    pub manifest_json: String,
    pub enabled: bool,
}

#[tauri::command]
pub fn get_setting(key: String, db: State<Database>) -> Option<String> {
    let conn = db.conn.lock().unwrap();
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |row| {
        row.get(0)
    })
    .ok()
}

#[tauri::command]
pub fn set_setting(key: String, value: String, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [&key, &value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_all_settings(db: State<Database>) -> Vec<Setting> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT key, value FROM settings").unwrap();
    stmt.query_map([], |row| {
        Ok(Setting {
            key: row.get(0)?,
            value: row.get(1)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
pub fn save_watch_progress(progress: WatchProgress, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO watch_progress (id, media_type, media_id, season, episode, progress_seconds, duration_seconds, completed, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
        rusqlite::params![
            progress.id,
            progress.media_type,
            progress.media_id,
            progress.season,
            progress.episode,
            progress.progress_seconds,
            progress.duration_seconds,
            progress.completed as i32,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_watch_progress(media_id: String, db: State<Database>) -> Option<WatchProgress> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id, media_type, media_id, season, episode, progress_seconds, duration_seconds, completed FROM watch_progress WHERE media_id = ?1 ORDER BY updated_at DESC LIMIT 1",
        [&media_id],
        |row| {
            Ok(WatchProgress {
                id: row.get(0)?,
                media_type: row.get(1)?,
                media_id: row.get(2)?,
                season: row.get(3)?,
                episode: row.get(4)?,
                progress_seconds: row.get(5)?,
                duration_seconds: row.get(6)?,
                completed: row.get::<_, i32>(7)? != 0,
            })
        },
    )
    .ok()
}

#[tauri::command]
pub fn save_home_rows(rows: Vec<HomeRow>, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM home_rows", [])
        .map_err(|e| e.to_string())?;
    for row in rows {
        conn.execute(
            "INSERT INTO home_rows (id, title, addon_id, catalog_type, catalog_id, layout, enabled, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                row.id,
                row.title,
                row.addon_id,
                row.catalog_type,
                row.catalog_id,
                row.layout,
                row.enabled as i32,
                row.sort_order,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_home_rows(db: State<Database>) -> Vec<HomeRow> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, title, addon_id, catalog_type, catalog_id, layout, enabled, sort_order FROM home_rows ORDER BY sort_order")
        .unwrap();
    stmt.query_map([], |row| {
        Ok(HomeRow {
            id: row.get(0)?,
            title: row.get(1)?,
            addon_id: row.get(2)?,
            catalog_type: row.get(3)?,
            catalog_id: row.get(4)?,
            layout: row.get(5)?,
            enabled: row.get::<_, i32>(6)? != 0,
            sort_order: row.get(7)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
pub fn save_addon(addon: AddonRecord, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO addons (id, name, version, url, manifest_json, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            addon.id,
            addon.name,
            addon.version,
            addon.url,
            addon.manifest_json,
            addon.enabled as i32,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_addon(addon_id: String, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM addons WHERE id = ?1", [&addon_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_addons(db: State<Database>) -> Vec<AddonRecord> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, name, version, url, manifest_json, enabled FROM addons")
        .unwrap();
    stmt.query_map([], |row| {
        Ok(AddonRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            version: row.get(2)?,
            url: row.get(3)?,
            manifest_json: row.get(4)?,
            enabled: row.get::<_, i32>(5)? != 0,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[tauri::command]
pub fn cache_metadata(key: String, data: String, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO metadata_cache (cache_key, data_json, cached_at) VALUES (?1, ?2, datetime('now'))",
        [&key, &data],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_cached_metadata(key: String, db: State<Database>) -> Option<String> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT data_json FROM metadata_cache WHERE cache_key = ?1",
        [&key],
        |row| row.get(0),
    )
    .ok()
}

#[tauri::command]
pub fn clear_cache(db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM metadata_cache", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_app_metadata(
    media_json: String,
    addon_id: String,
    addon_item_id: String,
    media_type: String,
    db: State<Database>,
) -> Result<(), String> {
    let media: serde_json::Value = serde_json::from_str(&media_json).map_err(|e| e.to_string())?;
    let id = media.get("id").and_then(|v| v.as_str()).ok_or("Missing media id")?;
    let title = media.get("title").and_then(|v| v.as_str()).ok_or("Missing media title")?;
    let updated_at = media.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");
    let text = |key: &str| media.get(key).and_then(|v| v.as_str());
    let integer = |key: &str| media.get(key).and_then(|v| v.as_i64());
    let real = |key: &str| media.get(key).and_then(|v| v.as_f64());
    let genres = media.get("genres").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
    let provider = text("sourceMetadataProvider").unwrap_or("fallback_addon");
    let conn = db.conn.lock().unwrap();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO app_media (id, media_type, title, original_title, localized_title, year, overview, poster, backdrop, logo, genres_json, runtime, rating, age_rating, language, country, tmdb_id, tvdb_id, imdb_id, trakt_id, simkl_id, anilist_id, mal_id, source_metadata_provider, source_addon_id, raw_json, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)",
        rusqlite::params![id, media_type, title, text("originalTitle"), text("localizedTitle"), integer("year"), text("overview"), text("poster"), text("backdrop"), text("logo"), genres, integer("runtime"), real("rating"), text("ageRating"), text("language"), text("country"), integer("tmdbId"), integer("tvdbId"), text("imdbId"), integer("traktId"), integer("simklId"), integer("anilistId"), integer("malId"), provider, addon_id, media_json, updated_at]
    ).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM app_seasons WHERE local_media_id = ?1", [id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM app_episodes WHERE local_media_id = ?1", [id]).map_err(|e| e.to_string())?;
    if let Some(seasons) = media.get("seasons").and_then(|v| v.as_array()) {
        for season in seasons {
            let season_id = season.get("id").and_then(|v| v.as_str()).unwrap_or("");
            tx.execute("INSERT OR REPLACE INTO app_seasons (id, local_media_id, season_number, title, overview, poster, episode_count, raw_json, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", rusqlite::params![season_id, id, season.get("seasonNumber").and_then(|v| v.as_i64()), season.get("title").and_then(|v| v.as_str()), season.get("overview").and_then(|v| v.as_str()), season.get("poster").and_then(|v| v.as_str()), season.get("episodeCount").and_then(|v| v.as_i64()), season.to_string(), updated_at]).map_err(|e| e.to_string())?;
            if let Some(episodes) = season.get("episodes").and_then(|v| v.as_array()) {
                for episode in episodes {
                    tx.execute("INSERT OR REPLACE INTO app_episodes (id, local_media_id, season_id, season_number, episode_number, absolute_episode_number, title, overview, still, air_date, runtime, tmdb_id, tvdb_id, anilist_id, raw_json, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", rusqlite::params![episode.get("id").and_then(|v| v.as_str()), id, season_id, episode.get("seasonNumber").and_then(|v| v.as_i64()), episode.get("episodeNumber").and_then(|v| v.as_i64()), episode.get("absoluteEpisodeNumber").and_then(|v| v.as_i64()), episode.get("title").and_then(|v| v.as_str()), episode.get("overview").and_then(|v| v.as_str()), episode.get("still").and_then(|v| v.as_str()), episode.get("airDate").and_then(|v| v.as_str()), episode.get("runtime").and_then(|v| v.as_i64()), episode.get("tmdbId").and_then(|v| v.as_i64()), episode.get("tvdbId").and_then(|v| v.as_i64()), episode.get("anilistId").and_then(|v| v.as_i64()), episode.to_string(), updated_at]).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    let mapping_id = format!("{}:{}", addon_id, addon_item_id);
    tx.execute("INSERT OR REPLACE INTO addon_media_mappings (id, addon_id, addon_item_id, local_media_id, media_type, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,COALESCE((SELECT created_at FROM addon_media_mappings WHERE id=?1),datetime('now')),datetime('now'))", rusqlite::params![mapping_id, addon_id, addon_item_id, id, media_type]).map_err(|e| e.to_string())?;
    let log_id = format!("{}:{}:{}", addon_id, addon_item_id, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
    tx.execute("INSERT INTO metadata_resolution_log (id, addon_id, addon_item_id, local_media_id, status, reason, created_at) VALUES (?1,?2,?3,?4,?5,?6,datetime('now'))", rusqlite::params![log_id, addon_id, addon_item_id, id, if provider == "fallback_addon" { "fallback" } else { "resolved" }, provider]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_metadata_for_addon(addon_id: String, addon_item_id: String, db: State<Database>) -> Option<String> {
    let conn = db.conn.lock().unwrap();
    conn.query_row("SELECT m.raw_json FROM app_media m JOIN addon_media_mappings a ON a.local_media_id=m.id WHERE a.addon_id=?1 AND a.addon_item_id=?2", rusqlite::params![addon_id, addon_item_id], |row| row.get(0)).ok()
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
    let conn = db.conn.lock().unwrap();
    
    // 1. Try by id first
    if let Some(ref id_str) = id {
        if let Ok(json) = conn.query_row(
            "SELECT raw_json FROM app_media WHERE id = ?1",
            [id_str],
            |row| row.get::<_, String>(0)
        ) {
            return Some(json);
        }
    }
    
    // 2. Try by imdb_id
    if let Some(ref imdb) = imdb_id {
        if !imdb.is_empty() {
            if let Ok(json) = conn.query_row(
                "SELECT raw_json FROM app_media WHERE imdb_id = ?1",
                [imdb],
                |row| row.get::<_, String>(0)
            ) {
                return Some(json);
            }
        }
    }
    
    // 3. Try by tmdb_id
    if let Some(tmdb) = tmdb_id {
        if tmdb > 0 {
            if let Ok(json) = conn.query_row(
                "SELECT raw_json FROM app_media WHERE tmdb_id = ?1",
                [tmdb],
                |row| row.get::<_, String>(0)
            ) {
                return Some(json);
            }
        }
    }
    
    // 4. Try by tvdb_id
    if let Some(tvdb) = tvdb_id {
        if tvdb > 0 {
            if let Ok(json) = conn.query_row(
                "SELECT raw_json FROM app_media WHERE tvdb_id = ?1",
                [tvdb],
                |row| row.get::<_, String>(0)
            ) {
                return Some(json);
            }
        }
    }
    
    // 5. Try by anilist_id
    if let Some(anilist) = anilist_id {
        if anilist > 0 {
            if let Ok(json) = conn.query_row(
                "SELECT raw_json FROM app_media WHERE anilist_id = ?1",
                [anilist],
                |row| row.get::<_, String>(0)
            ) {
                return Some(json);
            }
        }
    }
    
    None
}


#[tauri::command]
pub fn delete_app_metadata(
    addon_id: String,
    addon_item_id: String,
    db: State<Database>,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let local_media_id: Option<String> = tx.query_row(
        "SELECT local_media_id FROM addon_media_mappings WHERE addon_id = ?1 AND addon_item_id = ?2",
        rusqlite::params![addon_id, addon_item_id],
        |row| row.get(0)
    ).ok();

    if let Some(id) = local_media_id {
        tx.execute("DELETE FROM app_seasons WHERE local_media_id = ?1", [&id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM app_episodes WHERE local_media_id = ?1", [&id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM anime_season_mappings WHERE local_media_id = ?1", [&id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM anime_episode_mappings WHERE local_media_id = ?1", [&id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM app_media WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM addon_media_mappings WHERE local_media_id = ?1", [&id]).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hard_reset_anime_metadata(local_media_id: String, db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM app_seasons WHERE local_media_id = ?1", [&local_media_id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM app_episodes WHERE local_media_id = ?1", [&local_media_id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM anime_season_mappings WHERE local_media_id = ?1", [&local_media_id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM anime_episode_mappings WHERE local_media_id = ?1", [&local_media_id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM metadata_resolution_log WHERE local_media_id = ?1", [&local_media_id]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE app_media SET raw_json = NULL, updated_at = NULL WHERE id = ?1", [&local_media_id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_app_metadata(db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute_batch("DELETE FROM app_episodes; DELETE FROM app_seasons; DELETE FROM addon_media_mappings; DELETE FROM app_media; DELETE FROM metadata_resolution_log;").map_err(|e| e.to_string())
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

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("mpv.exe"));
            candidates.push(dir.join("mpv-x86_64-pc-windows-msvc.exe"));
            candidates.push(dir.join("binaries").join("mpv.exe"));
            candidates.push(dir.join("binaries").join("mpv-x86_64-pc-windows-msvc.exe"));
        }
    }
    candidates.push(
        PathBuf::from("src-tauri")
            .join("binaries")
            .join("mpv-x86_64-pc-windows-msvc.exe"),
    );

    for candidate in candidates {
        if candidate.exists() {
            Command::new(&candidate)
                .args(&args)
                .spawn()
                .map_err(|e| format!("Failed to launch mpv at {}: {}", candidate.display(), e))?;
            return Ok(());
        }
    }

    Err("Failed to launch mpv: bundled mpv executable was not found next to Aurales. Reinstall with the NSIS setup exe or copy mpv.exe beside aurales-app.exe.".to_string())
}

fn mpv_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("mpv.exe"));
            candidates.push(dir.join("mpv-x86_64-pc-windows-msvc.exe"));
            candidates.push(dir.join("binaries").join("mpv.exe"));
            candidates.push(dir.join("binaries").join("mpv-x86_64-pc-windows-msvc.exe"));
        }
    }
    candidates.push(
        PathBuf::from("src-tauri")
            .join("binaries")
            .join("mpv-x86_64-pc-windows-msvc.exe"),
    );
    candidates
}

fn find_mpv() -> Option<PathBuf> {
    mpv_candidates()
        .into_iter()
        .find(|candidate| candidate.exists())
}

#[tauri::command]
pub fn launch_embedded_mpv(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    start_time: Option<f64>,
    volume: Option<f64>,
    hwdec_mode: Option<String>,
    cache_buffer_size: Option<String>,
    mpv_cache_secs: Option<u32>,
    mpv_network_timeout: Option<u32>,
    mpv_custom_args: Option<String>,
    _x: Option<i32>,
    _y: Option<i32>,
    _width: Option<i32>,
    _height: Option<i32>,
) -> Result<(), String> {
    stop_embedded_mpv()?;

    #[cfg(target_os = "windows")]
    let hwnd = main_window_hwnd(&app)?;

    #[cfg(not(target_os = "windows"))]
    let hwnd: isize = {
        return Err("Embedded mpv playback is only implemented on Windows right now.".to_string());
    };

    launch_mpv_with_window(
        hwnd,
        url,
        title,
        start_time,
        volume,
        hwdec_mode,
        cache_buffer_size,
        mpv_cache_secs,
        mpv_network_timeout,
        mpv_custom_args,
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

    let mpv = find_mpv().ok_or_else(|| "Bundled mpv executable was not found.".to_string())?;
    let stream_hash = stable_stream_hash(&url);
    let session_id = format!(
        "minimal-{}-{}",
        std::process::id(),
        MPV_PIPE_COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    let hwdec = if hwdec_mode.as_deref() == Some("no") { "no" } else { "auto-safe" };

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
            child,
            ipc_path: session_id.clone(),
            writer: None,
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
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                player_debug_log(format!("[MPV STDERR] session={} {}", stderr_session, line));
            }
        });
    }

    if let Some(stdout) = stdout {
        let stdout_session = session_id.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
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
            if player.ipc_path != monitor_identity {
                return;
            }
            match player.child.try_wait() {
                Ok(Some(status)) => {
                    *state = None;
                    Some(format!("{}", status))
                }
                Ok(None) => None,
                Err(error) => Some(format!("wait-error: {}", error)),
            }
        };
        if let Some(status) = exit {
            player_debug_log(format!("[PLAYER EXIT] session={} status={}", monitor_session, status));
            return;
        }
    });

    Ok(MinimalPlayerInfo { session_id, pid, stream_hash })
}

#[tauri::command]
pub fn minimal_mpv_command(command: String, args: Option<Vec<serde_json::Value>>) -> Result<(), String> {
    let _ = args;
    player_debug_log(format!("[PLAYER CONTROL IGNORED] command={} reason=ipc-disabled-in-isolation", command));
    Err("Player controls are disabled in isolated playback. Use mpv's native controls.".to_string())
}

#[tauri::command]
pub fn stop_minimal_mpv(reason: Option<String>) -> Result<(), String> {
    player_debug_log(format!("[PLAYER STOP CALLED] reason={}", reason.unwrap_or_else(|| "unspecified".to_string())));
    stop_embedded_mpv()
}

#[tauri::command]
pub fn get_minimal_player_state() -> Result<MinimalPlayerStateResponse, String> {
    let (running, pid) = {
        let state = native_player_state().lock().map_err(|e| e.to_string())?;
        (state.is_some(), state.as_ref().map(|player| player.child.id()))
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
    Ok(native_player_state().lock().map_err(|e| e.to_string())?.is_some())
}

#[tauri::command]
pub fn get_player_debug_logs() -> Result<Vec<String>, String> {
    Ok(player_debug_state().lock().map_err(|e| e.to_string())?.logs.clone())
}

#[tauri::command]
pub fn clear_player_debug_logs() -> Result<(), String> {
    player_debug_state().lock().map_err(|e| e.to_string())?.logs.clear();
    Ok(())
}

#[tauri::command]
pub fn select_local_video_file() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Video", &["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"])
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned())
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
) -> Result<(), String> {
    {
        if let Ok(mut cache) = get_property_cache().write() {
            cache.clear();
        }
    }

    let mpv = find_mpv().ok_or_else(|| {
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
    let network_timeout = mpv_network_timeout.unwrap_or(15);

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
        "--cursor-autohide=1000".to_string(),
        "--input-default-bindings=no".to_string(),
        "--input-builtin-bindings=no".to_string(),
        format!("--hwdec={}", hwdec),
        "--vo=gpu-next".to_string(),
        "--gpu-api=d3d11".to_string(),
        "--vd-lavc-dr=yes".to_string(),
        format!("--input-ipc-server={}", ipc_path),
        "--terminal=yes".to_string(),
        "--msg-level=all=warn".to_string(),
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
        format!("--network-timeout={}", network_timeout),
        "--hr-seek=yes".to_string(),
        "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5".to_string(),
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
        for arg in custom.split_whitespace() {
            if !arg.is_empty() {
                args.push(arg.to_string());
            }
        }
    }

    args.push(url);

    let mut child = Command::new(&mpv)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch embedded mpv at {}: {}", mpv.display(), e))?;
    let stderr = child.stderr.take();
    let normal_session = format!("embedded-{}", child.id());

    player_debug_log(format!(
        "[PLAYER START] session={} stream={} hwdec={} args=embedded-buffered",
        normal_session,
        stable_stream_hash(args.last().map(String::as_str).unwrap_or_default()),
        hwdec
    ));

    if let Some(stderr) = stderr {
        let stderr_session = normal_session.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                player_debug_log(format!("[MPV STDERR] session={} {}", stderr_session, line));
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
            let Some(player) = state.as_mut() else { continue };
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
            player_debug_log(format!("[PLAYER EXIT] session={} status={}", monitor_session, status));
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

        if let Ok(mut state_lock) = native_player_state().lock() {
            if let Some(player) = state_lock.as_mut() {
                if player.ipc_path == ipc_path_clone {
                    player.writer = file.try_clone().ok();
                }
            }
        }

        let mut writer = file;
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
        ];
        for cmd in observe_cmds {
            let _ = writeln!(writer, "{}", cmd);
        }

        let reader = std::io::BufReader::new(reader_file);
        use std::io::BufRead;
        for line_res in reader.lines() {
            let line = match line_res {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if json.get("event").and_then(|v| v.as_str()) == Some("property-change") {
                    if let (Some(name), Some(data)) = (
                        json.get("name").and_then(|v| v.as_str()),
                        json.get("data").cloned(),
                    ) {
                        if let Ok(mut cache) = get_property_cache().write() {
                            cache.insert(name.to_string(), data);
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn mpv_command(command: String, args: Option<Vec<serde_json::Value>>) -> Result<(), String> {
    use std::io::Write;

    let payload = serde_json::json!({
        "command": std::iter::once(serde_json::Value::String(command))
            .chain(args.unwrap_or_default())
            .collect::<Vec<_>>()
    });

    let writer_opt = {
        let state = native_player_state().lock().map_err(|e| e.to_string())?;
        match state.as_ref() {
            Some(player) => player.writer.as_ref().and_then(|w| w.try_clone().ok()),
            None => return Err("No player is running".to_string()),
        }
    };

    if let Some(mut writer) = writer_opt {
        if let Err(e) = writeln!(writer, "{}", payload) {
            if let Ok(mut state) = native_player_state().lock() {
                if let Some(player) = state.as_mut() {
                    player.writer = None;
                }
            }
            return Err(format!("Failed to send mpv command: {}", e));
        }
        return Ok(());
    }

    Err("mpv IPC not ready yet".to_string())
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

/// Resize mpv's child HWND to fill (x, y, width, height) within the host window.
///
/// mpv does NOT auto-resize when its parent window is resized (child windows
/// never do on Win32).  We find mpv's window by matching the mpv process ID
/// among the host's child windows, then call SetWindowPos to move/resize it.
#[tauri::command]
pub fn resize_embedded_mpv(x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, RECT};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumChildWindows, GetClientRect, GetWindowThreadProcessId, SetWindowPos,
            SWP_NOACTIVATE, SWP_NOZORDER,
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
                let _ = SetWindowPos(
                    mpv_hwnd,
                    None, // HWND_TOP equivalent (no z-order change with SWP_NOZORDER)
                    x,
                    y,
                    w,
                    h,
                    SWP_NOZORDER | SWP_NOACTIVATE,
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

        let host_hwnd = {
            let state = native_player_state().lock().map_err(|e| e.to_string())?;
            state.as_ref().map(|s| s.host_hwnd).unwrap_or(0)
        };

        if host_hwnd != 0 && MPV_HOST_ORIG_PROC.load(Ordering::SeqCst) == 0 {
            // Safety: host_hwnd came from Tauri's hwnd() which is a valid HWND
            // for the lifetime of the main window.
            let prev = unsafe {
                SetWindowLongPtrW(
                    HWND(host_hwnd as *mut _),
                    GWLP_WNDPROC,
                    transparent_host_proc as *const () as isize,
                )
            };
            if prev != 0 {
                MPV_HOST_ORIG_PROC.store(prev, Ordering::SeqCst);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stop_embedded_mpv() -> Result<(), String> {
    let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
    if let Some(mut player) = state.take() {
        // Restore the original WndProc before killing mpv so the Tauri main
        // window is left in a clean state for the next playback session.
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_WNDPROC};
            let orig = MPV_HOST_ORIG_PROC.swap(0, Ordering::SeqCst);
            if orig != 0 {
                unsafe {
                    SetWindowLongPtrW(HWND(player.host_hwnd as *mut _), GWLP_WNDPROC, orig);
                }
            }
        }
        let _ = player.child.kill();
    }
    Ok(())
}

// ─── Generic PMDB proxy (bypasses CORS) ──────────────────────────────────────
//
// All PMDB API calls go through this command so that the request originates from
// the Rust process (no browser origin header) rather than from the WebView.
// This is identical in spirit to how Simkl auth is handled via ureq.

#[derive(Serialize, Deserialize)]
pub struct PmdbProxyResponse {
    pub status: u16,
    pub ok: bool,
    /// Raw response body as a string. The JS side JSON.parse()s it.
    pub body: String,
}

#[tauri::command]
pub async fn pmdb_request(
    method: String,
    url: String,
    api_key: String,
    body: Option<String>,
) -> Result<PmdbProxyResponse, String> {
    let method = method.to_uppercase();
    let api_key = api_key.trim().to_string();

    tokio::task::spawn_blocking(move || -> Result<PmdbProxyResponse, String> {
        let req = ureq::request(&method, &url)
            .set("Authorization", &format!("Bearer {}", api_key))
            .set("Content-Type", "application/json")
            .set("Accept", "application/json");

        let response = match &body {
            Some(b) => req.send_string(b),
            None => req.call(),
        };

        match response {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.into_string().unwrap_or_default();
                Ok(PmdbProxyResponse {
                    status,
                    ok: true,
                    body: text,
                })
            }
            Err(ureq::Error::Status(status, resp)) => {
                let text = resp.into_string().unwrap_or_default();
                Ok(PmdbProxyResponse {
                    status,
                    ok: false,
                    body: text,
                })
            }
            Err(other) => Err(format!("Network error contacting PMDB: {other}")),
        }
    })
    .await
    .map_err(|e| format!("PMDB request task panicked: {e}"))?
}

fn validate_http_url(url: &str) -> Result<(), String> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(())
    } else {
        Err("Only HTTP(S) subtitle URLs are supported.".to_string())
    }
}

#[tauri::command]
pub async fn http_get_text(url: String) -> Result<String, String> {
    validate_http_url(&url)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let response = ureq::get(&url)
            .set("Accept", "application/json, text/plain, */*")
            .call()
            .map_err(|e| format!("HTTP request failed: {e}"))?;
        response
            .into_string()
            .map_err(|e| format!("Failed to read response: {e}"))
    })
    .await
    .map_err(|e| format!("HTTP request task failed: {e}"))?
}

#[tauri::command]
pub async fn openrouter_chat(api_key: String, request_body: serde_json::Value) -> Result<String, String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("OpenRouter API key is required.".to_string());
    }
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let response = ureq::post("https://openrouter.ai/api/v1/chat/completions")
            .set("Authorization", &format!("Bearer {api_key}"))
            .set("Content-Type", "application/json")
            .set("HTTP-Referer", "https://github.com/itsrenoria/aurales")
            .set("X-Title", "Aurales Media Player")
            .send_json(request_body)
            .map_err(|error| read_ureq_error("OpenRouter", error))?;
        response
            .into_string()
            .map_err(|error| format!("Failed to read OpenRouter response: {error}"))
    })
    .await
    .map_err(|error| format!("OpenRouter request task failed: {error}"))?
}

fn safe_subtitle_name(file_name: &str) -> String {
    let cleaned: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "subtitle.srt".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
pub async fn download_subtitle(url: String, file_name: String) -> Result<String, String> {
    use std::io::Read;
    validate_http_url(&url)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let response = ureq::get(&url)
            .set("Accept", "text/vtt, application/x-subrip, text/plain, */*")
            .call()
            .map_err(|e| format!("Subtitle download failed: {e}"))?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(10 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Failed to read subtitle: {e}"))?;
        if bytes.is_empty() {
            return Err("Subtitle provider returned an empty file.".to_string());
        }
        let dir = std::env::temp_dir().join("aurales-subtitles");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create subtitle cache: {e}"))?;
        let path = dir.join(format!(
            "{}-{}",
            chrono::Utc::now().timestamp_millis(),
            safe_subtitle_name(&file_name)
        ));
        std::fs::write(&path, bytes).map_err(|e| format!("Failed to cache subtitle: {e}"))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Subtitle download task failed: {e}"))?
}

#[tauri::command]
pub async fn write_temp_subtitle(content: String, extension: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        if content.trim().is_empty() {
            return Err("Translated subtitle content is empty.".to_string());
        }
        let extension: String = extension
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(5)
            .collect();
        let extension = if extension.is_empty() {
            "srt"
        } else {
            extension.as_str()
        };
        let dir = std::env::temp_dir().join("aurales-subtitles");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create subtitle cache: {e}"))?;
        let path = dir.join(format!(
            "translated-{}.{}",
            chrono::Utc::now().timestamp_millis(),
            extension
        ));
        std::fs::write(&path, content.as_bytes())
            .map_err(|e| format!("Failed to write translated subtitle: {e}"))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Subtitle write task failed: {e}"))?
}

fn validate_subtitle_cache_path(path: &str) -> Result<std::path::PathBuf, String> {
    let cache_dir = std::env::temp_dir().join("aurales-subtitles");
    let candidate = std::path::PathBuf::from(path);
    if candidate.parent() == Some(cache_dir.as_path()) {
        Ok(candidate)
    } else {
        Err("Subtitle file is outside Aurales' temporary cache.".to_string())
    }
}

#[tauri::command]
pub async fn read_temp_subtitle(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = validate_subtitle_cache_path(&path)?;
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read subtitle cache: {e}"))
    })
    .await
    .map_err(|e| format!("Subtitle read task failed: {e}"))?
}

#[tauri::command]
pub async fn update_temp_subtitle(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = validate_subtitle_cache_path(&path)?;
        std::fs::write(path, content.as_bytes())
            .map_err(|e| format!("Failed to update subtitle cache: {e}"))
    })
    .await
    .map_err(|e| format!("Subtitle update task failed: {e}"))?
}

// ─── Simkl OAuth commands ─────────────────────────────────────────────────────

fn read_ureq_error(provider: &str, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            if body.is_empty() {
                format!("{provider} request failed: HTTP {status}")
            } else {
                format!("{provider} request failed: HTTP {status}: {body}")
            }
        }
        other => format!("{provider} request failed: {other}"),
    }
}

#[tauri::command]
pub async fn request_simkl_pin(client_id: String) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("SIMKL client ID is required".to_string());
    }

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let response = ureq::get("https://api.simkl.com/oauth/pin")
            .query("client_id", &client_id)
            .set("Accept", "application/json")
            .call()
            .map_err(|e| read_ureq_error("Simkl PIN request", e))?;

        let body = response
            .into_string()
            .map_err(|e| format!("Failed to read Simkl PIN response body: {}", e))?;
        let data: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse Simkl PIN response: {e}: {body}"))?;

        if data.get("result").and_then(|v| v.as_str()) != Some("OK") {
            return Err(format!("Simkl PIN request failed: {body}"));
        }

        Ok(body)
    })
    .await
    .map_err(|e| format!("Simkl PIN request task panicked: {}", e))?
}

#[tauri::command]
pub async fn check_simkl_pin(user_code: String, client_id: String) -> Result<String, String> {
    let user_code = user_code.trim().to_string();
    let client_id = client_id.trim().to_string();
    if user_code.is_empty() {
        return Err("SIMKL user code is required".to_string());
    }
    if client_id.is_empty() {
        return Err("SIMKL client ID is required".to_string());
    }

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let url = format!("https://api.simkl.com/oauth/pin/{user_code}");
        let response = ureq::get(&url)
            .query("client_id", &client_id)
            .set("Accept", "application/json")
            .call()
            .map_err(|e| read_ureq_error("Simkl PIN check", e))?;

        let body = response
            .into_string()
            .map_err(|e| format!("Failed to read Simkl PIN check response body: {}", e))?;
        let data: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse Simkl PIN check response: {e}: {body}"))?;

        if data.get("result").and_then(|v| v.as_str()) == Some("OK")
            && data.get("access_token").and_then(|v| v.as_str()).is_some()
        {
            return Ok(serde_json::json!({
                "status": "approved",
                "access_token": data.get("access_token").and_then(|v| v.as_str()).unwrap_or_default(),
                "token_type": "Bearer",
                "scope": data.get("scope").and_then(|v| v.as_str()).unwrap_or_default(),
            })
            .to_string());
        }

        Ok(serde_json::json!({
            "status": "pending",
            "message": data.get("message").and_then(|v| v.as_str()).unwrap_or("Waiting for Simkl approval."),
        })
        .to_string())
    })
    .await
    .map_err(|e| format!("Simkl PIN check task panicked: {}", e))?
}

/// Starts a one-shot TCP server on 127.0.0.1:42814 and waits for Simkl's
/// OAuth redirect.  Returns the `code` query parameter from the redirect URL.
///
/// The frontend calls this *before* opening the browser so the server is
/// ready when Simkl redirects back.
#[tauri::command]
pub async fn start_simkl_callback_server() -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    if SIMKL_CALLBACK_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Simkl authorization is already waiting for a browser callback. Finish the open Simkl tab or wait a moment before trying again.".to_string());
    }
    let _guard = SimklCallbackGuard;

    let listener = TcpListener::bind("127.0.0.1:42814")
        .await
        .map_err(|e| format!("Failed to bind Simkl callback port 42814: {}", e))?;

    let (mut stream, _) =
        tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept())
            .await
            .map_err(|_| "Timed out waiting for Simkl OAuth callback.".to_string())?
            .map_err(|e| format!("Failed to accept Simkl OAuth callback: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read Simkl callback request: {}", e))?;

    let request = String::from_utf8_lossy(&buf[..n]);
    let code = parse_oauth_code(&request)
        .ok_or_else(|| "Simkl OAuth callback did not contain a 'code' parameter".to_string())?;

    // Respond with a friendly page so the user knows they can close the tab.
    let html = concat!(
        "<html><head><meta charset=\"utf-8\"><title>Aurales</title></head>",
        "<body style=\"font-family:sans-serif;text-align:center;padding:60px\">",
        "<h2>Connected to Simkl!</h2>",
        "<p>You can close this tab and return to Aurales.</p>",
        "</body></html>",
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html,
    );
    let _ = stream.write_all(response.as_bytes()).await;

    Ok(code)
}

fn parse_oauth_code(request: &str) -> Option<String> {
    // First line of an HTTP request: "GET /path?code=xxxx&state=... HTTP/1.1"
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        if let Some(value) = param.strip_prefix("code=") {
            return Some(value.to_string());
        }
    }
    None
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
    // Resolved at compile time — will be None if the env var was absent.
    const CLIENT_SECRET: Option<&str> = option_env!("SIMKL_CLIENT_SECRET");
    let client_secret = CLIENT_SECRET
        .ok_or_else(|| {
            "SIMKL_CLIENT_SECRET was not set at build time. \
             Rebuild the app with the env var exported to enable Simkl login."
                .to_string()
        })?
        .to_string();

    let body = serde_json::json!({
        "code":          code,
        "client_id":     client_id,
        "client_secret": client_secret,
        "redirect_uri":  redirect_uri,
        "grant_type":    "authorization_code"
    })
    .to_string();

    // ureq is a blocking HTTP client — run it outside the async executor.
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let response = ureq::post("https://api.simkl.com/oauth/token")
            .set("Content-Type", "application/json")
            .set("Accept", "application/json")
            .send_string(&body)
            .map_err(|e| format!("Simkl token exchange request failed: {}", e))?;
        response
            .into_string()
            .map_err(|e| format!("Failed to read Simkl token response body: {}", e))
    })
    .await
    .map_err(|e| format!("Simkl token exchange task panicked: {}", e))?
}

/// Opens the Simkl OAuth authorisation URL in the user's default browser.
#[tauri::command]
#[allow(deprecated)] // tauri-plugin-shell::Shell::open is deprecated in favour of
                     // tauri-plugin-opener; switch once opener is added to Cargo.toml.
pub fn open_simkl_auth(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(&url, None)
        .map_err(|e| format!("Failed to open Simkl auth URL in browser: {}", e))
}

/// Starts a one-shot TCP server on 127.0.0.1:42814 and waits for AniList's
/// OAuth redirect. Returns the `code` query parameter from the redirect URL.
#[tauri::command]
pub async fn start_anilist_callback_server() -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    if ANILIST_CALLBACK_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("AniList authorization is already waiting for a browser callback. Finish the open AniList tab or wait a moment before trying again.".to_string());
    }
    let _guard = AnilistCallbackGuard;

    let listener = TcpListener::bind("127.0.0.1:42814")
        .await
        .map_err(|e| format!("Failed to bind AniList callback port 42814: {}", e))?;

    let (mut stream, _) =
        tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept())
            .await
            .map_err(|_| "Timed out waiting for AniList OAuth callback.".to_string())?
            .map_err(|e| format!("Failed to accept AniList OAuth callback: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read AniList callback request: {}", e))?;

    let request = String::from_utf8_lossy(&buf[..n]);
    let code = parse_oauth_code(&request)
        .ok_or_else(|| "AniList OAuth callback did not contain a 'code' parameter".to_string())?;

    // Respond with a friendly page so the user knows they can close the tab.
    let html = concat!(
        "<html><head><meta charset=\"utf-8\"><title>Aurales</title></head>",
        "<body style=\"font-family:sans-serif;text-align:center;padding:60px\">",
        "<h2>Connected to AniList!</h2>",
        "<p>You can close this tab and return to Aurales.</p>",
        "</body></html>",
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html,
    );
    let _ = stream.write_all(response.as_bytes()).await;

    Ok(code)
}

/// Exchanges an AniList authorization code for an access token.
#[tauri::command]
pub async fn exchange_anilist_token(
    code: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    let redirect_uri = redirect_uri.trim().to_string();
    let code = code.trim().to_string();

    if client_id.is_empty() {
        return Err("AniList client ID is required".to_string());
    }
    if client_secret.is_empty() {
        return Err("AniList client secret is required".to_string());
    }

    // ureq is a blocking HTTP client — run it outside the async executor.
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let response = ureq::post("https://anilist.co/api/v2/oauth/token")
            .set("Content-Type", "application/x-www-form-urlencoded")
            .set("Accept", "application/json")
            .send_form(&[
                ("grant_type", "authorization_code"),
                ("client_id", &client_id),
                ("client_secret", &client_secret),
                ("redirect_uri", &redirect_uri),
                ("code", &code),
            ])
            .map_err(|e| format!("AniList token exchange request failed: {}", e))?;
        response
            .into_string()
            .map_err(|e| format!("Failed to read AniList token response body: {}", e))
    })
    .await
    .map_err(|e| format!("AniList token exchange task panicked: {}", e))?
}

// ─── Cache Entries ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct CacheEntry {
    pub key: String,
    pub value: String,
    pub category: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub updated_at: String,
}

#[tauri::command]
pub fn cache_entry_set(
    key: String,
    value: String,
    category: String,
    ttl_seconds: Option<i64>,
    db: State<Database>,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let expires_at = ttl_seconds.map(|ttl| {
        format!(
            "{}",
            chrono::Utc::now()
                .checked_add_signed(chrono::Duration::seconds(ttl))
                .unwrap_or_else(chrono::Utc::now)
                .format("%Y-%m-%d %H:%M:%S")
        )
    });
    conn.execute(
        "INSERT OR REPLACE INTO cache_entries (key, value, category, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))",
        rusqlite::params![key, value, category, expires_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cache_entry_get(key: String, db: State<Database>) -> Option<CacheEntry> {
    let conn = db.conn.lock().ok()?;
    conn.query_row(
        "SELECT key, value, category, created_at, expires_at, updated_at FROM cache_entries WHERE key = ?1",
        rusqlite::params![key],
        |row| {
            Ok(CacheEntry {
                key: row.get(0)?,
                value: row.get(1)?,
                category: row.get(2)?,
                created_at: row.get(3)?,
                expires_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .ok()
}

#[tauri::command]
pub fn cache_entry_get_many(keys: Vec<String>, db: State<Database>) -> Vec<CacheEntry> {
    let conn = match db.conn.lock() {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let mut results = Vec::new();
    for key in &keys {
        if let Ok(entry) = conn.query_row(
            "SELECT key, value, category, created_at, expires_at, updated_at FROM cache_entries WHERE key = ?1",
            rusqlite::params![key],
            |row| {
                Ok(CacheEntry {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    category: row.get(2)?,
                    created_at: row.get(3)?,
                    expires_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        ) {
            results.push(entry);
        }
    }
    results
}

#[tauri::command]
pub fn cache_entry_clear_category(category: String, db: State<Database>) -> Result<u64, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count = conn
        .execute(
            "DELETE FROM cache_entries WHERE category = ?1",
            rusqlite::params![category],
        )
        .map_err(|e| e.to_string())?;
    Ok(count as u64)
}

#[tauri::command]
pub fn cache_entry_clear_expired(db: State<Database>) -> Result<u64, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count = conn
        .execute(
            "DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
            rusqlite::params![],
        )
        .map_err(|e| e.to_string())?;
    Ok(count as u64)
}

#[tauri::command]
pub fn cache_entry_stats(db: State<Database>) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let expired: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT category, COUNT(*) FROM cache_entries GROUP BY category")
        .map_err(|e| e.to_string())?;
    let by_category: std::collections::HashMap<String, i64> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::json!({
        "totalEntries": total,
        "expiredEntries": expired,
        "byCategory": by_category,
    }))
}

#[tauri::command]
pub fn get_mpv_info() -> Result<serde_json::Value, String> {
    let path = find_mpv().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "Not Found".to_string());
    let candidates: Vec<String> = mpv_candidates().into_iter().map(|p| p.to_string_lossy().to_string()).collect();
    Ok(serde_json::json!({
        "path": path,
        "candidates": candidates,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    }))
}
