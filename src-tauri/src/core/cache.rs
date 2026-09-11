use crate::db::Database;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct CacheEntry {
    pub key: String,
    pub value: String,
    pub category: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub updated_at: String,
}

pub fn entry_set(
    db: &Database,
    key: String,
    value: String,
    category: String,
    ttl_seconds: Option<i64>,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let expires_at = ttl_seconds.map(|ttl| {
        chrono::Utc::now()
            .checked_add_signed(chrono::Duration::seconds(ttl))
            .unwrap_or_else(chrono::Utc::now)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    });
    conn.execute(
        "INSERT OR REPLACE INTO cache_entries (key, value, category, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))",
        rusqlite::params![key, value, category, expires_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn metadata_set(db: &Database, key: String, data: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata_cache (cache_key, data_json, cached_at) VALUES (?1, ?2, datetime('now'))",
        [&key, &data],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn metadata_get(db: &Database, key: String) -> Option<String> {
    let conn = db.conn.lock().ok()?;
    conn.query_row(
        "SELECT data_json FROM metadata_cache WHERE cache_key = ?1",
        [&key],
        |row| row.get(0),
    )
    .ok()
}

pub fn clear_metadata(db: &Database) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM metadata_cache", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn entry_get(db: &Database, key: String) -> Option<CacheEntry> {
    let conn = db.conn.lock().ok()?;
    conn.query_row(
        "SELECT key, value, category, created_at, expires_at, updated_at FROM cache_entries WHERE key = ?1",
        rusqlite::params![key],
        cache_entry_from_row,
    )
    .ok()
}

pub fn entry_get_many(db: &Database, keys: Vec<String>) -> Vec<CacheEntry> {
    if keys.is_empty() {
        return vec![];
    }
    let conn = match db.conn.lock() {
        Ok(conn) => conn,
        Err(_) => return vec![],
    };
    let placeholders = std::iter::repeat("?")
        .take(keys.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT key, value, category, created_at, expires_at, updated_at FROM cache_entries WHERE key IN ({placeholders})");
    let mut statement = match conn.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return vec![],
    };
    let rows = match statement.query_map(
        rusqlite::params_from_iter(keys.iter()),
        cache_entry_from_row,
    ) {
        Ok(rows) => rows,
        Err(_) => return vec![],
    };
    rows.filter_map(Result::ok).collect()
}

pub fn clear_category(db: &Database, category: String) -> Result<u64, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM cache_entries WHERE category = ?1",
        rusqlite::params![category],
    )
    .map(|count| count as u64)
    .map_err(|error| error.to_string())
}

pub fn clear_expired(db: &Database) -> Result<u64, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
        [],
    )
    .map(|count| count as u64)
    .map_err(|error| error.to_string())
}

pub fn stats(db: &Database) -> Result<serde_json::Value, String> {
    let conn = db.conn.lock().map_err(|error| error.to_string())?;
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM cache_entries", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let expired: i64 = conn.query_row("SELECT COUNT(*) FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at < datetime('now')", [], |row| row.get(0)).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT category, COUNT(*) FROM cache_entries GROUP BY category")
        .map_err(|error| error.to_string())?;
    let by_category: std::collections::HashMap<String, i64> = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(
        serde_json::json!({ "totalEntries": total, "expiredEntries": expired, "byCategory": by_category }),
    )
}

fn cache_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CacheEntry> {
    Ok(CacheEntry {
        key: row.get(0)?,
        value: row.get(1)?,
        category: row.get(2)?,
        created_at: row.get(3)?,
        expires_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}
