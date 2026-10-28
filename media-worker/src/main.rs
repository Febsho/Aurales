use aurales_domain::media_probe::{
    accepts_byte_ranges, total_content_length, StreamProbeResponse, SAMPLE_BYTES,
};
use aurales_domain::streams::{rank_streams, RankStreamCandidatesResponse, SmartScoreContext};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{
    ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG,
    IF_RANGE, LAST_MODIFIED, RANGE,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::{Duration, Instant};
use tower_http::cors::{AllowOrigin, CorsLayer};

const MAX_CANDIDATES: usize = 250;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_MEDIA_ROOT_SESSIONS: usize = 256;
const MAX_MEDIA_RESOURCES: usize = 16_384;
const MEDIA_SESSION_TTL: Duration = Duration::from_secs(4 * 60 * 60);
const MEDIA_CHILD_GRACE: Duration = Duration::from_secs(60);
const MAX_HLS_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_HLS_REFERENCES: usize = 4_096;
const MAX_HLS_NESTING_DEPTH: u8 = 8;
const MAX_MEDIA_REDIRECTS: usize = 3;
const MAX_CONVERSION_JOBS: usize = 8;
const MAX_CONVERSION_INPUT_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    api_key: Arc<Vec<u8>>,
    ranking_slots: Arc<Semaphore>,
    session_key: Arc<Vec<u8>>,
    allowed_media_hosts: Arc<HashSet<String>>,
    media_sessions: Arc<Mutex<HashMap<String, MediaSession>>>,
    media_slots: Arc<Semaphore>,
    probe_slots: Arc<Semaphore>,
    pmdb_slots: Arc<Semaphore>,
    ffmpeg_path: Option<Arc<PathBuf>>,
    ffmpeg_caps: Option<FfmpegCapabilities>,
    conversion_dir: Arc<PathBuf>,
    conversion_slots: Arc<Semaphore>,
    conversion_jobs: Arc<Mutex<HashMap<String, ConversionJob>>>,
}

#[derive(Clone)]
struct ConversionJob {
    status: ConversionStatus,
    expires_at: Instant,
}

#[derive(Clone)]
enum ConversionStatus {
    Processing,
    Ready {
        path: PathBuf,
        bytes: u64,
        mode: ConversionMode,
        url: String,
    },
    Failed,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ConversionMode {
    Remux,
    AudioAac,
    H264Aac,
}

#[derive(Clone, Copy)]
struct FfmpegCapabilities {
    audio_aac: bool,
    video_h264: bool,
}

#[derive(Clone)]
struct MediaSession {
    url: url::Url,
    local_file: Option<PathBuf>,
    expires_at: Instant,
    children: HashMap<String, String>,
    is_root: bool,
    parent_id: Option<String>,
    nesting_depth: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankRequest {
    streams: Vec<Value>,
    context: SmartScoreContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRequest {
    url: String,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PmdbRequest {
    method: String,
    path: String,
    api_key: String,
    body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MdblistRequest {
    method: String,
    path: String,
    bearer_token: Option<String>,
    api_key: Option<String>,
    body: Option<String>,
    content_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraktRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TorboxRequest {
    method: String,
    path: String,
    token: Option<String>,
    body: Option<String>,
    content_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuralesSyncRequest {
    method: String,
    path: String,
    bearer_token: Option<String>,
    body: String,
}

#[derive(Serialize)]
struct ProviderProxyResponse {
    status: u16,
    ok: bool,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    stream_ranking: bool,
    media_remux: bool,
    media_transcode: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesResponse {
    stream_ranking: bool,
    media_direct_proxy: bool,
    pmdb_proxy: bool,
    mdblist_proxy: bool,
    trakt_proxy: bool,
    torbox_proxy: bool,
    aurales_sync_proxy: bool,
    media_remux: bool,
    audio_transcode: bool,
    video_transcode: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMediaSessionRequest {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMediaConversionRequest {
    url: String,
    mode: ConversionMode,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateMediaConversionResponse {
    job_id: String,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaConversionStatusResponse {
    job_id: String,
    status: &'static str,
    mode: Option<ConversionMode>,
    bytes: Option<u64>,
    url: Option<String>,
    error: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateMediaSessionResponse {
    url: String,
    expires_at: u64,
}

#[derive(Deserialize)]
struct SignedSession {
    expires: u64,
    signature: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Aurales media worker failed to start: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let api_key = std::env::var("AURALES_MEDIA_API_KEY").map_err(|_| {
        "AURALES_MEDIA_API_KEY must be set to a private key of at least 32 bytes".to_string()
    })?;
    if api_key.as_bytes().len() < 32 {
        return Err("AURALES_MEDIA_API_KEY must be at least 32 bytes".into());
    }
    let allowed_media_hosts =
        parse_allowed_hosts(&std::env::var("AURALES_MEDIA_ALLOWED_HOSTS").unwrap_or_default())?;
    let session_key = std::env::var("AURALES_MEDIA_SESSION_KEY").ok();
    let session_key = match session_key {
        Some(key) if key.as_bytes().len() >= 32 => key,
        Some(_) => return Err("AURALES_MEDIA_SESSION_KEY must be at least 32 bytes".into()),
        None if allowed_media_hosts.is_empty() => "media-proxy-disabled-signing-key".to_string(),
        None => return Err(
            "AURALES_MEDIA_SESSION_KEY must be set when AURALES_MEDIA_ALLOWED_HOSTS is configured"
                .into(),
        ),
    };
    let origins = parse_origins(&std::env::var("AURALES_MEDIA_WEB_ORIGINS").unwrap_or_default())?;
    if origins.is_empty() {
        return Err("AURALES_MEDIA_WEB_ORIGINS must list one or more exact HTTPS origins".into());
    }
    let address: SocketAddr = std::env::var("AURALES_MEDIA_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8188".into())
        .parse()
        .map_err(|_| "AURALES_MEDIA_BIND must be a valid IP:port socket address".to_string())?;
    let (ffmpeg_path, ffmpeg_caps) = match std::env::var("AURALES_FFMPEG_PATH") {
        Ok(value) if !value.trim().is_empty() => {
            let path = PathBuf::from(value.trim());
            let caps = validate_ffmpeg(&path).await?;
            (Some(Arc::new(path)), Some(caps))
        }
        _ => (None, None),
    };
    let conversion_dir = Arc::new(PathBuf::from(
        std::env::var("AURALES_MEDIA_CONVERSION_DIR").unwrap_or_else(|_| {
            std::env::temp_dir()
                .join("aurales-media-worker")
                .to_string_lossy()
                .into_owned()
        }),
    ));
    if ffmpeg_path.is_some() {
        tokio::fs::create_dir_all(conversion_dir.as_ref())
            .await
            .map_err(|error| {
                format!("Could not create the private media conversion directory: {error}")
            })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(
                conversion_dir.as_ref(),
                std::fs::Permissions::from_mode(0o700),
            )
            .await
            .map_err(|error| {
                format!("Could not restrict the media conversion directory: {error}")
            })?;
        }
    }
    if !address.ip().is_loopback()
        && std::env::var("AURALES_MEDIA_EXTERNAL_TLS").as_deref() != Ok("1")
    {
        return Err("Public binding requires a TLS-terminating reverse proxy and AURALES_MEDIA_EXTERNAL_TLS=1".into());
    }

    let conversion_enabled = ffmpeg_path.is_some();
    let state = AppState {
        api_key: Arc::new(api_key.into_bytes()),
        ranking_slots: Arc::new(Semaphore::new(4)),
        session_key: Arc::new(session_key.into_bytes()),
        allowed_media_hosts: Arc::new(allowed_media_hosts),
        media_sessions: Arc::new(Mutex::new(HashMap::new())),
        media_slots: Arc::new(Semaphore::new(16)),
        probe_slots: Arc::new(Semaphore::new(8)),
        pmdb_slots: Arc::new(Semaphore::new(8)),
        ffmpeg_path,
        ffmpeg_caps,
        conversion_dir,
        conversion_slots: Arc::new(Semaphore::new(2)),
        conversion_jobs: Arc::new(Mutex::new(HashMap::new())),
    };
    if conversion_enabled {
        clean_stale_conversion_files(state.conversion_dir.as_ref()).await;
        tokio::spawn(run_conversion_cleanup(state.clone()));
    }
    let app = router(state, origins);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Could not bind {address}: {error}"))?;
    eprintln!("Aurales media worker listening on {address}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| format!("HTTP server failed: {error}"))
}

async fn validate_ffmpeg(path: &PathBuf) -> Result<FfmpegCapabilities, String> {
    let version = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(path)
            .arg("-version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "AURALES_FFMPEG_PATH did not respond within 10 seconds".to_string())?
    .map_err(|error| format!("Could not start FFmpeg at AURALES_FFMPEG_PATH: {error}"))?;
    if !version.status.success() {
        return Err("The configured FFmpeg executable failed its version check".into());
    }
    let encoders = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(path)
            .args(["-hide_banner", "-encoders"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "FFmpeg encoder discovery timed out".to_string())?
    .map_err(|error| format!("Could not query FFmpeg encoders: {error}"))?;
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&encoders.stdout),
        String::from_utf8_lossy(&encoders.stderr)
    );
    Ok(FfmpegCapabilities {
        audio_aac: output
            .lines()
            .any(|line| line.split_whitespace().any(|name| name == "aac")),
        video_h264: output
            .lines()
            .any(|line| line.split_whitespace().any(|name| name == "libx264")),
    })
}

fn router(state: AppState, origins: Vec<HeaderValue>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::HEAD, Method::POST, Method::OPTIONS])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, RANGE, IF_RANGE])
        .expose_headers([
            ACCEPT_RANGES,
            CONTENT_LENGTH,
            CONTENT_RANGE,
            CONTENT_TYPE,
            ETAG,
            LAST_MODIFIED,
        ])
        .max_age(std::time::Duration::from_secs(600));
    Router::new()
        .route("/health", get(health))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/streams/rank", post(rank))
        .route("/v1/media/probe", post(probe_media))
        .route("/v1/providers/pmdb", post(proxy_pmdb))
        .route("/v1/providers/mdblist", post(proxy_mdblist))
        .route("/v1/providers/trakt", post(proxy_trakt))
        .route("/v1/providers/torbox", post(proxy_torbox))
        .route(
            "/v1/providers/aurales-sync",
            post(proxy_aurales_sync).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/v1/media/sessions", post(create_media_session))
        .route("/v1/media/conversions", post(create_media_conversion))
        .route("/v1/media/conversions/{id}", get(media_conversion_status))
        .route("/v1/media/{id}", get(proxy_media).head(proxy_media))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(cors)
        .with_state(state)
}

fn parse_origins(config: &str) -> Result<Vec<HeaderValue>, String> {
    config
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(|origin| {
            let parsed =
                url::Url::parse(origin).map_err(|_| format!("Invalid web origin: {origin}"))?;
            if parsed.scheme() != "https"
                && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            {
                return Err(format!("Web origin must use HTTPS: {origin}"));
            }
            if parsed.path() != "/"
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(format!(
                    "Configure an origin only, without path or credentials: {origin}"
                ));
            }
            HeaderValue::from_str(parsed.origin().ascii_serialization().as_str())
                .map_err(|_| format!("Invalid web origin header: {origin}"))
        })
        .collect()
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        stream_ranking: true,
        media_remux: state.ffmpeg_path.is_some(),
        media_transcode: state
            .ffmpeg_caps
            .is_some_and(|caps| caps.audio_aac || caps.video_h264),
    })
}

async fn capabilities(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "unauthorized",
            }),
        )
            .into_response();
    }
    let ffmpeg = state.ffmpeg_caps;
    Json(CapabilitiesResponse {
        stream_ranking: true,
        media_direct_proxy: !state.allowed_media_hosts.is_empty(),
        pmdb_proxy: true,
        mdblist_proxy: true,
        trakt_proxy: true,
        torbox_proxy: true,
        aurales_sync_proxy: true,
        media_remux: state.ffmpeg_path.is_some(),
        audio_transcode: ffmpeg.is_some_and(|caps| caps.audio_aac),
        video_transcode: ffmpeg.is_some_and(|caps| caps.video_h264),
    })
    .into_response()
}

async fn create_media_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateMediaSessionRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    if state.allowed_media_hosts.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "media_proxy_not_configured",
            }),
        )
            .into_response();
    }
    if request.url.len() > 16_384 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorResponse {
                error: "url_too_large",
            }),
        )
            .into_response();
    }
    let Ok(url) = url::Url::parse(&request.url) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid_media_url",
            }),
        )
            .into_response();
    };
    if validate_media_url(&url, &state.allowed_media_hosts).is_err()
        || resolve_public_address(&url).await.is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "media_host_not_allowed",
            }),
        )
            .into_response();
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + MEDIA_SESSION_TTL.as_secs();
    let signature = match sign_session(&state.session_key, &id, expires) {
        Some(value) => value,
        None => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut sessions = state.media_sessions.lock().await;
    sessions.retain(|_, session| session.expires_at > Instant::now());
    if sessions.len() >= MAX_MEDIA_RESOURCES
        || sessions.values().filter(|session| session.is_root).count() >= MAX_MEDIA_ROOT_SESSIONS
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorResponse {
                error: "too_many_media_sessions",
            }),
        )
            .into_response();
    }
    sessions.insert(
        id.clone(),
        MediaSession {
            url,
            local_file: None,
            expires_at: Instant::now() + MEDIA_SESSION_TTL,
            children: HashMap::new(),
            is_root: true,
            parent_id: None,
            nesting_depth: 0,
        },
    );
    let stream_url = format!("/v1/media/{id}?expires={expires}&signature={signature}");
    Json(CreateMediaSessionResponse {
        url: stream_url,
        expires_at: expires,
    })
    .into_response()
}

async fn create_media_conversion(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateMediaConversionRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    let Some(ffmpeg) = state.ffmpeg_path.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "ffmpeg_not_configured",
            }),
        )
            .into_response();
    };
    let supported = match request.mode {
        ConversionMode::Remux => true,
        ConversionMode::AudioAac => state.ffmpeg_caps.is_some_and(|caps| caps.audio_aac),
        ConversionMode::H264Aac => state
            .ffmpeg_caps
            .is_some_and(|caps| caps.audio_aac && caps.video_h264),
    };
    if !supported {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "conversion_mode_unavailable",
            }),
        )
            .into_response();
    }
    if request.url.len() > 16_384 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorResponse {
                error: "url_too_large",
            }),
        )
            .into_response();
    }
    let Ok(url) = url::Url::parse(&request.url) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid_media_url",
            }),
        )
            .into_response();
    };
    if validate_media_url(&url, &state.allowed_media_hosts).is_err()
        || is_hls_playlist(&url, None)
        || resolve_public_address(&url).await.is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "media_host_not_allowed",
            }),
        )
            .into_response();
    }
    let Ok(permit) = state.conversion_slots.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorResponse {
                error: "conversion_worker_busy",
            }),
        )
            .into_response();
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut jobs = state.conversion_jobs.lock().await;
        jobs.retain(|_, job| job.expires_at > Instant::now());
        if jobs.len() >= MAX_CONVERSION_JOBS {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ErrorResponse {
                    error: "too_many_conversion_jobs",
                }),
            )
                .into_response();
        }
        jobs.insert(
            id.clone(),
            ConversionJob {
                status: ConversionStatus::Processing,
                expires_at: Instant::now() + MEDIA_SESSION_TTL,
            },
        );
    }
    tokio::spawn(run_media_conversion(
        state,
        id.clone(),
        url,
        request.mode,
        ffmpeg,
        permit,
    ));
    (
        StatusCode::ACCEPTED,
        Json(CreateMediaConversionResponse {
            job_id: id,
            status: "processing",
        }),
    )
        .into_response()
}

async fn media_conversion_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let jobs = state.conversion_jobs.lock().await;
    let Some(job) = jobs.get(&id).filter(|job| job.expires_at > Instant::now()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let response = match &job.status {
        ConversionStatus::Processing => MediaConversionStatusResponse {
            job_id: id,
            status: "processing",
            mode: None,
            bytes: None,
            url: None,
            error: None,
        },
        ConversionStatus::Ready {
            bytes, mode, url, ..
        } => MediaConversionStatusResponse {
            job_id: id,
            status: "ready",
            mode: Some(*mode),
            bytes: Some(*bytes),
            url: Some(url.clone()),
            error: None,
        },
        ConversionStatus::Failed => MediaConversionStatusResponse {
            job_id: id,
            status: "failed",
            mode: None,
            bytes: None,
            url: None,
            error: Some("conversion_failed"),
        },
    };
    Json(response).into_response()
}

async fn run_media_conversion(
    state: AppState,
    id: String,
    url: url::Url,
    mode: ConversionMode,
    ffmpeg: Arc<PathBuf>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let input_path = state.conversion_dir.join(format!("{id}.input"));
    let output_path = state.conversion_dir.join(format!("{id}.mp4"));
    let result = async {
        download_allowlisted_media(&state, &url, &input_path).await?;
        let bytes = transcode_local_input(ffmpeg.as_ref(), &input_path, &output_path, mode).await?;
        let session_url = create_local_media_session(&state, output_path.clone()).await?;
        Ok::<_, ()>((bytes, session_url))
    }
    .await;
    let _ = tokio::fs::remove_file(&input_path).await;
    let mut jobs = state.conversion_jobs.lock().await;
    if let Some(job) = jobs.get_mut(&id) {
        job.status = match result {
            Ok((bytes, url)) => {
                job.expires_at = Instant::now() + MEDIA_SESSION_TTL;
                ConversionStatus::Ready {
                    path: output_path,
                    bytes,
                    mode,
                    url,
                }
            }
            Err(()) => {
                let _ = tokio::fs::remove_file(&output_path).await;
                ConversionStatus::Failed
            }
        };
    }
}

async fn transcode_local_input(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    output_path: &FsPath,
    mode: ConversionMode,
) -> Result<u64, ()> {
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .args([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
        ])
        .arg("-i")
        .arg(input_path)
        .args([
            "-map",
            "0:v:0?",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-map_metadata",
            "0",
        ]);
    match mode {
        ConversionMode::Remux => {
            command.args(["-c", "copy"]);
        }
        ConversionMode::AudioAac => {
            command.args(["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]);
        }
        ConversionMode::H264Aac => {
            command.args([
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", "2", "-c:a",
                "aac", "-b:a", "192k",
            ]);
        }
    }
    command
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(output_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| ())?;
    wait_for_ffmpeg(&mut child, output_path).await?;
    let bytes = tokio::fs::metadata(output_path)
        .await
        .map_err(|_| ())?
        .len();
    if bytes == 0 || bytes > MAX_CONVERSION_INPUT_BYTES {
        return Err(());
    }
    Ok(bytes)
}

async fn run_conversion_cleanup(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
    loop {
        interval.tick().await;
        let now = Instant::now();
        let mut expired_files = HashSet::new();
        {
            let mut jobs = state.conversion_jobs.lock().await;
            jobs.retain(|_, job| {
                if job.expires_at > now {
                    return true;
                }
                if let ConversionStatus::Ready { path, .. } = &job.status {
                    expired_files.insert(path.clone());
                }
                false
            });
        }
        {
            let mut sessions = state.media_sessions.lock().await;
            sessions.retain(|_, session| {
                if session.expires_at > now {
                    return true;
                }
                if let Some(path) = &session.local_file {
                    expired_files.insert(path.clone());
                }
                false
            });
        }
        for path in expired_files {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

async fn clean_stale_conversion_files(directory: &PathBuf) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_worker_file = name.ends_with(".input") || name.ends_with(".mp4");
        let id = name.rsplit_once('.').map(|(id, _)| id).unwrap_or_default();
        if is_worker_file && id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

async fn create_local_media_session(state: &AppState, path: PathBuf) -> Result<String, ()> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + MEDIA_SESSION_TTL.as_secs();
    let signature = sign_session(&state.session_key, &id, expires).ok_or(())?;
    let mut sessions = state.media_sessions.lock().await;
    sessions.retain(|_, session| session.expires_at > Instant::now());
    if sessions.len() >= MAX_MEDIA_RESOURCES
        || sessions.values().filter(|session| session.is_root).count() >= MAX_MEDIA_ROOT_SESSIONS
    {
        return Err(());
    }
    sessions.insert(
        id.clone(),
        MediaSession {
            url: url::Url::parse("https://local-media.invalid/").map_err(|_| ())?,
            local_file: Some(path),
            expires_at: Instant::now() + MEDIA_SESSION_TTL,
            children: HashMap::new(),
            is_root: true,
            parent_id: None,
            nesting_depth: 0,
        },
    );
    Ok(format!(
        "/v1/media/{id}?expires={expires}&signature={signature}"
    ))
}

async fn download_allowlisted_media(
    state: &AppState,
    initial_url: &url::Url,
    path: &PathBuf,
) -> Result<(), ()> {
    let mut url = initial_url.clone();
    for redirect in 0..=MAX_MEDIA_REDIRECTS {
        if validate_media_url(&url, &state.allowed_media_hosts).is_err() {
            return Err(());
        }
        let address = resolve_public_address(&url).await?;
        let host = url.host_str().ok_or(())?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .resolve(
                host,
                SocketAddr::new(address, url.port_or_known_default().ok_or(())?),
            )
            .build()
            .map_err(|_| ())?;
        let response = tokio::time::timeout(
            Duration::from_secs(30),
            client
                .get(url.clone())
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send(),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
        if response.status().is_redirection() {
            if redirect == MAX_MEDIA_REDIRECTS {
                return Err(());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(())?;
            url = url.join(location).map_err(|_| ())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(());
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if content_type.starts_with("text/") || content_type.contains("mpegurl") {
            return Err(());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_CONVERSION_INPUT_BYTES)
        {
            return Err(());
        }
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .await
            .map_err(|_| ())?;
        let mut body = response.bytes_stream();
        let mut total = 0u64;
        loop {
            match tokio::time::timeout(Duration::from_secs(45), body.next()).await {
                Ok(Some(Ok(chunk))) => {
                    total = total.saturating_add(chunk.len() as u64);
                    if total > MAX_CONVERSION_INPUT_BYTES {
                        return Err(());
                    }
                    file.write_all(&chunk).await.map_err(|_| ())?;
                }
                Ok(Some(Err(_))) | Err(_) => return Err(()),
                Ok(None) => break,
            }
        }
        file.flush().await.map_err(|_| ())?;
        return if total > 0 { Ok(()) } else { Err(()) };
    }
    Err(())
}

async fn wait_for_ffmpeg(
    child: &mut tokio::process::Child,
    output_path: &FsPath,
) -> Result<(), ()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2 * 60 * 60);
    loop {
        tokio::select! {
            status = child.wait() => return if status.map_err(|_| ())?.success() { Ok(()) } else { Err(()) },
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if tokio::fs::metadata(output_path).await.map(|metadata| metadata.len() > MAX_CONVERSION_INPUT_BYTES).unwrap_or(false) {
                    let _ = child.kill().await;
                    return Err(());
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                let _ = child.kill().await;
                return Err(());
            }
        }
    }
}

async fn proxy_media(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(signed): Query<SignedSession>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    if id.len() != 32
        || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || signed.expires
            < std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        || !verify_session(&state.session_key, &id, signed.expires, &signed.signature)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let session = {
        let mut sessions = state.media_sessions.lock().await;
        sessions.retain(|_, session| session.expires_at > Instant::now());
        match sessions.get(&id) {
            Some(session) => session.clone(),
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    };
    let Ok(permit) = state.media_slots.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorResponse {
                error: "media_proxy_busy",
            }),
        )
            .into_response();
    };
    if let Some(path) = session.local_file.clone() {
        return serve_local_media(path, headers, method, permit).await;
    }
    proxy_upstream(&state, id, signed.expires, session, headers, method, permit).await
}

async fn serve_local_media(
    path: PathBuf,
    headers: HeaderMap,
    method: Method,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !metadata.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let total = metadata.len();
    let etag = format!(
        "\"{:x}-{:x}\"",
        total,
        metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default()
    );
    let if_range_matches = headers
        .get(IF_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == etag)
        .unwrap_or(true);
    let requested_range = if if_range_matches {
        match headers.get(RANGE).and_then(|value| value.to_str().ok()) {
            Some(value) => match parse_byte_range(value, total) {
                Ok(range) => range,
                Err(()) => {
                    return Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(CONTENT_RANGE, format!("bytes */{total}"))
                        .header(ACCEPT_RANGES, "bytes")
                        .body(Body::empty())
                        .unwrap_or_else(|_| StatusCode::RANGE_NOT_SATISFIABLE.into_response());
                }
            },
            None => None,
        }
    } else {
        None
    };
    let (status, start, length) = match requested_range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        None => (StatusCode::OK, 0, total),
    };
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if file.seek(SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "video/mp4")
        .header(CONTENT_LENGTH, length.to_string())
        .header(ACCEPT_RANGES, "bytes")
        .header(ETAG, etag)
        .header(CACHE_CONTROL, "private, no-store");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            CONTENT_RANGE,
            format!("bytes {}-{}/{total}", start, start + length - 1),
        );
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(async_stream::stream! {
            let _permit = permit;
            let mut file = file;
            let mut remaining = length;
            let mut buffer = vec![0u8; 64 * 1024];
            while remaining > 0 {
                let count = remaining.min(buffer.len() as u64) as usize;
                match tokio::time::timeout(Duration::from_secs(30), file.read(&mut buffer[..count])).await {
                    Ok(Ok(0)) => break,
                    Ok(Ok(read)) => {
                        remaining -= read as u64;
                        yield Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(&buffer[..read]));
                    }
                    Ok(Err(error)) => { yield Err(error); break; }
                    Err(_) => { yield Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "local media read stalled")); break; }
                }
            }
        })
    };
    response
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn parse_byte_range(value: &str, total: u64) -> Result<Option<(u64, u64)>, ()> {
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if range.contains(',') || total == 0 {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok(Some((total.saturating_sub(suffix), total - 1)));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end.min(total - 1))))
}

async fn proxy_upstream(
    state: &AppState,
    parent_id: String,
    expires: u64,
    session: MediaSession,
    headers: HeaderMap,
    method: Method,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let mut url = session.url.clone();
    for redirect in 0..=MAX_MEDIA_REDIRECTS {
        if validate_media_url(&url, &state.allowed_media_hosts).is_err() {
            return StatusCode::FORBIDDEN.into_response();
        }
        let Ok(address) = resolve_public_address(&url).await else {
            return StatusCode::FORBIDDEN.into_response();
        };
        let Some(host) = url.host_str() else {
            return StatusCode::FORBIDDEN.into_response();
        };
        let port = url.port_or_known_default().unwrap_or(443);
        let client = match reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .resolve(host, SocketAddr::new(address, port))
            .build()
        {
            Ok(client) => client,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        let mut request = if method == Method::HEAD {
            client.head(url.clone())
        } else {
            client.get(url.clone())
        };
        for header in [RANGE, IF_RANGE] {
            if let Some(value) = headers.get(&header) {
                request = request.header(header.as_str(), value);
            }
        }
        let response = match request
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        if response.status().is_redirection() {
            if redirect == MAX_MEDIA_REDIRECTS {
                return StatusCode::BAD_GATEWAY.into_response();
            }
            let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                return StatusCode::BAD_GATEWAY.into_response();
            };
            let Ok(next) = url.join(location) else {
                return StatusCode::BAD_GATEWAY.into_response();
            };
            if validate_media_url(&next, &state.allowed_media_hosts).is_err() {
                return StatusCode::FORBIDDEN.into_response();
            }
            url = next;
            continue;
        }
        if let Some(session) = state.media_sessions.lock().await.get_mut(&parent_id) {
            session.url = url.clone();
        }
        let status = response.status();
        let upstream_headers = response.headers().clone();
        let is_playlist = is_hls_playlist(
            &url,
            upstream_headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
        );
        if is_playlist && status == reqwest::StatusCode::PARTIAL_CONTENT {
            return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        }
        if method != Method::HEAD && status == reqwest::StatusCode::OK && is_playlist {
            return rewrite_hls_response(
                state,
                &parent_id,
                expires,
                session.expires_at,
                &url,
                response,
                permit,
            )
            .await;
        }
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            let mut upstream = response.bytes_stream();
            Body::from_stream(async_stream::stream! {
                let _permit = permit;
                loop {
                    match tokio::time::timeout(Duration::from_secs(45), upstream.next()).await {
                        Ok(Some(Ok(chunk))) => yield Ok::<_, std::io::Error>(chunk),
                        Ok(Some(Err(error))) => yield Err(std::io::Error::other(error)),
                        Ok(None) => break,
                        Err(_) => yield Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "upstream media stream stalled")),
                    }
                }
            })
        };
        let mut result = Response::builder().status(status);
        for name in [
            CONTENT_TYPE,
            CONTENT_LENGTH,
            CONTENT_RANGE,
            ACCEPT_RANGES,
            ETAG,
            LAST_MODIFIED,
        ] {
            if let Some(value) = upstream_headers.get(&name) {
                result = result.header(name, value);
            }
        }
        result = result
            .header(CACHE_CONTROL, "private, no-store")
            .header("referrer-policy", "no-referrer");
        return result
            .body(body)
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    }
    StatusCode::BAD_GATEWAY.into_response()
}

fn is_hls_playlist(url: &url::Url, content_type: Option<&str>) -> bool {
    url.path().to_ascii_lowercase().ends_with(".m3u8")
        || content_type.is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("mpegurl") || value.contains("vnd.apple.mpegurl")
        })
}

async fn rewrite_hls_response(
    state: &AppState,
    parent_id: &str,
    expires: u64,
    parent_expires_at: Instant,
    base_url: &url::Url,
    response: reqwest::Response,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/vnd.apple.mpegurl")
        .to_string();
    let mut upstream = response.bytes_stream();
    let mut manifest = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(15), upstream.next()).await {
            Ok(Some(Ok(chunk))) if manifest.len() + chunk.len() <= MAX_HLS_MANIFEST_BYTES => {
                manifest.extend_from_slice(&chunk)
            }
            Ok(Some(Ok(_))) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Ok(Some(Err(_))) | Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
            Ok(None) => break,
        }
    }
    drop(permit);
    let Ok(manifest) = String::from_utf8(manifest) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let manifest = manifest.strip_prefix('\u{feff}').unwrap_or(&manifest);
    if !manifest.trim_start().starts_with("#EXTM3U") {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let Ok(spans) = playlist_uri_spans(&manifest) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if spans.len() > MAX_HLS_REFERENCES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }

    let mut requested_targets = Vec::new();
    let mut requested_references = HashSet::new();
    for (_, _, reference) in &spans {
        if !requested_references.insert(reference.clone()) {
            continue;
        }
        if reference.starts_with("data:") || reference.starts_with("skd:") {
            continue;
        }
        let Ok(child_url) = base_url.join(reference) else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        if child_url.scheme() != "http" && child_url.scheme() != "https" {
            continue;
        }
        if validate_media_url(&child_url, &state.allowed_media_hosts).is_err() {
            return StatusCode::FORBIDDEN.into_response();
        }
        requested_targets.push((reference.clone(), child_url));
    }

    let url_replacements = match register_child_sessions(
        state,
        parent_id,
        expires,
        parent_expires_at,
        requested_targets,
    )
    .await
    {
        Ok(replacements) => replacements,
        Err(status) => return status.into_response(),
    };

    let rewritten = match replace_playlist_uris(&manifest, &spans, &url_replacements) {
        Ok(value) => value,
        Err(()) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let bytes = rewritten.into_bytes();
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, bytes.len())
        .header(CACHE_CONTROL, "private, no-store")
        .header("referrer-policy", "no-referrer")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

async fn register_child_sessions(
    state: &AppState,
    parent_id: &str,
    expires: u64,
    parent_expires_at: Instant,
    targets: Vec<(String, url::Url)>,
) -> Result<HashMap<String, String>, StatusCode> {
    let mut sessions = state.media_sessions.lock().await;
    sessions.retain(|_, session| session.expires_at > Instant::now());
    let Some(parent) = sessions.get(parent_id).cloned() else {
        return Err(StatusCode::NOT_FOUND);
    };
    if !targets.is_empty() && parent.nesting_depth >= MAX_HLS_NESTING_DEPTH {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let child_depth = parent.nesting_depth.saturating_add(1);
    let mut ancestor_urls = HashSet::new();
    let mut ancestor_id = Some(parent_id);
    while let Some(id) = ancestor_id {
        let Some(ancestor) = sessions.get(id) else {
            break;
        };
        ancestor_urls.insert(ancestor.url.to_string());
        ancestor_id = ancestor.parent_id.as_deref();
    }
    let mut target_urls = HashMap::<String, url::Url>::new();
    for (_, url) in &targets {
        let key = url.to_string();
        if ancestor_urls.contains(&key) {
            return Err(StatusCode::BAD_GATEWAY);
        }
        target_urls.entry(key).or_insert_with(|| url.clone());
    }
    let mut current_children = HashMap::<String, String>::new();
    let mut pending = Vec::<(String, url::Url, String)>::new();
    for (key, url) in target_urls {
        let existing = parent
            .children
            .get(&key)
            .filter(|id| sessions.contains_key(*id))
            .cloned();
        if let Some(id) = existing {
            current_children.insert(key, id);
        } else {
            let id = uuid::Uuid::new_v4().simple().to_string();
            pending.push((key.clone(), url, id.clone()));
            current_children.insert(key, id);
        }
    }
    if sessions.len().saturating_add(pending.len()) > MAX_MEDIA_RESOURCES {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    let mut replacements = HashMap::new();
    for (reference, url) in targets {
        let Some(id) = current_children.get(&url.to_string()) else {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        };
        let Some(signature) = sign_session(&state.session_key, id, expires) else {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        };
        replacements.insert(
            reference,
            format!("/v1/media/{id}?expires={expires}&signature={signature}"),
        );
    }
    for (key, url, id) in pending {
        sessions.insert(
            id,
            MediaSession {
                url,
                local_file: None,
                expires_at: parent_expires_at,
                children: HashMap::new(),
                is_root: false,
                parent_id: Some(parent_id.to_string()),
                nesting_depth: child_depth,
            },
        );
        debug_assert!(current_children.contains_key(&key));
    }
    let old_children = parent.children;
    let current_ids: HashSet<&str> = current_children.values().map(String::as_str).collect();
    let grace_expiry = (Instant::now() + MEDIA_CHILD_GRACE).min(parent_expires_at);
    for id in old_children.values() {
        if !current_ids.contains(id.as_str()) {
            retire_session_tree(&mut sessions, id, grace_expiry);
        }
    }
    if let Some(parent) = sessions.get_mut(parent_id) {
        parent.children = current_children;
    }
    Ok(replacements)
}

fn retire_session_tree(
    sessions: &mut HashMap<String, MediaSession>,
    id: &str,
    expires_at: Instant,
) {
    let descendants = if let Some(session) = sessions.get_mut(id) {
        session.expires_at = expires_at;
        session.children.values().cloned().collect::<Vec<_>>()
    } else {
        return;
    };
    for child_id in descendants {
        retire_session_tree(sessions, &child_id, expires_at);
    }
}

fn playlist_uri_spans(text: &str) -> Result<Vec<(usize, usize, String)>, ()> {
    let mut spans = Vec::new();
    let mut line_offset = 0;
    for line in text.split_inclusive('\n') {
        let line_body = line.trim_end_matches(['\r', '\n']);
        let line_trimmed = line_body.trim();
        if line_trimmed.starts_with('#') {
            let bytes = line_body.as_bytes();
            let mut cursor = 0;
            while cursor + 4 <= bytes.len() {
                if bytes[cursor..cursor + 4].eq_ignore_ascii_case(b"URI=")
                    && (cursor == 0 || matches!(bytes[cursor - 1], b',' | b':' | b' '))
                {
                    let mut start = cursor + 4;
                    let quote = bytes
                        .get(start)
                        .copied()
                        .filter(|byte| *byte == b'"' || *byte == b'\'');
                    if quote.is_some() {
                        start += 1;
                    }
                    let mut end = start;
                    while end < bytes.len() {
                        if quote.is_some_and(|value| bytes[end] == value)
                            || (quote.is_none() && matches!(bytes[end], b',' | b' ' | b'\t'))
                        {
                            break;
                        }
                        end += 1;
                    }
                    if end > start {
                        let value = line_body.get(start..end).ok_or(())?.to_string();
                        spans.push((line_offset + start, line_offset + end, value));
                    }
                    cursor = end.saturating_add(1);
                } else {
                    cursor += 1;
                }
            }
        } else if !line_trimmed.is_empty() {
            let leading = line_body.len() - line_body.trim_start().len();
            let trailing = line_body.trim_end().len();
            let start = leading;
            let end = trailing;
            if end > start {
                let value = line_body.get(start..end).ok_or(())?.to_string();
                spans.push((line_offset + start, line_offset + end, value));
            }
        }
        line_offset += line.len();
    }
    Ok(spans)
}

fn replace_playlist_uris(
    text: &str,
    spans: &[(usize, usize, String)],
    replacements: &HashMap<String, String>,
) -> Result<String, ()> {
    let mut output = String::with_capacity(text.len() + spans.len() * 64);
    let mut cursor = 0;
    for (start, end, original) in spans {
        if *start < cursor || *end > text.len() || start > end {
            return Err(());
        }
        output.push_str(text.get(cursor..*start).ok_or(())?);
        output.push_str(
            replacements
                .get(original)
                .map(String::as_str)
                .unwrap_or(original),
        );
        cursor = *end;
    }
    output.push_str(text.get(cursor..).ok_or(())?);
    Ok(output)
}

fn parse_allowed_hosts(value: &str) -> Result<HashSet<String>, String> {
    let mut hosts = HashSet::new();
    for host in value
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
    {
        let host = host.to_ascii_lowercase().trim_end_matches('.').to_owned();
        if host.contains('*')
            || host.contains('/')
            || host.contains(':')
            || host.parse::<IpAddr>().is_ok()
            || host.is_empty()
        {
            return Err("AURALES_MEDIA_ALLOWED_HOSTS must contain exact DNS hostnames, not wildcards, paths, ports, or IPs".into());
        }
        hosts.insert(host);
    }
    Ok(hosts)
}

fn validate_media_url(url: &url::Url, allowed: &HashSet<String>) -> Result<(), ()> {
    let Some(host) = url.host_str() else {
        return Err(());
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !allowed.contains(&host.to_ascii_lowercase().trim_end_matches('.').to_owned())
    {
        return Err(());
    }
    Ok(())
}

async fn resolve_public_address(url: &url::Url) -> Result<IpAddr, ()> {
    let host = url.host_str().ok_or(())?;
    let port = url.port_or_known_default().ok_or(())?;
    let mut addresses = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    addresses
        .find(|address| is_public_ip(address.ip()))
        .map(|address| address.ip())
        .ok_or(())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51)
                || (a == 203 && b == 0))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let octets = ip.octets();
            let global_unicast = (0x20..=0x3f).contains(&octets[0]);
            let special_2001 = octets[0] == 0x20
                && octets[1] == 0x01
                && (octets[2] <= 0x01
                    || (octets[2] == 0 && matches!(octets[3], 0x02 | 0x10 | 0x20)));
            let documentation =
                (octets[0] == 0x20 && octets[1] == 0x01 && octets[2] == 0x0d && octets[3] == 0xb8)
                    || (octets[0] == 0x3f && octets[1] == 0xff && octets[2] & 0xf0 == 0);
            !(!global_unicast
                || ip.is_unspecified()
                || ip.is_loopback()
                || (octets[0] & 0xfe) == 0xfc
                || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80)
                || ip.is_multicast()
                || special_2001
                || documentation
                || octets[0] == 0x20 && octets[1] == 0x02)
        }
    }
}

fn sign_session(key: &[u8], id: &str, expires: u64) -> Option<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
    mac.update(format!("{id}:{expires}").as_bytes());
    Some(hex_encode(&mac.finalize().into_bytes()))
}

fn verify_session(key: &[u8], id: &str, expires: u64, signature: &str) -> bool {
    let Some(expected) = sign_session(key, id, expires) else {
        return false;
    };
    expected.len() == signature.len() && bool::from(expected.as_bytes().ct_eq(signature.as_bytes()))
}

fn hex_encode(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorResponse {
            error: "unauthorized",
        }),
    )
        .into_response()
}

async fn rank(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RankRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "unauthorized",
            }),
        )
            .into_response();
    }
    if request.streams.len() > MAX_CANDIDATES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorResponse {
                error: "too_many_streams",
            }),
        )
            .into_response();
    }
    let Ok(_permit) = state.ranking_slots.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorResponse {
                error: "worker_busy",
            }),
        )
            .into_response();
    };
    let candidates =
        match tokio::task::spawn_blocking(move || rank_streams(request.streams, &request.context))
            .await
        {
            Ok(candidates) => candidates,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "ranking_failed",
                    }),
                )
                    .into_response()
            }
        };
    Json(RankStreamCandidatesResponse {
        candidates,
        stale: false,
    })
    .into_response()
}

async fn probe_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ProbeRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    if state.allowed_media_hosts.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: "media_proxy_not_configured",
            }),
        )
            .into_response();
    }
    if request.url.len() > 16_384 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(ErrorResponse {
                error: "url_too_large",
            }),
        )
            .into_response();
    }
    let Ok(_permit) = state.probe_slots.clone().try_acquire_owned() else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorResponse {
                error: "probe_busy",
            }),
        )
            .into_response();
    };
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(4_000).clamp(500, 30_000));
    match probe_upstream(&state, request.url, timeout).await {
        Ok(result) => Json(result).into_response(),
        Err(status) => status.into_response(),
    }
}

/// Proxy only the fixed PMDB external API. The user's PMDB credential is
/// accepted in the authenticated request body and is sent only to this origin.
async fn proxy_pmdb(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PmdbRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    if request.api_key.trim().is_empty() || request.api_key.len() > 2_048 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(url) = pmdb_url(&request.path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(_permit) = state.pmdb_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    match pmdb_upstream(method, url, request.api_key, request.body).await {
        Ok(result) => Json(result).into_response(),
        Err(status) => status.into_response(),
    }
}

/// Proxy MDBList API and OAuth calls only to its fixed HTTPS API origin. Any
/// account credential reaches this route only after the device authenticates
/// to its configured worker.
async fn proxy_mdblist(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MdblistRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    if request
        .bearer_token
        .as_ref()
        .is_some_and(|value| value.trim().is_empty() || value.len() > 2_048)
        || request
            .api_key
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 2_048)
        || (request.bearer_token.is_some() && request.api_key.is_some())
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let content_type = request
        .content_type
        .as_deref()
        .unwrap_or("application/json");
    if !matches!(
        content_type,
        "application/json" | "application/x-www-form-urlencoded"
    ) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(mut url) = mdblist_url(&request.path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if let Some(api_key) = request.api_key.as_deref() {
        url.query_pairs_mut().append_pair("apikey", api_key);
    }
    let Ok(_permit) = state.pmdb_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    match mdblist_upstream(
        method,
        url,
        request.bearer_token,
        content_type,
        request.body,
    )
    .await
    {
        Ok(result) => Json(result).into_response(),
        Err(status) => status.into_response(),
    }
}

/// Proxy Trakt API requests only to its fixed HTTPS API origin. Trakt tokens,
/// client identifiers and user-provided OAuth secrets are forwarded only to
/// Trakt after the device authenticates to its configured worker.
async fn proxy_trakt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<TraktRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "DELETE" => Method::DELETE,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > 1024 * 1024)
        || request.headers.iter().any(|(name, value)| {
            !matches!(
                name.to_ascii_lowercase().as_str(),
                "content-type" | "trakt-api-key" | "trakt-api-version" | "authorization"
            ) || value.len() > 4_096
                || value.contains(['\r', '\n'])
        })
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(url) = trakt_url(&request.path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(_permit) = state.pmdb_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    match trakt_upstream(method, url, request.headers, request.body).await {
        Ok(result) => Json(result).into_response(),
        Err(status) => status.into_response(),
    }
}

/// Relay the small set of TorBox operations used by Aurales to its fixed API
/// origin. The user's token is forwarded only after authenticating to this
/// worker and is never persisted by the worker.
async fn proxy_torbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<TorboxRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    if request
        .token
        .as_ref()
        .is_some_and(|token| token.trim().is_empty() || token.len() > 2_048)
        || request
            .body
            .as_ref()
            .is_some_and(|body| body.len() > 1024 * 1024)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let content_type = request
        .content_type
        .as_deref()
        .unwrap_or("application/json");
    if !matches!(
        content_type,
        "application/json" | "application/x-www-form-urlencoded"
    ) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(url) = torbox_url(&request.path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(_permit) = state.pmdb_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    match torbox_upstream(method, url, request.token, content_type, request.body).await {
        Ok(result) => Json(result).into_response(),
        Err(status) => status.into_response(),
    }
}

/// Relay the existing Aurales Sync auth and batch contracts to the one
/// first-party service origin. Credentials and sync records are transient and
/// are forwarded only after this device authenticates to its configured worker.
async fn proxy_aurales_sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AuralesSyncRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key) {
        return unauthorized();
    }
    if request.method != "POST"
        || !matches!(
            request.path.as_str(),
            "/v1/auth/login" | "/v1/auth/register" | "/v1/sync"
        )
        || request.body.len() > 10 * 1024 * 1024
        || request.body.is_empty()
        || request.bearer_token.as_ref().is_some_and(|token| {
            token.trim().is_empty() || token.len() > 8_192 || token.contains(['\r', '\n'])
        })
        || (request.path == "/v1/sync") != request.bearer_token.is_some()
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(url) = aurales_sync_url(&request.path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(_permit) = state.pmdb_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    match aurales_sync_upstream(url, request.bearer_token, request.body).await {
        Ok(result) => Json(result).into_response(),
        Err(status) => status.into_response(),
    }
}

fn aurales_sync_url(path: &str) -> Result<url::Url, ()> {
    if !matches!(path, "/v1/auth/login" | "/v1/auth/register" | "/v1/sync") {
        return Err(());
    }
    let url = url::Url::parse(&format!("https://sync.febsho.me{path}")).map_err(|_| ())?;
    if url.scheme() != "https"
        || url.host_str() != Some("sync.febsho.me")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != path
        || url.query().is_some()
    {
        return Err(());
    }
    Ok(url)
}

async fn aurales_sync_upstream(
    url: url::Url,
    bearer_token: Option<String>,
    body: String,
) -> Result<ProviderProxyResponse, StatusCode> {
    const MAX_SYNC_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let address = resolve_public_address(&url)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let host = url.host_str().ok_or(StatusCode::BAD_GATEWAY)?;
    let port = url.port_or_known_default().ok_or(StatusCode::BAD_GATEWAY)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .resolve(host, SocketAddr::new(address, port))
        .build()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut upstream = client
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(token) = bearer_token {
        upstream = upstream.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = upstream
        .body(body)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();
    if status.is_redirection()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_SYNC_RESPONSE_BYTES as u64)
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_SYNC_RESPONSE_BYTES {
            return Err(StatusCode::BAD_GATEWAY);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ProviderProxyResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn torbox_url(path: &str) -> Result<url::Url, ()> {
    let raw_path = path.split('?').next().unwrap_or(path);
    if path.len() > 8_192
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '#'])
        || raw_path.to_ascii_lowercase().contains("%2e")
        || raw_path.split('/').any(|part| part == "." || part == "..")
    {
        return Err(());
    }
    let allowed = [
        "/user/auth/device/start",
        "/user/auth/device/token",
        "/user/me",
        "/torrents/checkcached",
        "/torrents/mylist",
        "/torrents/createtorrent",
        "/torrents/requestdl",
    ];
    if !allowed.contains(&raw_path) {
        return Err(());
    }
    let url = url::Url::parse(&format!("https://api.torbox.app/v1/api{path}")).map_err(|_| ())?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.torbox.app")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != format!("/v1/api{raw_path}")
    {
        return Err(());
    }
    Ok(url)
}

async fn torbox_upstream(
    method: Method,
    url: url::Url,
    token: Option<String>,
    content_type: &str,
    body: Option<String>,
) -> Result<ProviderProxyResponse, StatusCode> {
    const MAX_TORBOX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let address = resolve_public_address(&url)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let host = url.host_str().ok_or(StatusCode::BAD_GATEWAY)?;
    let port = url.port_or_known_default().ok_or(StatusCode::BAD_GATEWAY)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .resolve(host, SocketAddr::new(address, port))
        .build()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut upstream = client
        .request(method, url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, content_type);
    if let Some(token) = token {
        upstream = upstream.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(body) = body {
        upstream = upstream.body(body);
    }
    let response = upstream.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();
    if status.is_redirection()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_TORBOX_RESPONSE_BYTES as u64)
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_TORBOX_RESPONSE_BYTES {
            return Err(StatusCode::BAD_GATEWAY);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ProviderProxyResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn trakt_url(path: &str) -> Result<url::Url, ()> {
    let raw_path = path.split('?').next().unwrap_or(path);
    let lower_path = raw_path.to_ascii_lowercase();
    if path.len() > 8_192
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || lower_path.contains("%2e")
        || lower_path.contains("%2f")
        || lower_path.contains("%5c")
        || path
            .split(['?', '/'])
            .any(|segment| segment == "." || segment == "..")
    {
        return Err(());
    }
    let url = url::Url::parse(&format!("https://api.trakt.tv{path}")).map_err(|_| ())?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.trakt.tv")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(());
    }
    Ok(url)
}

fn mdblist_url(path: &str) -> Result<url::Url, ()> {
    let raw_path = path.split('?').next().unwrap_or(path);
    let lower_path = raw_path.to_ascii_lowercase();
    if path.len() > 8_192
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || lower_path.contains("%2e")
        || lower_path.contains("%2f")
        || lower_path.contains("%5c")
        || path
            .split(['?', '/'])
            .any(|segment| segment == "." || segment == "..")
    {
        return Err(());
    }
    let url = url::Url::parse(&format!("https://api.mdblist.com{path}")).map_err(|_| ())?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.mdblist.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(());
    }
    Ok(url)
}

async fn mdblist_upstream(
    method: Method,
    url: url::Url,
    bearer_token: Option<String>,
    content_type: &str,
    body: Option<String>,
) -> Result<ProviderProxyResponse, StatusCode> {
    const MAX_MDBLIST_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    if body.as_ref().is_some_and(|value| value.len() > 1024 * 1024) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let address = resolve_public_address(&url)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let host = url.host_str().ok_or(StatusCode::BAD_GATEWAY)?;
    let port = url.port_or_known_default().ok_or(StatusCode::BAD_GATEWAY)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .resolve(host, SocketAddr::new(address, port))
        .build()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut upstream = client
        .request(method, url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, content_type);
    if let Some(token) = bearer_token {
        upstream = upstream.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(body) = body {
        upstream = upstream.body(body);
    }
    let response = upstream.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();
    if status.is_redirection()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_MDBLIST_RESPONSE_BYTES as u64)
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_MDBLIST_RESPONSE_BYTES {
            return Err(StatusCode::BAD_GATEWAY);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ProviderProxyResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

async fn trakt_upstream(
    method: Method,
    url: url::Url,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ProviderProxyResponse, StatusCode> {
    const MAX_TRAKT_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    if body.as_ref().is_some_and(|value| value.len() > 1024 * 1024) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let address = resolve_public_address(&url)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let host = url.host_str().ok_or(StatusCode::BAD_GATEWAY)?;
    let port = url.port_or_known_default().ok_or(StatusCode::BAD_GATEWAY)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .resolve(host, SocketAddr::new(address, port))
        .build()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut upstream = client.request(method, url);
    for (name, value) in headers {
        let name = match name.to_ascii_lowercase().as_str() {
            "content-type" => reqwest::header::CONTENT_TYPE,
            "trakt-api-key" => reqwest::header::HeaderName::from_static("trakt-api-key"),
            "trakt-api-version" => reqwest::header::HeaderName::from_static("trakt-api-version"),
            "authorization" => reqwest::header::AUTHORIZATION,
            _ => return Err(StatusCode::BAD_REQUEST),
        };
        let value =
            reqwest::header::HeaderValue::from_str(&value).map_err(|_| StatusCode::BAD_REQUEST)?;
        upstream = upstream.header(name, value);
    }
    if let Some(body) = body {
        upstream = upstream.body(body);
    }
    let response = upstream.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();
    if status.is_redirection()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_TRAKT_RESPONSE_BYTES as u64)
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_TRAKT_RESPONSE_BYTES {
            return Err(StatusCode::BAD_GATEWAY);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ProviderProxyResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn pmdb_url(path: &str) -> Result<url::Url, ()> {
    let raw_path = path.split('?').next().unwrap_or(path);
    let lower_path = raw_path.to_ascii_lowercase();
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || lower_path.contains("%2e")
        || lower_path.contains("%2f")
        || lower_path.contains("%5c")
        || path
            .split(['?', '/'])
            .any(|segment| segment == "." || segment == "..")
    {
        return Err(());
    }
    let url =
        url::Url::parse(&format!("https://publicmetadb.com/api/external{path}")).map_err(|_| ())?;
    if url.scheme() != "https"
        || url.host_str() != Some("publicmetadb.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !(url.path() == "/api/external" || url.path().starts_with("/api/external/"))
    {
        return Err(());
    }
    Ok(url)
}

async fn pmdb_upstream(
    method: Method,
    url: url::Url,
    api_key: String,
    body: Option<String>,
) -> Result<ProviderProxyResponse, StatusCode> {
    const MAX_PMDB_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let address = resolve_public_address(&url)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let host = url.host_str().ok_or(StatusCode::BAD_GATEWAY)?;
    let port = url.port_or_known_default().ok_or(StatusCode::BAD_GATEWAY)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .resolve(host, SocketAddr::new(address, port))
        .build()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut request = client
        .request(method, url)
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(body) = body {
        if body.len() > 1024 * 1024 {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        request = request.body(body);
    }
    let response = request.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = response.status();
    if status.is_redirection() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PMDB_RESPONSE_BYTES as u64)
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_PMDB_RESPONSE_BYTES {
            return Err(StatusCode::BAD_GATEWAY);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ProviderProxyResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

async fn probe_upstream(
    state: &AppState,
    url: String,
    timeout: Duration,
) -> Result<StreamProbeResponse, StatusCode> {
    let started = std::time::Instant::now();
    let deadline = Instant::now() + timeout;
    let mut url = url::Url::parse(&url).map_err(|_| StatusCode::BAD_REQUEST)?;
    for redirect in 0..=MAX_MEDIA_REDIRECTS {
        if validate_media_url(&url, &state.allowed_media_hosts).is_err() {
            return Err(StatusCode::FORBIDDEN);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(StatusCode::GATEWAY_TIMEOUT);
        }
        let address = tokio::time::timeout(
            remaining.min(Duration::from_secs(5)),
            resolve_public_address(&url),
        )
        .await
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?
        .map_err(|_| StatusCode::FORBIDDEN)?;
        let host = url.host_str().ok_or(StatusCode::FORBIDDEN)?;
        let port = url.port_or_known_default().ok_or(StatusCode::FORBIDDEN)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(remaining.min(Duration::from_secs(10)))
            .timeout(remaining)
            .resolve(host, SocketAddr::new(address, port))
            .build()
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let response = match client
            .get(url.clone())
            .header(RANGE, format!("bytes=0-{}", SAMPLE_BYTES - 1))
            .header(reqwest::header::ACCEPT, "*/*")
            .header(
                reqwest::header::USER_AGENT,
                concat!(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ",
                    "AppleWebKit/537.36 (KHTML, like Gecko) Aurales/",
                    env!("CARGO_PKG_VERSION"),
                    " Safari/537.36"
                ),
            )
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return Err(StatusCode::BAD_GATEWAY),
        };
        if response.status().is_redirection() {
            if redirect == MAX_MEDIA_REDIRECTS {
                return Err(StatusCode::BAD_GATEWAY);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(StatusCode::BAD_GATEWAY)?;
            url = url.join(location).map_err(|_| StatusCode::BAD_GATEWAY)?;
            continue;
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let accept_ranges = accepts_byte_ranges(
            status,
            response
                .headers()
                .get(ACCEPT_RANGES)
                .and_then(|value| value.to_str().ok()),
        );
        let content_length = total_content_length(
            status,
            response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok()),
            response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()),
        );
        let mut stream = response.bytes_stream();
        let mut sampled_bytes = 0;
        while sampled_bytes < SAMPLE_BYTES {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(StatusCode::GATEWAY_TIMEOUT);
            }
            let chunk = match tokio::time::timeout(remaining, stream.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(Some(Err(_))) => return Err(StatusCode::BAD_GATEWAY),
                Err(_) => return Err(StatusCode::GATEWAY_TIMEOUT),
                Ok(None) => break,
            };
            sampled_bytes += (chunk.len() as u64).min(SAMPLE_BYTES - sampled_bytes);
        }
        return Ok(StreamProbeResponse {
            status,
            content_type,
            accept_ranges,
            content_length,
            final_url: url.to_string(),
            sampled_bytes,
            elapsed_ms: started.elapsed().as_millis().max(1) as u64,
        });
    }
    Err(StatusCode::BAD_GATEWAY)
}

fn is_authorized(headers: &HeaderMap, api_key: &[u8]) -> bool {
    let Some(header) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(provided) = header.strip_prefix("Bearer ") else {
        return false;
    };
    provided.len() == api_key.len() && bool::from(provided.as_bytes().ct_eq(api_key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[test]
    fn rejects_wildcard_and_non_https_cors_origins() {
        assert!(parse_origins("*").is_err());
        assert!(parse_origins("http://example.com").is_err());
        assert!(parse_origins("http://localhost:5174").is_ok());
    }

    #[tokio::test]
    async fn ffmpeg_remux_and_selective_transcodes_produce_browser_mp4() {
        let ffmpeg = PathBuf::from("ffmpeg");
        let ffprobe = PathBuf::from("ffprobe");
        let ffmpeg_ready = tokio::process::Command::new(&ffmpeg)
            .arg("-version")
            .output()
            .await;
        let ffprobe_ready = tokio::process::Command::new(&ffprobe)
            .arg("-version")
            .output()
            .await;
        if !ffmpeg_ready.is_ok_and(|result| result.status.success())
            || !ffprobe_ready.is_ok_and(|result| result.status.success())
        {
            eprintln!("Skipping FFmpeg conversion integration: ffmpeg/ffprobe is not installed");
            return;
        }

        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/browser/fixtures");
        let dir = std::env::temp_dir().join(format!(
            "aurales-ffmpeg-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let h264_opus = dir.join("h264-opus.mkv");
        let mut make_opus = tokio::process::Command::new(&ffmpeg);
        make_opus
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(fixtures.join("h264-aac.mp4"))
            .args([
                "-c:v", "copy", "-c:a", "libopus", "-b:a", "64k", "-f", "matroska",
            ])
            .arg(&h264_opus);
        let generated = make_opus.output().await.unwrap();
        assert!(
            generated.status.success(),
            "failed to prepare H.264/Opus fixture"
        );

        let cases = [
            (
                "remux",
                fixtures.join("h264-aac.mp4"),
                ConversionMode::Remux,
            ),
            ("audio-aac", h264_opus, ConversionMode::AudioAac),
            (
                "h264-aac",
                fixtures.join("vp8-opus.webm"),
                ConversionMode::H264Aac,
            ),
        ];
        for (name, input, mode) in cases {
            let output = dir.join(format!("{name}.mp4"));
            let bytes = transcode_local_input(&ffmpeg, &input, &output, mode)
                .await
                .unwrap();
            assert!(bytes > 0);
            let probe = tokio::process::Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_name",
                    "-of",
                    "csv=p=0",
                ])
                .arg(&output)
                .output()
                .await
                .unwrap();
            assert!(probe.status.success(), "ffprobe rejected {name} output");
            let codecs = String::from_utf8_lossy(&probe.stdout);
            assert!(
                codecs.lines().any(|codec| codec == "h264"),
                "{name} output is not H.264: {codecs}"
            );
            assert!(
                codecs.lines().any(|codec| codec == "aac"),
                "{name} output is not AAC: {codecs}"
            );
        }
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn origin_must_not_include_a_path_or_credentials() {
        assert!(parse_origins("https://aurales.example/app").is_err());
        assert!(parse_origins("https://user:pass@aurales.example").is_err());
        assert!(parse_origins("https://aurales.example").is_ok());
    }

    #[test]
    fn local_media_range_parser_handles_closed_open_and_suffix_ranges() {
        assert_eq!(parse_byte_range("bytes=2-5", 10), Ok(Some((2, 5))));
        assert_eq!(parse_byte_range("bytes=7-", 10), Ok(Some((7, 9))));
        assert_eq!(parse_byte_range("bytes=-4", 10), Ok(Some((6, 9))));
        assert_eq!(parse_byte_range("bytes=-40", 10), Ok(Some((0, 9))));
    }

    #[test]
    fn local_media_range_parser_rejects_invalid_and_multi_ranges() {
        assert!(parse_byte_range("items=0-1", 10).is_err());
        assert!(parse_byte_range("bytes=2-1", 10).is_err());
        assert!(parse_byte_range("bytes=10-", 10).is_err());
        assert!(parse_byte_range("bytes=0-1,4-5", 10).is_err());
        assert!(parse_byte_range("bytes=-0", 10).is_err());
        assert!(parse_byte_range("bytes=0-0", 0).is_err());
    }

    #[test]
    fn media_allowlist_requires_exact_dns_names_and_https_urls() {
        let allowed = parse_allowed_hosts("cdn.example, media.example").unwrap();
        assert!(validate_media_url(
            &url::Url::parse("https://cdn.example/video.mp4?sig=private").unwrap(),
            &allowed
        )
        .is_ok());
        assert!(validate_media_url(
            &url::Url::parse("http://cdn.example/video.mp4").unwrap(),
            &allowed
        )
        .is_err());
        assert!(validate_media_url(
            &url::Url::parse("https://other.example/video.mp4").unwrap(),
            &allowed
        )
        .is_err());
        assert!(parse_allowed_hosts("*.example").is_err());
        assert!(parse_allowed_hosts("127.0.0.1").is_err());
        assert!(parse_allowed_hosts("cdn.example:8443").is_err());
    }

    #[test]
    fn media_proxy_rejects_non_public_addresses_and_signatures_are_bound_to_expiry() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "192.168.1.5",
            "192.88.99.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:2::1",
            "2001:20::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        let key = b"unit-test-session-signing-key-at-least-32-bytes";
        let signature = sign_session(key, "0123456789abcdef0123456789abcdef", 1234).unwrap();
        assert!(verify_session(
            key,
            "0123456789abcdef0123456789abcdef",
            1234,
            &signature
        ));
        assert!(!verify_session(
            key,
            "0123456789abcdef0123456789abcdef",
            1235,
            &signature
        ));
    }

    #[test]
    fn hls_manifest_parser_rewrites_segment_key_map_and_variant_uris() {
        let manifest = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/en.m3u8\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nsegments/001.ts\n";
        let spans = playlist_uri_spans(manifest).unwrap();
        let replacements = HashMap::from([
            ("audio/en.m3u8".to_string(), "/audio".to_string()),
            ("keys/key.bin".to_string(), "/key".to_string()),
            ("init.mp4".to_string(), "/init".to_string()),
            ("segments/001.ts".to_string(), "/segment".to_string()),
        ]);
        let rewritten = replace_playlist_uris(manifest, &spans, &replacements).unwrap();
        assert!(rewritten.contains("URI=\"/audio\""));
        assert!(rewritten.contains("URI=\"/key\""));
        assert!(rewritten.contains("URI=\"/init\""));
        assert!(rewritten.ends_with("/segment\n"));
    }

    #[test]
    fn hls_manifest_parser_preserves_non_http_uri_schemes() {
        let manifest = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://asset-id\"\n";
        let spans = playlist_uri_spans(manifest).unwrap();
        let rewritten = replace_playlist_uris(manifest, &spans, &HashMap::new()).unwrap();
        assert_eq!(rewritten, manifest);
    }

    #[tokio::test]
    async fn hls_child_registration_rejects_cycles_and_reuses_valid_resources() {
        let root_id = "0123456789abcdef0123456789abcdef";
        let root_url = url::Url::parse("https://cdn.example/master.m3u8").unwrap();
        let state = AppState {
            api_key: Arc::new(vec![b'x'; 32]),
            ranking_slots: Arc::new(Semaphore::new(4)),
            session_key: Arc::new(b"unit-test-session-signing-key-at-least-32-bytes".to_vec()),
            allowed_media_hosts: Arc::new(parse_allowed_hosts("cdn.example").unwrap()),
            media_sessions: Arc::new(Mutex::new(HashMap::from([(
                root_id.to_string(),
                MediaSession {
                    url: root_url.clone(),
                    local_file: None,
                    expires_at: Instant::now() + MEDIA_SESSION_TTL,
                    children: HashMap::new(),
                    is_root: true,
                    parent_id: None,
                    nesting_depth: 0,
                },
            )]))),
            media_slots: Arc::new(Semaphore::new(16)),
            probe_slots: Arc::new(Semaphore::new(8)),
            pmdb_slots: Arc::new(Semaphore::new(8)),
            ffmpeg_path: None,
            ffmpeg_caps: None,
            conversion_dir: Arc::new(std::env::temp_dir().join("aurales-media-worker-test")),
            conversion_slots: Arc::new(Semaphore::new(2)),
            conversion_jobs: Arc::new(Mutex::new(HashMap::new())),
        };
        let expires_at = Instant::now() + MEDIA_SESSION_TTL;
        let targets = vec![
            (
                "segments/001.ts".to_string(),
                url::Url::parse("https://cdn.example/segments/001.ts").unwrap(),
            ),
            ("master.m3u8".to_string(), root_url),
        ];
        assert_eq!(
            register_child_sessions(&state, root_id, 1_800_000_000, expires_at, targets).await,
            Err(StatusCode::BAD_GATEWAY)
        );
        assert_eq!(state.media_sessions.lock().await.len(), 1);

        let segment = url::Url::parse("https://cdn.example/segments/001.ts").unwrap();
        let first = register_child_sessions(
            &state,
            root_id,
            1_800_000_000,
            expires_at,
            vec![("segments/001.ts".to_string(), segment.clone())],
        )
        .await
        .unwrap();
        let second = register_child_sessions(
            &state,
            root_id,
            1_800_000_000,
            expires_at,
            vec![("segments/001.ts".to_string(), segment)],
        )
        .await
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(state.media_sessions.lock().await.len(), 2);
    }

    #[tokio::test]
    async fn converted_local_media_supports_seekable_range_requests() {
        let path = std::env::temp_dir().join(format!(
            "aurales-test-{}.mp4",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(RANGE, HeaderValue::from_static("bytes=3-6"));
        let response = serve_local_media(
            path.clone(),
            headers,
            Method::GET,
            Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(CONTENT_RANGE).unwrap(),
            "bytes 3-6/10"
        );
        assert_eq!(response.headers().get(CONTENT_LENGTH).unwrap(), "4");
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "3456"
        );
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[test]
    fn api_key_comparison_requires_a_bearer_value_and_exact_length() {
        let key = b"a-private-api-key-that-is-long-enough";
        let mut headers = HeaderMap::new();
        assert!(!is_authorized(&headers, key));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer shorter"));
        assert!(!is_authorized(&headers, key));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer a-private-api-key-that-is-long-enough"),
        );
        assert!(is_authorized(&headers, key));
    }

    #[test]
    fn pmdb_proxy_is_restricted_to_the_fixed_external_api_origin() {
        assert_eq!(
            pmdb_url("/resume?perPage=5&page=1").unwrap().as_str(),
            "https://publicmetadb.com/api/external/resume?perPage=5&page=1"
        );
        for path in [
            "https://attacker.example/api/external/resume",
            "//attacker.example/api/external/resume",
            "/../admin",
            "/\\\\admin",
            "/resume#fragment",
            "/%2e%2e/admin",
            "/%2f%2fattacker.example/path",
        ] {
            assert!(pmdb_url(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn mdblist_proxy_is_restricted_to_the_fixed_https_api_origin() {
        assert_eq!(
            mdblist_url("/oauth/token/?grant_type=refresh_token")
                .unwrap()
                .as_str(),
            "https://api.mdblist.com/oauth/token/?grant_type=refresh_token"
        );
        for path in [
            "https://attacker.example/oauth/token/",
            "//attacker.example/oauth/token/",
            "/../admin",
            "/\\\\admin",
            "/oauth/token/#fragment",
            "/%2e%2e/admin",
            "/%2f%2fattacker.example/path",
        ] {
            assert!(mdblist_url(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn trakt_proxy_is_restricted_to_the_fixed_https_api_origin() {
        assert_eq!(
            trakt_url("/oauth/token").unwrap().as_str(),
            "https://api.trakt.tv/oauth/token"
        );
        assert_eq!(
            trakt_url("/users/me/watchlist/movies?extended=full")
                .unwrap()
                .host_str(),
            Some("api.trakt.tv")
        );
        for path in [
            "https://evil.example/path",
            "//evil.example/path",
            "/../admin",
            "/%2e%2e/admin",
            "/%2F%2Fevil.example",
            "/\\\\evil.example",
            "/path#fragment",
        ] {
            assert!(trakt_url(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn torbox_proxy_is_restricted_to_aurales_operations_on_the_fixed_api_origin() {
        assert_eq!(
            torbox_url("/torrents/checkcached?format=list")
                .unwrap()
                .as_str(),
            "https://api.torbox.app/v1/api/torrents/checkcached?format=list"
        );
        assert_eq!(
            torbox_url("/user/auth/device/start?app=Aurales")
                .unwrap()
                .host_str(),
            Some("api.torbox.app")
        );
        for path in [
            "https://evil.example/a",
            "//evil.example/a",
            "/../user/me",
            "/torrents/delete",
            "/torrents/%2e%2e/admin",
            "/user/me#fragment",
            "/\\\\evil.example",
        ] {
            assert!(torbox_url(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn aurales_sync_proxy_accepts_only_fixed_first_party_routes() {
        assert_eq!(
            aurales_sync_url("/v1/auth/login").unwrap().as_str(),
            "https://sync.febsho.me/v1/auth/login"
        );
        assert_eq!(
            aurales_sync_url("/v1/sync").unwrap().host_str(),
            Some("sync.febsho.me")
        );
        for path in [
            "//attacker.example/v1/sync",
            "/v1/auth/delete",
            "/v1/sync?redirect=https://evil.example",
            "/../v1/sync",
        ] {
            assert!(aurales_sync_url(path).is_err(), "accepted {path}");
        }
    }

    #[tokio::test]
    async fn rank_endpoint_authenticates_and_calls_the_shared_rust_scorer() {
        let key = "a-private-worker-key-that-exceeds-32-bytes";
        let origins = parse_origins("https://app.example").unwrap();
        let state = AppState {
            api_key: Arc::new(key.as_bytes().to_vec()),
            ranking_slots: Arc::new(Semaphore::new(4)),
            session_key: Arc::new(b"unit-test-session-signing-key-at-least-32-bytes".to_vec()),
            allowed_media_hosts: Arc::new(HashSet::new()),
            media_sessions: Arc::new(Mutex::new(HashMap::new())),
            media_slots: Arc::new(Semaphore::new(16)),
            probe_slots: Arc::new(Semaphore::new(8)),
            pmdb_slots: Arc::new(Semaphore::new(8)),
            ffmpeg_path: None,
            ffmpeg_caps: None,
            conversion_dir: Arc::new(std::env::temp_dir().join("aurales-media-worker-test")),
            conversion_slots: Arc::new(Semaphore::new(2)),
            conversion_jobs: Arc::new(Mutex::new(HashMap::new())),
        };
        let app = router(state, origins);
        let capabilities_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/capabilities")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let capabilities_body = capabilities_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let capabilities_json: Value = serde_json::from_slice(&capabilities_body).unwrap();
        assert_eq!(capabilities_json["mediaDirectProxy"], false);
        assert_eq!(capabilities_json["pmdbProxy"], true);
        assert_eq!(capabilities_json["mdblistProxy"], true);
        assert_eq!(capabilities_json["traktProxy"], true);
        assert_eq!(capabilities_json["torboxProxy"], true);
        assert_eq!(capabilities_json["auralesSyncProxy"], true);

        let conversion_disabled = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/media/conversions")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"url":"https://cdn.example/video.mkv","mode":"remux"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            conversion_disabled.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );

        let unauthorized_pmdb_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/pmdb")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"/resume","apiKey":"pm-secret"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            unauthorized_pmdb_response.status(),
            StatusCode::UNAUTHORIZED
        );
        let unauthorized_mdblist_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/mdblist")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"POST","path":"/oauth/token/","body":"grant_type=authorization_code","contentType":"application/x-www-form-urlencoded"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            unauthorized_mdblist_response.status(),
            StatusCode::UNAUTHORIZED
        );
        let unauthorized_torbox_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/torbox")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"/user/me","token":"private"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            unauthorized_torbox_response.status(),
            StatusCode::UNAUTHORIZED
        );
        let invalid_torbox_path_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/torbox")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"/torrents/delete","token":"private"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            invalid_torbox_path_response.status(),
            StatusCode::BAD_REQUEST
        );
        let unauthorized_sync_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/aurales-sync")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"POST","path":"/v1/sync","bearerToken":"account-token","body":"{}"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            unauthorized_sync_response.status(),
            StatusCode::UNAUTHORIZED
        );
        let invalid_sync_path_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/aurales-sync")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"POST","path":"/v1/auth/admin","body":"{}"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid_sync_path_response.status(), StatusCode::BAD_REQUEST);
        let large_sync_body = format!(
            r#"{{"method":"POST","path":"/v1/auth/admin","body":"{}"}}"#,
            "x".repeat(1024 * 1024 + 1)
        );
        let large_sync_relay_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/aurales-sync")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(large_sync_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(large_sync_relay_response.status(), StatusCode::BAD_REQUEST);
        let unauthorized_trakt_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/trakt")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"/users/settings","headers":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            unauthorized_trakt_response.status(),
            StatusCode::UNAUTHORIZED
        );
        let invalid_pmdb_path_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/pmdb")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"//attacker.example/","apiKey":"pm-secret"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid_pmdb_path_response.status(), StatusCode::BAD_REQUEST);
        let invalid_mdblist_path_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/mdblist")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"//attacker.example/","bearerToken":"mdblist-token"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            invalid_mdblist_path_response.status(),
            StatusCode::BAD_REQUEST
        );
        let invalid_trakt_path_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/trakt")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"//attacker.example/","headers":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            invalid_trakt_path_response.status(),
            StatusCode::BAD_REQUEST
        );
        let invalid_trakt_header_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/providers/trakt")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"method":"GET","path":"/users/settings","headers":{"x-forwarded-host":"attacker.example"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            invalid_trakt_header_response.status(),
            StatusCode::BAD_REQUEST
        );

        let session_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/media/sessions")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"url":"https://cdn.example/video.mp4"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(session_response.status(), StatusCode::UNAUTHORIZED);

        let disabled_session_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/media/sessions")
                    .header(CONTENT_TYPE, "application/json")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .body(Body::from(r#"{"url":"https://cdn.example/video.mp4"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            disabled_session_response.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );

        let probe_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/media/probe")
                    .header(CONTENT_TYPE, "application/json")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .body(Body::from(
                        r#"{"url":"https://cdn.example/video.mp4","timeoutMs":1000}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(probe_response.status(), StatusCode::SERVICE_UNAVAILABLE);

        let unauthorized_probe = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/media/probe")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"url":"https://cdn.example/video.mp4"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized_probe.status(), StatusCode::UNAUTHORIZED);

        let payload = serde_json::json!({
            "streams": [
                { "url": "https://cdn.example/movie.mp4", "title": "Example 1080p WEB-DL", "name": "Example Movie", "addonId": "addon", "addonName": "Addon" },
                { "url": "https://cdn.example/bad.mp4", "title": "Example Movie fake trailer 2160p", "name": "Example Movie", "addonId": "other", "addonName": "Other" }
            ],
            "context": { "title": "Example Movie", "mode": "best", "player": "web" }
        });
        let unauthorized = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/streams/rank")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/streams/rank")
                    .header(CONTENT_TYPE, "application/json")
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["candidates"][0]["stream"]["addonId"], "addon");
        assert_eq!(json["candidates"][0]["score"].as_f64(), Some(72.0));
    }
}
