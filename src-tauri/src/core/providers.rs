use std::io::Read;

const PROVIDER_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_OAUTH_REQUEST_BYTES: usize = 16 * 1024;
const OAUTH_HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_PROVIDER_RESPONSE_BYTES: u64 = 64 * 1024;

fn read_provider_body(response: ureq::Response) -> Result<String, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_PROVIDER_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read provider response body: {error}"))?;
    if bytes.len() as u64 > MAX_PROVIDER_RESPONSE_BYTES {
        return Err("Provider response exceeded the 64 KiB limit".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_ureq_error(provider: &str, error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let body = read_provider_body(response).unwrap_or_default();
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
static SIMKL_CALLBACK_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

struct SimklCallbackGuard;

impl Drop for SimklCallbackGuard {
    fn drop(&mut self) {
        if let Ok(mut cancel) = SIMKL_CALLBACK_CANCEL.lock() {
            *cancel = None;
        }
        SIMKL_CALLBACK_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

pub async fn cancel_simkl_callback() -> Result<(), String> {
    let mut should_wait = false;
    if let Ok(mut cancel) = SIMKL_CALLBACK_CANCEL.lock() {
        if let Some(sender) = cancel.take() {
            let _ = sender.send(());
            should_wait = true;
        }
    }
    if should_wait {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while SIMKL_CALLBACK_ACTIVE.load(std::sync::atomic::Ordering::SeqCst)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        if SIMKL_CALLBACK_ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Simkl callback server did not stop in time.".to_string());
        }
    }
    Ok(())
}

static ANILIST_CALLBACK_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static ANILIST_CALLBACK_CANCEL: std::sync::Mutex<
    Option<(String, tokio::sync::watch::Sender<bool>)>,
> = std::sync::Mutex::new(None);

pub struct AnilistCallbackGuard;
impl Drop for AnilistCallbackGuard {
    fn drop(&mut self) {
        if let Ok(mut cancel) = ANILIST_CALLBACK_CANCEL.lock() {
            *cancel = None;
        }
        ANILIST_CALLBACK_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

pub async fn cancel_anilist_callback(provider: &str) -> Result<(), String> {
    let mut should_wait = false;
    if let Ok(cancel) = ANILIST_CALLBACK_CANCEL.lock() {
        if let Some((_, sender)) = cancel
            .as_ref()
            .filter(|(active_provider, _)| active_provider == provider)
        {
            sender.send_replace(true);
            should_wait = true;
        }
    }
    if should_wait {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while ANILIST_CALLBACK_ACTIVE.load(std::sync::atomic::Ordering::SeqCst)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        if ANILIST_CALLBACK_ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("OAuth callback server did not stop in time.".to_string());
        }
    }
    Ok(())
}

pub async fn begin_anilist_callback(
    provider: &str,
) -> Result<
    (
        tokio::net::TcpListener,
        AnilistCallbackGuard,
        tokio::sync::watch::Receiver<bool>,
    ),
    String,
> {
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
    // Own the reservation before the fallible bind. If binding fails or this
    // future is cancelled while awaiting the OS, Drop releases the global flag.
    let guard = AnilistCallbackGuard;
    let (cancel_sender, cancel_receiver) = tokio::sync::watch::channel(false);
    if let Ok(mut cancel) = ANILIST_CALLBACK_CANCEL.lock() {
        *cancel = Some((provider.to_string(), cancel_sender));
    } else {
        return Err("Could not initialize OAuth callback cancellation.".to_string());
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:42814")
        .await
        .map_err(|error| format!("Failed to bind callback port 42814: {error}"))?;
    Ok((listener, guard, cancel_receiver))
}

/// Wait for the AUTH V2 browser redirect and return only the validated callback
/// fields. State and issuer are checked by the renderer alongside its PKCE
/// verifier; no user token is ever placed in the redirect.
pub async fn wait_for_simkl_callback() -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
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
    let (cancel_sender, mut cancel_receiver) = tokio::sync::oneshot::channel();
    if let Ok(mut cancel) = SIMKL_CALLBACK_CANCEL.lock() {
        *cancel = Some(cancel_sender);
    } else {
        return Err("Could not initialize Simkl callback cancellation.".to_string());
    }
    let listener = TcpListener::bind("127.0.0.1:42814")
        .await
        .map_err(|error| format!("Failed to bind Simkl callback port 42814: {error}"))?;
    let accepted = tokio::select! {
        _ = &mut cancel_receiver => return Err("Simkl authorization was cancelled.".to_string()),
        result = tokio::time::timeout(std::time::Duration::from_secs(600), listener.accept()) => {
            result.map_err(|_| "Timed out waiting for Simkl OAuth callback.".to_string())?
                .map_err(|error| format!("Failed to accept Simkl OAuth callback: {error}"))?
        }
    };
    let (mut stream, _) = accepted;
    let request = tokio::select! {
        request = read_request_head(&mut stream, "Simkl") => request?,
        _ = &mut cancel_receiver => return Err("Simkl authorization was cancelled.".to_string()),
    };
    let code = parse_oauth_code(&request);
    let state = parse_oauth_param(&request, "state");
    let issuer = parse_oauth_param(&request, "iss");
    let error = parse_oauth_param(&request, "error");
    let html = concat!(
        "<html><head><meta charset=\"utf-8\"><title>Aurales</title></head>",
        "<body style=\"font-family:sans-serif;text-align:center;padding:60px\">",
        "<h2>Simkl approval received</h2>",
        "<p>Return to Aurales to finish connecting your account.</p>",
        "</body></html>",
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(), html,
    );
    let _ = stream.write_all(response.as_bytes()).await;
    Ok(
        serde_json::json!({ "code": code, "state": state, "iss": issuer, "error": error })
            .to_string(),
    )
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
    cancel: &mut tokio::sync::watch::Receiver<bool>,
    timeout_seconds: u64,
    timeout_error: &str,
    accept_error: &str,
) -> Result<tokio::net::TcpStream, String> {
    if *cancel.borrow() {
        return Err("OAuth authorization was cancelled.".to_string());
    }
    tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(timeout_seconds), listener.accept()) => {
            result.map_err(|_| timeout_error.to_string())?
                .map(|(stream, _)| stream)
                .map_err(|error| format!("{accept_error}: {error}"))
        }
        _ = cancel.changed() => Err("OAuth authorization was cancelled.".to_string()),
    }
}

pub async fn read_oauth_callback(
    stream: &mut tokio::net::TcpStream,
    provider: &str,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    if *cancel.borrow() {
        return Err("OAuth authorization was cancelled.".to_string());
    }
    tokio::select! {
        request = read_request_head(stream, provider) => request,
        _ = cancel.changed() => Err("OAuth authorization was cancelled.".to_string()),
    }
}

async fn read_request_head(
    stream: &mut tokio::net::TcpStream,
    provider: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;

    let read = async {
        let mut buffer = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        loop {
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                return Ok(String::from_utf8_lossy(&buffer).into_owned());
            }
            if buffer.len() >= MAX_OAUTH_REQUEST_BYTES {
                return Err(format!("{provider} callback headers are too large"));
            }
            let remaining = MAX_OAUTH_REQUEST_BYTES - buffer.len();
            let read_len = chunk.len().min(remaining);
            let count = stream
                .read(&mut chunk[..read_len])
                .await
                .map_err(|error| format!("Failed to read {provider} callback request: {error}"))?;
            if count == 0 {
                return Err(format!(
                    "{provider} callback closed before sending complete headers"
                ));
            }
            buffer.extend_from_slice(&chunk[..count]);
        }
    };

    tokio::time::timeout(OAUTH_HEADER_TIMEOUT, read)
        .await
        .map_err(|_| format!("Timed out reading {provider} callback headers"))?
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
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

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub fn request_simkl_pin(client_id: String) -> Result<String, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("SIMKL client ID is required".to_string());
    }
    let response = ureq::get("https://api.simkl.com/oauth/pin")
        .timeout(PROVIDER_HTTP_TIMEOUT)
        .query("client_id", &client_id)
        .set("Accept", "application/json")
        .call()
        .map_err(|error| read_ureq_error("Simkl PIN request", error))?;
    let body = read_provider_body(response)?;
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
        .timeout(PROVIDER_HTTP_TIMEOUT)
        .query("client_id", &client_id)
        .set("Accept", "application/json")
        .call()
        .map_err(|error| read_ureq_error("Simkl PIN check", error))?;
    let body = read_provider_body(response)?;
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
        .timeout(PROVIDER_HTTP_TIMEOUT)
        .query("client_id", &client_id)
        .query("app-name", "Aurales")
        .query("app-version", env!("CARGO_PKG_VERSION"))
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("User-Agent", "Aurales/0.4.8")
        .set("Accept", "application/json")
        .call()
        .map_err(|error| read_ureq_error("Simkl user fetch", error))?;
    read_provider_body(response)
}

pub fn exchange_anilist_token(
    code: String,
    client_id: String,
    redirect_uri: String,
) -> Result<String, String> {
    const CLIENT_SECRET: Option<&str> = crate::native_secrets::ANILIST_CLIENT_SECRET;
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
        .timeout(PROVIDER_HTTP_TIMEOUT)
        .set("Accept", "application/json")
        .send_json(ureq::json!({
            "grant_type": "authorization_code",
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "code": code,
        }));
    match result {
        Ok(response) => read_provider_body(response).and_then(parse_anilist_access_token),
        Err(ureq::Error::Status(status, response)) => {
            let body = read_provider_body(response).unwrap_or_default();
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
    const CLIENT_SECRET: Option<&str> = crate::native_secrets::SIMKL_CLIENT_SECRET;
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
        .timeout(PROVIDER_HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(&body)
        .map_err(|error| format!("Simkl token exchange request failed: {error}"))?;
    read_provider_body(response)
}

pub fn exchange_simkl_v2_token(
    code: String,
    client_id: String,
    redirect_uri: String,
    code_verifier: String,
) -> Result<String, String> {
    let response = ureq::post("https://api.simkl.com/oauth2/token")
        .timeout(PROVIDER_HTTP_TIMEOUT)
        .set("Accept", "application/json")
        .set("User-Agent", "Aurales/0.4.8")
        .send_form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.trim()),
            ("code", code.trim()),
            ("redirect_uri", redirect_uri.trim()),
            ("code_verifier", code_verifier.trim()),
        ])
        .map_err(|error| read_ureq_error("Simkl AUTH V2 token exchange", error))?;
    read_provider_body(response)
}

pub fn refresh_simkl_v2_token(refresh_token: String, client_id: String) -> Result<String, String> {
    let response = ureq::post("https://api.simkl.com/oauth2/token")
        .timeout(PROVIDER_HTTP_TIMEOUT)
        .set("Accept", "application/json")
        .set("User-Agent", "Aurales/0.4.8")
        .send_form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.trim()),
            ("refresh_token", refresh_token.trim()),
        ])
        .map_err(|error| read_ureq_error("Simkl AUTH V2 refresh", error))?;
    read_provider_body(response)
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
        if crate::native_secrets::SIMKL_CLIENT_SECRET.is_none() {
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
