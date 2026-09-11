//! Native Fribb anime-ID dataset cache and indexed lookup.

use crate::core::cache;
use crate::core::detail_page::{priority_score, DetailPageCoordinator, SharedResult};
use crate::db::Database;
use chrono::{NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

const DATA_URL: &str =
    "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
const CACHE_KEY: &str = "anime-mappings:fribb-mini:v1";
const CACHE_TTL_SECONDS: i64 = 24 * 60 * 60;
const FAILURE_RETRY_SECONDS: i64 = 60;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupAnimeMappingsRequest {
    pub platform: Option<String>,
    pub key: Option<String>,
    #[serde(default)]
    pub count: bool,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub cancel_group: String,
    pub timeout_ms: Option<u64>,
}

fn default_priority() -> String {
    "visible".to_string()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupAnimeMappingsResponse {
    pub entries: Vec<Value>,
    pub count: usize,
    pub stale: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAnimeIdsRequest {
    pub anilist_id: Option<String>,
    pub mal_id: Option<String>,
    pub tvdb_id: Option<String>,
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub content_type: Option<String>,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub cancel_group: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAnimeIdsResponse {
    pub mapping: Option<Value>,
    pub stale: bool,
}

struct AnimeMappingIndex {
    entries: Vec<Value>,
    indexes: HashMap<String, HashMap<String, Vec<usize>>>,
    expires_at: i64,
}

static INDEX: OnceLock<RwLock<Option<Arc<AnimeMappingIndex>>>> = OnceLock::new();
static REFRESHING: AtomicBool = AtomicBool::new(false);
static LAST_FETCH_FAILURE_AT: AtomicI64 = AtomicI64::new(0);

fn index_slot() -> &'static RwLock<Option<Arc<AnimeMappingIndex>>> {
    INDEX.get_or_init(|| RwLock::new(None))
}

pub fn clear_memory_cache() {
    if let Ok(mut index) = index_slot().write() {
        *index = None;
    }
    LAST_FETCH_FAILURE_AT.store(0, Ordering::Relaxed);
}

pub async fn lookup_anime_mappings(
    coordinator: &DetailPageCoordinator,
    db: &Database,
    request: LookupAnimeMappingsRequest,
) -> Result<LookupAnimeMappingsResponse, String> {
    validate_lookup(&request)?;
    if request.cancel_group.trim().is_empty() {
        return Err("Anime mapping cancel group is required".to_string());
    }

    if let Some(index) = index_slot()
        .read()
        .map_err(|error| error.to_string())?
        .clone()
    {
        let stale = index.expires_at <= Utc::now().timestamp();
        if stale {
            refresh_in_background(db.clone());
        }
        return Ok(response_from_index(&index, &request, stale));
    }

    if let Some(entry) = cache::entry_get(db, CACHE_KEY.to_string()) {
        if let Ok(index) = parse_index(&entry.value, cache_expiry(&entry.expires_at)) {
            let index = Arc::new(index);
            let stale = index.expires_at <= Utc::now().timestamp();
            *index_slot().write().map_err(|error| error.to_string())? = Some(index.clone());
            if stale {
                refresh_in_background(db.clone());
            }
            return Ok(response_from_index(&index, &request, stale));
        }
    }

    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000));
    let response = coordinator
        .run(
            "anime-mappings:fribb-mini:load".to_string(),
            request.cancel_group.clone(),
            priority_score(&request.priority),
            timeout,
            || async move {
                let _provider_permit = coordinator
                    .acquire_provider("https://raw.githubusercontent.com")
                    .await?;
                let json = tokio::task::spawn_blocking(fetch_dataset)
                    .await
                    .map_err(|error| format!("Anime mapping worker failed: {error}"))??;
                Ok(SharedResult {
                    data: json,
                    cache_status: "miss".to_string(),
                })
            },
        )
        .await?;

    let serialized = serde_json::to_string(&response.data)
        .map_err(|error| format!("Failed to serialize anime mappings: {error}"))?;
    let expires_at = Utc::now().timestamp() + CACHE_TTL_SECONDS;
    let index = Arc::new(parse_index(&serialized, expires_at)?);
    cache::entry_set(
        db,
        CACHE_KEY.to_string(),
        serialized,
        "anime_mapping".to_string(),
        Some(CACHE_TTL_SECONDS),
    )?;
    *index_slot().write().map_err(|error| error.to_string())? = Some(index.clone());
    Ok(response_from_index(&index, &request, response.stale))
}

pub async fn resolve_anime_ids(
    coordinator: &DetailPageCoordinator,
    db: &Database,
    request: ResolveAnimeIdsRequest,
) -> Result<ResolveAnimeIdsResponse, String> {
    let known = [
        ("mal", request.mal_id.as_deref()),
        ("anilist", request.anilist_id.as_deref()),
        ("tvdb", request.tvdb_id.as_deref()),
        ("tmdb", request.tmdb_id.as_deref()),
        ("imdb", request.imdb_id.as_deref()),
    ];
    let mut stale = false;
    for (platform, key) in known {
        let Some(key) = key.filter(|value| !value.is_empty()) else {
            continue;
        };
        let lookup = lookup_anime_mappings(
            coordinator,
            db,
            LookupAnimeMappingsRequest {
                platform: Some(platform.to_string()),
                key: Some(key.to_string()),
                count: false,
                priority: request.priority.clone(),
                cancel_group: request.cancel_group.clone(),
                timeout_ms: request.timeout_ms,
            },
        )
        .await?;
        stale |= lookup.stale;
        if lookup.entries.is_empty() {
            continue;
        }
        let mapping = if platform == "imdb" {
            lookup.entries.into_iter().next()
        } else {
            select_best_mapping(&lookup.entries, &request)
        };
        return Ok(ResolveAnimeIdsResponse { mapping, stale });
    }
    Ok(ResolveAnimeIdsResponse {
        mapping: None,
        stale,
    })
}

fn select_best_mapping(entries: &[Value], known: &ResolveAnimeIdsRequest) -> Option<Value> {
    let mut best: Option<(&Value, i64)> = None;
    for entry in entries {
        let score = mapping_score(entry, known);
        if best.is_none() || score > best.map(|(_, score)| score).unwrap_or(i64::MIN) {
            best = Some((entry, score));
        }
    }
    best.map(|(entry, _)| entry.clone())
}

fn mapping_score(entry: &Value, known: &ResolveAnimeIdsRequest) -> i64 {
    let Some(entry) = entry.as_object() else {
        return i64::MIN;
    };
    let mut score = 0;
    if let Some(content_type) = known.content_type.as_deref() {
        score += if infer_media_kind(entry) == content_type {
            40
        } else {
            -100
        };
    }
    for (known_id, field, weight) in [
        (known.anilist_id.as_deref(), "anilist_id", 100),
        (known.mal_id.as_deref(), "mal_id", 100),
        (known.tvdb_id.as_deref(), "tvdb_id", 80),
    ] {
        if known_id.is_some_and(|known| id_matches(entry.get(field), known)) {
            score += weight;
        }
    }
    if known.tmdb_id.as_deref().is_some_and(|known_id| {
        extract_tmdb_id(entry.get("themoviedb_id"), known.content_type.as_deref())
            .is_some_and(|value| id_matches(Some(value), known_id))
    }) {
        score += 100;
    }
    if known
        .imdb_id
        .as_deref()
        .is_some_and(|known| value_contains(entry.get("imdb_id"), known))
    {
        score += 100;
    }
    score
}

fn id_matches(value: Option<&Value>, known: &str) -> bool {
    value
        .and_then(value_key)
        .is_some_and(|value| value == strip_id_prefix(known))
}

fn value_key(value: &Value) -> Option<String> {
    match value {
        Value::Number(value) => Some(value.to_string()),
        Value::String(value) => Some(strip_id_prefix(value).to_string()),
        _ => None,
    }
}

fn strip_id_prefix(value: &str) -> &str {
    value
        .rsplit_once(['-', ':'])
        .map(|(_, value)| value)
        .unwrap_or(value)
}

fn value_contains(value: Option<&Value>, known: &str) -> bool {
    match value {
        Some(Value::String(value)) => value == known,
        Some(Value::Array(values)) => values.iter().any(|value| value.as_str() == Some(known)),
        _ => false,
    }
}

fn extract_tmdb_id<'a>(value: Option<&'a Value>, content_type: Option<&str>) -> Option<&'a Value> {
    let value = value?;
    if !value.is_object() {
        return Some(value);
    }
    let object = value.as_object()?;
    match content_type {
        Some("movie") => object.get("movie"),
        Some("series") => object.get("tv"),
        _ => object
            .get("tv")
            .or_else(|| object.get("movie"))
            .or_else(|| object.get("id"))
            .or_else(|| object.get("value")),
    }
}

fn infer_media_kind(entry: &serde_json::Map<String, Value>) -> &str {
    if let Some(tmdb) = entry.get("themoviedb_id").and_then(Value::as_object) {
        if tmdb.get("movie").is_some_and(|value| !value.is_null())
            && !tmdb.get("tv").is_some_and(|value| !value.is_null())
        {
            return "movie";
        }
        if tmdb.get("tv").is_some_and(|value| !value.is_null()) {
            return "series";
        }
    }
    if entry
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("movie") || value.contains("film")
        })
    {
        "movie"
    } else {
        "series"
    }
}

fn validate_lookup(request: &LookupAnimeMappingsRequest) -> Result<(), String> {
    if request.count {
        return Ok(());
    }
    let platform = request.platform.as_deref().unwrap_or_default();
    if !matches!(platform, "mal" | "anilist" | "tvdb" | "tmdb" | "imdb") {
        return Err(format!("Unsupported anime mapping platform: {platform}"));
    }
    if request.key.as_deref().unwrap_or_default().is_empty() {
        return Err("Anime mapping lookup key is required".to_string());
    }
    Ok(())
}

fn response_from_index(
    index: &AnimeMappingIndex,
    request: &LookupAnimeMappingsRequest,
    stale: bool,
) -> LookupAnimeMappingsResponse {
    let entries = if request.count {
        Vec::new()
    } else {
        index
            .indexes
            .get(request.platform.as_deref().unwrap_or_default())
            .and_then(|platform| platform.get(request.key.as_deref().unwrap_or_default()))
            .into_iter()
            .flatten()
            .filter_map(|position| index.entries.get(*position).cloned())
            .collect()
    };
    LookupAnimeMappingsResponse {
        entries,
        count: index.entries.len(),
        stale,
    }
}

fn parse_index(json: &str, expires_at: i64) -> Result<AnimeMappingIndex, String> {
    let entries = serde_json::from_str::<Vec<Value>>(json)
        .map_err(|error| format!("Invalid anime mapping dataset: {error}"))?;
    let mut indexes = ["mal", "anilist", "tvdb", "tmdb", "imdb"]
        .into_iter()
        .map(|platform| (platform.to_string(), HashMap::new()))
        .collect::<HashMap<_, _>>();
    for (position, entry) in entries.iter().enumerate() {
        let Some(object) = entry.as_object() else {
            continue;
        };
        append(&mut indexes, "mal", object.get("mal_id"), position);
        append(&mut indexes, "anilist", object.get("anilist_id"), position);
        append(&mut indexes, "tvdb", object.get("tvdb_id"), position);
        if let Some(tmdb) = object.get("themoviedb_id") {
            if let Some(object) = tmdb.as_object() {
                append(&mut indexes, "tmdb", object.get("tv"), position);
                match object.get("movie") {
                    Some(Value::Array(values)) => {
                        for value in values {
                            append(&mut indexes, "tmdb", Some(value), position);
                        }
                    }
                    value => append(&mut indexes, "tmdb", value, position),
                }
            } else {
                append(&mut indexes, "tmdb", Some(tmdb), position);
            }
        }
        match object.get("imdb_id") {
            Some(Value::Array(values)) => {
                for value in values {
                    append(&mut indexes, "imdb", Some(value), position);
                }
            }
            value => append(&mut indexes, "imdb", value, position),
        }
    }
    Ok(AnimeMappingIndex {
        entries,
        indexes,
        expires_at,
    })
}

fn append(
    indexes: &mut HashMap<String, HashMap<String, Vec<usize>>>,
    platform: &str,
    value: Option<&Value>,
    position: usize,
) {
    let key = match value {
        Some(Value::String(value)) if !value.is_empty() => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => return,
    };
    indexes
        .get_mut(platform)
        .expect("known anime mapping platform")
        .entry(key)
        .or_default()
        .push(position);
}

fn fetch_dataset() -> Result<Value, String> {
    ureq::AgentBuilder::new()
        .timeout(FETCH_TIMEOUT)
        .build()
        .get(DATA_URL)
        .set("Accept", "application/json")
        .set("User-Agent", "Aurales/0.3")
        .call()
        .map_err(|error| error.to_string())?
        .into_json::<Value>()
        .map_err(|error| format!("Invalid anime mapping response: {error}"))
        .and_then(|value| {
            value
                .is_array()
                .then_some(value)
                .ok_or_else(|| "Anime mapping response is not an array".to_string())
        })
}

fn cache_expiry(expires_at: &Option<String>) -> i64 {
    expires_at
        .as_deref()
        .and_then(|value| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").ok())
        .map(|value| value.and_utc().timestamp())
        .unwrap_or(0)
}

fn refresh_in_background(db: Database) {
    let now = Utc::now().timestamp();
    if now - LAST_FETCH_FAILURE_AT.load(Ordering::Relaxed) < FAILURE_RETRY_SECONDS
        || REFRESHING.swap(true, Ordering::AcqRel)
    {
        return;
    }
    std::thread::spawn(move || {
        match fetch_dataset().and_then(|value| {
            let serialized = serde_json::to_string(&value).map_err(|error| error.to_string())?;
            let index = Arc::new(parse_index(
                &serialized,
                Utc::now().timestamp() + CACHE_TTL_SECONDS,
            )?);
            cache::entry_set(
                &db,
                CACHE_KEY.to_string(),
                serialized,
                "anime_mapping".to_string(),
                Some(CACHE_TTL_SECONDS),
            )?;
            *index_slot().write().map_err(|error| error.to_string())? = Some(index);
            Ok(())
        }) {
            Ok(()) => LAST_FETCH_FAILURE_AT.store(0, Ordering::Relaxed),
            Err(_) => LAST_FETCH_FAILURE_AT.store(Utc::now().timestamp(), Ordering::Relaxed),
        }
        REFRESHING.store(false, Ordering::Release);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn indexes_scalar_array_and_typed_tmdb_ids_without_changing_entries() {
        let data = json!([
            {"anilist_id":1,"mal_id":2,"tvdb_id":3,"themoviedb_id":{"tv":4,"movie":[5,6]},"imdb_id":["tt1","tt2"],"season":{"tvdb":1}},
            {"anilist_id":7,"themoviedb_id":8,"imdb_id":"tt1"}
        ]);
        let serialized = data.to_string();
        let index = parse_index(&serialized, 100).unwrap();
        let lookup = |platform: &str, key: &str| {
            response_from_index(
                &index,
                &LookupAnimeMappingsRequest {
                    platform: Some(platform.into()),
                    key: Some(key.into()),
                    count: false,
                    priority: "visible".into(),
                    cancel_group: "test".into(),
                    timeout_ms: None,
                },
                false,
            )
            .entries
        };
        assert_eq!(lookup("tmdb", "4")[0], data[0]);
        assert_eq!(lookup("tmdb", "6")[0], data[0]);
        assert_eq!(
            lookup("imdb", "tt1"),
            vec![data[0].clone(), data[1].clone()]
        );
        assert_eq!(lookup("anilist", "7")[0], data[1]);
    }

    #[test]
    fn validates_platform_and_empty_key() {
        let request = LookupAnimeMappingsRequest {
            platform: Some("unknown".into()),
            key: Some("1".into()),
            count: false,
            priority: "visible".into(),
            cancel_group: "test".into(),
            timeout_ms: None,
        };
        assert!(validate_lookup(&request)
            .unwrap_err()
            .contains("Unsupported"));
    }

    #[test]
    fn best_mapping_matches_content_type_and_known_id_weights_stably() {
        let entries = vec![
            json!({"anilist_id":1,"tvdb_id":10,"themoviedb_id":{"movie":20}}),
            json!({"anilist_id":1,"tvdb_id":11,"themoviedb_id":{"tv":21}}),
        ];
        let known = ResolveAnimeIdsRequest {
            anilist_id: Some("1".into()),
            mal_id: None,
            tvdb_id: Some("11".into()),
            tmdb_id: None,
            imdb_id: None,
            content_type: Some("series".into()),
            priority: "visible".into(),
            cancel_group: "test".into(),
            timeout_ms: None,
        };
        assert_eq!(
            select_best_mapping(&entries, &known),
            Some(entries[1].clone())
        );

        let tie = ResolveAnimeIdsRequest {
            tvdb_id: None,
            content_type: None,
            ..known
        };
        assert_eq!(
            select_best_mapping(&entries, &tie),
            Some(entries[0].clone())
        );
    }
}
