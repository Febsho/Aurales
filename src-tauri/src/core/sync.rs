use crate::core::detail_page::{priority_score, DetailPageCoordinator, SharedResult};
use crate::db::Database;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

const KEYRING_SERVICE: &str = "com.aurales.app.sync";

fn keyring_entry(email: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, email).map_err(|error| error.to_string())
}

pub fn store_password(email: String, password: String) -> Result<(), String> {
    keyring_entry(&email)?
        .set_password(&password)
        .map_err(|error| error.to_string())
}

pub fn load_password(email: String) -> Result<Option<String>, String> {
    match keyring_entry(&email)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn delete_password(email: String) -> Result<(), String> {
    match keyring_entry(&email)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatchRequest {
    pub endpoint: String,
    pub access_token: String,
    pub schema_version: u64,
    pub device_id: String,
    pub device_name: String,
    pub cursor: Option<String>,
    #[serde(default)]
    pub records: Vec<Value>,
    #[serde(default = "default_sync_mode")]
    pub mode: String,
    #[serde(default = "default_sync_priority")]
    pub priority: String,
    pub cancel_group: String,
    pub timeout_ms: Option<u64>,
}

fn default_sync_mode() -> String {
    "sync".to_string()
}
fn default_sync_priority() -> String {
    "interactive".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatchResponse {
    pub cursor: Option<String>,
    #[serde(default)]
    pub records: Vec<Value>,
    #[serde(default)]
    pub stale: bool,
}

pub async fn sync_batch(
    coordinator: &DetailPageCoordinator,
    request: SyncBatchRequest,
) -> Result<SyncBatchResponse, String> {
    if request.access_token.is_empty() || request.cancel_group.is_empty() {
        return Err("Aurales Sync is not configured".to_string());
    }
    let endpoint = sync_endpoint(&request.endpoint)?;
    let body = json!({
        "schemaVersion": request.schema_version,
        "deviceId": request.device_id,
        "deviceName": request.device_name,
        "cursor": request.cursor,
        "records": request.records,
    });
    let key = sync_request_key(&endpoint, &body);
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(30_000).clamp(1_000, 60_000));
    let token = request.access_token;
    let mode = request.mode;
    let response = coordinator
        .run(
            key,
            request.cancel_group,
            priority_score(&request.priority),
            timeout,
            || async move {
                let result = tokio::task::spawn_blocking(move || {
                    post_sync(&endpoint, &token, body, timeout, &mode)
                })
                .await
                .map_err(|error| format!("Sync worker failed: {error}"))??;
                Ok(SharedResult {
                    data: serde_json::to_value(result).map_err(|error| error.to_string())?,
                    cache_status: "bypass".to_string(),
                })
            },
        )
        .await?;
    let mut result: SyncBatchResponse = serde_json::from_value(response.data)
        .map_err(|error| format!("Malformed sync response: {error}"))?;
    result.stale = response.stale;
    Ok(result)
}

fn sync_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = format!("{}/v1/sync", endpoint.trim_end_matches('/'));
    let parsed =
        url::Url::parse(&endpoint).map_err(|_| "Invalid Aurales Sync endpoint".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Invalid Aurales Sync endpoint".to_string());
    }
    Ok(endpoint)
}

fn sync_request_key(endpoint: &str, body: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    endpoint.hash(&mut hasher);
    body.to_string().hash(&mut hasher);
    format!("sync-batch:{:016x}", hasher.finish())
}

fn post_sync(
    endpoint: &str,
    access_token: &str,
    body: Value,
    timeout: Duration,
    mode: &str,
) -> Result<SyncBatchResponse, String> {
    let label = if mode == "download" {
        "Download"
    } else {
        "Sync"
    };
    let response = ureq::AgentBuilder::new()
        .timeout(timeout)
        .build()
        .post(endpoint)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {access_token}"))
        .send_json(body)
        .map_err(|error| match error {
            ureq::Error::Status(status, _) => format!("{label} failed ({status})"),
            other => other.to_string(),
        })?;
    let value = response
        .into_json::<Value>()
        .map_err(|error| format!("Invalid sync response: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Invalid sync response".to_string())?;
    let records = match object.get("records") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(records)) => records.clone(),
        Some(_) => return Err("Invalid sync response records".to_string()),
    };
    Ok(SyncBatchResponse {
        cursor: object
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_string),
        records,
        stale: false,
    })
}

/// Persisted local resume state. This stays deliberately separate from the
/// frontend sync queue: it is the SQLite contract used for Continue Watching.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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

pub fn save_watch_progress(db: &Database, progress: WatchProgress) -> Result<(), String> {
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
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_watch_progress(db: &Database, media_id: String) -> Option<WatchProgress> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_existing_keyring_service_identity() {
        assert_eq!(KEYRING_SERVICE, "com.aurales.app.sync");
    }

    #[test]
    fn builds_only_the_scoped_sync_endpoint_and_stable_non_secret_key() {
        assert_eq!(
            sync_endpoint("https://sync.example/").unwrap(),
            "https://sync.example/v1/sync"
        );
        assert!(sync_endpoint("file:///tmp/sync").is_err());
        let body = json!({"cursor":"1","records":[]});
        assert_eq!(
            sync_request_key("https://sync.example/v1/sync", &body),
            sync_request_key("https://sync.example/v1/sync", &body)
        );
    }

    #[test]
    fn persists_resume_state_with_the_existing_shape() {
        let directory = std::env::temp_dir().join(format!(
            "aurales-sync-core-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let database = Database::new(directory.clone()).unwrap();
        let progress = WatchProgress {
            id: "episode-1".into(),
            media_type: "series".into(),
            media_id: "show-1".into(),
            season: Some(2),
            episode: Some(3),
            progress_seconds: 120.5,
            duration_seconds: 1800.0,
            completed: false,
        };

        save_watch_progress(&database, progress.clone()).unwrap();
        assert_eq!(
            get_watch_progress(&database, "show-1".into()),
            Some(progress)
        );
        assert_eq!(get_watch_progress(&database, "missing".into()), None);

        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
