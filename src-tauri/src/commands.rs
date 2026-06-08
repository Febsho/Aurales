use crate::db::Database;
use serde::{Deserialize, Serialize};
use tauri::State;

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
pub fn launch_mpv(url: String, title: Option<String>, start_time: Option<f64>) -> Result<(), String> {
    let mut args = vec![url];
    if let Some(t) = title {
        args.push(format!("--title={}", t));
    }
    if let Some(s) = start_time {
        args.push(format!("--start={}", s));
    }
    args.push("--force-window=yes".to_string());

    std::process::Command::new("mpv")
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to launch mpv: {}. Make sure mpv is installed and in PATH.", e))?;
    Ok(())
}
