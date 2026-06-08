use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};
use tauri::{Manager, State};

struct NativePlayerState {
    host_hwnd: isize,
    child: Child,
    ipc_path: String,
}

static NATIVE_PLAYER: OnceLock<Mutex<Option<NativePlayerState>>> = OnceLock::new();

fn native_player_state() -> &'static Mutex<Option<NativePlayerState>> {
    NATIVE_PLAYER.get_or_init(|| Mutex::new(None))
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
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [&key],
        |row| row.get(0),
    )
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
pub fn launch_mpv(app: tauri::AppHandle, url: String, title: Option<String>, start_time: Option<f64>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let mut args: Vec<String> = vec![
        "--force-window=yes".to_string(),
        "--fullscreen".to_string(),
        "--osc=yes".to_string(),
        "--osd-bar=yes".to_string(),
        "--input-default-bindings=yes".to_string(),
        "--no-terminal".to_string(),
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
    candidates.push(PathBuf::from("src-tauri").join("binaries").join("mpv-x86_64-pc-windows-msvc.exe"));

    for candidate in candidates {
        if candidate.exists() {
            Command::new(&candidate)
                .args(&args)
                .spawn()
                .map_err(|e| format!("Failed to launch mpv at {}: {}", candidate.display(), e))?;
            return Ok(());
        }
    }

    Err("Failed to launch mpv: bundled mpv executable was not found next to Orynt. Reinstall with the NSIS setup exe or copy mpv.exe beside orynt-app.exe.".to_string())
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
    candidates.push(PathBuf::from("src-tauri").join("binaries").join("mpv-x86_64-pc-windows-msvc.exe"));
    candidates
}

fn find_mpv() -> Option<PathBuf> {
    mpv_candidates().into_iter().find(|candidate| candidate.exists())
}

#[tauri::command]
pub fn launch_embedded_mpv(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    start_time: Option<f64>,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<(), String> {
    stop_embedded_mpv()?;

    #[cfg(target_os = "windows")]
    let hwnd = create_main_window_player_host(
        &app,
        x.unwrap_or(0),
        y.unwrap_or(88),
        width.unwrap_or(1280),
        height.unwrap_or(720),
    )?;

    #[cfg(not(target_os = "windows"))]
    let hwnd: isize = {
        return Err("Embedded mpv playback is only implemented on Windows right now.".to_string());
    };

    launch_mpv_with_window(hwnd, url, title, start_time)
}

#[cfg(target_os = "windows")]
fn create_main_window_player_host(app: &tauri::AppHandle, x: i32, y: i32, width: i32, height: i32) -> Result<isize, String> {
    use windows::core::w;
    use std::ptr::null_mut;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, SetForegroundWindow, SetWindowPos, ShowWindow,
        HWND_TOP, SW_SHOW, SWP_SHOWWINDOW, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
    };

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Main Orynt window was not found.".to_string())?;
    let parent = main
        .hwnd()
        .map_err(|e| format!("Failed to get main window handle: {}", e))?;

    let host = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Orynt Native Player"),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            x,
            y,
            width,
            height,
            Some(parent),
            None,
            None,
            None,
        )
        .map_err(|e| format!("Failed to create native player host inside Orynt: {}", e))?
    };

    if host.0 == null_mut() {
        return Err("Failed to create native player host inside Orynt.".to_string());
    }

    unsafe {
        let _ = SetWindowPos(host, Some(HWND_TOP), 0, 0, width, height, SWP_SHOWWINDOW);
        let _ = ShowWindow(host, SW_SHOW);
        let _ = SetForegroundWindow(HWND(parent.0));
    }

    Ok(host.0 as isize)
}

fn launch_mpv_with_window(hwnd: isize, url: String, title: Option<String>, start_time: Option<f64>) -> Result<(), String> {

    let mpv = find_mpv().ok_or_else(|| {
        "Failed to launch embedded mpv: bundled mpv executable was not found. Reinstall with the NSIS setup exe.".to_string()
    })?;

    let ipc_path = format!(r"\\.\pipe\orynt-mpv-{}", std::process::id());
    let mut args: Vec<String> = vec![
        format!("--wid={}", hwnd),
        "--force-window=immediate".to_string(),
        "--osc=no".to_string(),
        "--osd-bar=no".to_string(),
        "--no-config".to_string(),
        "--cursor-autohide=1000".to_string(),
        "--input-default-bindings=yes".to_string(),
        "--input-builtin-bindings=yes".to_string(),
        format!("--input-ipc-server={}", ipc_path),
        "--no-terminal".to_string(),
        "--keep-open=no".to_string(),
    ];
    if let Some(t) = title {
        args.push(format!("--force-media-title={}", t));
    }
    if let Some(s) = start_time {
        args.push(format!("--start={}", s));
    }
    args.push(url);

    let child = Command::new(&mpv)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to launch embedded mpv at {}: {}", mpv.display(), e))?;

    let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
    *state = Some(NativePlayerState { host_hwnd: hwnd, child, ipc_path });
    Ok(())
}

#[tauri::command]
pub fn mpv_command(command: String, args: Option<Vec<serde_json::Value>>) -> Result<(), String> {
    use std::io::Write;

    let ipc_path = {
        let state = native_player_state().lock().map_err(|e| e.to_string())?;
        state
            .as_ref()
            .map(|player| player.ipc_path.clone())
            .ok_or_else(|| "No native player is running.".to_string())?
    };

    let payload = serde_json::json!({
        "command": std::iter::once(serde_json::Value::String(command))
            .chain(args.unwrap_or_default())
            .collect::<Vec<_>>()
    });

    let mut pipe = std::fs::OpenOptions::new()
        .write(true)
        .open(&ipc_path)
        .map_err(|e| format!("Failed to connect to mpv IPC: {}", e))?;
    writeln!(pipe, "{}", payload).map_err(|e| format!("Failed to send mpv command: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn mpv_get_property(property: String) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};

    let ipc_path = {
        let state = native_player_state().lock().map_err(|e| e.to_string())?;
        state
            .as_ref()
            .map(|player| player.ipc_path.clone())
            .ok_or_else(|| "No native player is running.".to_string())?
    };

    // Open pipe for both read and write (mpv IPC uses PIPE_ACCESS_DUPLEX)
    let mut pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&ipc_path)
        .map_err(|e| format!("Failed to open mpv IPC for query: {}", e))?;

    let req_id: u64 = 9001;
    let cmd = serde_json::json!({
        "command": ["get_property", property],
        "request_id": req_id
    });
    writeln!(pipe, "{}", cmd).map_err(|e| format!("Failed to write property request: {}", e))?;

    // Give mpv a moment to respond
    std::thread::sleep(std::time::Duration::from_millis(200));

    let mut buf = vec![0u8; 131072];
    let n = pipe.read(&mut buf).map_err(|e| format!("Failed to read mpv response: {}", e))?;
    let text = String::from_utf8_lossy(&buf[..n]);

    for line in text.lines() {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if json.get("request_id").and_then(|v| v.as_u64()) == Some(req_id) {
                let err = json.get("error").and_then(|v| v.as_str()).unwrap_or("success");
                if err == "success" {
                    return Ok(json.get("data").cloned().unwrap_or(serde_json::Value::Null));
                }
                return Err(format!("mpv property error: {}", err));
            }
        }
    }

    Err("No matching response received from mpv IPC".to_string())
}

#[tauri::command]
pub fn resize_embedded_mpv(x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    let host_hwnd = {
        let state = native_player_state().lock().map_err(|e| e.to_string())?;
        state
            .as_ref()
            .map(|player| player.host_hwnd)
            .ok_or_else(|| "No native player is running.".to_string())?
    };

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_SHOWWINDOW};
        let _ = SetWindowPos(HWND(host_hwnd as _), Some(HWND_TOP), x, y, width, height, SWP_SHOWWINDOW);
    }

    Ok(())
}

#[tauri::command]
pub fn stop_embedded_mpv() -> Result<(), String> {
    let mut state = native_player_state().lock().map_err(|e| e.to_string())?;
    if let Some(mut player) = state.take() {
        let _ = player.child.kill();
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
            let _ = DestroyWindow(HWND(player.host_hwnd as _));
        }
    }
    Ok(())
}
