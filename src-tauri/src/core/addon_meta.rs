//! Coarse native addon detail-metadata loading.

use crate::core::detail_page::{priority_score, DetailPageCoordinator, SharedResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const AURALES_USER_AGENT: &str = "Aurales/0.3";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAddonMetaRequest {
    pub addon_url: String,
    pub media_type: String,
    pub id: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub cancel_group: String,
    pub timeout_ms: Option<u64>,
}

fn default_priority() -> String {
    "interactive".to_string()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAddonMetaResponse {
    pub meta: Value,
    pub stale: bool,
}

pub async fn load_addon_meta(
    coordinator: &DetailPageCoordinator,
    request: LoadAddonMetaRequest,
) -> Result<LoadAddonMetaResponse, String> {
    if request.cancel_group.trim().is_empty() {
        return Err("Addon metadata cancel group is required".to_string());
    }
    let url = addon_meta_url(&request.addon_url, &request.media_type, &request.id)?;
    let provider = provider_origin(&url);
    let priority = priority_score(&request.priority);
    let retry_once = matches!(request.priority.as_str(), "interactive" | "playback");
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000));

    let response = coordinator
        .run(
            format!("addon-meta:{url}"),
            request.cancel_group,
            priority,
            timeout,
            || async move {
                let _provider_permit = coordinator.acquire_provider(&provider).await?;
                let meta =
                    tokio::task::spawn_blocking(move || fetch_meta(&url, timeout, retry_once))
                        .await
                        .map_err(|error| format!("Addon metadata worker failed: {error}"))??;
                Ok(SharedResult {
                    data: meta,
                    // The TypeScript detail cache remains the compatibility
                    // authority and encloses this request.
                    cache_status: "bypass".to_string(),
                })
            },
        )
        .await?;

    Ok(LoadAddonMetaResponse {
        meta: response.data,
        stale: response.stale,
    })
}

fn fetch_meta(url: &str, timeout: Duration, retry_once: bool) -> Result<Value, String> {
    let attempts = if retry_once { 2 } else { 1 };
    let mut last_error = None;
    for attempt in 0..attempts {
        match fetch_meta_once(url, timeout) {
            Ok(value) => return parse_meta_response(value),
            Err((error, retryable)) => {
                last_error = Some(error);
                if !retryable || attempt + 1 >= attempts {
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Addon metadata request failed".to_string()))
}

fn fetch_meta_once(url: &str, timeout: Duration) -> Result<Value, (String, bool)> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    agent
        .get(url)
        .set("Accept", "application/json")
        .set("User-Agent", AURALES_USER_AGENT)
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(status, response) => {
                let body = response.into_string().unwrap_or_default();
                (
                    format!("HTTP {status}: {body}"),
                    status == 429 || status >= 500,
                )
            }
            other => (other.to_string(), true),
        })?
        .into_json()
        .map_err(|error| (format!("Invalid JSON response: {error}"), true))
}

fn parse_meta_response(response: Value) -> Result<Value, String> {
    response
        .as_object()
        .and_then(|object| object.get("meta"))
        .filter(|meta| !meta.is_null())
        .cloned()
        .ok_or_else(|| "Addon meta response is empty".to_string())
}

fn addon_meta_url(addon_url: &str, media_type: &str, id: &str) -> Result<String, String> {
    let base = addon_url
        .trim_end_matches("/manifest.json")
        .trim_end_matches('/');
    if base.is_empty() || media_type.is_empty() || id.is_empty() {
        return Err("Addon URL, media type, and metadata ID are required".to_string());
    }
    Ok(format!(
        "{base}/meta/{}/{}.json",
        encode_component(media_type),
        encode_component(id)
    ))
}

fn provider_origin(url: &str) -> String {
    url::Url::parse(url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| url.to_string())
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

    #[test]
    fn meta_url_matches_the_existing_addon_contract() {
        assert_eq!(
            addon_meta_url("https://addon.example/manifest.json", "series", "tt123:1 ?").unwrap(),
            "https://addon.example/meta/series/tt123%3A1%20%3F.json"
        );
    }

    #[test]
    fn meta_response_keeps_the_complete_authoritative_value() {
        let meta = json!({"id":"show", "videos":[{"season":1,"episode":1}]});
        assert_eq!(
            parse_meta_response(json!({"meta":meta.clone()})).unwrap(),
            meta
        );
        assert!(parse_meta_response(json!({})).is_err());
        assert!(parse_meta_response(json!({"meta":null})).is_err());
    }
}
