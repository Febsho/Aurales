fn read_ureq_error(provider: &str, error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            if body.is_empty() {
                format!("{provider} request failed: HTTP {status}")
            } else {
                format!("{provider} request failed: HTTP {status}: {body}")
            }
        }
        other => format!("{provider} request failed: {other}"),
    }
}

static SIMKL_CALLBACK_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

struct SimklCallbackGuard;

impl Drop for SimklCallbackGuard {
    fn drop(&mut self) {
        SIMKL_CALLBACK_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

static ANILIST_CALLBACK_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub struct AnilistCallbackGuard;
impl Drop for AnilistCallbackGuard {
    fn drop(&mut self) {
        ANILIST_CALLBACK_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

pub async fn begin_anilist_callback(
) -> Result<(tokio::net::TcpListener, AnilistCallbackGuard), String> {
    if ANILIST_CALLBACK_ACTIVE
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return Err("AniList authorization is already waiting for a browser callback. Finish the open AniList tab or wait a moment before trying again.".to_string());
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:42814")
        .await
        .map_err(|error| format!("Failed to bind callback port 42814: {error}"))?;
    Ok((listener, AnilistCallbackGuard))
}

/// Runs the existing one-shot Simkl localhost callback listener outside the
/// Tauri adapter. The port, timeout, HTML response, and error text are stable.
pub async fn wait_for_simkl_callback() -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    if SIMKL_CALLBACK_ACTIVE
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return Err("Simkl authorization is already waiting for a browser callback. Finish the open Simkl tab or wait a moment before trying again.".to_string());
    }
    let _guard = SimklCallbackGuard;
    let listener = TcpListener::bind("127.0.0.1:42814")
        .await
        .map_err(|error| format!("Failed to bind Simkl callback port 42814: {error}"))?;
    let (mut stream, _) =
        tokio::time::timeout(std::time::Duration::from_secs(60), listener.accept())
            .await
            .map_err(|_| "Timed out waiting for Simkl OAuth callback.".to_string())?
            .map_err(|error| format!("Failed to accept Simkl OAuth callback: {error}"))?;
    let mut buffer = vec![0u8; 4096];
    let count = stream
        .read(&mut buffer)
        .await
        .map_err(|error| format!("Failed to read Simkl callback request: {error}"))?;
    let request = String::from_utf8_lossy(&buffer[..count]);
    let code = parse_oauth_code(&request)
        .ok_or_else(|| "Simkl OAuth callback did not contain a 'code' parameter".to_string())?;
    let html = concat!(
        "<html><head><meta charset=\"utf-8\"><title>Aurales</title></head>",
        "<body style=\"font-family:sans-serif;text-align:center;padding:60px\">",
        "<h2>Connected to Simkl!</h2>",
        "<p>You can close this tab and return to Aurales.</p>",
        "</body></html>",
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(), html,
    );
    let _ = stream.write_all(response.as_bytes()).await;
    Ok(code)
}

/// Extracts a percent-decoded OAuth authorization code from an HTTP callback.
/// Kept independent from Tauri so the callback servers can migrate separately.
pub fn parse_oauth_code(request: &str) -> Option<String> {
    parse_oauth_param(request, "code")
}

pub fn parse_oauth_param(request: &str, key: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    query
        .split('&')
        .find_map(|param| param.strip_prefix(&format!("{key}=")).map(percent_decode))
}

pub async fn write_oauth_success_response(stream: &mut tokio::net::TcpStream, title: &str) {
    use tokio::io::AsyncWriteExt;
    let html = format!(
        "<html><head><meta charset=\"utf-8\"><title>Aurales</title></head>\
         <body style=\"font-family:sans-serif;text-align:center;padding:60px\">\
         <h2>{title}</h2><p>You can close this tab and return to Aurales.</p>\
         </body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(), html,
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

pub async fn accept_oauth_callback(
    listener: &tokio::net::TcpListener,
    timeout_seconds: u64,
    timeout_error: &str,
    accept_error: &str,
) -> Result<tokio::net::TcpStream, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout_seconds),
        listener.accept(),
    )
    .await
    .map_err(|_| timeout_error.to_string())?
    .map(|(stream, _)| stream)
    .map_err(|error| format!("{accept_error}: {error}"))
}

pub async fn read_oauth_callback(
    stream: &mut tokio::net::TcpStream,
    provider: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut buffer = vec![0u8; 4096];
    let count = stream
        .read(&mut buffer)
        .await
        .map_err(|error| format!("Failed to read {provider} callback request: {error}"))?;
    Ok(String::from_utf8_lossy(&buffer[..count]).to_string())
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(hex);
                index += 3;
                continue;
            }
        }
        decoded.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&decoded).to_string()
}

pub fn request_simkl_pin(client_id: String) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("SIMKL client ID is required".to_string());
    }
    let response = ureq::get("https://api.simkl.com/oauth/pin")
        .query("client_id", &client_id)
        .set("Accept", "application/json")
        .call()
        .map_err(|error| read_ureq_error("Simkl PIN request", error))?;
    let body = response
        .into_string()
        .map_err(|error| format!("Failed to read Simkl PIN response body: {error}"))?;
    let data: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Failed to parse Simkl PIN response: {error}: {body}"))?;
    if data.get("result").and_then(|value| value.as_str()) != Some("OK") {
        return Err(format!("Simkl PIN request failed: {body}"));
    }
    Ok(body)
}

pub fn check_simkl_pin(user_code: String, client_id: String) -> Result<String, String> {
    let user_code = user_code.trim().to_string();
    let client_id = client_id.trim().to_string();
    if user_code.is_empty() {
        return Err("SIMKL user code is required".to_string());
    }
    if client_id.is_empty() {
        return Err("SIMKL client ID is required".to_string());
    }
    let url = format!("https://api.simkl.com/oauth/pin/{user_code}");
    let response = ureq::get(&url)
        .query("client_id", &client_id)
        .set("Accept", "application/json")
        .call()
        .map_err(|error| read_ureq_error("Simkl PIN check", error))?;
    let body = response
        .into_string()
        .map_err(|error| format!("Failed to read Simkl PIN check response body: {error}"))?;
    let data: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Failed to parse Simkl PIN check response: {error}: {body}"))?;
    if data.get("result").and_then(|value| value.as_str()) == Some("OK")
        && data
            .get("access_token")
            .and_then(|value| value.as_str())
            .is_some()
    {
        return Ok(serde_json::json!({
            "status": "approved",
            "access_token": data.get("access_token").and_then(|value| value.as_str()).unwrap_or_default(),
            "token_type": "Bearer",
            "scope": data.get("scope").and_then(|value| value.as_str()).unwrap_or_default(),
        })
        .to_string());
    }
    Ok(serde_json::json!({
        "status": "pending",
        "message": data.get("message").and_then(|value| value.as_str()).unwrap_or("Waiting for Simkl approval."),
    })
    .to_string())
}

pub fn fetch_simkl_user(access_token: String, client_id: String) -> Result<String, String> {
    let access_token = access_token.trim().to_string();
    let client_id = client_id.trim().to_string();
    if access_token.is_empty() {
        return Err("SIMKL access token is required".to_string());
    }
    if client_id.is_empty() {
        return Err("SIMKL client ID is required".to_string());
    }
    let response = ureq::get("https://api.simkl.com/users/settings")
        .query("client_id", &client_id)
        .query("app-name", "Aurales")
        .query("app-version", env!("CARGO_PKG_VERSION"))
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("simkl-api-key", &client_id)
        .set("Accept", "application/json")
        .call()
        .map_err(|error| read_ureq_error("Simkl user fetch", error))?;
    response
        .into_string()
        .map_err(|error| format!("Failed to read Simkl user response body: {error}"))
}

pub fn exchange_anilist_token(
    code: String,
    client_id: String,
    redirect_uri: String,
) -> Result<String, String> {
    const CLIENT_SECRET: Option<&str> = option_env!("ANILIST_CLIENT_SECRET");
    let client_id = client_id.trim().to_string();
    let client_secret = CLIENT_SECRET
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "AniList login is not configured in this build. Set \
             ANILIST_CLIENT_SECRET when building Aurales."
                .to_string()
        })?
        .to_string();
    let redirect_uri = redirect_uri.trim().to_string();
    let code = code.trim().to_string();
    if client_id.is_empty() {
        return Err("AniList client ID is required".to_string());
    }
    if client_secret.is_empty() {
        return Err("AniList client secret is required".to_string());
    }
    let result = ureq::post("https://anilist.co/api/v2/oauth/token")
        .set("Accept", "application/json")
        .send_json(ureq::json!({
            "grant_type": "authorization_code",
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "code": code,
        }));
    match result {
        Ok(response) => response
            .into_string()
            .map_err(|error| format!("Failed to read AniList token response body: {error}"))
            .and_then(parse_anilist_access_token),
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(anilist_oauth_error(status, &body))
        }
        Err(error) => Err(format!("AniList token exchange request failed: {error}")),
    }
}

pub fn exchange_simkl_token(
    code: String,
    client_id: String,
    redirect_uri: String,
) -> Result<String, String> {
    const CLIENT_SECRET: Option<&str> = option_env!("SIMKL_CLIENT_SECRET");
    let client_secret = CLIENT_SECRET
        .ok_or_else(|| {
            "SIMKL_CLIENT_SECRET was not set at build time. \
             Rebuild the app with the env var exported to enable Simkl login."
                .to_string()
        })?
        .to_string();
    let body = serde_json::json!({
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code"
    })
    .to_string();
    let response = ureq::post("https://api.simkl.com/oauth/token")
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(&body)
        .map_err(|error| format!("Simkl token exchange request failed: {error}"))?;
    response
        .into_string()
        .map_err(|error| format!("Failed to read Simkl token response body: {error}"))
}

fn parse_anilist_access_token(body: String) -> Result<String, String> {
    let data: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "AniList returned an invalid token response.".to_string())?;
    data.get("access_token")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anilist_oauth_error(200, &body))
}

fn anilist_oauth_error(status: u16, body: &str) -> String {
    if let Ok(data) = serde_json::from_str::<serde_json::Value>(body) {
        let message = data
            .get("message")
            .or_else(|| data.get("error_description"))
            .or_else(|| data.get("error"))
            .and_then(|value| value.as_str());
        if let Some(message) = message {
            return format!("AniList login failed: {message}");
        }
    }
    format!("AniList token exchange failed ({status}).")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_simkl_inputs_before_network_work() {
        assert_eq!(
            request_simkl_pin(" ".into()),
            Err("SIMKL client ID is required".into())
        );
        assert_eq!(
            check_simkl_pin(" ".into(), "client".into()),
            Err("SIMKL user code is required".into())
        );
        assert_eq!(
            fetch_simkl_user("token".into(), " ".into()),
            Err("SIMKL client ID is required".into())
        );
    }

    #[test]
    fn preserves_anilist_token_response_contract() {
        assert_eq!(
            parse_anilist_access_token(r#"{"access_token":"jwt-token"}"#.into()).as_deref(),
            Ok("jwt-token")
        );
        assert_eq!(
            anilist_oauth_error(400, r#"{"message":"Authorization code expired"}"#),
            "AniList login failed: Authorization code expired"
        );
    }

    #[test]
    fn retains_the_simkl_build_time_secret_requirement() {
        if option_env!("SIMKL_CLIENT_SECRET").is_none() {
            assert_eq!(
                exchange_simkl_token("code".into(), "client".into(), "uri".into()),
                Err("SIMKL_CLIENT_SECRET was not set at build time. Rebuild the app with the env var exported to enable Simkl login.".into())
            );
        }
    }

    #[test]
    fn parses_percent_encoded_oauth_callback_parameters() {
        let request = "GET /?code=abc%2B123&state=one+two HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(parse_oauth_code(request).as_deref(), Some("abc+123"));
        assert_eq!(
            parse_oauth_param(request, "state").as_deref(),
            Some("one two")
        );
    }
}
