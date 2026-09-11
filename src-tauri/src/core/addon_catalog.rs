//! Coarse native addon-catalog loading.
//!
//! SQLite stale-while-revalidate and card normalization deliberately remain in
//! the compatibility wrapper. Rust owns the provider request, deduplication,
//! timeout, priority, and navigation generation for this operation.

use crate::core::detail_page::{priority_score, DetailPageCoordinator, SharedResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

const AURALES_USER_AGENT: &str = "Aurales/0.3";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct CatalogExtra {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAddonCatalogRequest {
    pub addon_url: String,
    pub media_type: String,
    pub catalog_id: String,
    #[serde(default)]
    pub extra: Vec<CatalogExtra>,
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
pub struct LoadAddonCatalogResponse {
    pub metas: Vec<Value>,
    pub stale: bool,
}

pub async fn load_addon_catalog(
    coordinator: &DetailPageCoordinator,
    request: LoadAddonCatalogRequest,
) -> Result<LoadAddonCatalogResponse, String> {
    if request.cancel_group.trim().is_empty() {
        return Err("Addon catalog cancel group is required".to_string());
    }
    let url = addon_catalog_url(
        &request.addon_url,
        &request.media_type,
        &request.catalog_id,
        &request.extra,
    )?;
    let provider = provider_origin(&url);
    let key = catalog_request_key(&url);
    let priority = priority_score(&request.priority);
    let retry_once = matches!(request.priority.as_str(), "interactive" | "playback");
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000));
    let request_timeout = timeout;

    let response = coordinator
        .run(
            key,
            request.cancel_group,
            priority,
            timeout,
            || async move {
                let _provider_permit = coordinator.acquire_provider(&provider).await?;
                let metas = tokio::task::spawn_blocking(move || {
                    fetch_catalog(&url, request_timeout, retry_once)
                })
                .await
                .map_err(|error| format!("Addon catalog worker failed: {error}"))??;
                Ok(SharedResult {
                    data: json!({ "metas": metas }),
                    // The established TypeScript SQLite cache encloses this
                    // call and remains authoritative during migration.
                    cache_status: "bypass".to_string(),
                })
            },
        )
        .await?;

    let metas = response
        .data
        .get("metas")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Malformed native addon catalog result".to_string())?;
    Ok(LoadAddonCatalogResponse {
        metas,
        stale: response.stale,
    })
}

fn fetch_catalog(url: &str, timeout: Duration, retry_once: bool) -> Result<Vec<Value>, String> {
    let attempts = if retry_once { 2 } else { 1 };
    let mut last_error = None;
    for attempt in 0..attempts {
        match fetch_catalog_once(url, timeout) {
            Ok(value) => return parse_catalog_response(value),
            Err((error, retryable)) => {
                last_error = Some(error);
                if !retryable || attempt + 1 >= attempts {
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Addon catalog request failed".to_string()))
}

fn fetch_catalog_once(url: &str, timeout: Duration) -> Result<Value, (String, bool)> {
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

fn parse_catalog_response(response: Value) -> Result<Vec<Value>, String> {
    let object = response
        .as_object()
        .ok_or_else(|| "Malformed addon catalog response".to_string())?;
    match object.get("metas") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(metas)) => Ok(metas.clone()),
        Some(_) => Err("Malformed addon catalog response: metas is not an array".to_string()),
    }
}

fn addon_catalog_url(
    addon_url: &str,
    media_type: &str,
    catalog_id: &str,
    extra: &[CatalogExtra],
) -> Result<String, String> {
    let base = addon_url
        .trim_end_matches("/manifest.json")
        .trim_end_matches('/');
    if base.is_empty() || media_type.is_empty() || catalog_id.is_empty() {
        return Err("Addon URL, media type, and catalog ID are required".to_string());
    }
    let extras = extra
        .iter()
        .filter(|entry| !entry.value.is_empty())
        .map(|entry| {
            format!(
                "{}={}",
                encode_component(&entry.key),
                encode_component(&entry.value)
            )
        })
        .collect::<Vec<_>>();
    let extra_path = if extras.is_empty() {
        String::new()
    } else {
        format!("/{}", extras.join("&"))
    };
    Ok(format!(
        "{base}/catalog/{}/{}{}.json",
        encode_component(media_type),
        encode_component(catalog_id),
        extra_path
    ))
}

fn provider_origin(url: &str) -> String {
    url::Url::parse(url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| url.to_string())
}

fn catalog_request_key(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("addon-catalog:{:016x}", hasher.finish())
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn url_matches_typescript_and_preserves_extra_order() {
        let extras = vec![
            CatalogExtra {
                key: "search".into(),
                value: "A/B ?".into(),
            },
            CatalogExtra {
                key: "skip".into(),
                value: "20".into(),
            },
            CatalogExtra {
                key: "empty".into(),
                value: "".into(),
            },
        ];
        assert_eq!(
            addon_catalog_url(
                "https://addon.example/manifest.json",
                "series",
                "top now",
                &extras
            )
            .unwrap(),
            "https://addon.example/catalog/series/top%20now/search=A%2FB%20%3F&skip=20.json"
        );
    }

    #[test]
    fn response_preserves_raw_metadata_and_empty_behavior() {
        let raw = json!({"id":"show", "videos":[{"season":1,"episode":1}]});
        assert_eq!(
            parse_catalog_response(json!({"metas":[raw.clone()]})).unwrap(),
            vec![raw]
        );
        assert!(parse_catalog_response(json!({})).unwrap().is_empty());
        assert!(parse_catalog_response(json!({"metas":null}))
            .unwrap()
            .is_empty());
        assert!(parse_catalog_response(json!({"metas":{}})).is_err());
    }

    #[tokio::test]
    async fn duplicate_catalog_operations_share_one_provider_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let server_count = count.clone();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            server_count.fetch_add(1, Ordering::SeqCst);
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            std::thread::sleep(Duration::from_millis(100));
            let body = r#"{"metas":[{"id":"one","name":"One"}]}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let coordinator = DetailPageCoordinator::default();
        let request = || LoadAddonCatalogRequest {
            addon_url: format!("http://{address}/manifest.json"),
            media_type: "series".into(),
            catalog_id: "top".into(),
            extra: vec![],
            priority: "visible".into(),
            cancel_group: "home:top".into(),
            timeout_ms: Some(2_000),
        };
        let (first, second) = tokio::join!(
            load_addon_catalog(&coordinator, request()),
            load_addon_catalog(&coordinator, request())
        );
        assert_eq!(first.unwrap().metas, second.unwrap().metas);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
