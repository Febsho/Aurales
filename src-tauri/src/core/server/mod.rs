//! First-class media-server providers.
//!
//! Connection metadata and cached catalog rows live in SQLite. Authentication
//! material never does: it is addressed by connection id in the OS keyring.

mod jellyfin;
mod webdav;

use crate::db::Database;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

const KEYRING_SERVICE: &str = "com.aurales.app.server";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveServerConnectionRequest {
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    pub server_url: String,
    pub username: Option<String>,
    pub secret: Option<String>,
    pub auth_mode: String,
    pub base_directory: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConnection {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub server_url: String,
    pub username: Option<String>,
    pub auth_mode: String,
    pub base_directory: Option<String>,
    pub enabled: bool,
    pub status: String,
    pub has_secret: bool,
    #[serde(rename = "statusMessage")]
    pub last_error: Option<String>,
    pub server_name: Option<String>,
    pub user_name: Option<String>,
    #[serde(rename = "lastCheckedAt")]
    pub last_tested_at: Option<String>,
    #[serde(rename = "lastCatalogRefreshAt")]
    pub last_refreshed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub message: Option<String>,
    pub server_name: Option<String>,
    pub user_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCatalog {
    pub connection_id: String,
    pub catalog_id: String,
    pub provider: String,
    pub title: String,
    pub content_type: String,
    pub kind: String,
    pub item_count: u64,
    pub connection_item_count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCatalogItem {
    pub connection_id: String,
    pub source_connection_id: String,
    pub source_item_id: String,
    pub source_addon_id: String,
    pub source_addon_item_id: String,
    pub provider: String,
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub is_anime: bool,
    pub catalog_ids: Vec<String>,
    pub media_type: String,
    pub title: String,
    pub year: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub parent_source_item_id: Option<String>,
    pub tmdb_id: Option<String>,
    pub tvdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub anilist_id: Option<String>,
    pub mal_id: Option<String>,
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    pub raw: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStreamRequest {
    pub media_type: String,
    pub media_id: String,
    pub tmdb_id: Option<Value>,
    pub tvdb_id: Option<Value>,
    pub mal_id: Option<Value>,
    pub anilist_id: Option<Value>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub source_connection_id: Option<String>,
    pub source_item_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStream {
    pub addon_id: String,
    pub addon_name: String,
    pub provider: String,
    pub connection_id: String,
    pub source_item_id: String,
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub filename: Option<String>,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub direct_play: bool,
    pub direct_stream: bool,
    pub transcode: bool,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub resolution: Option<String>,
    pub bitrate: Option<i64>,
    pub hdr: Option<String>,
    pub media_source_id: Option<String>,
    pub audio_tracks: Vec<Value>,
    pub subtitle_tracks: Vec<Value>,
    pub subtitles: Vec<Value>,
    pub behavior_hints: Value,
    pub chapters: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub connection_id: String,
    pub added_or_updated: u64,
    pub removed: u64,
    pub incremental: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredSecret {
    #[serde(alias = "secret")]
    credential: String,
    access_token: Option<String>,
    user_id: Option<String>,
}

pub fn list_connections(db: &Database) -> Result<Vec<ServerConnection>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id,kind,name,server_url,username,auth_mode,base_directory,enabled,status,last_error,server_name,user_name,last_tested_at,last_refreshed_at FROM server_connections ORDER BY name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], connection_from_row)
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .map(|mut item| {
            item.has_secret = load_secret(&item.id).ok().flatten().is_some();
            item
        })
        .collect())
}

pub fn save_connection(
    db: &Database,
    mut request: SaveServerConnectionRequest,
) -> Result<ServerConnection, String> {
    normalize_request(&mut request)?;
    let id = request
        .id
        .clone()
        .unwrap_or_else(|| connection_id(&request));
    let existing_secret = load_secret(&id)?;
    if request
        .secret
        .as_ref()
        .map_or(true, |secret| secret.is_empty())
        && existing_secret.is_none()
    {
        return Err(match request.auth_mode.as_str() {
            "password" => "Jellyfin password is required before saving this connection",
            "token" => "An access token or API key is required before saving this connection",
            _ => "A server credential is required before saving this connection",
        }
        .into());
    }
    if let Some(secret) = request.secret.as_ref().filter(|s| !s.is_empty()) {
        let preserve_token = existing_secret
            .as_ref()
            .filter(|old| old.credential == *secret)
            .and_then(|old| old.access_token.clone());
        let preserve_user = existing_secret.as_ref().and_then(|old| old.user_id.clone());
        store_secret(
            &id,
            &StoredSecret {
                credential: secret.clone(),
                access_token: preserve_token,
                user_id: preserve_user,
            },
        )?;
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO server_connections (id,kind,name,server_url,username,auth_mode,base_directory,enabled,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,datetime('now')) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,server_url=excluded.server_url,username=excluded.username,auth_mode=excluded.auth_mode,base_directory=excluded.base_directory,enabled=excluded.enabled,updated_at=datetime('now')",
        params![id, request.kind, request.name, request.server_url, request.username, request.auth_mode, request.base_directory, request.enabled as i64],
    ).map_err(|e| e.to_string())?;
    drop(conn);
    get_connection(db, &id)?.ok_or_else(|| "Saved server connection was not found".to_string())
}

pub fn remove_connection(db: &Database, id: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM server_catalog_items WHERE connection_id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM server_connections WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    drop(conn);
    delete_secret(id)
}

pub fn set_enabled(db: &Database, id: &str, enabled: bool) -> Result<ServerConnection, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count = conn
        .execute(
            "UPDATE server_connections SET enabled=?2,updated_at=datetime('now') WHERE id=?1",
            params![id, enabled as i64],
        )
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Err("Server connection not found".into());
    }
    drop(conn);
    get_connection(db, id)?.ok_or_else(|| "Server connection not found".into())
}

pub fn test_connection(
    db: Option<&Database>,
    mut request: SaveServerConnectionRequest,
) -> ConnectionTestResult {
    if let Err(message) = normalize_request(&mut request) {
        return failed(message);
    }
    let id = request
        .id
        .clone()
        .unwrap_or_else(|| connection_id(&request));
    let stored = load_secret(&id).ok().flatten();
    let supplied = request.secret.clone().filter(|v| !v.is_empty());
    let secret = supplied.or_else(|| stored.as_ref().map(|v| v.credential.clone()));
    let outcome = match request.kind.as_str() {
        "jellyfin" => jellyfin::test(&request, secret.as_deref()),
        "webdav" => webdav::test(&request, secret.as_deref()),
        _ => Err("Unsupported server kind".to_string()),
    };
    match outcome {
        Ok(identity) => {
            if let Some(token) = identity.access_token.as_ref() {
                let credential = secret.unwrap_or_default();
                let _ = store_secret(
                    &id,
                    &StoredSecret {
                        credential,
                        access_token: Some(token.clone()),
                        user_id: identity.user_id.clone(),
                    },
                );
            }
            if let Some(db) = db {
                let _ = update_status(
                    db,
                    &id,
                    "connected",
                    None,
                    identity.server_name.as_deref(),
                    identity.user_name.as_deref(),
                    true,
                );
            }
            ConnectionTestResult {
                ok: true,
                message: Some("Connection successful".into()),
                server_name: identity.server_name,
                user_name: identity.user_name,
            }
        }
        Err(message) => {
            if let Some(db) = db {
                let _ = update_status(db, &id, "error", Some(&message), None, None, true);
            }
            failed(message)
        }
    }
}

pub fn refresh_catalog(db: &Database, id: &str) -> Result<RefreshResult, String> {
    let connection =
        get_connection(db, id)?.ok_or_else(|| "Server connection not found".to_string())?;
    if !connection.enabled {
        return Err("Server connection is disabled".into());
    }
    let secret = load_secret(id)?.unwrap_or_default();
    let cursor = refresh_cursor(db, id)?;
    let scan = match connection.kind.as_str() {
        "jellyfin" => jellyfin::scan(
            &connection,
            secret.access_token.as_deref().unwrap_or(&secret.credential),
            secret.user_id.as_deref(),
            cursor.as_deref(),
        ),
        "webdav" => webdav::scan(&connection, &secret.credential, cursor.as_deref()),
        _ => Err("Unsupported server kind".into()),
    };
    let scan = match scan {
        Ok(scan) => scan,
        Err(error) => {
            update_status(db, id, "error", Some(&error), None, None, false)?;
            return Err(error);
        }
    };
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut touched = 0u64;
    for item in &scan.items {
        let catalogs = serde_json::to_string(&item.catalog_ids).map_err(|e| e.to_string())?;
        let raw = serde_json::to_string(&item.raw).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO server_catalog_items (connection_id,source_item_id,catalog_ids_json,media_type,title,year,season,episode,parent_source_item_id,tmdb_id,tvdb_id,imdb_id,anilist_id,mal_id,poster,backdrop,updated_marker,raw_json,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,datetime('now')) ON CONFLICT(connection_id,source_item_id) DO UPDATE SET catalog_ids_json=excluded.catalog_ids_json,media_type=excluded.media_type,title=excluded.title,year=excluded.year,season=excluded.season,episode=excluded.episode,parent_source_item_id=excluded.parent_source_item_id,tmdb_id=excluded.tmdb_id,tvdb_id=excluded.tvdb_id,imdb_id=excluded.imdb_id,anilist_id=excluded.anilist_id,mal_id=excluded.mal_id,poster=excluded.poster,backdrop=excluded.backdrop,updated_marker=excluded.updated_marker,raw_json=excluded.raw_json,updated_at=datetime('now')",
            params![id,item.source_item_id,catalogs,item.media_type,item.title,item.year,item.season,item.episode,item.parent_source_item_id,item.tmdb_id,item.tvdb_id,item.imdb_id,item.anilist_id,item.mal_id,item.poster,item.backdrop,item.raw.get("updatedMarker").and_then(Value::as_str),raw]).map_err(|e| e.to_string())?;
        touched += 1;
    }
    let removed = if scan.complete {
        let ids: Vec<&str> = scan
            .items
            .iter()
            .map(|v| v.source_item_id.as_str())
            .collect();
        let mut stmt = tx
            .prepare("SELECT source_item_id FROM server_catalog_items WHERE connection_id=?1")
            .map_err(|e| e.to_string())?;
        let stale: Vec<String> = stmt
            .query_map([id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|v: &String| !ids.contains(&v.as_str()))
            .collect();
        drop(stmt);
        for stale_id in &stale {
            tx.execute(
                "DELETE FROM server_catalog_items WHERE connection_id=?1 AND source_item_id=?2",
                params![id, stale_id],
            )
            .map_err(|e| e.to_string())?;
        }
        stale.len() as u64
    } else {
        0
    };
    tx.execute("UPDATE server_connections SET status='connected',last_error=NULL,last_refreshed_at=datetime('now'),refresh_cursor=?2,updated_at=datetime('now') WHERE id=?1", params![id, scan.cursor]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(RefreshResult {
        connection_id: id.to_string(),
        added_or_updated: touched,
        removed,
        incremental: !scan.complete,
    })
}

pub fn list_catalogs(db: &Database) -> Result<Vec<ServerCatalog>, String> {
    // Release SQLite before loading connection metadata below.  Keeping this
    // guard while calling `list_connections` would attempt to lock the same
    // non-reentrant mutex a second time and freeze the Library route.
    let counts = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT connection_id,catalog_ids_json FROM server_catalog_items WHERE connection_id IN (SELECT id FROM server_connections WHERE enabled=1)").map_err(|e| e.to_string())?;
        let mut counts = std::collections::BTreeMap::<(String, String), u64>::new();
        let mut connection_item_counts = std::collections::HashMap::<String, u64>::new();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows.filter_map(Result::ok) {
            *connection_item_counts.entry(row.0.clone()).or_default() += 1;
            for id in serde_json::from_str::<Vec<String>>(&row.1).unwrap_or_default() {
                *counts.entry((row.0.clone(), id)).or_default() += 1;
            }
        }
        (counts, connection_item_counts)
    };
    let (counts, connection_item_counts) = counts;
    let providers: std::collections::HashMap<_, _> = list_connections(db)?
        .into_iter()
        .map(|v| (v.id, v.kind))
        .collect();
    Ok(counts
        .into_iter()
        .map(|((connection_id, catalog_id), item_count)| ServerCatalog {
            provider: providers.get(&connection_id).cloned().unwrap_or_default(),
            connection_item_count: *connection_item_counts.get(&connection_id).unwrap_or(&0),
            connection_id,
            title: catalog_name(&catalog_id),
            content_type: catalog_media_type(&catalog_id),
            kind: catalog_kind(&catalog_id),
            catalog_id,
            item_count,
        })
        .collect())
}

pub fn catalog_items(
    db: &Database,
    connection_id: &str,
    catalog_id: &str,
    max_items: Option<usize>,
) -> Result<Vec<ServerCatalogItem>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let order_by = match catalog_id {
        "recently-added" => "json_extract(raw_json, '$.DateCreated') DESC",
        "continue-watching" => "json_extract(raw_json, '$.UserData.LastPlayedDate') DESC",
        _ => "title COLLATE NOCASE",
    };
    let sql = format!(
        "SELECT connection_id,source_item_id,catalog_ids_json,media_type,title,year,season,episode,parent_source_item_id,tmdb_id,tvdb_id,imdb_id,anilist_id,mal_id,poster,backdrop,raw_json FROM server_catalog_items WHERE connection_id=?1 AND instr(catalog_ids_json, ?2)>0 ORDER BY {order_by} LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let catalog_token = serde_json::to_string(catalog_id).map_err(|e| e.to_string())?;
    let limit = max_items.unwrap_or(usize::MAX).min(i64::MAX as usize) as i64;
    let rows = stmt
        .query_map(
            params![connection_id, catalog_token, limit],
            catalog_item_from_row,
        )
        .map_err(|e| e.to_string())?;
    let secret = load_secret(connection_id)?.unwrap_or_default();
    let kind = get_connection(db, connection_id)?
        .map(|v| v.kind)
        .unwrap_or_default();
    let mut items: Vec<_> = rows
        .filter_map(Result::ok)
        .filter(|item| item.catalog_ids.iter().any(|id| id == catalog_id))
        .map(|item| authenticate_catalog_artwork(item, &kind, &secret))
        .collect();
    if catalog_id == "recently-added" {
        items.sort_by(|a, b| {
            b.raw
                .get("DateCreated")
                .and_then(Value::as_str)
                .cmp(&a.raw.get("DateCreated").and_then(Value::as_str))
        });
    } else if catalog_id == "continue-watching" {
        items.sort_by(|a, b| {
            b.raw
                .pointer("/UserData/LastPlayedDate")
                .and_then(Value::as_str)
                .cmp(
                    &a.raw
                        .pointer("/UserData/LastPlayedDate")
                        .and_then(Value::as_str),
                )
        });
    }
    Ok(items)
}

pub fn search_catalogs(db: &Database, query: &str) -> Result<Vec<ServerCatalogItem>, String> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let connections = list_connections(db)?;
    let mut result = Vec::new();
    for connection in connections.into_iter().filter(|v| v.enabled) {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt=conn.prepare("SELECT connection_id,source_item_id,catalog_ids_json,media_type,title,year,season,episode,parent_source_item_id,tmdb_id,tvdb_id,imdb_id,anilist_id,mal_id,poster,backdrop,raw_json FROM server_catalog_items WHERE connection_id=?1 AND lower(title) LIKE ?2 ORDER BY title COLLATE NOCASE LIMIT 100").map_err(|e|e.to_string())?;
        let pattern = format!("%{needle}%");
        let rows = stmt
            .query_map(params![connection.id, pattern], catalog_item_from_row)
            .map_err(|e| e.to_string())?;
        let secret = load_secret(&connection.id)?.unwrap_or_default();
        result.extend(
            rows.filter_map(Result::ok)
                .map(|item| authenticate_catalog_artwork(item, &connection.kind, &secret)),
        );
    }
    Ok(result)
}

pub fn streams(db: &Database, request: ServerStreamRequest) -> Result<Vec<ServerStream>, String> {
    let matches = find_stream_items(db, &request)?;
    let mut result = Vec::new();
    for (connection, item) in matches {
        let secret = match load_secret(&connection.id) {
            Ok(Some(v)) => v,
            _ => continue,
        };
        let resolved = match connection.kind.as_str() {
            "jellyfin" => jellyfin::streams(
                &connection,
                secret.access_token.as_deref().unwrap_or(&secret.credential),
                secret.user_id.as_deref(),
                &item.source_item_id,
            ),
            "webdav" => webdav::streams(&connection, &secret.credential, &item),
            _ => continue,
        };
        if let Ok(mut sources) = resolved {
            result.append(&mut sources);
        }
    }
    result.sort_by_key(|v| (v.transcode, !v.direct_play));
    Ok(result)
}

fn find_stream_items(
    db: &Database,
    request: &ServerStreamRequest,
) -> Result<Vec<(ServerConnection, ServerCatalogItem)>, String> {
    let connections = list_connections(db)?;
    let mut result = Vec::new();
    for connection in connections.into_iter().filter(|c| {
        c.enabled
            && request
                .source_connection_id
                .as_ref()
                .map(|v| v == &c.id)
                .unwrap_or(true)
    }) {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT connection_id,source_item_id,catalog_ids_json,media_type,title,year,season,episode,parent_source_item_id,tmdb_id,tvdb_id,imdb_id,anilist_id,mal_id,poster,backdrop,raw_json FROM server_catalog_items WHERE connection_id=?1").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&connection.id], catalog_item_from_row)
            .map_err(|e| e.to_string())?;
        for item in rows.filter_map(Result::ok) {
            let exact = request
                .source_item_id
                .as_ref()
                .map(|v| {
                    v == &item.source_item_id
                        || (item.parent_source_item_id.as_ref() == Some(v)
                            && item.season == request.season
                            && item.episode == request.episode)
                })
                .unwrap_or(false);
            let canonical = (request.media_id == item.id
                || request.media_id == item.source_item_id)
                && (request.media_type == item.item_type
                    || (request.media_type == "series" && item.media_type == "episode"));
            let external = same_value_id(&request.tmdb_id, &item.tmdb_id)
                || same_value_id(&request.tvdb_id, &item.tvdb_id)
                || same_value_id(&request.anilist_id, &item.anilist_id)
                || same_value_id(&request.mal_id, &item.mal_id);
            let episode = item.season == request.season && item.episode == request.episode;
            if exact
                || (canonical && (request.season.is_none() || episode))
                || (external && (request.season.is_none() || episode))
            {
                result.push((connection.clone(), item));
            }
        }
    }
    Ok(result)
}

fn same_value_id(a: &Option<Value>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(Value::String(a)), Some(b)) => a == b,
        (Some(Value::Number(a)), Some(b)) => a.to_string() == *b,
        _ => false,
    }
}

fn get_connection(db: &Database, id: &str) -> Result<Option<ServerConnection>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let result=conn.query_row("SELECT id,kind,name,server_url,username,auth_mode,base_directory,enabled,status,last_error,server_name,user_name,last_tested_at,last_refreshed_at FROM server_connections WHERE id=?1", [id], connection_from_row).optional().map_err(|e| e.to_string())?;
    drop(conn);
    Ok(result.map(|mut item| {
        item.has_secret = load_secret(&item.id).ok().flatten().is_some();
        item
    }))
}

fn connection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServerConnection> {
    Ok(ServerConnection {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        server_url: row.get(3)?,
        username: row.get(4)?,
        auth_mode: row.get(5)?,
        base_directory: row.get(6)?,
        enabled: row.get::<_, i64>(7)? != 0,
        status: row.get(8)?,
        has_secret: false,
        last_error: row.get(9)?,
        server_name: row.get(10)?,
        user_name: row.get(11)?,
        last_tested_at: row.get(12)?,
        last_refreshed_at: row.get(13)?,
    })
}

fn catalog_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServerCatalogItem> {
    let catalogs: String = row.get(2)?;
    let raw: String = row.get(16)?;
    let connection_id: String = row.get(0)?;
    let source_item_id: String = row.get(1)?;
    let media_type: String = row.get(3)?;
    let catalog_ids: Vec<String> = serde_json::from_str(&catalogs).unwrap_or_default();
    let tmdb_id: Option<String> = row.get(9)?;
    let tvdb_id: Option<String> = row.get(10)?;
    let anilist_id: Option<String> = row.get(12)?;
    Ok(ServerCatalogItem {
        source_addon_id: format!("server:{connection_id}"),
        source_addon_item_id: source_item_id.clone(),
        provider: String::new(),
        id: tmdb_id
            .clone()
            .or(tvdb_id.clone())
            .or(anilist_id.clone())
            .unwrap_or_else(|| source_item_id.clone()),
        item_type: if media_type == "episode" {
            "series".into()
        } else {
            media_type.clone()
        },
        is_anime: catalog_ids.iter().any(|v| v == "anime"),
        source_connection_id: connection_id.clone(),
        connection_id,
        source_item_id,
        catalog_ids,
        media_type,
        title: row.get(4)?,
        year: row.get(5)?,
        season: row.get(6)?,
        episode: row.get(7)?,
        parent_source_item_id: row.get(8)?,
        tmdb_id,
        tvdb_id,
        imdb_id: row.get(11)?,
        anilist_id,
        mal_id: row.get(13)?,
        poster: row.get(14)?,
        backdrop: row.get(15)?,
        raw: serde_json::from_str(&raw).unwrap_or(Value::Null),
    })
}

fn normalize_request(request: &mut SaveServerConnectionRequest) -> Result<(), String> {
    request.kind = request.kind.trim().to_ascii_lowercase();
    if !matches!(request.kind.as_str(), "jellyfin" | "webdav") {
        return Err("Server kind must be jellyfin or webdav".into());
    }
    request.name = request.name.trim().to_string();
    if request.name.is_empty() {
        return Err("Connection name is required".into());
    }
    request.server_url = request.server_url.trim().trim_end_matches('/').to_string();
    let parsed = url::Url::parse(&request.server_url)
        .map_err(|_| "A valid HTTP(S) server URL is required".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Server URL must use HTTP or HTTPS".into());
    }
    request.base_directory = request
        .base_directory
        .as_ref()
        .map(|v| v.trim_matches('/').to_string())
        .filter(|v| !v.is_empty());
    Ok(())
}

fn connection_id(request: &SaveServerConnectionRequest) -> String {
    let mut h = DefaultHasher::new();
    request.kind.hash(&mut h);
    request.server_url.hash(&mut h);
    request.username.hash(&mut h);
    format!("server-{:016x}", h.finish())
}

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}
fn store_secret(id: &str, secret: &StoredSecret) -> Result<(), String> {
    keyring_entry(id)?
        .set_password(&serde_json::to_string(secret).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn load_secret(id: &str) -> Result<Option<StoredSecret>, String> {
    match keyring_entry(id)?.get_password() {
        Ok(v) => serde_json::from_str(&v)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn delete_secret(id: &str) -> Result<(), String> {
    match keyring_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn refresh_cursor(db: &Database, id: &str) -> Result<Option<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT refresh_cursor FROM server_connections WHERE id=?1",
        [id],
        |r| r.get(0),
    )
    .optional()
    .map(|v| v.flatten())
    .map_err(|e| e.to_string())
}
fn update_status(
    db: &Database,
    id: &str,
    status: &str,
    error: Option<&str>,
    server_name: Option<&str>,
    user_name: Option<&str>,
    tested: bool,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE server_connections SET status=?2,last_error=?3,server_name=COALESCE(?4,server_name),user_name=COALESCE(?5,user_name),last_tested_at=CASE WHEN ?6 THEN datetime('now') ELSE last_tested_at END,updated_at=datetime('now') WHERE id=?1",params![id,status,error,server_name,user_name,tested]).map_err(|e|e.to_string())?;
    Ok(())
}
fn failed(message: String) -> ConnectionTestResult {
    ConnectionTestResult {
        ok: false,
        message: Some(message),
        server_name: None,
        user_name: None,
    }
}
fn catalog_name(id: &str) -> String {
    match id {
        "movies" => "Movies",
        "series" => "TV Shows",
        "anime" => "Anime",
        "episodes" => "Episodes",
        "continue-watching" => "Continue Watching",
        "recently-added" => "Recently Added",
        "favorites" => "Favorites",
        "collections" => "Collections",
        _ if id.starts_with("collection:") => id.trim_start_matches("collection:"),
        _ if id.starts_with("library:") => id.trim_start_matches("library:"),
        _ => id,
    }
    .to_string()
}
fn catalog_media_type(id: &str) -> String {
    match id {
        "movies" => "movie",
        "series" => "series",
        "anime" => "anime",
        _ => "mixed",
    }
    .into()
}
fn catalog_kind(id: &str) -> String {
    match id {
        "continue-watching" => "continue-watching",
        "recently-added" => "recently-added",
        "favorites" => "favorites",
        "collections" => "collection",
        _ if id.starts_with("collection:") => "collection",
        _ => "library",
    }
    .into()
}
fn authenticate_catalog_artwork(
    mut item: ServerCatalogItem,
    kind: &str,
    secret: &StoredSecret,
) -> ServerCatalogItem {
    item.provider = kind.to_string();
    if kind == "jellyfin" {
        let token = secret.access_token.as_deref().unwrap_or(&secret.credential);
        if !token.is_empty() {
            for value in [&mut item.poster, &mut item.backdrop] {
                if let Some(path) = value.as_ref() {
                    if path.starts_with('/') {
                        *value = Some(format!(
                            "{}{}{}api_key={}",
                            item.raw
                                .get("serverUrl")
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                            path,
                            if path.contains('?') { "&" } else { "?" },
                            url::form_urlencoded::byte_serialize(token.as_bytes())
                                .collect::<String>()
                        ));
                    }
                }
            }
        }
    }
    item
}

pub(super) struct Identity {
    pub server_name: Option<String>,
    pub user_name: Option<String>,
    pub access_token: Option<String>,
    pub user_id: Option<String>,
}
pub(super) struct ScanResult {
    pub items: Vec<ServerCatalogItem>,
    pub cursor: Option<String>,
    pub complete: bool,
}
pub(super) fn now_cursor() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_and_normalizes_server_urls() {
        let mut r = SaveServerConnectionRequest {
            id: None,
            kind: "JELLYFIN".into(),
            name: " Home ".into(),
            server_url: "https://media.example/".into(),
            username: None,
            secret: None,
            auth_mode: "token".into(),
            base_directory: None,
            enabled: true,
        };
        normalize_request(&mut r).unwrap();
        assert_eq!(r.kind, "jellyfin");
        assert_eq!(r.server_url, "https://media.example");
    }
    #[test]
    fn refuses_non_http_media_endpoints() {
        let mut r = SaveServerConnectionRequest {
            id: None,
            kind: "webdav".into(),
            name: "x".into(),
            server_url: "file:///tmp".into(),
            username: None,
            secret: None,
            auth_mode: "password".into(),
            base_directory: None,
            enabled: true,
        };
        assert!(normalize_request(&mut r).is_err());
    }
}
