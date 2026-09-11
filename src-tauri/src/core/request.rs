use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub ok: bool,
    /// Raw response body; frontend callers retain responsibility for parsing.
    pub body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbeResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub accept_ranges: bool,
    pub content_length: Option<u64>,
    pub final_url: String,
    pub sampled_bytes: u64,
    pub elapsed_ms: u64,
}

pub fn validate_http_url(url: &str) -> Result<(), String> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(())
    } else {
        Err("Only HTTP(S) subtitle URLs are supported.".to_string())
    }
}

pub fn normalize_http_method(method: String) -> Result<String, String> {
    let method = method.to_uppercase();
    match method.as_str() {
        "GET" | "POST" | "PUT" | "DELETE" | "PATCH" => Ok(method),
        _ => Err(format!("Unsupported HTTP method: {method}")),
    }
}

/// Executes the established generic IPC request contract. This intentionally
/// preserves its text-only response and status-error formatting while moving
/// the implementation out of the Tauri command adapter layer.
pub fn request_text(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let mut request = match normalize_http_method(method)?.as_str() {
        "GET" => ureq::get(&url),
        "POST" => ureq::post(&url),
        "PUT" => ureq::put(&url),
        "DELETE" => ureq::delete(&url),
        "PATCH" => ureq::patch(&url),
        _ => unreachable!("normalize_http_method restricts the request verb"),
    };
    for (key, value) in &headers {
        request = request.set(key, value);
    }
    let response = if let Some(body) = body {
        request.send_string(&body)
    } else {
        request.call()
    }
    .map_err(|error| {
        if let ureq::Error::Status(code, response) = error {
            let body = response.into_string().unwrap_or_default();
            format!("{code}:{body}")
        } else {
            format!("HTTP request failed: {error}")
        }
    })?;
    response
        .into_string()
        .map_err(|error| format!("Failed to read response: {error}"))
}

pub fn get_text(url: String) -> Result<String, String> {
    let response = ureq::get(&url)
        .set("Accept", "application/json, text/plain, */*")
        .set("Accept-Language", "en-US,en;q=0.9")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Aurales/1.0 Safari/537.36")
        .call()
        .map_err(|error| format!("HTTP request failed: {error}"))?;
    response
        .into_string()
        .map_err(|error| format!("Failed to read response: {error}"))
}

/// Performs the established bounded range request used to warm direct streams.
/// HTTP failures are returned as probe data, while transport failures remain
/// command errors, exactly matching the previous command implementation.
pub fn probe_stream(url: String, timeout_ms: Option<u64>) -> Result<StreamProbeResponse, String> {
    let started = std::time::Instant::now();
    const SAMPLE_BYTES: u64 = 256 * 1024;
    let agent = ureq::builder()
        .timeout(std::time::Duration::from_millis(
            timeout_ms.unwrap_or(4_000),
        ))
        .build();
    let response = match agent.get(&url)
        .set("Range", &format!("bytes=0-{}", SAMPLE_BYTES - 1))
        .set("Accept", "*/*")
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Aurales/1.0 Safari/537.36")
        .call() {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(format!("Stream probe failed: {error}")),
    };
    let status = response.status();
    let content_type = response.header("Content-Type").map(str::to_owned);
    let accept_ranges = status == 206
        || response
            .header("Accept-Ranges")
            .map(|value| value.to_ascii_lowercase().contains("bytes"))
            .unwrap_or(false);
    let content_length = response
        .header("Content-Range")
        .and_then(|value| value.rsplit('/').next())
        .and_then(|total| total.trim().parse::<u64>().ok())
        .or_else(|| {
            if status == 206 {
                None
            } else {
                response
                    .header("Content-Length")
                    .and_then(|value| value.trim().parse::<u64>().ok())
            }
        });
    let final_url = response.get_url().to_string();
    let mut reader = std::io::Read::take(response.into_reader(), SAMPLE_BYTES);
    let sampled_bytes = std::io::copy(&mut reader, &mut std::io::sink()).unwrap_or(0);
    Ok(StreamProbeResponse {
        status,
        content_type,
        accept_ranges,
        content_length,
        final_url,
        sampled_bytes,
        elapsed_ms: started.elapsed().as_millis().max(1) as u64,
    })
}

pub fn pmdb_request(
    method: String,
    url: String,
    api_key: String,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let request = ureq::request(&method, &url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json");
    proxy_response(request, body, "PMDB")
}

pub fn normalize_pmdb_request(method: String, api_key: String) -> (String, String) {
    (method.to_uppercase(), api_key.trim().to_string())
}

pub fn torbox_request(
    method: String,
    path: String,
    token: String,
    body: Option<String>,
    content_type: String,
) -> Result<ProxyResponse, String> {
    let url = format!("https://api.torbox.app/v1/api{path}");
    let mut request = ureq::request(&method, &url)
        .set("Accept", "application/json")
        .set("Content-Type", &content_type);
    if !token.is_empty() {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    proxy_response(request, body, "TorBox")
}

pub fn normalize_torbox_request(
    method: String,
    path: String,
    token: Option<String>,
    content_type: Option<String>,
) -> Result<(String, String, String, String), String> {
    let method = method.to_uppercase();
    if method != "GET" && method != "POST" {
        return Err("Unsupported TorBox request method".to_string());
    }
    if !path.starts_with('/') || path.contains("..") || path.contains("//") {
        return Err("Invalid TorBox API path".to_string());
    }
    Ok((
        method,
        path,
        token.unwrap_or_default().trim().to_string(),
        content_type.unwrap_or_else(|| "application/json".to_string()),
    ))
}

/// Preserves the established OpenRouter request contract while keeping the
/// network work out of the Tauri command adapter.
pub fn openrouter_chat(api_key: String, request_body: serde_json::Value) -> Result<String, String> {
    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("OpenRouter API key is required.".to_string());
    }
    let response = ureq::post("https://openrouter.ai/api/v1/chat/completions")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .set("HTTP-Referer", "https://github.com/itsrenoria/aurales")
        .set("X-Title", "Aurales Media Player")
        .send_json(request_body)
        .map_err(|error| openrouter_error(error))?;
    response
        .into_string()
        .map_err(|error| format!("Failed to read OpenRouter response: {error}"))
}

pub fn github_release_notes() -> Result<String, String> {
    let mut request = ureq::get("https://api.github.com/repos/Febsho/Aurales/releases/latest")
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "Aurales-App");
    if let Some(token) = option_env!("AURALES_UPDATE_TOKEN") {
        if !token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
    }
    let response = request
        .call()
        .map_err(|error| format!("GitHub release lookup failed: {error}"))?;
    response
        .into_string()
        .map_err(|error| format!("Failed to read GitHub response: {error}"))
}

/// Uses the ytproxy agent so returned Innertube stream URLs remain compatible
/// with the proxy's network path.
pub fn innertube_player(body: String, user_agent: String) -> Result<String, String> {
    let response = crate::ytproxy::agent()
        .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        .set("Content-Type", "application/json")
        .set("User-Agent", &user_agent)
        .send_string(&body)
        .map_err(|error| format!("Innertube request failed: {error}"))?;
    response
        .into_string()
        .map_err(|error| format!("Failed to read Innertube response: {error}"))
}

fn openrouter_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            if body.is_empty() {
                format!("OpenRouter request failed: HTTP {status}")
            } else {
                format!("OpenRouter request failed: HTTP {status}: {body}")
            }
        }
        other => format!("OpenRouter request failed: {other}"),
    }
}

fn proxy_response(
    request: ureq::Request,
    body: Option<String>,
    service: &str,
) -> Result<ProxyResponse, String> {
    let response = match body.as_deref() {
        Some(value) => request.send_string(value),
        None => request.call(),
    };
    match response {
        Ok(response) => Ok(ProxyResponse {
            status: response.status(),
            ok: true,
            body: response.into_string().unwrap_or_default(),
        }),
        Err(ureq::Error::Status(status, response)) => Ok(ProxyResponse {
            status,
            ok: false,
            body: response.into_string().unwrap_or_default(),
        }),
        Err(error) => Err(format!("Network error contacting {service}: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_http_method, normalize_pmdb_request, normalize_torbox_request, openrouter_chat,
        validate_http_url,
    };

    #[test]
    fn allows_only_http_urls() {
        assert!(validate_http_url("https://example.test").is_ok());
        assert!(validate_http_url("http://example.test").is_ok());
        assert!(validate_http_url("file:///tmp/example").is_err());
    }

    #[test]
    fn rejects_empty_openrouter_keys_before_any_network_request() {
        assert_eq!(
            openrouter_chat("  ".into(), serde_json::json!({})),
            Err("OpenRouter API key is required.".into())
        );
    }

    #[test]
    fn keeps_torbox_validation_out_of_command_adapters() {
        assert!(normalize_torbox_request("GET".into(), "/torrents".into(), None, None).is_ok());
        assert!(normalize_torbox_request("PUT".into(), "/torrents".into(), None, None).is_err());
        assert!(normalize_torbox_request("GET".into(), "/../token".into(), None, None).is_err());
    }

    #[test]
    fn normalizes_pmdb_inputs_in_the_request_core() {
        assert_eq!(
            normalize_pmdb_request("post".into(), " key ".into()),
            ("POST".into(), "key".into())
        );
    }

    #[test]
    fn validates_generic_http_methods_once() {
        assert_eq!(normalize_http_method("post".into()), Ok("POST".into()));
        assert!(normalize_http_method("TRACE".into()).is_err());
    }
}
