//! Coarse native stream-candidate loading.
//!
//! The frontend remains the owner of stream preload cache, stale-while-
//! revalidate updates, and addon performance history. This operation only
//! coordinates one live addon fan-out so navigation/playback work can share
//! the native request coordinator without changing those cache semantics.

use crate::core::detail_page::{priority_score, DetailPageCoordinator, SharedResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;

const MAX_CONCURRENT_ADDON_REQUESTS: usize = 4;
const MAX_CONCURRENT_REQUESTS_PER_PROVIDER: usize = 1;
const AURORALES_USER_AGENT: &str = "Aurales/0.3";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAddonDescriptor {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadStreamCandidatesRequest {
    pub media_type: String,
    pub id: String,
    #[serde(default)]
    pub addons: Vec<StreamAddonDescriptor>,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub cancel_group: String,
    pub timeout_ms: Option<u64>,
    pub provider_timeout_ms: Option<u64>,
}

fn default_priority() -> String {
    "playback".to_string()
}

/// This is serialized as a normal `StreamResult` with `addonId` and
/// `addonName` added, preserving the existing TypeScript-facing shape.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamCandidate {
    #[serde(flatten)]
    pub stream: Map<String, Value>,
    pub addon_id: String,
    pub addon_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddonStreamFailure {
    pub addon_id: String,
    pub addon_name: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadStreamCandidatesResponse {
    pub candidates: Vec<StreamCandidate>,
    pub failures: Vec<AddonStreamFailure>,
    pub stale: bool,
}

pub async fn load_stream_candidates(
    coordinator: &DetailPageCoordinator,
    request: LoadStreamCandidatesRequest,
) -> Result<LoadStreamCandidatesResponse, String> {
    let media_type = request.media_type.trim().to_string();
    let id = request.id.trim().to_string();
    if media_type.is_empty() || id.is_empty() {
        return Err("Stream media type and ID are required".to_string());
    }
    if request.cancel_group.trim().is_empty() {
        return Err("Stream cancel group is required".to_string());
    }

    let addons = normalize_addons(request.addons);
    let key = stream_request_key(&media_type, &id, &addons)?;
    let priority = priority_score(&request.priority);
    let retry_once = matches!(request.priority.as_str(), "interactive" | "playback");
    let timeout = Duration::from_millis(
        request
            .provider_timeout_ms
            .unwrap_or(8_000)
            .clamp(1_000, 15_000),
    );
    let operation_timeout =
        Duration::from_millis(request.timeout_ms.unwrap_or(20_000).clamp(1_000, 60_000));

    let response = coordinator
        .run(
            key,
            request.cancel_group,
            priority,
            operation_timeout,
            || async move {
                let (candidates, failures) =
                    fetch_addon_streams(addons, media_type, id, timeout, retry_once).await;
                Ok(SharedResult {
                    data: json!({ "candidates": candidates, "failures": failures }),
                    // StreamPreloadManager deliberately retains its player-
                    // lifecycle cache; Rust owns only the coordinated live
                    // provider fan-out represented by this operation.
                    cache_status: "bypass".to_string(),
                })
            },
        )
        .await?;

    let candidates =
        serde_json::from_value(response.data.get("candidates").cloned().unwrap_or_default())
            .map_err(|error| format!("Failed to decode stream candidates: {error}"))?;
    let failures =
        serde_json::from_value(response.data.get("failures").cloned().unwrap_or_default())
            .map_err(|error| format!("Failed to decode stream addon failures: {error}"))?;
    Ok(LoadStreamCandidatesResponse {
        candidates,
        failures,
        stale: response.stale,
    })
}

fn normalize_addons(addons: Vec<StreamAddonDescriptor>) -> Vec<StreamAddonDescriptor> {
    addons
        .into_iter()
        .filter_map(|addon| {
            let id = addon.id.trim().to_string();
            let name = addon.name.trim().to_string();
            let url = addon.url.trim().to_string();
            (!id.is_empty() && !url.is_empty()).then_some(StreamAddonDescriptor { id, name, url })
        })
        .collect()
}

fn stream_request_key(
    media_type: &str,
    id: &str,
    addons: &[StreamAddonDescriptor],
) -> Result<String, String> {
    let payload = serde_json::to_vec(&(media_type, id, addons))
        .map_err(|error| format!("Failed to serialize stream request: {error}"))?;
    let mut hasher = DefaultHasher::new();
    payload.hash(&mut hasher);
    Ok(format!("stream-candidates:{:016x}", hasher.finish()))
}

async fn fetch_addon_streams(
    addons: Vec<StreamAddonDescriptor>,
    media_type: String,
    id: String,
    timeout: Duration,
    retry_once: bool,
) -> (Vec<StreamCandidate>, Vec<AddonStreamFailure>) {
    let global_limiter = Arc::new(Semaphore::new(MAX_CONCURRENT_ADDON_REQUESTS));
    let provider_limiters = Arc::new(Mutex::new(HashMap::<String, Arc<Semaphore>>::new()));
    let mut tasks = Vec::with_capacity(addons.len());

    for addon in addons {
        let global_limiter = global_limiter.clone();
        let provider_limiters = provider_limiters.clone();
        let media_type = media_type.clone();
        let id = id.clone();
        tasks.push(tokio::spawn(async move {
            let provider_key = addon_provider_key(&addon.url);
            let provider_limiter = {
                let mut limiters = provider_limiters
                    .lock()
                    .expect("provider limiter lock poisoned");
                limiters
                    .entry(provider_key)
                    .or_insert_with(|| {
                        Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS_PER_PROVIDER))
                    })
                    .clone()
            };
            let _global_permit =
                global_limiter
                    .acquire_owned()
                    .await
                    .map_err(|_| AddonStreamFailure {
                        addon_id: addon.id.clone(),
                        addon_name: addon.name.clone(),
                        error: "Stream request coordinator closed".to_string(),
                    })?;
            let _provider_permit =
                provider_limiter
                    .acquire_owned()
                    .await
                    .map_err(|_| AddonStreamFailure {
                        addon_id: addon.id.clone(),
                        addon_name: addon.name.clone(),
                        error: "Stream provider limiter closed".to_string(),
                    })?;
            let addon_for_worker = addon.clone();
            tokio::task::spawn_blocking(move || {
                fetch_one_addon(&addon_for_worker, &media_type, &id, timeout, retry_once)
            })
            .await
            .map_err(|error| AddonStreamFailure {
                addon_id: addon.id.clone(),
                addon_name: addon.name.clone(),
                error: format!("Stream addon worker failed: {error}"),
            })?
            .map_err(|error| AddonStreamFailure {
                addon_id: addon.id,
                addon_name: addon.name,
                error,
            })
        }));
    }

    let mut candidates = Vec::new();
    let mut failures = Vec::new();
    for task in tasks {
        match task.await {
            Ok(Ok(streams)) => candidates.extend(streams),
            Ok(Err(failure)) => failures.push(failure),
            Err(error) => failures.push(AddonStreamFailure {
                addon_id: "unknown".to_string(),
                addon_name: "Unknown addon".to_string(),
                error: format!("Stream addon task failed: {error}"),
            }),
        }
    }
    (candidates, failures)
}

fn fetch_one_addon(
    addon: &StreamAddonDescriptor,
    media_type: &str,
    id: &str,
    timeout: Duration,
    retry_once: bool,
) -> Result<Vec<StreamCandidate>, String> {
    let url = addon_stream_url(&addon.url, media_type, id)?;
    let attempts = if retry_once { 2 } else { 1 };
    let mut last_error = None;
    for _ in 0..attempts {
        match fetch_streams_once(&url, timeout)
            .and_then(|response| parse_stream_response(response, addon))
        {
            Ok(candidates) => return Ok(candidates),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "Stream request failed".to_string()))
}

fn fetch_streams_once(url: &str, timeout: Duration) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    agent
        .get(url)
        .set("Accept", "application/json")
        .set("User-Agent", AURORALES_USER_AGENT)
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(status, response) => {
                let body = response.into_string().unwrap_or_default();
                format!("HTTP {status}: {body}")
            }
            other => other.to_string(),
        })?
        .into_json()
        .map_err(|error| format!("Invalid JSON response: {error}"))
}

fn parse_stream_response(
    response: Value,
    addon: &StreamAddonDescriptor,
) -> Result<Vec<StreamCandidate>, String> {
    let object = response
        .as_object()
        .ok_or_else(|| "Malformed streams response".to_string())?;
    let Some(streams) = object.get("streams") else {
        // Stremio addons are allowed to omit `streams`, which has historically
        // been treated as a valid empty result by getAddonStreams().
        return Ok(Vec::new());
    };
    let streams = streams
        .as_array()
        .ok_or_else(|| "Malformed streams response: streams is not an array".to_string())?;
    Ok(streams
        .iter()
        .filter_map(Value::as_object)
        .filter(|stream| has_playable_stream_field(stream))
        .map(|stream| {
            let mut stream = stream.clone();
            // Match `{ ...stream, addonId, addonName }` in the preload
            // manager: addon-owned identity must replace any addon-provided
            // fields with the same names.
            stream.remove("addonId");
            stream.remove("addonName");
            StreamCandidate {
                stream,
                addon_id: addon.id.clone(),
                addon_name: addon.name.clone(),
            }
        })
        .collect())
}

fn has_playable_stream_field(stream: &Map<String, Value>) -> bool {
    ["url", "externalUrl", "ytId", "infoHash"]
        .iter()
        .any(|key| stream.get(*key).is_some_and(Value::is_string))
}

fn addon_stream_url(addon_url: &str, media_type: &str, id: &str) -> Result<String, String> {
    let base = addon_url
        .trim()
        .trim_end_matches("/manifest.json")
        .trim_end_matches('/');
    if base.is_empty() {
        return Err("Addon URL is required".to_string());
    }
    Ok(format!(
        "{base}/stream/{}/{}.json",
        encode_component(media_type),
        encode_component(id)
    ))
}

fn addon_provider_key(addon_url: &str) -> String {
    match url::Url::parse(addon_url).map(|url| url.origin().ascii_serialization()) {
        Ok(origin) if !origin.is_empty() => origin,
        _ => addon_url.trim().to_string(),
    }
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn addon() -> StreamAddonDescriptor {
        StreamAddonDescriptor {
            id: "com.example.addon".into(),
            name: "Example".into(),
            url: "https://addon.example/manifest.json".into(),
        }
    }

    #[test]
    fn stream_url_matches_the_existing_typescript_endpoint_contract() {
        assert_eq!(
            addon_stream_url("https://addon.example/manifest.json", "series", "tt123:1:2"),
            Ok("https://addon.example/stream/series/tt123%3A1%3A2.json".into())
        );
        assert_eq!(
            addon_stream_url("https://addon.example/", "movie", "a/b ?"),
            Ok("https://addon.example/stream/movie/a%2Fb%20%3F.json".into())
        );
    }

    #[test]
    fn valid_streams_keep_existing_fields_and_receive_addon_identity() {
        let candidates = parse_stream_response(
            json!({"streams": [
                {"name": "Direct", "url": "https://cdn.example/file.mkv", "addonId": "wrong"},
                {"externalUrl": "https://watch.example"},
                {"ytId": "abc"},
                {"infoHash": "0123"},
                {"name": "Not playable"},
                null
            ]}),
            &addon(),
        )
        .unwrap();
        assert_eq!(candidates.len(), 4);
        assert_eq!(candidates[0].stream["url"], "https://cdn.example/file.mkv");
        assert_eq!(candidates[0].addon_id, "com.example.addon");
        assert_eq!(candidates[0].addon_name, "Example");
        assert_eq!(
            serde_json::to_value(&candidates[0]).unwrap()["addonId"],
            "com.example.addon"
        );
    }

    #[test]
    fn empty_and_malformed_response_behavior_matches_strict_addon_fetching() {
        assert!(parse_stream_response(json!({}), &addon())
            .unwrap()
            .is_empty());
        assert!(parse_stream_response(json!({"streams": []}), &addon())
            .unwrap()
            .is_empty());
        assert!(parse_stream_response(json!({"streams": {}}), &addon())
            .unwrap_err()
            .contains("not an array"));
        assert!(parse_stream_response(json!([]), &addon())
            .unwrap_err()
            .contains("Malformed"));
    }

    #[test]
    fn request_keys_include_the_addon_set_but_ignore_navigation_details() {
        let first = stream_request_key("series", "tt1", &[addon()]).unwrap();
        let second = stream_request_key("series", "tt1", &[addon()]).unwrap();
        let other = stream_request_key("series", "tt2", &[addon()]).unwrap();
        assert_eq!(first, second);
        assert_ne!(first, other);
    }
}
