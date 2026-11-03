use aurales_domain::media_probe::{
    accepts_byte_ranges, total_content_length, StreamProbeResponse, SAMPLE_BYTES,
};
use aurales_domain::streams::{rank_streams, RankStreamCandidatesResponse, SmartScoreContext};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{
    ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    COOKIE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE, SET_COOKIE,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use quick_xml::events::Event as XmlEvent;
use quick_xml::reader::Reader as XmlReader;
use quick_xml::XmlVersion;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
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
const DEFAULT_MAX_CONVERSION_GIB: u64 = 8;
const MAX_CONFIGURED_CONVERSION_GIB: u64 = 64;
static MAX_CONVERSION_BYTES: OnceLock<u64> = OnceLock::new();
const DEFAULT_CONVERSION_TIMEOUT_MINUTES: u64 = 120;
const MAX_CONVERSION_TIMEOUT_MINUTES: u64 = 1_440;
static MAX_CONVERSION_RUNTIME_SECONDS: OnceLock<u64> = OnceLock::new();
const MAX_CONVERTED_SUBTITLE_TRACKS: usize = 8;
const MAX_CONVERTED_AUDIO_TRACKS: usize = 8;
const MAX_CONVERTED_SUBTITLE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_DASH_XML_NODES: usize = 65_536;
const MAX_DASH_XML_DEPTH: usize = 64;
const MAX_DASH_PERIODS: usize = 128;
const ACCESS_COOKIE: &str = "aurales_worker_session";
const ACCESS_SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const MAX_ACCESS_ATTEMPTS: usize = 8;
const ACCESS_ATTEMPT_WINDOW: Duration = Duration::from_secs(15 * 60);

fn conversion_limit_from_gib(value: Option<&str>) -> Result<u64, String> {
    let gib = match value {
        Some(value) => value.trim().parse::<u64>().map_err(|_| {
            "AURALES_MEDIA_MAX_CONVERSION_GIB must be an integer from 1 to 64".to_string()
        })?,
        None => DEFAULT_MAX_CONVERSION_GIB,
    };
    if !(1..=MAX_CONFIGURED_CONVERSION_GIB).contains(&gib) {
        return Err("AURALES_MEDIA_MAX_CONVERSION_GIB must be an integer from 1 to 64".into());
    }
    Ok(gib * 1024 * 1024 * 1024)
}

fn max_conversion_bytes() -> u64 {
    *MAX_CONVERSION_BYTES.get_or_init(|| DEFAULT_MAX_CONVERSION_GIB * 1024 * 1024 * 1024)
}

fn conversion_timeout_from_minutes(value: Option<&str>) -> Result<u64, String> {
    let minutes = match value {
        Some(value) => value.trim().parse::<u64>().map_err(|_| {
            "AURALES_MEDIA_CONVERSION_TIMEOUT_MINUTES must be an integer from 1 to 1440".to_string()
        })?,
        None => DEFAULT_CONVERSION_TIMEOUT_MINUTES,
    };
    if !(1..=MAX_CONVERSION_TIMEOUT_MINUTES).contains(&minutes) {
        return Err(
            "AURALES_MEDIA_CONVERSION_TIMEOUT_MINUTES must be an integer from 1 to 1440".into(),
        );
    }
    Ok(minutes * 60)
}

fn max_conversion_runtime_seconds() -> u64 {
    *MAX_CONVERSION_RUNTIME_SECONDS.get_or_init(|| DEFAULT_CONVERSION_TIMEOUT_MINUTES * 60)
}

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
    conversion_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    access_code: Option<Arc<Vec<u8>>>,
    access_attempts: Arc<Mutex<HashMap<String, (usize, Instant)>>>,
    allowed_origins: Arc<HashSet<String>>,
}

#[derive(Clone)]
struct ConversionJob {
    status: ConversionStatus,
    expires_at: Instant,
}

#[derive(Clone)]
enum ConversionStatus {
    Processing,
    Cancelled,
    Ready {
        path: PathBuf,
        bytes: u64,
        mode: ConversionMode,
        url: String,
        source_info: Value,
        subtitles: Vec<ConvertedSubtitleTrack>,
        live_snapshot: bool,
        audio_tracks_reduced: bool,
    },
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ConversionMode {
    /// Server-owned fallback ladder: stream copy, AAC-only, then H.264/AAC.
    Auto,
    Remux,
    AudioAac,
    H264Aac,
    H264AacLow,
    H264AacCompat,
}

#[derive(Clone, Copy)]
struct FfmpegCapabilities {
    audio_aac: bool,
    video_h264: bool,
    video_hardware_encoder: Option<&'static str>,
    mp4_output: bool,
    hls_output: bool,
}

#[derive(Clone, Debug, Default)]
struct DashNode {
    name: String,
    attributes: HashMap<String, String>,
    text: String,
    children: Vec<DashNode>,
}

impl DashNode {
    fn child(&self, name: &str) -> Option<&DashNode> {
        self.children.iter().find(|child| child.name == name)
    }

    fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a DashNode> {
        self.children.iter().filter(move |child| child.name == name)
    }

    fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes.get(name).map(String::as_str)
    }
}

fn conversion_output_available(
    capabilities: Option<FfmpegCapabilities>,
    format: ConversionOutputFormat,
) -> bool {
    capabilities.is_some_and(|caps| match format {
        ConversionOutputFormat::Mp4 => caps.mp4_output,
        ConversionOutputFormat::Hls => caps.hls_output,
    })
}

#[derive(Clone)]
struct MediaSession {
    url: url::Url,
    request_headers: HashMap<String, String>,
    request_header_origin: String,
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
    media_mp4: bool,
    media_hls: bool,
    audio_transcode: bool,
    video_transcode: bool,
    mobile_safe_video_transcode: bool,
    conversion_timeout_seconds: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMediaSessionRequest {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateMediaConversionRequest {
    url: String,
    mode: ConversionMode,
    #[serde(default)]
    output_format: ConversionOutputFormat,
    #[serde(default)]
    mobile_compatibility: bool,
    #[serde(default)]
    preferred_audio_languages: Vec<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ConversionOutputFormat {
    #[default]
    Mp4,
    Hls,
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
    source_info: Option<Value>,
    subtitles: Option<Vec<ConvertedSubtitleTrack>>,
    live_snapshot: Option<bool>,
    audio_tracks_reduced: Option<bool>,
    error: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConvertedSubtitleTrack {
    url: String,
    lang: String,
    label: String,
    forced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateMediaSessionResponse {
    url: String,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessSessionRequest {
    access_code: String,
}

#[derive(Deserialize)]
struct SignedSession {
    expires: u64,
    signature: String,
    #[serde(flatten)]
    extra_params: HashMap<String, String>,
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
    let conversion_limit = conversion_limit_from_gib(
        std::env::var("AURALES_MEDIA_MAX_CONVERSION_GIB")
            .ok()
            .as_deref(),
    )?;
    MAX_CONVERSION_BYTES
        .set(conversion_limit)
        .map_err(|_| "The conversion size limit was already initialized".to_string())?;
    let conversion_timeout = conversion_timeout_from_minutes(
        std::env::var("AURALES_MEDIA_CONVERSION_TIMEOUT_MINUTES")
            .ok()
            .as_deref(),
    )?;
    MAX_CONVERSION_RUNTIME_SECONDS
        .set(conversion_timeout)
        .map_err(|_| "The conversion runtime limit was already initialized".to_string())?;
    let api_key = std::env::var("AURALES_MEDIA_API_KEY").map_err(|_| {
        "AURALES_MEDIA_API_KEY must be set to a private key of at least 32 bytes".to_string()
    })?;
    if api_key.as_bytes().len() < 32 {
        return Err("AURALES_MEDIA_API_KEY must be at least 32 bytes".into());
    }
    let access_code = std::env::var("AURALES_MEDIA_ACCESS_CODE")
        .ok()
        .filter(|value| !value.is_empty());
    if access_code.as_ref().is_some_and(|value| value.len() < 16) {
        return Err("AURALES_MEDIA_ACCESS_CODE must be at least 16 bytes when configured".into());
    }
    let allowed_media_hosts =
        parse_allowed_hosts(&std::env::var("AURALES_MEDIA_ALLOWED_HOSTS").unwrap_or_default())?;
    let session_key = std::env::var("AURALES_MEDIA_SESSION_KEY").ok();
    let session_key = match session_key {
        Some(key) if key.as_bytes().len() >= 32 => key,
        Some(_) => return Err("AURALES_MEDIA_SESSION_KEY must be at least 32 bytes".into()),
        None if allowed_media_hosts.is_empty() && access_code.is_none() => "media-proxy-disabled-signing-key".to_string(),
        None => return Err(
            "AURALES_MEDIA_SESSION_KEY must be set when media proxying or access-code sessions are configured"
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
    let allowed_origins = origins
        .iter()
        .filter_map(|origin| origin.to_str().ok().map(str::to_owned))
        .collect();
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
        conversion_tasks: Arc::new(Mutex::new(HashMap::new())),
        access_code: access_code.map(|value| Arc::new(value.into_bytes())),
        access_attempts: Arc::new(Mutex::new(HashMap::new())),
        allowed_origins: Arc::new(allowed_origins),
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
    let ffprobe = ffprobe_path_for(path);
    let probe_version = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(&ffprobe)
            .arg("-version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "FFprobe did not respond within 10 seconds".to_string())?
    .map_err(|_| "Could not start FFprobe; install it alongside FFmpeg or on PATH".to_string())?;
    if !probe_version.status.success() {
        return Err("The FFprobe executable failed its version check".into());
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
    let muxers = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(path)
            .args(["-hide_banner", "-muxers"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "FFmpeg muxer discovery timed out".to_string())?
    .map_err(|error| format!("Could not query FFmpeg muxers: {error}"))?;
    let muxer_output = format!(
        "{}{}",
        String::from_utf8_lossy(&muxers.stdout),
        String::from_utf8_lossy(&muxers.stderr)
    );
    let has_muxer = |target: &str| {
        muxer_output.lines().any(|line| {
            line.split_whitespace()
                .any(|entry| entry.trim_matches(',') == target)
        })
    };
    Ok(FfmpegCapabilities {
        audio_aac: output
            .lines()
            .any(|line| line.split_whitespace().any(|name| name == "aac")),
        video_h264: output
            .lines()
            .any(|line| line.split_whitespace().any(|name| name == "libx264")),
        video_hardware_encoder: ["h264_videotoolbox", "h264_nvenc", "h264_qsv", "h264_amf"]
            .into_iter()
            .find(|encoder| {
                output
                    .lines()
                    .any(|line| line.split_whitespace().any(|name| name == *encoder))
            }),
        mp4_output: has_muxer("mp4"),
        hls_output: has_muxer("hls") && has_muxer("mpegts"),
    })
}

fn router(state: AppState, origins: Vec<HeaderValue>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, RANGE, IF_RANGE])
        .expose_headers([
            ACCEPT_RANGES,
            CONTENT_LENGTH,
            CONTENT_RANGE,
            CONTENT_TYPE,
            ETAG,
            LAST_MODIFIED,
        ])
        .allow_credentials(true)
        .max_age(std::time::Duration::from_secs(600));
    Router::new()
        .route("/health", get(health))
        .route(
            "/v1/access/session",
            post(create_access_session).delete(delete_access_session),
        )
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
        .route(
            "/v1/media/conversions/{id}",
            get(media_conversion_status).delete(cancel_media_conversion),
        )
        .route(
            "/v1/media/{id}/{*asset}",
            get(proxy_local_media_asset).head(proxy_local_media_asset),
        )
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
        media_remux: state
            .ffmpeg_caps
            .is_some_and(|caps| caps.mp4_output || caps.hls_output),
        media_transcode: state.ffmpeg_caps.is_some_and(|caps| {
            (caps.mp4_output || caps.hls_output) && (caps.audio_aac || caps.video_h264)
        }),
    })
}

async fn create_access_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AccessSessionRequest>,
) -> Response {
    let Some(access_code) = state.access_code.as_deref() else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "access_code_disabled",
            }),
        )
            .into_response();
    };
    if !request_origin_allowed(&headers, &state.allowed_origins) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "origin_not_allowed",
            }),
        )
            .into_response();
    }

    let forwarded_ip = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .unwrap_or("unknown");
    let now = Instant::now();
    {
        let mut attempts = state.access_attempts.lock().await;
        attempts.retain(|_, (_, reset)| *reset > now);
        if attempts
            .get(forwarded_ip)
            .is_some_and(|(count, _)| *count >= MAX_ACCESS_ATTEMPTS)
        {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ErrorResponse {
                    error: "access_rate_limited",
                }),
            )
                .into_response();
        }
    }

    let provided = request.access_code.as_bytes();
    let matches = provided.len() == access_code.len() && bool::from(provided.ct_eq(access_code));
    if !matches {
        let mut attempts = state.access_attempts.lock().await;
        let entry = attempts
            .entry(forwarded_ip.to_string())
            .or_insert((0, now + ACCESS_ATTEMPT_WINDOW));
        entry.0 = entry.0.saturating_add(1);
        if attempts.len() > 4096 {
            attempts.retain(|_, (_, reset)| *reset > now);
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "invalid_access_code",
            }),
        )
            .into_response();
    }
    state.access_attempts.lock().await.remove(forwarded_ip);

    let expires = unix_timestamp().saturating_add(ACCESS_SESSION_TTL_SECONDS);
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let Some(signature) = sign_access_session(&state.session_key, expires, &nonce) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let cookie = format!("{ACCESS_COOKIE}={expires}.{nonce}.{signature}; Path=/v1; HttpOnly; Secure; SameSite=Strict; Max-Age={ACCESS_SESSION_TTL_SECONDS}");
    let mut response = (StatusCode::NO_CONTENT, "").into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(SET_COOKIE, value);
    } else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    response
}

async fn delete_access_session(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !request_origin_allowed(&headers, &state.allowed_origins) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "origin_not_allowed",
            }),
        )
            .into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    let cookie =
        format!("{ACCESS_COOKIE}=; Path=/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    response
}

fn request_origin_allowed(headers: &HeaderMap, allowed_origins: &HashSet<String>) -> bool {
    headers
        .get("origin")
        .and_then(|origin| origin.to_str().ok())
        .is_some_and(|origin| allowed_origins.contains(origin))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn sign_access_session(key: &[u8], expires: u64, nonce: &str) -> Option<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).ok()?;
    mac.update(format!("aurales-worker-access:{expires}:{nonce}").as_bytes());
    Some(
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

fn verify_access_session(headers: &HeaderMap, key: &[u8]) -> bool {
    let Some(cookie_header) = headers.get(COOKIE).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    for cookie in cookie_header.split(';').map(str::trim) {
        let Some(value) = cookie.strip_prefix(&format!("{ACCESS_COOKIE}=")) else {
            continue;
        };
        let mut parts = value.split('.');
        let (Some(expires), Some(nonce), Some(signature)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        if parts.next().is_some()
            || nonce.len() != 32
            || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return false;
        }
        let Ok(expires) = expires.parse::<u64>() else {
            return false;
        };
        if expires <= unix_timestamp() {
            return false;
        }
        let Some(expected) = sign_access_session(key, expires, nonce) else {
            return false;
        };
        return expected.len() == signature.len()
            && bool::from(expected.as_bytes().ct_eq(signature.as_bytes()));
    }
    false
}

async fn capabilities(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
        media_remux: ffmpeg.is_some_and(|caps| caps.mp4_output || caps.hls_output),
        media_mp4: ffmpeg.is_some_and(|caps| caps.mp4_output),
        media_hls: ffmpeg.is_some_and(|caps| caps.hls_output),
        audio_transcode: ffmpeg
            .is_some_and(|caps| (caps.mp4_output || caps.hls_output) && caps.audio_aac),
        video_transcode: ffmpeg.is_some_and(|caps| {
            (caps.mp4_output || caps.hls_output)
                && (caps.video_h264 || caps.video_hardware_encoder.is_some())
        }),
        mobile_safe_video_transcode: ffmpeg.is_some_and(|caps| {
            (caps.mp4_output || caps.hls_output)
                && caps.audio_aac
                && (caps.video_h264 || caps.video_hardware_encoder.is_some())
        }),
        conversion_timeout_seconds: max_conversion_runtime_seconds(),
    })
    .into_response()
}

async fn create_media_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateMediaSessionRequest>,
) -> Response {
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    let Ok(request_headers) = validate_playback_headers(&request.headers) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid_playback_headers",
            }),
        )
            .into_response();
    };
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
    let is_hls = is_hls_playlist(&url, None);
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
            request_header_origin: url.origin().ascii_serialization(),
            url,
            request_headers,
            local_file: None,
            expires_at: Instant::now() + MEDIA_SESSION_TTL,
            children: HashMap::new(),
            is_root: true,
            parent_id: None,
            nesting_depth: 0,
        },
    );
    let stream_url = format!(
        "/v1/media/{id}?expires={expires}&signature={signature}{}",
        if is_hls { "&format=hls" } else { "" }
    );
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    let output_available = conversion_output_available(state.ffmpeg_caps, request.output_format);
    if !output_available {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: match request.output_format {
                    ConversionOutputFormat::Mp4 => "mp4_output_unavailable",
                    ConversionOutputFormat::Hls => "hls_output_unavailable",
                },
            }),
        )
            .into_response();
    }
    let supported = match request.mode {
        ConversionMode::Auto => true,
        ConversionMode::Remux => true,
        ConversionMode::AudioAac => state.ffmpeg_caps.is_some_and(|caps| caps.audio_aac),
        ConversionMode::H264Aac => state.ffmpeg_caps.is_some_and(|caps| {
            caps.audio_aac && (caps.video_h264 || caps.video_hardware_encoder.is_some())
        }),
        ConversionMode::H264AacLow | ConversionMode::H264AacCompat => {
            state.ffmpeg_caps.is_some_and(|caps| {
                caps.audio_aac && (caps.video_h264 || caps.video_hardware_encoder.is_some())
            })
        }
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
    let Ok(request_headers) = validate_playback_headers(&request.headers) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid_playback_headers",
            }),
        )
            .into_response();
    };
    if request.preferred_audio_languages.len() > 16
        || request.preferred_audio_languages.iter().any(|language| {
            language.is_empty()
                || language.len() > 16
                || !language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "invalid_audio_language_preferences",
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
    let tasks = state.conversion_tasks.clone();
    let task = tokio::spawn(run_media_conversion(
        state,
        id.clone(),
        url,
        request.mode,
        request.output_format,
        request.mobile_compatibility,
        request.preferred_audio_languages,
        request_headers,
        ffmpeg,
        permit,
    ));
    // Retain the task handle so a client AbortSignal can stop FFmpeg and its
    // active upstream download. Child processes use kill_on_drop(true).
    tasks.lock().await.insert(id.clone(), task);
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
            source_info: None,
            subtitles: None,
            live_snapshot: None,
            audio_tracks_reduced: None,
            error: None,
        },
        ConversionStatus::Cancelled => MediaConversionStatusResponse {
            job_id: id,
            status: "cancelled",
            mode: None,
            bytes: None,
            url: None,
            source_info: None,
            subtitles: None,
            live_snapshot: None,
            audio_tracks_reduced: None,
            error: None,
        },
        ConversionStatus::Ready {
            bytes,
            mode,
            url,
            source_info,
            subtitles,
            live_snapshot,
            audio_tracks_reduced,
            ..
        } => MediaConversionStatusResponse {
            job_id: id,
            status: "ready",
            mode: Some(*mode),
            bytes: Some(*bytes),
            url: Some(url.clone()),
            source_info: Some(source_info.clone()),
            subtitles: Some(subtitles.clone()),
            live_snapshot: Some(*live_snapshot),
            audio_tracks_reduced: Some(*audio_tracks_reduced),
            error: None,
        },
        ConversionStatus::Failed => MediaConversionStatusResponse {
            job_id: id,
            status: "failed",
            mode: None,
            bytes: None,
            url: None,
            source_info: None,
            subtitles: None,
            live_snapshot: None,
            audio_tracks_reduced: None,
            error: Some("conversion_failed"),
        },
    };
    Json(response).into_response()
}

async fn cancel_media_conversion(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
        return unauthorized();
    }
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(task) = state.conversion_tasks.lock().await.remove(&id) {
        task.abort();
        let _ = task.await;
    }
    let mut removed_paths = Vec::new();
    {
        let mut jobs = state.conversion_jobs.lock().await;
        if let Some(job) = jobs.get_mut(&id) {
            if let ConversionStatus::Ready { path, .. } = &job.status {
                removed_paths.push(path.clone());
            }
            job.status = ConversionStatus::Cancelled;
            job.expires_at = Instant::now() + Duration::from_secs(60);
        }
    }
    {
        let mut sessions = state.media_sessions.lock().await;
        sessions.retain(|_, session| {
            let remove = session
                .local_file
                .as_ref()
                .is_some_and(|path| removed_paths.contains(path));
            !remove
        });
    }
    for name in conversion_artifact_names(&id) {
        let path = state.conversion_dir.join(name);
        let _ = tokio::fs::remove_file(path).await;
    }
    remove_conversion_subtitles(state.conversion_dir.as_ref(), &id).await;
    let _ =
        tokio::fs::remove_dir_all(state.conversion_dir.join(format!("{id}.input-assets"))).await;
    for path in removed_paths {
        let _ = tokio::fs::remove_file(path).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn run_media_conversion(
    state: AppState,
    id: String,
    url: url::Url,
    mode: ConversionMode,
    output_format: ConversionOutputFormat,
    mobile_compatibility: bool,
    preferred_audio_languages: Vec<String>,
    request_headers: HashMap<String, String>,
    ffmpeg: Arc<PathBuf>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let probed_content_type = if is_hls_playlist(&url, None) || is_dash_manifest(&url, None) {
        None
    } else {
        probe_media_content_type(&state, &url, &request_headers).await
    };
    let hls_input = is_hls_playlist(&url, probed_content_type.as_deref());
    let dash_input = is_dash_manifest(&url, probed_content_type.as_deref());
    let input_path = state.conversion_dir.join(if hls_input {
        format!("{id}.input.m3u8")
    } else if dash_input {
        format!("{id}.input.m3u8")
    } else {
        format!("{id}.input")
    });
    let output_path = conversion_output_path(state.conversion_dir.as_ref(), &id, output_format);
    let result = tokio::time::timeout(
        Duration::from_secs(max_conversion_runtime_seconds()),
        async {
            let live_snapshot = if hls_input {
                download_hls_conversion_input(
                    &state,
                    &url,
                    &request_headers,
                    &input_path,
                    &state.conversion_dir.join(format!("{id}.input-assets")),
                    mobile_compatibility,
                )
                .await?
            } else if dash_input {
                download_dash_conversion_input(
                    &state,
                    &url,
                    &request_headers,
                    &input_path,
                    &state.conversion_dir.join(format!("{id}.input-assets")),
                    mobile_compatibility,
                )
                .await?
            } else {
                download_allowlisted_media(&state, &url, &request_headers, &input_path).await?;
                false
            };
            let source_info = probe_local_media(ffmpeg.as_ref(), &input_path).await?;
            let source_audio_track_count = source_info
                .get("streams")
                .and_then(Value::as_array)
                .map(|streams| {
                    streams
                        .iter()
                        .filter(|stream| {
                            stream.get("codec_type").and_then(Value::as_str) == Some("audio")
                        })
                        .count()
                })
                .unwrap_or(0);
            let preferred_audio_track_indices =
                if mobile_compatibility && output_format == ConversionOutputFormat::Mp4 {
                    ordered_audio_track_indices(&source_info, &preferred_audio_languages)
                } else {
                    Vec::new()
                };
            // Let FFmpeg inspect the actual container and streams. Each attempt maps
            // the real streams and validates the target container; the mode reported
            // to the client is the first conversion that FFmpeg can produce.
            let (bytes, actual_mode, ready_path, audio_tracks_reduced) =
                if matches!(mode, ConversionMode::Auto) {
                    let mut result = None;
                    for candidate in conversion_candidates(state.ffmpeg_caps) {
                        let candidate_path = conversion_output_candidate_path(
                            state.conversion_dir.as_ref(),
                            &id,
                            candidate,
                            output_format,
                        );
                        let hardware_encoder = if matches!(
                            candidate,
                            ConversionMode::H264Aac
                                | ConversionMode::H264AacLow
                                | ConversionMode::H264AacCompat
                        ) {
                            state
                                .ffmpeg_caps
                                .and_then(|caps| caps.video_hardware_encoder)
                        } else {
                            None
                        };
                        match transcode_conversion_candidate(
                            ffmpeg.as_ref(),
                            &input_path,
                            &candidate_path,
                            candidate,
                            hardware_encoder,
                            output_format,
                            mobile_compatibility,
                            source_audio_track_count,
                            &preferred_audio_track_indices,
                        )
                        .await
                        {
                            Ok((bytes, audio_tracks_reduced)) => {
                                result =
                                    Some((bytes, candidate, candidate_path, audio_tracks_reduced));
                                break;
                            }
                            Err(()) => remove_conversion_output(&candidate_path).await,
                        }
                    }
                    let Some((bytes, actual_mode, candidate_path, audio_tracks_reduced)) = result
                    else {
                        return Err(());
                    };
                    let ready_path = if output_format == ConversionOutputFormat::Mp4 {
                        tokio::fs::rename(&candidate_path, &output_path)
                            .await
                            .map_err(|_| ())?;
                        output_path.clone()
                    } else {
                        candidate_path
                    };
                    Ok::<_, ()>((bytes, actual_mode, ready_path, audio_tracks_reduced))
                } else {
                    let hardware_encoder = if matches!(
                        mode,
                        ConversionMode::H264Aac
                            | ConversionMode::H264AacLow
                            | ConversionMode::H264AacCompat
                    ) {
                        state
                            .ffmpeg_caps
                            .and_then(|caps| caps.video_hardware_encoder)
                    } else {
                        None
                    };
                    let (bytes, audio_tracks_reduced) = transcode_conversion_candidate(
                        ffmpeg.as_ref(),
                        &input_path,
                        &output_path,
                        mode,
                        hardware_encoder,
                        output_format,
                        mobile_compatibility,
                        source_audio_track_count,
                        &preferred_audio_track_indices,
                    )
                    .await?;
                    Ok((bytes, mode, output_path.clone(), audio_tracks_reduced))
                }?;
            let session_url = create_local_media_session(&state, ready_path.clone()).await?;
            let subtitles = extract_text_subtitle_tracks(
                ffmpeg.as_ref(),
                &input_path,
                state.conversion_dir.as_ref(),
                &id,
                &session_url,
                &source_info,
            )
            .await;
            Ok::<_, ()>((
                bytes,
                actual_mode,
                ready_path,
                session_url,
                source_info,
                subtitles,
                live_snapshot,
                audio_tracks_reduced,
            ))
        },
    )
    .await
    .unwrap_or(Err(()));
    let _ = tokio::fs::remove_file(&input_path).await;
    let _ =
        tokio::fs::remove_dir_all(state.conversion_dir.join(format!("{id}.input-assets"))).await;
    let mut jobs = state.conversion_jobs.lock().await;
    if let Some(job) = jobs.get_mut(&id) {
        job.status = match result {
            Ok((
                bytes,
                mode,
                ready_path,
                url,
                source_info,
                subtitles,
                live_snapshot,
                audio_tracks_reduced,
            )) => {
                job.expires_at = Instant::now() + MEDIA_SESSION_TTL;
                ConversionStatus::Ready {
                    path: ready_path,
                    bytes,
                    mode,
                    url,
                    source_info,
                    subtitles,
                    live_snapshot,
                    audio_tracks_reduced,
                }
            }
            Err(()) => {
                cleanup_conversion_files(state.conversion_dir.as_ref(), &id).await;
                ConversionStatus::Failed
            }
        };
    }
}

/// Detect extensionless HLS/DASH endpoints before deciding whether to download
/// a file or recursively materialize a manifest. Try HEAD first, then inspect
/// only the first 4 KiB of a Range GET for servers that reject HEAD or return a
/// generic content type.
async fn probe_media_content_type(
    state: &AppState,
    initial_url: &url::Url,
    request_headers: &HashMap<String, String>,
) -> Option<String> {
    if let Some((content_type, _)) =
        probe_media_response(state, initial_url, request_headers, reqwest::Method::HEAD).await
    {
        if is_hls_playlist(initial_url, Some(&content_type))
            || is_dash_manifest(initial_url, Some(&content_type))
        {
            return Some(content_type);
        }
        let (range_content_type, prefix) =
            probe_media_response(state, initial_url, request_headers, reqwest::Method::GET).await?;
        if let Some(detected) = sniff_media_playlist_content_type(&prefix) {
            return Some(detected.to_string());
        }
        return Some(if range_content_type.is_empty() {
            content_type
        } else {
            range_content_type
        });
    }
    let (content_type, prefix) =
        probe_media_response(state, initial_url, request_headers, reqwest::Method::GET).await?;
    sniff_media_playlist_content_type(&prefix)
        .map(str::to_owned)
        .or_else(|| (!content_type.is_empty()).then_some(content_type))
}

fn sniff_media_playlist_content_type(prefix: &[u8]) -> Option<&'static str> {
    let text = String::from_utf8_lossy(prefix);
    let text = text.trim_start_matches('\u{feff}').trim_start();
    if text.starts_with("#EXTM3U") {
        return Some("application/vnd.apple.mpegurl");
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("<mpd") || lower.contains(":mpd") {
        return Some("application/dash+xml");
    }
    None
}

async fn probe_media_response(
    state: &AppState,
    initial_url: &url::Url,
    request_headers: &HashMap<String, String>,
    method: reqwest::Method,
) -> Option<(String, Vec<u8>)> {
    let credential_origin = initial_url.origin();
    let mut url = initial_url.clone();
    for redirect in 0..=MAX_MEDIA_REDIRECTS {
        if validate_media_url(&url, &state.allowed_media_hosts).is_err() {
            return None;
        }
        let address = resolve_public_address(&url).await.ok()?;
        let host = url.host_str()?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .resolve(host, SocketAddr::new(address, url.port_or_known_default()?))
            .build()
            .ok()?;
        let mut request = apply_playback_request_headers(
            client.request(method.clone(), url.clone()),
            request_headers,
            url.origin() == credential_origin,
        );
        if method == reqwest::Method::GET {
            request = request
                .header(RANGE, "bytes=0-4095")
                .header(reqwest::header::ACCEPT_ENCODING, "identity");
        }
        let response = tokio::time::timeout(Duration::from_secs(8), request.send())
            .await
            .ok()?
            .ok()?;
        if response.status().is_redirection() {
            if redirect == MAX_MEDIA_REDIRECTS {
                return None;
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)?
                .to_str()
                .ok()?;
            url = url.join(location).ok()?;
            continue;
        }
        if !response.status().is_success() {
            return None;
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if method == reqwest::Method::HEAD {
            return Some((content_type, Vec::new()));
        }
        let mut body = response.bytes_stream();
        let chunk = tokio::time::timeout(Duration::from_secs(8), body.next())
            .await
            .ok()??
            .ok()?;
        return Some((content_type, chunk.iter().take(4096).copied().collect()));
    }
    None
}

fn conversion_candidates(caps: Option<FfmpegCapabilities>) -> Vec<ConversionMode> {
    let mut modes = vec![ConversionMode::Remux];
    if caps.is_some_and(|value| value.audio_aac) {
        modes.push(ConversionMode::AudioAac);
    }
    if caps.is_some_and(|value| {
        value.audio_aac && (value.video_h264 || value.video_hardware_encoder.is_some())
    }) {
        modes.push(ConversionMode::H264Aac);
    }
    modes
}

#[cfg(test)]
async fn transcode_local_input(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    output_path: &FsPath,
    mode: ConversionMode,
) -> Result<u64, ()> {
    transcode_local_output(
        ffmpeg,
        input_path,
        output_path,
        mode,
        ConversionOutputFormat::Mp4,
    )
    .await
}

#[cfg(test)]
async fn transcode_local_output(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    output_path: &FsPath,
    mode: ConversionMode,
    output_format: ConversionOutputFormat,
) -> Result<u64, ()> {
    transcode_local_output_using_encoder(ffmpeg, input_path, output_path, mode, None, output_format)
        .await
}

#[cfg(test)]
async fn transcode_local_output_using_encoder(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    output_path: &FsPath,
    mode: ConversionMode,
    hardware_encoder: Option<&str>,
    output_format: ConversionOutputFormat,
) -> Result<u64, ()> {
    transcode_local_output_using_encoder_with_audio_policy(
        ffmpeg,
        input_path,
        output_path,
        mode,
        hardware_encoder,
        output_format,
        false,
        None,
        &[],
    )
    .await
}

async fn transcode_local_output_using_encoder_with_audio_policy(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    output_path: &FsPath,
    mode: ConversionMode,
    hardware_encoder: Option<&str>,
    output_format: ConversionOutputFormat,
    mobile_compatibility: bool,
    audio_track_index: Option<usize>,
    preferred_audio_track_indices: &[usize],
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
            "file,pipe,crypto,data",
            // Rebuild missing presentation timestamps from decoding timestamps;
            // malformed timelines otherwise produce MP4s some mobile decoders reject.
            "-fflags",
            "+genpts",
        ])
        .arg("-i")
        .arg(input_path)
        // Uppercase `V` ignores attached cover art and thumbnails, which some
        // containers expose as video streams before the actual picture.
        .args(["-map", "0:V:0?"]);
    if output_format == ConversionOutputFormat::Mp4 && audio_track_index.is_none() {
        // Mobile MP4 can carry alternate language tracks; retain them so the
        // browser or native media controls can expose the source choices.
        if preferred_audio_track_indices.is_empty() {
            command.args(["-map", "0:a?"]);
        } else {
            for track_index in preferred_audio_track_indices {
                command.arg("-map").arg(format!("0:a:{track_index}?"));
            }
            for output_track_index in 0..preferred_audio_track_indices.len() {
                command
                    .arg(format!("-disposition:a:{output_track_index}"))
                    .arg(if output_track_index == 0 {
                        "default"
                    } else {
                        "0"
                    });
            }
        }
    } else if output_format == ConversionOutputFormat::Mp4 {
        command
            .arg("-map")
            .arg(format!("0:a:{}?", audio_track_index.unwrap_or(0)));
    } else {
        // The single-variant HLS output path currently packages one audio track.
        command.args(["-map", "0:a:0?"]);
    }
    command.args(["-sn", "-dn", "-map_metadata", "0"]);
    // Some mobile demuxers reject files whose first DTS/PTS is negative even
    // when FFmpeg has generated missing timestamps. Shift the output timeline
    // to zero for both MP4 and HLS so seeking and native startup are reliable.
    command.args(["-avoid_negative_ts", "make_zero"]);
    match mode {
        ConversionMode::Auto => return Err(()),
        ConversionMode::Remux => {
            command.args(["-c", "copy"]);
        }
        ConversionMode::AudioAac => {
            command.args([
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                "48000",
                "-profile:a",
                "aac_low",
                "-ac",
                "2",
            ]);
        }
        ConversionMode::H264Aac | ConversionMode::H264AacLow | ConversionMode::H264AacCompat => {
            if mode == ConversionMode::H264AacCompat {
                command.args([
                    "-vf",
                    "scale=w='if(gte(iw,ih),min(720,iw),min(480,iw))':h='if(gte(iw,ih),min(480,ih),min(720,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=fps='if(gt(source_fps,0),min(source_fps,30),30)'",
                    "-profile:v",
                    "baseline",
                    "-level:v",
                    "3.0",
                ]);
            } else if mode == ConversionMode::H264AacLow {
                command.args([
                    "-vf",
                    "scale=w='if(gte(iw,ih),min(1280,iw),min(720,iw))':h='if(gte(iw,ih),min(720,ih),min(1280,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=fps='if(gt(source_fps,0),min(source_fps,30),30)'",
                    "-profile:v",
                    "baseline",
                    "-level:v",
                    "3.1",
                ]);
            } else if output_format == ConversionOutputFormat::Mp4 || mobile_compatibility {
                // Keep mobile fallback output within Level 4.2 frame-size
                // limits, including HLS, square and portrait sources.
                command.args([
                    "-vf",
                    "scale=w='if(gte(iw,ih),min(1920,iw),min(1080,iw))':h='if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=fps='if(gt(source_fps,0),min(source_fps,60),30)'",
                    // H.264 Level 4.2 tops out at 522,240 macroblocks per
                    // second. The fps filter caps high-frame-rate sources
                    // without depending on the newer -fpsmax output option.
                    "-profile:v",
                    "baseline",
                    "-level:v",
                    "4.2",
                ]);
            }
            if let Some(encoder) = hardware_encoder {
                command.args([
                    "-c:v", encoder, "-b:v", "5M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a",
                    "192k", "-ar", "48000",
                ]);
            } else {
                command.args([
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", "2",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                ]);
            }
            command.args(["-profile:a", "aac_low", "-ac", "2"]);
        }
    }
    if output_format == ConversionOutputFormat::Mp4 {
        command.args(["-movflags", "+faststart", "-f", "mp4"]);
    } else {
        let segment_path = output_path.with_extension("ts");
        command
            .args([
                "-hls_time",
                "6",
                "-hls_list_size",
                "0",
                "-hls_flags",
                "single_file+independent_segments",
                "-hls_segment_filename",
            ])
            .arg(&segment_path)
            .args(["-f", "hls"]);
    }
    command
        .arg(output_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| ())?;
    let size_path = if output_format == ConversionOutputFormat::Hls {
        output_path.with_extension("ts")
    } else {
        output_path.to_path_buf()
    };
    wait_for_ffmpeg(&mut child, &size_path).await?;
    let playlist_bytes = tokio::fs::metadata(output_path)
        .await
        .map_err(|_| ())?
        .len();
    let bytes = if output_format == ConversionOutputFormat::Hls {
        playlist_bytes.saturating_add(tokio::fs::metadata(&size_path).await.map_err(|_| ())?.len())
    } else {
        playlist_bytes
    };
    if bytes == 0 || bytes > max_conversion_bytes() {
        return Err(());
    }
    Ok(bytes)
}

async fn transcode_conversion_candidate(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    output_path: &FsPath,
    mode: ConversionMode,
    hardware_encoder: Option<&str>,
    output_format: ConversionOutputFormat,
    mobile_compatibility: bool,
    source_audio_track_count: usize,
    preferred_audio_track_indices: &[usize],
) -> Result<(u64, bool), ()> {
    if let Ok(bytes) = transcode_conversion_with_encoder_fallback(
        ffmpeg,
        input_path,
        output_path,
        mode,
        hardware_encoder,
        output_format,
        mobile_compatibility,
        None,
        preferred_audio_track_indices,
    )
    .await
    {
        return Ok((bytes, false));
    }
    remove_conversion_output(output_path).await;
    if output_format != ConversionOutputFormat::Mp4 || source_audio_track_count <= 1 {
        return Err(());
    }

    let fallback_track_order: Vec<usize> = if preferred_audio_track_indices.is_empty() {
        (0..source_audio_track_count).collect()
    } else {
        preferred_audio_track_indices.to_vec()
    };
    for audio_track_index in fallback_track_order
        .into_iter()
        .take(MAX_CONVERTED_AUDIO_TRACKS)
    {
        remove_conversion_output(output_path).await;
        if let Ok(bytes) = transcode_conversion_with_encoder_fallback(
            ffmpeg,
            input_path,
            output_path,
            mode,
            hardware_encoder,
            output_format,
            mobile_compatibility,
            Some(audio_track_index),
            preferred_audio_track_indices,
        )
        .await
        {
            return Ok((bytes, true));
        }
    }
    remove_conversion_output(output_path).await;
    Err(())
}

fn audio_language_preference_rank(language: &str, preferences: &[String]) -> Option<usize> {
    fn canonical(language: &str) -> String {
        let primary = language
            .split(['-', '_'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        match primary.as_str() {
            "en" | "eng" => "en".to_owned(),
            "ja" | "jpn" => "ja".to_owned(),
            "de" | "deu" | "ger" => "de".to_owned(),
            "fr" | "fra" | "fre" => "fr".to_owned(),
            "es" | "spa" => "es".to_owned(),
            "it" | "ita" => "it".to_owned(),
            "pt" | "por" => "pt".to_owned(),
            "ko" | "kor" => "ko".to_owned(),
            "zh" | "zho" | "chi" => "zh".to_owned(),
            "ru" | "rus" => "ru".to_owned(),
            "ar" | "ara" => "ar".to_owned(),
            "nl" | "nld" | "dut" => "nl".to_owned(),
            "sv" | "swe" => "sv".to_owned(),
            "no" | "nor" => "no".to_owned(),
            "da" | "dan" => "da".to_owned(),
            "fi" | "fin" => "fi".to_owned(),
            "pl" | "pol" => "pl".to_owned(),
            "tr" | "tur" => "tr".to_owned(),
            "uk" | "ukr" => "uk".to_owned(),
            "cs" | "ces" | "cze" => "cs".to_owned(),
            "el" | "ell" | "gre" => "el".to_owned(),
            "he" | "heb" => "he".to_owned(),
            "hi" | "hin" => "hi".to_owned(),
            "th" | "tha" => "th".to_owned(),
            "vi" | "vie" => "vi".to_owned(),
            _ => primary,
        }
    }
    let language = canonical(language);
    preferences
        .iter()
        .position(|preference| canonical(preference) == language)
}

fn ordered_audio_track_indices(source_info: &Value, preferences: &[String]) -> Vec<usize> {
    if preferences.is_empty() {
        return Vec::new();
    }
    let Some(streams) = source_info.get("streams").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut tracks: Vec<(usize, Option<usize>)> = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .enumerate()
        .map(|(index, stream)| {
            let language = stream
                .get("tags")
                .and_then(|tags| tags.get("language"))
                .and_then(Value::as_str)
                .unwrap_or("");
            (index, audio_language_preference_rank(language, preferences))
        })
        .collect();
    if !tracks.iter().any(|(_, rank)| rank.is_some()) {
        return Vec::new();
    }
    tracks.sort_by_key(|(index, rank)| (rank.unwrap_or(usize::MAX), *index));
    tracks.into_iter().map(|(index, _)| index).collect()
}

async fn transcode_conversion_with_encoder_fallback(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    output_path: &FsPath,
    mode: ConversionMode,
    hardware_encoder: Option<&str>,
    output_format: ConversionOutputFormat,
    mobile_compatibility: bool,
    audio_track_index: Option<usize>,
    preferred_audio_track_indices: &[usize],
) -> Result<u64, ()> {
    if let Some(encoder) = hardware_encoder {
        match transcode_local_output_using_encoder_with_audio_policy(
            ffmpeg,
            input_path,
            output_path,
            mode,
            Some(encoder),
            output_format,
            mobile_compatibility,
            audio_track_index,
            preferred_audio_track_indices,
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(()) => remove_conversion_output(output_path).await,
        }
    }
    let result = transcode_local_output_using_encoder_with_audio_policy(
        ffmpeg,
        input_path,
        output_path,
        mode,
        None,
        output_format,
        mobile_compatibility,
        audio_track_index,
        preferred_audio_track_indices,
    )
    .await;
    if result.is_err() {
        remove_conversion_output(output_path).await;
    }
    result
}

/// Inspect downloaded bytes with ffprobe; URL suffixes and MIME hints are not
/// treated as reliable container or codec evidence.
async fn probe_local_media(ffmpeg: &FsPath, input_path: &FsPath) -> Result<Value, ()> {
    let executable = ffprobe_path_for(ffmpeg);
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new(executable)
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe,crypto,data",
                "-show_entries",
                "format=format_name:stream=index,codec_type,codec_name,profile,width,height,sample_rate,channels:stream_tags=language,title:stream_disposition=forced",
                "-of",
                "json",
            ])
            .arg(input_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if !output.status.success() || output.stdout.len() > 256 * 1024 {
        return Err(());
    }
    let raw: Value = serde_json::from_slice(&output.stdout).map_err(|_| ())?;
    let format_name = raw
        .get("format")
        .and_then(|format| format.get("format_name"))
        .and_then(Value::as_str)
        .ok_or(())?;
    let streams = raw.get("streams").and_then(Value::as_array).ok_or(())?;
    if streams.len() > 32 {
        return Err(());
    }
    let streams: Vec<Value> = streams
        .iter()
        .map(|stream| {
            let mut info = serde_json::Map::new();
            for key in [
                "index",
                "codec_type",
                "codec_name",
                "profile",
                "width",
                "height",
                "sample_rate",
                "channels",
            ] {
                if let Some(value) = stream.get(key).filter(|value| !value.is_null()) {
                    info.insert(key.to_owned(), value.clone());
                }
            }
            if let Some(tags) = stream.get("tags").and_then(Value::as_object) {
                let subtitle_tags = ["language", "title"]
                    .into_iter()
                    .filter_map(|key| {
                        tags.get(key)
                            .filter(|value| value.as_str().is_some_and(|text| text.len() <= 256))
                            .map(|value| (key.to_owned(), value.clone()))
                    })
                    .collect::<serde_json::Map<_, _>>();
                if !subtitle_tags.is_empty() {
                    info.insert("tags".to_owned(), Value::Object(subtitle_tags));
                }
            }
            if let Some(forced) = stream
                .get("disposition")
                .and_then(|disposition| disposition.get("forced"))
                .filter(|value| value.as_i64().is_some())
            {
                info.insert(
                    "forced".to_owned(),
                    Value::Bool(forced.as_i64().is_some_and(|value| value != 0)),
                );
            }
            Value::Object(info)
        })
        .collect();
    Ok(serde_json::json!({ "container": format_name, "streams": streams }))
}

fn is_text_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec,
        "subrip"
            | "ass"
            | "ssa"
            | "webvtt"
            | "mov_text"
            | "text"
            | "ttml"
            | "sami"
            | "realtext"
            | "subviewer"
            | "subviewer1"
            | "vplayer"
            | "jacosub"
            | "mpl2"
            | "microdvd"
            | "aqtitle"
    )
}

fn local_media_asset_url(session_url: &str, asset_name: &str) -> Result<String, ()> {
    if asset_name.is_empty()
        || asset_name.contains('/')
        || asset_name.contains('\\')
        || asset_name.contains("..")
    {
        return Err(());
    }
    let (path, query) = session_url.split_once('?').ok_or(())?;
    if !path.starts_with("/v1/media/") || query.is_empty() {
        return Err(());
    }
    Ok(format!("{path}/{asset_name}?{query}"))
}

async fn extract_text_subtitle_tracks(
    ffmpeg: &FsPath,
    input_path: &FsPath,
    conversion_dir: &FsPath,
    conversion_id: &str,
    media_session_url: &str,
    source_info: &Value,
) -> Vec<ConvertedSubtitleTrack> {
    let Some(streams) = source_info.get("streams").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut tracks = Vec::new();
    for stream in streams {
        if tracks.len() >= MAX_CONVERTED_SUBTITLE_TRACKS
            || stream.get("codec_type").and_then(Value::as_str) != Some("subtitle")
            || !stream
                .get("codec_name")
                .and_then(Value::as_str)
                .is_some_and(is_text_subtitle_codec)
        {
            continue;
        }
        let Some(stream_index) = stream.get("index").and_then(Value::as_u64) else {
            continue;
        };
        let asset_name = format!("{conversion_id}-subtitle-{stream_index}.vtt");
        let output_path = conversion_dir.join(&asset_name);
        let command = tokio::process::Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-protocol_whitelist",
                "file,pipe,crypto,data",
                "-i",
            ])
            .arg(input_path)
            .arg("-map")
            .arg(format!("0:{stream_index}"))
            .args(["-c:s", "webvtt", "-f", "webvtt"])
            .arg(&output_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let succeeded = tokio::time::timeout(Duration::from_secs(90), command)
            .await
            .ok()
            .and_then(Result::ok)
            .is_some_and(|output| output.status.success());
        let length = if succeeded {
            tokio::fs::metadata(&output_path)
                .await
                .ok()
                .filter(|metadata| {
                    metadata.is_file()
                        && metadata.len() > 0
                        && metadata.len() <= MAX_CONVERTED_SUBTITLE_BYTES
                })
                .map(|metadata| metadata.len())
        } else {
            None
        };
        if length.is_none() {
            let _ = tokio::fs::remove_file(&output_path).await;
            continue;
        }
        let tags = stream.get("tags");
        let language = tags
            .and_then(|tags| tags.get("language"))
            .and_then(Value::as_str)
            .filter(|language| {
                !language.is_empty()
                    && language.len() <= 35
                    && language
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            .unwrap_or("und")
            .to_owned();
        let title = tags
            .and_then(|tags| tags.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty() && title.len() <= 256);
        let label = title.map(str::to_owned).unwrap_or_else(|| {
            if language == "und" {
                format!("Subtitle {}", tracks.len() + 1)
            } else {
                format!("{language} subtitles")
            }
        });
        let Ok(url) = local_media_asset_url(media_session_url, &asset_name) else {
            let _ = tokio::fs::remove_file(&output_path).await;
            continue;
        };
        tracks.push(ConvertedSubtitleTrack {
            url,
            lang: language,
            label,
            forced: stream
                .get("forced")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    tracks
}

fn ffprobe_path_for(ffmpeg: &FsPath) -> PathBuf {
    ffmpeg
        .parent()
        .map(|parent| {
            parent.join(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            })
        })
        .filter(|path| path.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            })
        })
}

fn conversion_mode_name(mode: ConversionMode) -> &'static str {
    match mode {
        ConversionMode::Auto => "auto",
        ConversionMode::Remux => "remux",
        ConversionMode::AudioAac => "audio-aac",
        ConversionMode::H264Aac => "h264-aac",
        ConversionMode::H264AacLow => "h264-aac-low",
        ConversionMode::H264AacCompat => "h264-aac-compat",
    }
}

fn conversion_artifact_names(id: &str) -> Vec<String> {
    let mut names = vec![
        format!("{id}.input"),
        format!("{id}.input.m3u8"),
        format!("{id}.input.mpd"),
        format!("{id}.mp4"),
        format!("{id}.m3u8"),
        format!("{id}.ts"),
    ];
    for mode in [
        ConversionMode::Remux,
        ConversionMode::AudioAac,
        ConversionMode::H264Aac,
        ConversionMode::H264AacLow,
        ConversionMode::H264AacCompat,
    ] {
        let mode = conversion_mode_name(mode);
        names.extend([
            format!("{id}-{mode}.mp4"),
            format!("{id}-{mode}.m3u8"),
            format!("{id}-{mode}.ts"),
        ]);
    }
    names
}

fn conversion_output_path(directory: &FsPath, id: &str, format: ConversionOutputFormat) -> PathBuf {
    directory.join(match format {
        ConversionOutputFormat::Mp4 => format!("{id}.mp4"),
        ConversionOutputFormat::Hls => format!("{id}.m3u8"),
    })
}

fn conversion_output_candidate_path(
    directory: &FsPath,
    id: &str,
    mode: ConversionMode,
    format: ConversionOutputFormat,
) -> PathBuf {
    let extension = match format {
        ConversionOutputFormat::Mp4 => "mp4",
        ConversionOutputFormat::Hls => "m3u8",
    };
    directory.join(format!("{id}-{}.{extension}", conversion_mode_name(mode)))
}

async fn remove_conversion_output(path: &FsPath) {
    let _ = tokio::fs::remove_file(path).await;
    if path
        .extension()
        .is_some_and(|extension| extension == "m3u8")
    {
        let _ = tokio::fs::remove_file(path.with_extension("ts")).await;
    }
    if let (Some(directory), Some(stem)) = (
        path.parent(),
        path.file_stem().and_then(|name| name.to_str()),
    ) {
        let conversion_id = stem.split_once('-').map_or(stem, |(id, _)| id);
        if conversion_id.len() == 32 && conversion_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            remove_conversion_subtitles(directory, conversion_id).await;
        }
    }
}

async fn remove_conversion_subtitles(directory: &FsPath, conversion_id: &str) {
    let prefix = format!("{conversion_id}-subtitle-");
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name
            .strip_prefix(&prefix)
            .and_then(|suffix| suffix.strip_suffix(".vtt"))
            .is_some_and(|index| {
                !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
            })
        {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

async fn cleanup_conversion_files(directory: &FsPath, id: &str) {
    for name in conversion_artifact_names(id) {
        let path = directory.join(name);
        let _ = tokio::fs::remove_file(&path).await;
    }
    remove_conversion_subtitles(directory, id).await;
    let _ = tokio::fs::remove_dir_all(directory.join(format!("{id}.input-assets"))).await;
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
            remove_conversion_output(&path).await;
        }
        state
            .conversion_tasks
            .lock()
            .await
            .retain(|_, task| !task.is_finished());
    }
}

async fn clean_stale_conversion_files(directory: &PathBuf) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_worker_conversion_directory(&name) {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        } else if is_worker_conversion_filename(&name) {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

fn is_worker_conversion_filename(name: &str) -> bool {
    if let Some(stem) = name.strip_suffix(".vtt") {
        let Some((id, index)) = stem.split_once("-subtitle-") else {
            return false;
        };
        return id.len() == 32
            && id.bytes().all(|byte| byte.is_ascii_hexdigit())
            && !index.is_empty()
            && index.bytes().all(|byte| byte.is_ascii_digit());
    }
    let Some(stem) = name
        .strip_suffix(".input.m3u8")
        .or_else(|| name.strip_suffix(".input.mpd"))
        .or_else(|| name.strip_suffix(".input"))
        .or_else(|| name.strip_suffix(".mp4"))
        .or_else(|| name.strip_suffix(".m3u8"))
        .or_else(|| name.strip_suffix(".ts"))
    else {
        return false;
    };
    let (id, variant) = stem.split_once('-').unwrap_or((stem, ""));
    id.len() == 32
        && id.bytes().all(|byte| byte.is_ascii_hexdigit())
        && matches!(
            variant,
            "" | "remux" | "audio-aac" | "h264-aac" | "h264-aac-low" | "h264-aac-compat"
        )
}

fn is_worker_conversion_directory(name: &str) -> bool {
    name.strip_suffix(".input-assets")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

async fn create_local_media_session(state: &AppState, path: PathBuf) -> Result<String, ()> {
    let is_hls = path
        .extension()
        .is_some_and(|extension| extension == "m3u8");
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
            request_headers: HashMap::new(),
            request_header_origin: String::new(),
            local_file: Some(path),
            expires_at: Instant::now() + MEDIA_SESSION_TTL,
            children: HashMap::new(),
            is_root: true,
            parent_id: None,
            nesting_depth: 0,
        },
    );
    Ok(format!(
        "/v1/media/{id}?expires={expires}&signature={signature}{}",
        if is_hls { "&format=hls" } else { "" }
    ))
}

async fn download_allowlisted_media(
    state: &AppState,
    initial_url: &url::Url,
    request_headers: &HashMap<String, String>,
    path: &PathBuf,
) -> Result<(), ()> {
    let credential_origin = initial_url.origin();
    let (_, content_type, _) = download_allowlisted_resource(
        state,
        initial_url,
        &credential_origin,
        request_headers,
        path,
        max_conversion_bytes(),
        false,
    )
    .await?;
    if content_type.starts_with("text/") || content_type.contains("mpegurl") {
        return Err(());
    }
    Ok(())
}

async fn download_allowlisted_resource(
    state: &AppState,
    initial_url: &url::Url,
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    path: &PathBuf,
    max_bytes: u64,
    allow_text: bool,
) -> Result<(url::Url, String, u64), ()> {
    download_allowlisted_resource_with_range(
        state,
        initial_url,
        credential_origin,
        request_headers,
        path,
        max_bytes,
        allow_text,
        None,
    )
    .await
}

async fn download_allowlisted_resource_with_range(
    state: &AppState,
    initial_url: &url::Url,
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    path: &PathBuf,
    max_bytes: u64,
    allow_text: bool,
    byte_range: Option<(u64, u64)>,
) -> Result<(url::Url, String, u64), ()> {
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
        let mut upstream_request = apply_playback_request_headers(
            client.get(url.clone()),
            request_headers,
            &url.origin() == credential_origin,
        );
        if let Some((start, end)) = byte_range {
            upstream_request = upstream_request.header(RANGE, format!("bytes={start}-{end}"));
        }
        let response = tokio::time::timeout(
            Duration::from_secs(30),
            upstream_request
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
        if let Some((start, end)) = byte_range {
            let content_range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok());
            if !valid_hls_range_response(response.status(), content_range, start, end) {
                return Err(());
            }
        }
        if !response.status().is_success() {
            return Err(());
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !allow_text && (content_type.starts_with("text/") || content_type.contains("mpegurl")) {
            return Err(());
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes)
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
                    if total > max_bytes {
                        return Err(());
                    }
                    file.write_all(&chunk).await.map_err(|_| ())?;
                }
                Ok(Some(Err(_))) | Err(_) => return Err(()),
                Ok(None) => break,
            }
        }
        file.flush().await.map_err(|_| ())?;
        return if total > 0 {
            Ok((url, content_type, total))
        } else {
            Err(())
        };
    }
    Err(())
}

fn valid_hls_range_response(
    status: StatusCode,
    content_range: Option<&str>,
    start: u64,
    end: u64,
) -> bool {
    if status != StatusCode::PARTIAL_CONTENT {
        return false;
    }
    let Some((unit_and_bounds, total)) = content_range.and_then(|value| value.split_once('/'))
    else {
        return false;
    };
    let Some((unit, bounds)) = unit_and_bounds.split_once(' ') else {
        return false;
    };
    let Some((actual_start, actual_end)) = bounds.split_once('-') else {
        return false;
    };
    unit == "bytes"
        && actual_start.parse::<u64>().ok() == Some(start)
        && actual_end.parse::<u64>().ok() == Some(end)
        && total.parse::<u64>().is_ok_and(|total| total > end)
}

async fn wait_for_ffmpeg(
    child: &mut tokio::process::Child,
    output_path: &FsPath,
) -> Result<(), ()> {
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(max_conversion_runtime_seconds());
    loop {
        tokio::select! {
            status = child.wait() => return if status.map_err(|_| ())?.success() { Ok(()) } else { Err(()) },
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if tokio::fs::metadata(output_path).await.map(|metadata| metadata.len() > max_conversion_bytes()).unwrap_or(false) {
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
        if path
            .extension()
            .is_some_and(|extension| extension == "m3u8")
        {
            return serve_local_hls_manifest(
                path,
                id,
                signed.expires,
                signed.signature,
                method,
                permit,
            )
            .await;
        }
        return serve_local_media(path, headers, method, permit, "video/mp4").await;
    }
    let mut session = session;
    session.url = match hls_reload_url(&session.url, &signed.extra_params) {
        Ok(url) => url,
        Err(()) => return StatusCode::BAD_REQUEST.into_response(),
    };
    proxy_upstream(&state, id, signed.expires, session, headers, method, permit).await
}

async fn proxy_local_media_asset(
    State(state): State<AppState>,
    Path((id, asset)): Path<(String, String)>,
    Query(signed): Query<SignedSession>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    if id.len() != 32
        || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || signed.expires
            < SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        || !verify_session(&state.session_key, &id, signed.expires, &signed.signature)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if asset.is_empty() || asset.contains('/') || asset.contains('\\') || asset.contains("..") {
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
    let Some(local_path) = session.local_file else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (asset_path, content_type) = if local_path
        .extension()
        .is_some_and(|extension| extension == "m3u8")
    {
        let segment_path = local_path.with_extension("ts");
        if segment_path.file_name().and_then(|name| name.to_str()) == Some(asset.as_str()) {
            (segment_path, "video/mp2t")
        } else if is_local_subtitle_asset(&local_path, &asset) {
            let Some(parent) = local_path.parent() else {
                return StatusCode::NOT_FOUND.into_response();
            };
            (parent.join(asset), "text/vtt; charset=utf-8")
        } else {
            return StatusCode::NOT_FOUND.into_response();
        }
    } else {
        if !is_local_subtitle_asset(&local_path, &asset) {
            return StatusCode::NOT_FOUND.into_response();
        }
        let Some(parent) = local_path.parent() else {
            return StatusCode::NOT_FOUND.into_response();
        };
        (parent.join(asset), "text/vtt; charset=utf-8")
    };
    let Ok(permit) = state.media_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    serve_local_media(asset_path, headers, method, permit, content_type).await
}

fn is_local_subtitle_asset(local_media_path: &FsPath, asset: &str) -> bool {
    let Some(stem) = local_media_path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };
    let expected_prefix = format!("{stem}-subtitle-");
    asset
        .strip_prefix(&expected_prefix)
        .and_then(|suffix| suffix.strip_suffix(".vtt"))
        .is_some_and(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
}

async fn serve_local_hls_manifest(
    path: PathBuf,
    id: String,
    expires: u64,
    signature: String,
    method: Method,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    if method == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(CACHE_CONTROL, "private, no-store")
            .header("referrer-policy", "no-referrer")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !metadata.is_file() || metadata.len() > MAX_HLS_MANIFEST_BYTES as u64 {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(manifest) = String::from_utf8(bytes) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if !manifest.trim_start().starts_with("#EXTM3U") {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let Some(segment_name) = path
        .with_extension("ts")
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(manifest) =
        rewrite_local_hls_manifest(&manifest, &id, expires, &signature, &segment_name)
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    drop(permit);
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/vnd.apple.mpegurl")
        .header(CONTENT_LENGTH, manifest.len().to_string())
        .header(CACHE_CONTROL, "private, no-store")
        .header("referrer-policy", "no-referrer")
        .body(Body::from(manifest))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn rewrite_local_hls_manifest(
    manifest: &str,
    id: &str,
    expires: u64,
    signature: &str,
    segment_name: &str,
) -> Result<String, ()> {
    if !manifest.trim_start().starts_with("#EXTM3U")
        || segment_name.is_empty()
        || segment_name.contains('/')
        || segment_name.contains('\\')
    {
        return Err(());
    }
    let spans = playlist_uri_spans(manifest)?;
    if spans.is_empty() {
        return Err(());
    }
    if spans.iter().any(|(_, _, reference)| {
        reference != segment_name && !reference.ends_with(&format!("/{segment_name}"))
    }) {
        return Err(());
    }
    let segment_url =
        format!("/v1/media/{id}/{segment_name}?expires={expires}&signature={signature}");
    let replacements = spans
        .iter()
        .map(|(_, _, reference)| (reference.clone(), segment_url.clone()))
        .collect::<HashMap<_, _>>();
    replace_playlist_uris(manifest, &spans, &replacements)
}

async fn serve_local_media(
    path: PathBuf,
    headers: HeaderMap,
    method: Method,
    permit: tokio::sync::OwnedSemaphorePermit,
    content_type: &'static str,
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
        .header(CONTENT_TYPE, content_type)
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
        let request = if method == Method::HEAD {
            client.head(url.clone())
        } else {
            client.get(url.clone())
        };
        let mut request = apply_playback_request_headers(
            request,
            &session.request_headers,
            url.origin().ascii_serialization() == session.request_header_origin,
        );
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
        || url.query_pairs().any(|(name, value)| {
            name.eq_ignore_ascii_case("format") && value.eq_ignore_ascii_case("hls")
        })
        || content_type.is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("mpegurl") || value.contains("vnd.apple.mpegurl")
        })
}

fn hls_reload_url(
    upstream_url: &url::Url,
    extra_params: &HashMap<String, String>,
) -> Result<url::Url, ()> {
    if !is_hls_playlist(upstream_url, None) {
        return Ok(upstream_url.clone());
    }
    let mut reload_params = Vec::new();
    for name in ["_HLS_msn", "_HLS_part", "_HLS_skip"] {
        let Some(value) = extra_params.get(name) else {
            continue;
        };
        match name {
            "_HLS_msn" | "_HLS_part" => {
                value.parse::<u64>().map_err(|_| ())?;
            }
            "_HLS_skip"
                if value.eq_ignore_ascii_case("YES") || value.eq_ignore_ascii_case("v2") => {}
            "_HLS_skip" => return Err(()),
            _ => unreachable!(),
        }
        reload_params.push((name, value.as_str()));
    }
    if reload_params.is_empty() {
        return Ok(upstream_url.clone());
    }

    // Keep provider credentials byte-for-byte intact while replacing only the
    // reload directives the HLS client is allowed to add.
    let reload_names = ["_HLS_msn", "_HLS_part", "_HLS_skip"];
    let mut query_parts = upstream_url
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|part| {
            let key = part.split_once('=').map_or(*part, |(key, _)| key);
            !percent_decode_hls_query_component(key)
                .ok()
                .is_some_and(|key| reload_names.contains(&key.as_str()))
        })
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    query_parts.extend(
        reload_params
            .into_iter()
            .map(|(name, value)| format!("{name}={value}")),
    );
    let mut url = upstream_url.clone();
    url.set_query(Some(&query_parts.join("&")));
    Ok(url)
}

fn is_dash_manifest(url: &url::Url, content_type: Option<&str>) -> bool {
    url.path().to_ascii_lowercase().ends_with(".mpd")
        || url.query_pairs().any(|(name, value)| {
            name.eq_ignore_ascii_case("format") && value.eq_ignore_ascii_case("dash")
        })
        || content_type
            .is_some_and(|value| value.to_ascii_lowercase().contains("application/dash+xml"))
}

fn dash_xml_node(start: &quick_xml::events::BytesStart<'_>) -> Result<DashNode, ()> {
    let name = start.local_name().as_ref().to_string();
    let mut attributes = HashMap::new();
    for attribute in start.attributes().with_checks(true) {
        let attribute = attribute.map_err(|_| ())?;
        let key = attribute.key.as_ref().to_string();
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| ())?
            .into_owned();
        if attributes.insert(key, value).is_some() {
            return Err(());
        }
    }
    Ok(DashNode {
        name,
        attributes,
        text: String::new(),
        children: Vec::new(),
    })
}

fn parse_dash_xml(input: &str) -> Result<DashNode, ()> {
    if input.len() > MAX_HLS_MANIFEST_BYTES {
        return Err(());
    }
    let mut reader = XmlReader::from_str(input);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<DashNode> = Vec::new();
    let mut root: Option<DashNode> = None;
    let mut node_count = 0usize;
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer).map_err(|_| ())? {
            XmlEvent::Start(start) => {
                if stack.len() >= MAX_DASH_XML_DEPTH {
                    return Err(());
                }
                node_count += 1;
                if node_count > MAX_DASH_XML_NODES {
                    return Err(());
                }
                stack.push(dash_xml_node(&start)?);
            }
            XmlEvent::Empty(start) => {
                node_count += 1;
                if node_count > MAX_DASH_XML_NODES {
                    return Err(());
                }
                let node = dash_xml_node(&start)?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else if root.replace(node).is_some() {
                    return Err(());
                }
            }
            XmlEvent::End(_) => {
                let node = stack.pop().ok_or(())?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else if root.replace(node).is_some() {
                    return Err(());
                }
            }
            XmlEvent::Text(text) => {
                if let Some(parent) = stack.last_mut() {
                    parent
                        .text
                        .push_str(&text.xml_content(XmlVersion::Implicit1_0));
                }
            }
            XmlEvent::CData(text) => {
                if let Some(parent) = stack.last_mut() {
                    parent
                        .text
                        .push_str(&text.xml_content(XmlVersion::Implicit1_0));
                }
            }
            XmlEvent::GeneralRef(reference) => {
                if let Some(parent) = stack.last_mut() {
                    if let Some(character) = reference.resolve_char_ref().map_err(|_| ())? {
                        parent.text.push(character);
                    } else {
                        let replacement = match reference.as_ref() {
                            "amp" => "&",
                            "lt" => "<",
                            "gt" => ">",
                            "apos" => "'",
                            "quot" => "\"",
                            _ => return Err(()),
                        };
                        parent.text.push_str(replacement);
                    }
                }
            }
            XmlEvent::DocType(_) => return Err(()),
            XmlEvent::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !stack.is_empty() {
        return Err(());
    }
    root.ok_or(())
}

#[derive(Clone, Debug)]
struct DashPart {
    url: url::Url,
    range: Option<(u64, u64)>,
    is_initialization: bool,
}

#[derive(Clone, Debug)]
struct DashTrackPlan {
    kind: &'static str,
    mime_type: String,
    bandwidth: u64,
    segment_list_attributes: HashMap<String, String>,
    timeline: Option<DashNode>,
    initialization: Option<DashPart>,
    segments: Vec<DashPart>,
}

#[derive(Clone, Debug)]
struct DashMpdPlan {
    periods: Vec<DashPeriodPlan>,
    dynamic: bool,
}

#[derive(Clone, Debug)]
struct DashPeriodPlan {
    video: DashTrackPlan,
    audio: Vec<DashAudioPlan>,
    subtitles: Vec<DashSubtitlePlan>,
}

#[derive(Clone, Debug)]
struct DashAudioPlan {
    language: Option<String>,
    label: String,
    is_main: bool,
    track: DashTrackPlan,
}

impl DashAudioPlan {
    fn key(&self) -> String {
        format!(
            "{}|{}",
            self.language.as_deref().unwrap_or("und"),
            self.label
        )
    }
}

#[derive(Clone, Debug)]
struct DashSubtitlePlan {
    language: Option<String>,
    label: String,
    forced: bool,
    track: DashTrackPlan,
}

impl DashSubtitlePlan {
    fn key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.language.as_deref().unwrap_or("und"),
            self.label,
            self.forced
        )
    }
}

struct DashMaterializedTrack {
    track: DashTrackPlan,
    asset_prefix: String,
    initialization_name: Option<String>,
    segment_names: Vec<String>,
}

fn dash_base_url(node: &DashNode, parent: &url::Url) -> Result<url::Url, ()> {
    let base_urls = node.children_named("BaseURL").collect::<Vec<_>>();
    if base_urls.len() > 1 {
        return Err(());
    }
    let Some(base) = base_urls.first() else {
        return Ok(parent.clone());
    };
    let reference = base.text.trim();
    if reference.is_empty() {
        return Ok(parent.clone());
    }
    join_with_same_origin_query(parent, reference)
}

/// Resolve a media reference and preserve token query parameters on same-origin
/// relative URLs. Some HLS/DASH origins put authorization on the manifest URL
/// but omit it from child playlist and segment references. CloudFront-style
/// signed URLs are self-contained and must not have their signature extended.
fn join_with_same_origin_query(base: &url::Url, reference: &str) -> Result<url::Url, ()> {
    let mut resolved = base.join(reference).map_err(|_| ())?;
    if resolved.origin() != base.origin() {
        return Ok(resolved);
    }
    let inherited_query = base
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if inherited_query.is_empty()
        || inherited_query
            .iter()
            .any(|(key, _)| key.to_ascii_lowercase().starts_with("x-amz-"))
    {
        return Ok(resolved);
    }
    let existing_keys = resolved
        .query_pairs()
        .map(|(key, _)| key.into_owned())
        .collect::<HashSet<_>>();
    for (key, value) in inherited_query {
        if !existing_keys.contains(&key) {
            resolved.query_pairs_mut().append_pair(&key, &value);
        }
    }
    Ok(resolved)
}

fn dash_segment_range(value: &str) -> Result<(u64, u64), ()> {
    let (start, end) = value.split_once('-').ok_or(())?;
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = end.parse::<u64>().map_err(|_| ())?;
    if end < start {
        return Err(());
    }
    Ok((start, end))
}

fn dash_track_kind(adaptation: &DashNode, representation: &DashNode) -> Option<&'static str> {
    let content_type = representation
        .attribute("contentType")
        .or_else(|| adaptation.attribute("contentType"));
    if let Some(content_type) = content_type {
        if content_type.eq_ignore_ascii_case("video") {
            return Some("video");
        }
        if content_type.eq_ignore_ascii_case("audio") {
            return Some("audio");
        }
        if content_type.eq_ignore_ascii_case("text")
            || content_type.eq_ignore_ascii_case("subtitle")
        {
            return Some("text");
        }
    }
    let mime_type = representation
        .attribute("mimeType")
        .or_else(|| adaptation.attribute("mimeType"))?;
    let mime_type = mime_type.to_ascii_lowercase();
    let codecs = representation
        .attribute("codecs")
        .or_else(|| adaptation.attribute("codecs"))
        .unwrap_or("")
        .to_ascii_lowercase();
    if mime_type.starts_with("video/") {
        Some("video")
    } else if mime_type.starts_with("audio/") {
        Some("audio")
    } else if mime_type.starts_with("text/")
        || mime_type.contains("ttml")
        || codecs
            .split(',')
            .any(|codec| matches!(codec.trim(), "stpp" | "wvtt"))
    {
        Some("text")
    } else {
        None
    }
}

fn dash_segment_list<'a>(
    period: &'a DashNode,
    adaptation: &'a DashNode,
    representation: &'a DashNode,
) -> Option<&'a DashNode> {
    representation
        .child("SegmentList")
        .or_else(|| adaptation.child("SegmentList"))
        .or_else(|| period.child("SegmentList"))
}

fn inherited_dash_segment_template<'a>(
    period: &'a DashNode,
    adaptation: &'a DashNode,
    representation: &'a DashNode,
) -> Option<&'a DashNode> {
    representation
        .child("SegmentTemplate")
        .or_else(|| adaptation.child("SegmentTemplate"))
        .or_else(|| period.child("SegmentTemplate"))
}

fn inherited_dash_segment_base<'a>(
    period: &'a DashNode,
    adaptation: &'a DashNode,
    representation: &'a DashNode,
) -> Option<&'a DashNode> {
    representation
        .child("SegmentBase")
        .or_else(|| adaptation.child("SegmentBase"))
        .or_else(|| period.child("SegmentBase"))
}

fn expand_dash_template(
    template: &str,
    representation_id: &str,
    bandwidth: u64,
    number: u64,
    time: u64,
) -> Result<String, ()> {
    let mut expanded = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '$' {
            expanded.push(character);
            continue;
        }
        if chars.peek() == Some(&'$') {
            chars.next();
            expanded.push('$');
            continue;
        }
        let mut token = String::new();
        let mut terminated = false;
        for next in chars.by_ref() {
            if next == '$' {
                terminated = true;
                break;
            }
            token.push(next);
        }
        if !terminated || token.is_empty() {
            return Err(());
        }
        let (name, format) = if let Some((name, format)) = token.split_once('%') {
            if !format.starts_with('0') || !format.ends_with('d') {
                return Err(());
            }
            let width = format[1..format.len() - 1]
                .parse::<usize>()
                .map_err(|_| ())?;
            if width > 20 {
                return Err(());
            }
            (name, Some(width))
        } else {
            (token.as_str(), None)
        };
        let value = match name {
            "RepresentationID" if format.is_none() => representation_id.to_string(),
            "Bandwidth" => bandwidth.to_string(),
            "Number" => number.to_string(),
            "Time" => time.to_string(),
            _ => return Err(()),
        };
        if let Some(width) = format {
            if name != "Number" && name != "Bandwidth" && name != "Time" {
                return Err(());
            }
            expanded.push_str(&format!("{value:0>width$}"));
        } else {
            expanded.push_str(&value);
        }
    }
    Ok(expanded)
}

fn dash_duration_seconds(value: &str) -> Result<f64, ()> {
    let value = value.strip_prefix('P').ok_or(())?;
    if value.is_empty() {
        return Err(());
    }
    let mut number = String::new();
    let mut seconds = 0.0;
    let mut in_time = false;
    let mut saw_time_separator = false;
    let mut saw_component = false;
    let mut saw_time_component = false;
    for character in value.chars() {
        if character == 'T' {
            if in_time || !number.is_empty() {
                return Err(());
            }
            in_time = true;
            saw_time_separator = true;
            continue;
        }
        if character.is_ascii_digit() || character == '.' {
            number.push(character);
            continue;
        }
        let amount = number.parse::<f64>().map_err(|_| ())?;
        number.clear();
        if !amount.is_finite() || amount < 0.0 {
            return Err(());
        }
        let multiplier = match (character, in_time) {
            ('W', false) if !saw_component => 7.0 * 24.0 * 3600.0,
            ('D', false) => 24.0 * 3600.0,
            ('H', true) => 3600.0,
            ('M', true) => 60.0,
            ('S', true) => 1.0,
            _ => return Err(()),
        };
        seconds += amount * multiplier;
        saw_component = true;
        saw_time_component |= in_time;
    }
    if !number.is_empty()
        || !saw_component
        || (saw_time_separator && !saw_time_component)
        || !seconds.is_finite()
        || seconds < 0.0
    {
        return Err(());
    }
    Ok(seconds)
}

fn dash_datetime_unix_seconds(value: &str) -> Result<f64, ()> {
    let timezone_start = value
        .char_indices()
        .skip(10)
        .find(|(_, character)| matches!(character, 'Z' | 'z' | '+' | '-'))
        .map(|(index, _)| index)
        .ok_or(())?;
    let (date_time, timezone) = value.split_at(timezone_start);
    if date_time.len() < 19 || date_time.as_bytes().get(10) != Some(&b'T') {
        return Err(());
    }
    let number = |range: std::ops::Range<usize>| -> Result<i64, ()> {
        date_time
            .get(range)
            .ok_or(())?
            .parse::<i64>()
            .map_err(|_| ())
    };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if date_time.as_bytes().get(4) != Some(&b'-')
        || date_time.as_bytes().get(7) != Some(&b'-')
        || !matches!(date_time.as_bytes().get(13), Some(b':'))
        || !matches!(date_time.as_bytes().get(16), Some(b':'))
        || !(1..=12).contains(&month)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return Err(());
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day < 1 || day > days_in_month {
        return Err(());
    }
    let fraction = match date_time.get(19..) {
        Some("") | None => 0.0,
        Some(suffix) => suffix
            .strip_prefix('.')
            .ok_or(())?
            .parse::<f64>()
            .map_err(|_| ())?,
    };
    if !fraction.is_finite() || !(0.0..1.0).contains(&fraction) {
        return Err(());
    }
    let timezone_offset = if timezone.eq_ignore_ascii_case("Z") {
        0
    } else {
        if timezone.len() != 6 || timezone.as_bytes().get(3) != Some(&b':') {
            return Err(());
        }
        let hours = timezone
            .get(1..3)
            .ok_or(())?
            .parse::<i64>()
            .map_err(|_| ())?;
        let minutes = timezone
            .get(4..6)
            .ok_or(())?
            .parse::<i64>()
            .map_err(|_| ())?;
        if hours > 23 || minutes > 59 {
            return Err(());
        }
        let offset = hours * 3600 + minutes * 60;
        if timezone.starts_with('-') {
            -offset
        } else if timezone.starts_with('+') {
            offset
        } else {
            return Err(());
        }
    };
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    Ok(
        (days_since_epoch * 86_400 + hour * 3600 + minute * 60 + second - timezone_offset) as f64
            + fraction,
    )
}

fn dash_dynamic_presentation_duration(mpd: &DashNode) -> Result<f64, ()> {
    let availability_start =
        dash_datetime_unix_seconds(mpd.attribute("availabilityStartTime").ok_or(())?)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_secs_f64();
    let publish_time = mpd
        .attribute("publishTime")
        .map(dash_datetime_unix_seconds)
        .transpose()?;
    let live_edge = publish_time.map_or(now, |published| published.min(now));
    let presentation_delay = mpd
        .attribute("suggestedPresentationDelay")
        .map(dash_duration_seconds)
        .transpose()?
        .unwrap_or(3.0)
        .max(3.0);
    let elapsed = live_edge - availability_start - presentation_delay;
    if !elapsed.is_finite() || elapsed <= 0.0 {
        return Err(());
    }
    Ok(elapsed)
}

fn dash_timeline_repeat_count(
    entries: &[&DashNode],
    index: usize,
    duration: u64,
    start_time: u64,
    repeat: i64,
    terminal_time: Option<u64>,
) -> Result<u64, ()> {
    if repeat >= 0 {
        return (repeat as u64).checked_add(1).ok_or(());
    }
    if repeat != -1 || duration == 0 {
        return Err(());
    }
    let end_time = if let Some(next) = entries.get(index + 1) {
        next.attribute("t")
            .map(str::parse::<u64>)
            .transpose()
            .map_err(|_| ())?
            .ok_or(())?
    } else {
        terminal_time.ok_or(())?
    };
    if end_time <= start_time {
        return Err(());
    }
    end_time
        .checked_sub(start_time)
        .and_then(|span| span.checked_add(duration - 1))
        .map(|span| span / duration)
        .filter(|count| *count > 0)
        .ok_or(())
}

fn build_dash_template_track_plan(
    mpd: &DashNode,
    period: &DashNode,
    representation_base: &url::Url,
    template: &DashNode,
    kind: &'static str,
    mime_type: String,
    representation_id: String,
    bandwidth: u64,
) -> Result<Option<DashTrackPlan>, ()> {
    let timescale = template
        .attribute("timescale")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| ())?
        .unwrap_or(1);
    if timescale == 0 {
        return Err(());
    }
    let media = template.attribute("media").ok_or(())?;
    let initialization = template
        .attribute("initialization")
        .map(|reference| {
            let url = expand_dash_template(reference, &representation_id, bandwidth, 0, 0)?;
            Ok::<DashPart, ()>(DashPart {
                url: join_with_same_origin_query(representation_base, &url)?,
                range: None,
                is_initialization: true,
            })
        })
        .transpose()?;
    if initialization.is_none()
        && matches!(
            mime_type.as_str(),
            "video/mp4" | "audio/mp4" | "application/mp4"
        )
    {
        return Err(());
    }
    let start_number = template
        .attribute("startNumber")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| ())?
        .unwrap_or(1);
    let mut segments = Vec::new();
    let mut durations = Vec::new();
    if let Some(timeline) = template.child("SegmentTimeline") {
        let mut current_time = 0u64;
        let entries = timeline.children_named("S").collect::<Vec<_>>();
        let presentation_duration = mpd
            .attribute("mediaPresentationDuration")
            .or_else(|| period.attribute("duration"))
            .map(dash_duration_seconds)
            .transpose()?;
        let terminal_time = presentation_duration
            .map(|duration| (duration * timescale as f64).ceil())
            .filter(|value| value.is_finite() && *value <= u64::MAX as f64)
            .map(|value| value as u64);
        let live_window_start = if mpd.attribute("auralesLiveSnapshot") == Some("true") {
            let global_start = mpd
                .attribute("auralesLiveWindowStart")
                .ok_or(())?
                .parse::<f64>()
                .map_err(|_| ())?;
            let period_start = period
                .attribute("start")
                .map(dash_duration_seconds)
                .transpose()?
                .unwrap_or(0.0);
            Some(((global_start - period_start).max(0.0) * timescale as f64).floor() as u64)
        } else {
            None
        };
        let mut segment_offset = 0u64;
        for (entry_index, entry) in entries.iter().enumerate() {
            let duration = entry
                .attribute("d")
                .ok_or(())?
                .parse::<u64>()
                .map_err(|_| ())?;
            let repeat = entry
                .attribute("r")
                .map(str::parse::<i64>)
                .transpose()
                .map_err(|_| ())?
                .unwrap_or(0);
            let time = entry
                .attribute("t")
                .map(str::parse::<u64>)
                .transpose()
                .map_err(|_| ())?
                .unwrap_or(current_time);
            if duration == 0 || repeat < -1 {
                return Err(());
            }
            let declared_repeat_count = dash_timeline_repeat_count(
                &entries,
                entry_index,
                duration,
                time,
                repeat,
                terminal_time,
            )?;
            let repeat_count = if live_window_start.is_some() {
                terminal_time.map_or(declared_repeat_count, |terminal| {
                    let available = if terminal <= time {
                        0
                    } else {
                        (terminal - time).saturating_add(duration - 1) / duration
                    };
                    declared_repeat_count.min(available)
                })
            } else {
                declared_repeat_count
            };
            let first_repeat = live_window_start
                .map_or(0, |window_start| {
                    if window_start <= time {
                        0
                    } else {
                        (window_start - time) / duration
                    }
                })
                .max(repeat_count.saturating_sub(MAX_HLS_REFERENCES as u64));
            for repeat_index in first_repeat..repeat_count {
                let segment_time = time
                    .checked_add(duration.checked_mul(repeat_index).ok_or(())?)
                    .ok_or(())?;
                let reference = expand_dash_template(
                    media,
                    &representation_id,
                    bandwidth,
                    start_number
                        .checked_add(segment_offset)
                        .and_then(|number| number.checked_add(repeat_index))
                        .ok_or(())?,
                    segment_time,
                )?;
                segments.push(DashPart {
                    url: join_with_same_origin_query(representation_base, &reference)?,
                    range: None,
                    is_initialization: false,
                });
                durations.push(duration);
            }
            let excess = segments.len().saturating_sub(MAX_HLS_REFERENCES);
            if excess > 0 {
                segments.drain(..excess);
                durations.drain(..excess);
            }
            segment_offset = segment_offset
                .checked_add(declared_repeat_count)
                .ok_or(())?;
            current_time = time
                .checked_add(duration.checked_mul(declared_repeat_count).ok_or(())?)
                .ok_or(())?;
        }
    } else {
        let duration = template
            .attribute("duration")
            .ok_or(())?
            .parse::<u64>()
            .map_err(|_| ())?;
        let presentation_duration = mpd
            .attribute("mediaPresentationDuration")
            .or_else(|| period.attribute("duration"))
            .ok_or(())
            .and_then(dash_duration_seconds)?;
        if duration == 0 {
            return Err(());
        }
        let count = (presentation_duration * timescale as f64 / duration as f64).ceil();
        if !count.is_finite() || count <= 0.0 || count > u64::MAX as f64 {
            return Err(());
        }
        let total_count = count as u64;
        let first_index = if mpd.attribute("auralesLiveSnapshot") == Some("true") {
            let global_start = mpd
                .attribute("auralesLiveWindowStart")
                .ok_or(())?
                .parse::<f64>()
                .map_err(|_| ())?;
            let period_start = period
                .attribute("start")
                .map(dash_duration_seconds)
                .transpose()?
                .unwrap_or(0.0);
            let window_start = (global_start - period_start).max(0.0) * timescale as f64;
            (window_start / duration as f64).floor() as u64
        } else {
            0
        }
        .max(total_count.saturating_sub(MAX_HLS_REFERENCES as u64));
        if first_index >= total_count {
            return Err(());
        }
        for index in first_index..total_count {
            let time = index.checked_mul(duration).ok_or(())?;
            let reference = expand_dash_template(
                media,
                &representation_id,
                bandwidth,
                start_number.checked_add(index).ok_or(())?,
                time,
            )?;
            segments.push(DashPart {
                url: join_with_same_origin_query(representation_base, &reference)?,
                range: None,
                is_initialization: false,
            });
            durations.push(duration);
        }
    }
    if segments.is_empty() {
        return Err(());
    }
    let synthetic_timeline = DashNode {
        name: "SegmentTimeline".to_string(),
        attributes: HashMap::new(),
        text: String::new(),
        children: durations
            .iter()
            .map(|duration| DashNode {
                name: "S".to_string(),
                attributes: HashMap::from([("d".to_string(), duration.to_string())]),
                text: String::new(),
                children: Vec::new(),
            })
            .collect(),
    };
    Ok(Some(DashTrackPlan {
        kind,
        mime_type,
        bandwidth,
        segment_list_attributes: HashMap::from([("timescale".to_string(), timescale.to_string())]),
        timeline: Some(synthetic_timeline),
        initialization,
        segments,
    }))
}

fn build_dash_track_plan(
    mpd: &DashNode,
    period: &DashNode,
    adaptation: &DashNode,
    representation: &DashNode,
    adaptation_base: &url::Url,
) -> Result<Option<DashTrackPlan>, ()> {
    let Some(kind) = dash_track_kind(adaptation, representation) else {
        return Ok(None);
    };
    let representation_base = dash_base_url(representation, adaptation_base)?;
    let mime_type = representation
        .attribute("mimeType")
        .or_else(|| adaptation.attribute("mimeType"))
        .unwrap_or(if kind == "video" {
            "video/mp4"
        } else if kind == "text" {
            "text/vtt"
        } else {
            "audio/mp4"
        })
        .to_string();
    let representation_id = representation
        .attribute("id")
        .unwrap_or(if kind == "video" {
            "aurales-video"
        } else {
            "aurales-audio"
        })
        .to_string();
    let bandwidth = representation
        .attribute("bandwidth")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| ())?
        .unwrap_or(1);
    let segment_base = inherited_dash_segment_base(period, adaptation, representation);
    if segment_base.is_some()
        && (inherited_dash_segment_template(period, adaptation, representation).is_some()
            || dash_segment_list(period, adaptation, representation).is_some())
    {
        return Err(());
    }
    if let Some(segment_base) = segment_base {
        let resource_name = representation_base.path_segments().and_then(Iterator::last);
        if resource_name.is_none_or(str::is_empty)
            || representation_base
                .path()
                .to_ascii_lowercase()
                .ends_with(".mpd")
            || representation_base
                .path()
                .to_ascii_lowercase()
                .ends_with(".m3u8")
        {
            return Err(());
        }
        let initialization = if let Some(initialization) = segment_base.child("Initialization") {
            let source = initialization.attribute("sourceURL").unwrap_or("");
            let initialization_url = join_with_same_origin_query(&representation_base, source)?;
            let range = initialization
                .attribute("range")
                .map(dash_segment_range)
                .transpose()?;
            (initialization_url != representation_base).then_some(DashPart {
                url: initialization_url,
                range,
                is_initialization: true,
            })
        } else {
            None
        };
        let timescale = segment_base
            .attribute("timescale")
            .map(str::parse::<u64>)
            .transpose()
            .map_err(|_| ())?
            .unwrap_or(1);
        let duration = period
            .attribute("duration")
            .or_else(|| mpd.attribute("mediaPresentationDuration"))
            .ok_or(())
            .and_then(dash_duration_seconds)?;
        if timescale == 0 || !duration.is_finite() || duration <= 0.0 {
            return Err(());
        }
        let duration_ticks = (duration * timescale as f64).ceil();
        if !duration_ticks.is_finite() || duration_ticks <= 0.0 || duration_ticks > u64::MAX as f64
        {
            return Err(());
        }
        return Ok(Some(DashTrackPlan {
            kind,
            mime_type,
            bandwidth,
            segment_list_attributes: HashMap::from([
                ("timescale".to_string(), timescale.to_string()),
                ("duration".to_string(), (duration_ticks as u64).to_string()),
            ]),
            timeline: None,
            initialization,
            segments: vec![DashPart {
                url: representation_base,
                range: None,
                is_initialization: false,
            }],
        }));
    }
    if inherited_dash_segment_template(period, adaptation, representation).is_some() {
        let mut effective_template = DashNode {
            name: "SegmentTemplate".to_string(),
            attributes: HashMap::new(),
            text: String::new(),
            children: Vec::new(),
        };
        for owner in [period, adaptation, representation] {
            if let Some(owner_template) = owner.child("SegmentTemplate") {
                effective_template
                    .attributes
                    .extend(owner_template.attributes.clone());
                if let Some(timeline) = owner_template.child("SegmentTimeline") {
                    effective_template.children = vec![timeline.clone()];
                }
            }
        }
        return build_dash_template_track_plan(
            mpd,
            period,
            &representation_base,
            &effective_template,
            kind,
            mime_type,
            representation_id,
            bandwidth,
        );
    }
    let Some(segment_list) = dash_segment_list(period, adaptation, representation) else {
        return Err(());
    };
    if segment_list.children_named("SegmentURL").count() > MAX_HLS_REFERENCES {
        return Err(());
    }
    let initialization = if let Some(initialization) = segment_list.child("Initialization") {
        let source = initialization.attribute("sourceURL").unwrap_or("");
        let url = join_with_same_origin_query(&representation_base, source)?;
        let range = initialization
            .attribute("range")
            .map(dash_segment_range)
            .transpose()?;
        Some(DashPart {
            url,
            range,
            is_initialization: true,
        })
    } else {
        None
    };
    if initialization.is_none()
        && matches!(
            mime_type.as_str(),
            "video/mp4" | "audio/mp4" | "application/mp4"
        )
    {
        return Err(());
    }
    let segment_urls = segment_list
        .children_named("SegmentURL")
        .collect::<Vec<_>>();
    if segment_urls.is_empty() {
        return Err(());
    }
    let mut segments = Vec::with_capacity(segment_urls.len());
    for segment in segment_urls {
        if segment.attribute("index").is_some() || segment.attribute("indexRange").is_some() {
            return Err(());
        }
        let reference = segment.attribute("media").ok_or(())?;
        let url = join_with_same_origin_query(&representation_base, reference)?;
        let range = segment
            .attribute("mediaRange")
            .map(dash_segment_range)
            .transpose()?;
        segments.push(DashPart {
            url,
            range,
            is_initialization: false,
        });
    }
    let timeline = segment_list.child("SegmentTimeline").cloned();
    if segment_list.attribute("duration").is_none() && timeline.is_none() {
        return Err(());
    }
    Ok(Some(DashTrackPlan {
        kind,
        mime_type,
        bandwidth,
        segment_list_attributes: segment_list.attributes.clone(),
        timeline,
        initialization,
        segments,
    }))
}

fn dash_has_descendant(node: &DashNode, name: &str) -> bool {
    node.children
        .iter()
        .any(|child| child.name == name || dash_has_descendant(child, name))
}

fn dash_dynamic_has_bounded_segments(
    mpd: &DashNode,
    periods: &[&DashNode],
    mobile_compatibility: bool,
) -> bool {
    let mut found_track = false;
    for (period_index, period) in periods.iter().enumerate() {
        for adaptation in period.children_named("AdaptationSet") {
            for representation in adaptation.children_named("Representation") {
                let Some(kind) = dash_track_kind(adaptation, representation) else {
                    continue;
                };
                // Text tracks are optional and the planner already skips an
                // unsupported subtitle representation. Do not let an
                // unbounded caption template reject an otherwise bounded
                // dynamic audio/video snapshot.
                if kind == "text" {
                    continue;
                }
                found_track = true;
                if inherited_dash_segment_base(period, adaptation, representation).is_some() {
                    return false;
                }
                if let Some(segment_list) = dash_segment_list(period, adaptation, representation) {
                    if inherited_dash_segment_template(period, adaptation, representation).is_some()
                    {
                        return false;
                    }
                    let segment_count = segment_list.children_named("SegmentURL").count();
                    if segment_count == 0
                        || segment_count > MAX_HLS_REFERENCES
                        || (segment_list.attribute("duration").is_none()
                            && segment_list.child("SegmentTimeline").is_none())
                    {
                        return false;
                    }
                    continue;
                }
                if inherited_dash_segment_template(period, adaptation, representation).is_none() {
                    return false;
                }
                let template_owners = [period, adaptation, representation];
                let has_timeline = template_owners.iter().any(|owner| {
                    owner
                        .child("SegmentTemplate")
                        .is_some_and(|template| template.child("SegmentTimeline").is_some())
                });
                let has_fixed_duration = template_owners.iter().any(|owner| {
                    owner
                        .child("SegmentTemplate")
                        .is_some_and(|template| template.attribute("duration").is_some())
                });
                let bounded_period = period.attribute("duration").is_some()
                    || mpd.attribute("mediaPresentationDuration").is_some()
                    || (mobile_compatibility && mpd.attribute("availabilityStartTime").is_some())
                    || periods
                        .get(period_index + 1)
                        .is_some_and(|next| next.attribute("start").is_some());
                if !has_timeline && !(has_fixed_duration && bounded_period) {
                    return false;
                }
            }
        }
    }
    found_track
}

fn resolution_pixel_count(resolution: Option<(u64, u64)>) -> Option<u64> {
    resolution.and_then(|(width, height)| width.checked_mul(height))
}

fn mobile_resolution_rank(resolution: Option<(u64, u64)>) -> u8 {
    match resolution {
        Some((width, height))
            if (width <= 1920 && height <= 1080) || (width <= 1080 && height <= 1920) =>
        {
            2
        }
        Some(_) => 1,
        None => 0,
    }
}

fn parse_frame_rate(value: Option<&str>) -> Option<f64> {
    let value = value?;
    let frame_rate = if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }
        numerator / denominator
    } else {
        value.parse::<f64>().ok()?
    };
    (frame_rate.is_finite() && frame_rate > 0.0).then_some(frame_rate)
}

fn mobile_frame_rate_rank(frame_rate: Option<f64>) -> u8 {
    match frame_rate {
        Some(frame_rate) if frame_rate <= 60.0 => 2,
        None => 1,
        Some(_) => 0,
    }
}

fn mobile_video_variant_is_better(
    candidate_resolution: Option<(u64, u64)>,
    candidate_frame_rate: Option<f64>,
    candidate_bandwidth: u64,
    current_resolution: Option<(u64, u64)>,
    current_frame_rate: Option<f64>,
    current_bandwidth: u64,
) -> bool {
    let candidate_resolution_rank = mobile_resolution_rank(candidate_resolution);
    let current_resolution_rank = mobile_resolution_rank(current_resolution);
    if candidate_resolution_rank != current_resolution_rank {
        return candidate_resolution_rank > current_resolution_rank;
    }
    if candidate_resolution_rank == 1 {
        let candidate_pixels = resolution_pixel_count(candidate_resolution);
        let current_pixels = resolution_pixel_count(current_resolution);
        if candidate_pixels != current_pixels {
            return candidate_pixels < current_pixels;
        }
    }
    let candidate_frame_rate_rank = mobile_frame_rate_rank(candidate_frame_rate);
    let current_frame_rate_rank = mobile_frame_rate_rank(current_frame_rate);
    if candidate_frame_rate_rank != current_frame_rate_rank {
        return candidate_frame_rate_rank > current_frame_rate_rank;
    }
    candidate_bandwidth > current_bandwidth
}

fn dash_representation_resolution(
    adaptation: &DashNode,
    representation: &DashNode,
) -> Option<(u64, u64)> {
    let width = representation
        .attribute("width")
        .or_else(|| adaptation.attribute("width"))?
        .parse::<u64>()
        .ok()?;
    let height = representation
        .attribute("height")
        .or_else(|| adaptation.attribute("height"))?
        .parse::<u64>()
        .ok()?;
    Some((width, height))
}

fn plan_static_dash_mpd(manifest: &str, manifest_url: &url::Url) -> Result<DashMpdPlan, ()> {
    plan_static_dash_mpd_for_mobile(manifest, manifest_url, false)
}

fn plan_static_dash_mpd_for_mobile(
    manifest: &str,
    manifest_url: &url::Url,
    mobile_compatibility: bool,
) -> Result<DashMpdPlan, ()> {
    let mpd = parse_dash_xml(manifest)?;
    if mpd.name != "MPD" || dash_has_descendant(&mpd, "ContentProtection") {
        return Err(());
    }
    let dynamic = mpd
        .attribute("type")
        .is_some_and(|kind| kind.eq_ignore_ascii_case("dynamic"));
    if mpd.attribute("type").is_some_and(|kind| {
        !kind.eq_ignore_ascii_case("static") && !kind.eq_ignore_ascii_case("dynamic")
    }) {
        return Err(());
    }
    let periods = mpd.children_named("Period").collect::<Vec<_>>();
    if periods.is_empty() || periods.len() > MAX_DASH_PERIODS {
        return Err(());
    }
    if dynamic && !dash_dynamic_has_bounded_segments(&mpd, &periods, mobile_compatibility) {
        return Err(());
    }
    let mpd_base = dash_base_url(&mpd, manifest_url)?;
    let mpd_duration = mpd
        .attribute("mediaPresentationDuration")
        .map(dash_duration_seconds)
        .transpose()?;
    let mpd_duration = if dynamic && mobile_compatibility {
        Some(dash_dynamic_presentation_duration(&mpd)?)
    } else {
        mpd_duration
    };
    let live_window_start = if dynamic && mobile_compatibility {
        let window_seconds = mpd
            .attribute("timeShiftBufferDepth")
            .map(dash_duration_seconds)
            .transpose()?
            .unwrap_or(300.0)
            .max(1.0);
        Some((mpd_duration.ok_or(())? - window_seconds).max(0.0))
    } else {
        None
    };
    let mut resolved_periods = Vec::with_capacity(periods.len());
    let mut previous_period_end = Some(0.0);
    for (period_index, original_period) in periods.iter().enumerate() {
        let start = original_period
            .attribute("start")
            .map(dash_duration_seconds)
            .transpose()?
            .or(previous_period_end);
        if live_window_start.is_some()
            && start
                .zip(mpd_duration)
                .is_some_and(|(start, live_edge)| start >= live_edge)
        {
            break;
        }
        let explicit_duration = original_period
            .attribute("duration")
            .map(dash_duration_seconds)
            .transpose()?;
        let next_start = periods
            .get(period_index + 1)
            .and_then(|next| next.attribute("start"))
            .map(dash_duration_seconds)
            .transpose()?;
        let period_duration =
            explicit_duration.or_else(|| match (start, next_start, mpd_duration) {
                (Some(start), Some(next_start), _) if next_start > start => {
                    Some(next_start - start)
                }
                (Some(start), _, Some(total)) if total > start => Some(total - start),
                _ => None,
            });
        let period_duration = if dynamic && mobile_compatibility {
            match (period_duration, start, mpd_duration) {
                (Some(duration), Some(start), Some(live_edge)) => {
                    Some(duration.min((live_edge - start).max(0.0)))
                }
                (_, Some(start), Some(live_edge)) if live_edge > start => Some(live_edge - start),
                (duration, _, _) => duration,
            }
        } else {
            period_duration
        };
        let mut period = (*original_period).clone();
        let mut period_mpd = mpd.clone();
        if let Some(live_window_start) = live_window_start {
            period_mpd
                .attributes
                .insert("auralesLiveSnapshot".to_string(), "true".to_string());
            period_mpd.attributes.insert(
                "auralesLiveWindowStart".to_string(),
                format!("{live_window_start:.6}"),
            );
        }
        if let Some(start) = start {
            period
                .attributes
                .insert("start".to_string(), format!("PT{start:.6}S"));
        }
        if let Some(duration) = period_duration {
            period
                .attributes
                .insert("duration".to_string(), format!("PT{duration:.6}S"));
            period_mpd.attributes.insert(
                "mediaPresentationDuration".to_string(),
                format!("PT{duration:.6}S"),
            );
            previous_period_end = start.map(|start| start + duration);
        } else {
            previous_period_end = None;
            if periods.len() > 1 {
                period_mpd.attributes.remove("mediaPresentationDuration");
            }
        }
        if live_window_start.is_some_and(|window_start| {
            start
                .zip(period_duration)
                .is_some_and(|(start, duration)| start + duration <= window_start)
        }) {
            continue;
        }
        let period_base = dash_base_url(&period, &mpd_base)?;
        let mut selected_video: Option<DashTrackPlan> = None;
        let mut selected_video_resolution: Option<(u64, u64)> = None;
        let mut selected_video_frame_rate: Option<f64> = None;
        let mut selected_audio: HashMap<String, DashAudioPlan> = HashMap::new();
        let mut selected_subtitles: HashMap<String, DashSubtitlePlan> = HashMap::new();
        for adaptation in period.children_named("AdaptationSet") {
            if dash_has_descendant(adaptation, "ContentProtection") {
                return Err(());
            }
            let adaptation_base = dash_base_url(adaptation, &period_base)?;
            let is_main = adaptation.children_named("Role").any(|role| {
                role.attribute("value")
                    .is_some_and(|value| value.eq_ignore_ascii_case("main"))
            });
            let language = adaptation
                .attribute("lang")
                .map(str::to_owned)
                .filter(|value| is_safe_hls_language(value));
            let adaptation_label = adaptation
                .child("Label")
                .map(|node| node.text.trim().to_owned())
                .filter(|value| is_safe_hls_label(value));
            let subtitle_label = adaptation_label
                .clone()
                .or_else(|| language.clone())
                .unwrap_or_else(|| "Subtitles".to_string());
            let audio_label = adaptation_label
                .or_else(|| language.clone())
                .unwrap_or_else(|| "Audio".to_string());
            let forced = adaptation.children_named("Role").any(|role| {
                role.attribute("value")
                    .is_some_and(|value| value.eq_ignore_ascii_case("forced-subtitle"))
            });
            for representation in adaptation.children_named("Representation") {
                if dash_has_descendant(representation, "ContentProtection") {
                    return Err(());
                }
                let Some(kind) = dash_track_kind(adaptation, representation) else {
                    continue;
                };
                let plan_result = build_dash_track_plan(
                    &period_mpd,
                    &period,
                    adaptation,
                    representation,
                    &adaptation_base,
                );
                let plan = match plan_result {
                    Ok(Some(plan)) => plan,
                    Ok(None) => continue,
                    // Unsupported or malformed optional caption tracks must
                    // not prevent the video and audio representations from
                    // being prepared.
                    Err(()) if kind == "text" => continue,
                    Err(()) => return Err(()),
                };
                match plan.kind {
                    "video" => {
                        let resolution = dash_representation_resolution(adaptation, representation);
                        let frame_rate = parse_frame_rate(
                            representation
                                .attribute("frameRate")
                                .or_else(|| adaptation.attribute("frameRate")),
                        );
                        let should_replace = selected_video.as_ref().is_none_or(|current| {
                            if !mobile_compatibility {
                                return plan.bandwidth > current.bandwidth;
                            }
                            mobile_video_variant_is_better(
                                resolution,
                                frame_rate,
                                plan.bandwidth,
                                selected_video_resolution,
                                selected_video_frame_rate,
                                current.bandwidth,
                            )
                        });
                        if should_replace {
                            selected_video = Some(plan);
                            selected_video_resolution = resolution;
                            selected_video_frame_rate = frame_rate;
                        }
                    }
                    "audio" => {
                        let audio = DashAudioPlan {
                            language: language.clone(),
                            label: audio_label.clone(),
                            is_main,
                            track: plan,
                        };
                        let key = audio.key();
                        if selected_audio
                            .get(&key)
                            .is_none_or(|current| audio.track.bandwidth > current.track.bandwidth)
                        {
                            selected_audio.insert(key, audio);
                        }
                    }
                    "text" => {
                        let key = format!(
                            "{}|{}|{}",
                            language.as_deref().unwrap_or("und"),
                            subtitle_label,
                            forced
                        );
                        let replace = selected_subtitles
                            .get(&key)
                            .is_none_or(|current| plan.bandwidth > current.track.bandwidth);
                        if replace {
                            selected_subtitles.insert(
                                key,
                                DashSubtitlePlan {
                                    language: language.clone(),
                                    label: subtitle_label.clone(),
                                    forced,
                                    track: plan,
                                },
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        resolved_periods.push(DashPeriodPlan {
            video: selected_video.ok_or(())?,
            audio: {
                let mut audio = selected_audio.into_values().collect::<Vec<_>>();
                audio.sort_by(|left, right| {
                    (!left.is_main)
                        .cmp(&(!right.is_main))
                        .then_with(|| right.track.bandwidth.cmp(&left.track.bandwidth))
                        .then_with(|| left.language.cmp(&right.language))
                        .then_with(|| left.label.cmp(&right.label))
                });
                audio.truncate(MAX_CONVERTED_AUDIO_TRACKS);
                audio
            },
            subtitles: {
                let mut subtitles = selected_subtitles.into_values().collect::<Vec<_>>();
                subtitles.sort_by(|left, right| {
                    left.language
                        .cmp(&right.language)
                        .then_with(|| left.label.cmp(&right.label))
                        .then_with(|| left.forced.cmp(&right.forced))
                });
                subtitles.truncate(MAX_CONVERTED_SUBTITLE_TRACKS);
                subtitles
            },
        });
    }
    let audio_periods = resolved_periods
        .iter()
        .filter(|period| !period.audio.is_empty())
        .count();
    if audio_periods != 0 && audio_periods != resolved_periods.len() {
        return Err(());
    }
    Ok(DashMpdPlan {
        periods: resolved_periods,
        dynamic,
    })
}

fn dash_segment_durations(track: &DashTrackPlan) -> Result<Vec<f64>, ()> {
    let timescale = track
        .segment_list_attributes
        .get("timescale")
        .map(|value| value.parse::<u64>().map_err(|_| ()))
        .transpose()?
        .unwrap_or(1);
    if timescale == 0 {
        return Err(());
    }
    let durations = if let Some(timeline) = &track.timeline {
        let mut durations = Vec::new();
        let entries = timeline.children_named("S").collect::<Vec<_>>();
        let mut current_time = 0u64;
        for (entry_index, segment) in entries.iter().enumerate() {
            let duration = segment
                .attribute("d")
                .ok_or(())?
                .parse::<u64>()
                .map_err(|_| ())?;
            let repeat = segment
                .attribute("r")
                .map(str::parse::<i64>)
                .transpose()
                .map_err(|_| ())?
                .unwrap_or(0);
            if duration == 0 || repeat < -1 {
                return Err(());
            }
            let start_time = segment
                .attribute("t")
                .map(str::parse::<u64>)
                .transpose()
                .map_err(|_| ())?
                .unwrap_or(current_time);
            let repeat_count = if repeat == -1 && entry_index + 1 == entries.len() {
                (track.segments.len() - durations.len()) as u64
            } else {
                dash_timeline_repeat_count(
                    &entries,
                    entry_index,
                    duration,
                    start_time,
                    repeat,
                    None,
                )?
            };
            if repeat_count == 0 {
                return Err(());
            }
            for _ in 0..repeat_count {
                if durations.len() >= track.segments.len() {
                    return Err(());
                }
                durations.push(duration as f64 / timescale as f64);
            }
            current_time = start_time
                .checked_add(duration.checked_mul(repeat_count).ok_or(())?)
                .ok_or(())?;
        }
        durations
    } else {
        let duration = track
            .segment_list_attributes
            .get("duration")
            .ok_or(())?
            .parse::<u64>()
            .map_err(|_| ())?;
        if duration == 0 {
            return Err(());
        }
        vec![duration as f64 / timescale as f64; track.segments.len()]
    };
    if durations.len() != track.segments.len()
        || durations
            .iter()
            .any(|duration| !duration.is_finite() || *duration <= 0.0)
    {
        return Err(());
    }
    Ok(durations)
}

#[cfg(test)]
fn serialize_dash_media_playlist(
    track: &DashTrackPlan,
    asset_prefix: &str,
    initialization_name: Option<&str>,
    segment_names: &[String],
) -> Result<String, ()> {
    let durations = dash_segment_durations(track)?;
    let max_duration = durations.iter().copied().fold(0.0_f64, f64::max).ceil() as u64;
    if max_duration == 0 {
        return Err(());
    }
    let mut output = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:{max_duration}\n#EXT-X-MEDIA-SEQUENCE:0\n"
    );
    if let Some(initialization_name) = initialization_name {
        output.push_str(&format!(
            "#EXT-X-MAP:URI=\"{asset_prefix}/{initialization_name}\"\n"
        ));
    }
    for (duration, segment_name) in durations.iter().zip(segment_names) {
        output.push_str(&format!(
            "#EXTINF:{duration:.6},\n{asset_prefix}/{segment_name}\n"
        ));
    }
    output.push_str("#EXT-X-ENDLIST\n");
    Ok(output)
}

fn serialize_dash_period_playlist(tracks: &[DashMaterializedTrack]) -> Result<String, ()> {
    if tracks.is_empty() {
        return Err(());
    }
    let all_durations = tracks
        .iter()
        .map(|materialized| {
            let durations = dash_segment_durations(&materialized.track)?;
            if durations.len() != materialized.segment_names.len() {
                return Err(());
            }
            Ok(durations)
        })
        .collect::<Result<Vec<_>, ()>>()?;
    let max_duration = all_durations
        .iter()
        .flatten()
        .copied()
        .fold(0.0_f64, f64::max)
        .ceil() as u64;
    if max_duration == 0 {
        return Err(());
    }
    let mut output = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:{max_duration}\n#EXT-X-MEDIA-SEQUENCE:0\n"
    );
    for (period_index, (materialized, durations)) in
        tracks.iter().zip(all_durations.iter()).enumerate()
    {
        if period_index > 0 {
            output.push_str("#EXT-X-DISCONTINUITY\n");
        }
        if let Some(initialization_name) = &materialized.initialization_name {
            output.push_str(&format!(
                "#EXT-X-MAP:URI=\"{}/{initialization_name}\"\n",
                materialized.asset_prefix
            ));
        }
        for (duration, segment_name) in durations.iter().zip(&materialized.segment_names) {
            output.push_str(&format!(
                "#EXTINF:{duration:.6},\n{}/{}\n",
                materialized.asset_prefix, segment_name
            ));
        }
    }
    output.push_str("#EXT-X-ENDLIST\n");
    Ok(output)
}

fn dash_resource_extension(
    url: &url::Url,
    content_type: &str,
    is_initialization: bool,
) -> &'static str {
    let content_type = content_type.split(';').next().unwrap_or("").trim();
    match content_type {
        "video/mp4" | "audio/mp4" | "application/mp4" => {
            return if is_initialization { "mp4" } else { "m4s" };
        }
        "video/webm" | "audio/webm" => return "webm",
        "video/mp2t" | "video/mpeg" => return "ts",
        "text/vtt" | "application/webvtt" => return "vtt",
        "application/ttml+xml" => return "ttml",
        "application/x-subrip" | "text/srt" => return "srt",
        _ => {}
    }
    match url
        .path()
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" | "m4a" | "m4s" | "webm" | "ts" | "aac" | "ac3" | "ec3" | "mp3" => {
            match url
                .path()
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "mp4" => "mp4",
                "m4v" => "m4v",
                "m4a" => "m4a",
                "m4s" => "m4s",
                "webm" => "webm",
                "ts" => "ts",
                "aac" => "aac",
                "ac3" => "ac3",
                "ec3" => "ec3",
                "mp3" => "mp3",
                _ => unreachable!(),
            }
        }
        _ if is_initialization => "mp4",
        _ => "m4s",
    }
}

async fn materialize_dash_track(
    state: &AppState,
    track: &DashTrackPlan,
    asset_dir: &PathBuf,
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    already_downloaded: u64,
) -> Result<(Option<String>, Vec<String>, u64), ()> {
    tokio::fs::create_dir_all(asset_dir).await.map_err(|_| ())?;
    let mut downloaded_bytes = 0u64;
    let mut initialization_name = None;
    let mut segment_names = Vec::with_capacity(track.segments.len());
    let mut parts = Vec::with_capacity(track.segments.len() + 1);
    if let Some(initialization) = &track.initialization {
        parts.push(initialization.clone());
    }
    parts.extend(track.segments.iter().cloned());
    for (index, part) in parts.iter().enumerate() {
        if validate_media_url(&part.url, &state.allowed_media_hosts).is_err() {
            return Err(());
        }
        let remaining = max_conversion_bytes()
            .saturating_sub(already_downloaded.saturating_add(downloaded_bytes));
        let temporary_name = if part.is_initialization {
            "initialization.download".to_string()
        } else {
            format!("segment-{index:04}.download")
        };
        let temporary_path = asset_dir.join(temporary_name);
        let (final_url, content_type, length) = if let Some((start, end)) = part.range {
            let expected = end
                .checked_sub(start)
                .and_then(|length| length.checked_add(1))
                .ok_or(())?;
            if expected > remaining {
                return Err(());
            }
            download_allowlisted_resource_with_range(
                state,
                &part.url,
                credential_origin,
                request_headers,
                &temporary_path,
                expected,
                false,
                Some((start, end)),
            )
            .await?
        } else {
            download_allowlisted_resource(
                state,
                &part.url,
                credential_origin,
                request_headers,
                &temporary_path,
                remaining,
                false,
            )
            .await?
        };
        if let Some((start, end)) = part.range {
            if length != end - start + 1 {
                return Err(());
            }
        }
        let effective_content_type =
            if content_type.is_empty() || content_type.starts_with("application/octet-stream") {
                track.mime_type.as_str()
            } else {
                content_type.as_str()
            };
        let extension =
            dash_resource_extension(&final_url, effective_content_type, part.is_initialization);
        let local_name = if part.is_initialization {
            format!("init.{extension}")
        } else {
            format!("segment-{index:04}.{extension}")
        };
        tokio::fs::rename(&temporary_path, asset_dir.join(&local_name))
            .await
            .map_err(|_| ())?;
        if part.is_initialization {
            initialization_name = Some(local_name);
        } else {
            segment_names.push(local_name);
        }
        downloaded_bytes = downloaded_bytes.saturating_add(length);
    }
    Ok((initialization_name, segment_names, downloaded_bytes))
}

async fn download_dash_conversion_input(
    state: &AppState,
    initial_url: &url::Url,
    request_headers: &HashMap<String, String>,
    output_path: &PathBuf,
    assets_dir: &PathBuf,
    mobile_compatibility: bool,
) -> Result<bool, ()> {
    tokio::fs::create_dir(assets_dir).await.map_err(|_| ())?;
    let credential_origin = initial_url.origin();
    let source_mpd_path = assets_dir.join("source.mpd");
    let (manifest_url, content_type, manifest_size) = download_allowlisted_resource(
        state,
        initial_url,
        &credential_origin,
        request_headers,
        &source_mpd_path,
        MAX_HLS_MANIFEST_BYTES as u64,
        true,
    )
    .await?;
    if !is_dash_manifest(&manifest_url, Some(&content_type)) {
        return Err(());
    }
    let manifest_bytes = tokio::fs::read(&source_mpd_path).await.map_err(|_| ())?;
    let manifest = String::from_utf8(manifest_bytes).map_err(|_| ())?;
    let plan = if mobile_compatibility {
        plan_static_dash_mpd_for_mobile(&manifest, &manifest_url, true)?
    } else {
        plan_static_dash_mpd(&manifest, &manifest_url)?
    };
    let live_snapshot = plan.dynamic;
    let directory_name = assets_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(())?;
    let mut downloaded_bytes = manifest_size;
    let mut video_tracks = Vec::with_capacity(plan.periods.len());
    let mut audio_tracks = Vec::<(DashAudioPlan, Vec<DashMaterializedTrack>)>::new();
    let mut subtitle_tracks = Vec::<(DashSubtitlePlan, Vec<DashMaterializedTrack>)>::new();
    for (period_index, period) in plan.periods.iter().enumerate() {
        let period_dir = format!("period-{period_index:03}");
        let video_dir = assets_dir.join(&period_dir).join("video");
        let (video_init, video_segments, video_bytes) = materialize_dash_track(
            state,
            &period.video,
            &video_dir,
            &credential_origin,
            request_headers,
            downloaded_bytes,
        )
        .await?;
        downloaded_bytes = downloaded_bytes.saturating_add(video_bytes);
        video_tracks.push(DashMaterializedTrack {
            track: period.video.clone(),
            asset_prefix: format!("{period_dir}/video"),
            initialization_name: video_init,
            segment_names: video_segments,
        });
    }
    if let Some(first_period) = plan.periods.first() {
        for (audio_index, audio) in first_period.audio.iter().enumerate() {
            let key = audio.key();
            let matching_periods = plan
                .periods
                .iter()
                .map(|period| period.audio.iter().find(|candidate| candidate.key() == key))
                .collect::<Vec<_>>();
            if matching_periods.iter().any(Option::is_none) {
                continue;
            }
            let mut materialized_audio = Vec::with_capacity(plan.periods.len());
            let mut audio_downloaded_bytes = 0u64;
            let mut audio_failed = false;
            for (period_index, audio) in matching_periods.into_iter().enumerate() {
                let audio = audio.ok_or(())?;
                let period_dir = format!("period-{period_index:03}");
                let asset_dir = assets_dir
                    .join(&period_dir)
                    .join(format!("audio-{audio_index}"));
                let result = materialize_dash_track(
                    state,
                    &audio.track,
                    &asset_dir,
                    &credential_origin,
                    request_headers,
                    downloaded_bytes.saturating_add(audio_downloaded_bytes),
                )
                .await;
                let Ok((initialization_name, segment_names, bytes)) = result else {
                    audio_failed = true;
                    break;
                };
                audio_downloaded_bytes = audio_downloaded_bytes.saturating_add(bytes);
                materialized_audio.push(DashMaterializedTrack {
                    track: audio.track.clone(),
                    asset_prefix: format!("{period_dir}/audio-{audio_index}"),
                    initialization_name,
                    segment_names,
                });
            }
            if audio_failed {
                for period_index in 0..materialized_audio.len() + 1 {
                    let period_dir = format!("period-{period_index:03}");
                    let asset_dir = assets_dir
                        .join(period_dir)
                        .join(format!("audio-{audio_index}"));
                    let _ = tokio::fs::remove_dir_all(asset_dir).await;
                }
                continue;
            }
            let Ok(audio_playlist) = serialize_dash_period_playlist(&materialized_audio) else {
                for period_index in 0..materialized_audio.len() {
                    let period_dir = format!("period-{period_index:03}");
                    let asset_dir = assets_dir
                        .join(period_dir)
                        .join(format!("audio-{audio_index}"));
                    let _ = tokio::fs::remove_dir_all(asset_dir).await;
                }
                continue;
            };
            downloaded_bytes = downloaded_bytes.saturating_add(audio_downloaded_bytes);
            let materialized_index = audio_tracks.len();
            tokio::fs::write(
                assets_dir.join(format!("audio-{materialized_index}.m3u8")),
                audio_playlist,
            )
            .await
            .map_err(|_| ())?;
            audio_tracks.push((audio.clone(), materialized_audio));
        }
    }
    let has_audio_in_source = plan.periods.iter().any(|period| !period.audio.is_empty());
    if has_audio_in_source && audio_tracks.is_empty() {
        return Err(());
    }
    if let Some(first_period) = plan.periods.first() {
        for (subtitle_index, subtitle) in first_period.subtitles.iter().enumerate() {
            let key = subtitle.key();
            let matching_periods = plan
                .periods
                .iter()
                .map(|period| {
                    period
                        .subtitles
                        .iter()
                        .find(|candidate| candidate.key() == key)
                })
                .collect::<Vec<_>>();
            // Only expose a language when it is represented throughout the
            // complete timeline; otherwise its cues would be shifted at period
            // boundaries in the synthesized HLS subtitle playlist.
            if matching_periods.iter().any(Option::is_none) {
                continue;
            }
            let mut materialized_subtitle = Vec::with_capacity(plan.periods.len());
            let mut subtitle_downloaded_bytes = 0u64;
            let mut subtitle_failed = false;
            for (period_index, subtitle) in matching_periods.into_iter().enumerate() {
                let subtitle = subtitle.ok_or(())?;
                let period_dir = format!("period-{period_index:03}");
                let asset_dir = assets_dir
                    .join(&period_dir)
                    .join(format!("subtitle-{subtitle_index}"));
                let result = materialize_dash_track(
                    state,
                    &subtitle.track,
                    &asset_dir,
                    &credential_origin,
                    request_headers,
                    downloaded_bytes.saturating_add(subtitle_downloaded_bytes),
                )
                .await;
                let Ok((initialization_name, segment_names, subtitle_bytes)) = result else {
                    subtitle_failed = true;
                    break;
                };
                subtitle_downloaded_bytes =
                    subtitle_downloaded_bytes.saturating_add(subtitle_bytes);
                materialized_subtitle.push(DashMaterializedTrack {
                    track: subtitle.track.clone(),
                    asset_prefix: format!("{period_dir}/subtitle-{subtitle_index}"),
                    initialization_name,
                    segment_names,
                });
            }
            if subtitle_failed {
                for period_index in 0..materialized_subtitle.len() + 1 {
                    let period_dir = format!("period-{period_index:03}");
                    let asset_dir = assets_dir
                        .join(period_dir)
                        .join(format!("subtitle-{subtitle_index}"));
                    let _ = tokio::fs::remove_dir_all(asset_dir).await;
                }
                continue;
            }
            let Ok(subtitle_playlist) = serialize_dash_period_playlist(&materialized_subtitle)
            else {
                for period_index in 0..materialized_subtitle.len() {
                    let period_dir = format!("period-{period_index:03}");
                    let asset_dir = assets_dir
                        .join(period_dir)
                        .join(format!("subtitle-{subtitle_index}"));
                    let _ = tokio::fs::remove_dir_all(asset_dir).await;
                }
                continue;
            };
            downloaded_bytes = downloaded_bytes.saturating_add(subtitle_downloaded_bytes);
            let materialized_index = subtitle_tracks.len();
            tokio::fs::write(
                assets_dir.join(format!("subtitle-{materialized_index}.m3u8")),
                subtitle_playlist,
            )
            .await
            .map_err(|_| ())?;
            subtitle_tracks.push((subtitle.clone(), materialized_subtitle));
        }
    }
    if !audio_tracks.is_empty() || !subtitle_tracks.is_empty() {
        let video_playlist = serialize_dash_period_playlist(&video_tracks)?;
        tokio::fs::write(assets_dir.join("video.m3u8"), video_playlist)
            .await
            .map_err(|_| ())?;
        let audios = audio_tracks
            .iter()
            .enumerate()
            .map(|(index, (audio, _))| MaterializedHlsAudio {
                uri: format!("{directory_name}/audio-{index}.m3u8"),
                language: audio.language.clone(),
                label: audio.label.clone(),
                is_default: audio.is_main,
                autoselect: true,
            })
            .collect::<Vec<_>>();
        let subtitles = subtitle_tracks
            .iter()
            .enumerate()
            .map(|(index, (subtitle, _))| MaterializedHlsSubtitle {
                uri: format!("{directory_name}/subtitle-{index}.m3u8"),
                language: subtitle.language.clone(),
                label: Some(subtitle.label.clone()),
                is_default: false,
                autoselect: true,
                forced: subtitle.forced,
            })
            .collect::<Vec<_>>();
        tokio::fs::write(
            output_path,
            local_hls_master_manifest_with_tracks(
                directory_name,
                video_tracks
                    .iter()
                    .map(|materialized| materialized.track.bandwidth)
                    .max()
                    .unwrap_or(1),
                &audios,
                &subtitles,
            ),
        )
        .await
        .map_err(|_| ())?;
    } else {
        for materialized in &mut video_tracks {
            materialized.asset_prefix = format!("{directory_name}/{}", materialized.asset_prefix);
        }
        let video_playlist = serialize_dash_period_playlist(&video_tracks)?;
        tokio::fs::write(output_path, video_playlist)
            .await
            .map_err(|_| ())?;
    }
    let _ = tokio::fs::remove_file(source_mpd_path).await;
    Ok(live_snapshot)
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
        let Ok(child_url) = join_with_same_origin_query(&base_url, reference) else {
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
                request_headers: parent.request_headers.clone(),
                request_header_origin: parent.request_header_origin.clone(),
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

async fn materialize_hls_subtitle_renditions(
    state: &AppState,
    renditions: &[(url::Url, HlsSubtitleRendition)],
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    inherited_variables: &HashMap<String, String>,
    assets_dir: &PathBuf,
    asset_directory_name: &str,
    mut already_downloaded: u64,
) -> Result<(Vec<MaterializedHlsSubtitle>, u64), ()> {
    let mut subtitles = Vec::with_capacity(renditions.len());
    let mut default_assigned = false;
    for (index, (subtitle_url, rendition)) in renditions.iter().enumerate() {
        let temporary_path = assets_dir.join(format!("subtitle-source-{index}.m3u8"));
        let local_playlist = assets_dir.join(format!("subtitle-{index}.m3u8"));
        let local_assets = assets_dir.join(format!("subtitle-{index}"));
        let asset_prefix = format!("{asset_directory_name}/subtitle-{index}");
        let track_result = async {
            let (final_url, manifest, manifest_size) = download_hls_media_playlist_manifest(
                state,
                subtitle_url,
                credential_origin,
                request_headers,
                &temporary_path,
            )
            .await?;
            let total_before_segments = already_downloaded.saturating_add(manifest_size);
            if total_before_segments > max_conversion_bytes() {
                return Err(());
            }
            let (manifest, _) = resolve_hls_variables(&manifest, &final_url, inherited_variables)?;
            if select_hls_conversion_variant(&manifest)?.is_some() {
                return Err(());
            }
            let subtitle_bytes = materialize_hls_media_playlist(
                state,
                &manifest,
                &final_url,
                credential_origin,
                request_headers,
                &local_playlist,
                &local_assets,
                &asset_prefix,
                total_before_segments,
            )
            .await?;
            if total_before_segments.saturating_add(subtitle_bytes) > max_conversion_bytes() {
                return Err(());
            }
            Ok::<_, ()>(manifest_size.saturating_add(subtitle_bytes))
        }
        .await;
        match track_result {
            Ok(track_bytes) => {
                already_downloaded = already_downloaded.saturating_add(track_bytes);
            }
            Err(()) => {
                // Captions are optional. Remove any partial download and keep
                // its consumed bytes in the job budget before trying the next
                // rendition, so a broken subtitle host cannot block video.
                already_downloaded = already_downloaded.saturating_add(
                    conversion_asset_bytes(&[
                        temporary_path.clone(),
                        local_playlist.clone(),
                        local_assets.clone(),
                    ])
                    .await,
                );
                let _ = tokio::fs::remove_file(&temporary_path).await;
                let _ = tokio::fs::remove_file(&local_playlist).await;
                let _ = tokio::fs::remove_dir_all(&local_assets).await;
                if already_downloaded > max_conversion_bytes() {
                    return Err(());
                }
                continue;
            }
        }
        let _ = tokio::fs::remove_file(temporary_path).await;
        let language = rendition.language.as_deref().filter(|language| {
            !language.is_empty()
                && language.len() <= 35
                && language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
        let is_default = rendition.is_default && !default_assigned;
        default_assigned |= is_default;
        subtitles.push(MaterializedHlsSubtitle {
            uri: format!("{asset_directory_name}/subtitle-{index}.m3u8"),
            language: language.map(str::to_owned),
            label: None,
            is_default,
            autoselect: rendition.autoselect || is_default,
            forced: rendition.forced,
        });
    }
    Ok((subtitles, already_downloaded))
}

async fn conversion_asset_bytes(paths: &[PathBuf]) -> u64 {
    let mut pending = paths.to_vec();
    let mut total = 0u64;
    while let Some(path) = pending.pop() {
        let Ok(metadata) = tokio::fs::metadata(&path).await else {
            continue;
        };
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            let Ok(mut entries) = tokio::fs::read_dir(path).await else {
                continue;
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                pending.push(entry.path());
            }
        }
    }
    total
}

async fn materialize_hls_audio_renditions(
    state: &AppState,
    renditions: &[(url::Url, HlsAudioRendition)],
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    inherited_variables: &HashMap<String, String>,
    assets_dir: &PathBuf,
    asset_directory_name: &str,
    mut already_downloaded: u64,
) -> Result<(Vec<MaterializedHlsAudio>, u64), ()> {
    let mut audio_tracks = Vec::with_capacity(renditions.len());
    let mut default_assigned = false;
    for (index, (audio_url, rendition)) in renditions.iter().enumerate() {
        let temporary_path = assets_dir.join(format!("audio-source-{index}.m3u8"));
        let local_playlist = assets_dir.join(format!("audio-{index}.m3u8"));
        let local_assets = assets_dir.join(format!("audio-{index}"));
        let asset_prefix = format!("{asset_directory_name}/audio-{index}");
        let result = async {
            let (final_url, manifest, manifest_size) = download_hls_media_playlist_manifest(
                state,
                audio_url,
                credential_origin,
                request_headers,
                &temporary_path,
            )
            .await?;
            let total = already_downloaded.saturating_add(manifest_size);
            if total > max_conversion_bytes() {
                return Err(());
            }
            let (manifest, _) = resolve_hls_variables(&manifest, &final_url, inherited_variables)?;
            if select_hls_conversion_variant(&manifest)?.is_some() {
                return Err(());
            }
            let audio_bytes = materialize_hls_media_playlist(
                state,
                &manifest,
                &final_url,
                credential_origin,
                request_headers,
                &local_playlist,
                &local_assets,
                &asset_prefix,
                total,
            )
            .await?;
            let total = total.saturating_add(audio_bytes);
            if total > max_conversion_bytes() {
                return Err(());
            }
            let language = rendition
                .language
                .as_deref()
                .filter(|language| is_safe_hls_language(language))
                .map(str::to_owned);
            let label = if is_safe_hls_label(&rendition.name) {
                rendition.name.clone()
            } else {
                format!("Audio {}", index + 1)
            };
            Ok::<_, ()>((
                total,
                MaterializedHlsAudio {
                    uri: format!("{asset_directory_name}/audio-{index}.m3u8"),
                    language,
                    label,
                    is_default: false,
                    autoselect: rendition.autoselect,
                },
            ))
        }
        .await;
        match result {
            Ok((total, mut audio_track)) => {
                already_downloaded = total;
                if rendition.is_default && !default_assigned {
                    audio_track.is_default = true;
                    audio_track.autoselect = true;
                    default_assigned = true;
                }
                audio_tracks.push(audio_track);
            }
            Err(()) => {
                // Preserve the global transfer budget even when a rendition
                // fails partway through downloading its playlist or segments.
                already_downloaded = already_downloaded.saturating_add(
                    conversion_asset_bytes(&[
                        temporary_path.clone(),
                        local_playlist.clone(),
                        local_assets.clone(),
                    ])
                    .await,
                );
                let _ = tokio::fs::remove_file(temporary_path).await;
                let _ = tokio::fs::remove_file(local_playlist).await;
                let _ = tokio::fs::remove_dir_all(local_assets).await;
                if already_downloaded > max_conversion_bytes() {
                    return Err(());
                }
            }
        }
    }
    if !renditions.is_empty() && audio_tracks.is_empty() {
        return Err(());
    }
    if !audio_tracks.is_empty() && !default_assigned {
        audio_tracks[0].is_default = true;
        audio_tracks[0].autoselect = true;
    }
    Ok((audio_tracks, already_downloaded))
}

async fn download_hls_conversion_input(
    state: &AppState,
    initial_url: &url::Url,
    request_headers: &HashMap<String, String>,
    output_path: &PathBuf,
    assets_dir: &PathBuf,
    mobile_compatibility: bool,
) -> Result<bool, ()> {
    let credential_origin = initial_url.origin();
    tokio::fs::create_dir(assets_dir).await.map_err(|_| ())?;
    let mut playlist_url = initial_url.clone();
    let mut downloaded_bytes = 0u64;
    let mut final_manifest = String::new();
    let mut final_base_url = initial_url.clone();
    let mut temporary_manifest = PathBuf::new();
    let mut external_audio = Vec::<(url::Url, HlsAudioRendition)>::new();
    let mut external_audio_bandwidth = 5_000_000u64;
    let mut playlist_variables = HashMap::new();
    let mut external_audio_variables = HashMap::new();
    let mut external_subtitles = Vec::<(url::Url, HlsSubtitleRendition)>::new();
    let mut external_subtitle_variables = HashMap::new();

    for depth in 0..MAX_HLS_NESTING_DEPTH {
        temporary_manifest = assets_dir.join(format!("master-{depth}.m3u8"));
        let (final_url, content_type, bytes) = download_allowlisted_resource(
            state,
            &playlist_url,
            &credential_origin,
            request_headers,
            &temporary_manifest,
            MAX_HLS_MANIFEST_BYTES as u64,
            true,
        )
        .await?;
        downloaded_bytes = downloaded_bytes.saturating_add(bytes);
        if downloaded_bytes > max_conversion_bytes() {
            return Err(());
        }
        if !is_hls_playlist(&final_url, Some(&content_type)) {
            return Err(());
        }
        let bytes = tokio::fs::read(&temporary_manifest).await.map_err(|_| ())?;
        let manifest = String::from_utf8(bytes).map_err(|_| ())?;
        let manifest = manifest.strip_prefix('\u{feff}').unwrap_or(&manifest);
        if !manifest.trim_start().starts_with("#EXTM3U") {
            return Err(());
        }
        let (manifest, variables) =
            resolve_hls_variables(manifest, &final_url, &playlist_variables)?;
        if let Some(selection) =
            select_hls_conversion_variant_for_mobile(&manifest, mobile_compatibility)?
        {
            let _ = tokio::fs::remove_file(&temporary_manifest).await;
            playlist_url = join_with_same_origin_query(&final_url, &selection.uri)?;
            if validate_media_url(&playlist_url, &state.allowed_media_hosts).is_err() {
                return Err(());
            }
            if !selection.audio_renditions.is_empty() {
                let mut resolved_audio = Vec::new();
                for rendition in selection.audio_renditions {
                    let audio_url = join_with_same_origin_query(&final_url, &rendition.uri)?;
                    if validate_media_url(&audio_url, &state.allowed_media_hosts).is_ok() {
                        resolved_audio.push((audio_url, rendition));
                    }
                }
                if resolved_audio.is_empty() {
                    return Err(());
                }
                external_audio = resolved_audio;
                external_audio_bandwidth = selection.bandwidth;
                external_audio_variables = variables.clone();
            }
            if !selection.subtitle_renditions.is_empty() {
                let mut resolved_subtitles = Vec::new();
                for rendition in selection.subtitle_renditions {
                    let Ok(subtitle_url) = join_with_same_origin_query(&final_url, &rendition.uri)
                    else {
                        continue;
                    };
                    if validate_media_url(&subtitle_url, &state.allowed_media_hosts).is_err() {
                        continue;
                    }
                    resolved_subtitles.push((subtitle_url, rendition));
                }
                external_subtitles = resolved_subtitles;
                external_subtitle_variables = variables.clone();
            }
            playlist_variables = variables;
            continue;
        }
        final_manifest = manifest;
        final_base_url = final_url;
        break;
    }
    if final_manifest.is_empty() {
        return Err(());
    }
    let live_snapshot = !final_manifest
        .lines()
        .any(|line| line.trim() == "#EXT-X-ENDLIST");
    let asset_directory_name = assets_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(())?;
    if !external_audio.is_empty() || !external_subtitles.is_empty() {
        let video_playlist_path = assets_dir.join("video.m3u8");
        let video_assets = assets_dir.join("video");
        downloaded_bytes = downloaded_bytes.saturating_add(
            materialize_hls_media_playlist(
                state,
                &final_manifest,
                &final_base_url,
                &credential_origin,
                request_headers,
                &video_playlist_path,
                &video_assets,
                "video",
                downloaded_bytes,
            )
            .await?,
        );
        let (audio_tracks, total_audio_bytes) = materialize_hls_audio_renditions(
            state,
            &external_audio,
            &credential_origin,
            request_headers,
            &external_audio_variables,
            assets_dir,
            asset_directory_name,
            downloaded_bytes,
        )
        .await?;
        if total_audio_bytes > max_conversion_bytes() {
            return Err(());
        }
        downloaded_bytes = total_audio_bytes;
        let (subtitles, total_bytes) = materialize_hls_subtitle_renditions(
            state,
            &external_subtitles,
            &credential_origin,
            request_headers,
            &external_subtitle_variables,
            assets_dir,
            asset_directory_name,
            downloaded_bytes,
        )
        .await?;
        if total_bytes > max_conversion_bytes() {
            return Err(());
        }
        let master = local_hls_master_manifest_with_tracks(
            asset_directory_name,
            external_audio_bandwidth,
            &audio_tracks,
            &subtitles,
        );
        tokio::fs::write(output_path, master)
            .await
            .map_err(|_| ())?;
    } else {
        materialize_hls_media_playlist(
            state,
            &final_manifest,
            &final_base_url,
            &credential_origin,
            request_headers,
            output_path,
            assets_dir,
            asset_directory_name,
            downloaded_bytes,
        )
        .await?;
    }
    let _ = tokio::fs::remove_file(temporary_manifest).await;
    Ok(live_snapshot)
}

async fn download_hls_media_playlist_manifest(
    state: &AppState,
    initial_url: &url::Url,
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    manifest_path: &PathBuf,
) -> Result<(url::Url, String, u64), ()> {
    let (final_url, content_type, size) = download_allowlisted_resource(
        state,
        initial_url,
        credential_origin,
        request_headers,
        manifest_path,
        MAX_HLS_MANIFEST_BYTES as u64,
        true,
    )
    .await?;
    if !is_hls_playlist(&final_url, Some(&content_type)) {
        return Err(());
    }
    let bytes = tokio::fs::read(manifest_path).await.map_err(|_| ())?;
    let manifest = String::from_utf8(bytes).map_err(|_| ())?;
    let manifest = manifest
        .strip_prefix('\u{feff}')
        .unwrap_or(&manifest)
        .to_string();
    if !manifest.trim_start().starts_with("#EXTM3U") {
        return Err(());
    }
    Ok((final_url, manifest, size))
}

async fn materialize_hls_media_playlist(
    state: &AppState,
    manifest: &str,
    base_url: &url::Url,
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    output_path: &PathBuf,
    assets_dir: &PathBuf,
    asset_prefix: &str,
    already_downloaded: u64,
) -> Result<u64, ()> {
    tokio::fs::create_dir_all(assets_dir)
        .await
        .map_err(|_| ())?;
    let snapshot_manifest = strip_hls_low_latency_parts(manifest)?;
    let (final_manifest, range_bytes) = materialize_hls_byte_ranges(
        state,
        &snapshot_manifest,
        base_url,
        credential_origin,
        request_headers,
        assets_dir,
        asset_prefix,
        already_downloaded,
    )
    .await?;
    let mut downloaded_bytes = already_downloaded.saturating_add(range_bytes);
    let spans = hls_conversion_resource_spans(&final_manifest)?;
    let mut replacements = HashMap::new();
    for (index, (_, _, reference)) in spans.iter().enumerate() {
        if replacements.contains_key(reference) {
            continue;
        }
        if reference.starts_with(&format!("{asset_prefix}/range-")) {
            replacements.insert(reference.clone(), reference.clone());
            continue;
        }
        let line_start = final_manifest[..spans[index].0]
            .rfind('\n')
            .map(|offset| offset + 1)
            .unwrap_or(0);
        let line = final_manifest[line_start..spans[index].0].trim_start();
        let is_key = line.starts_with("#EXT-X-KEY:");
        let resource_url = join_with_same_origin_query(base_url, reference)?;
        if validate_media_url(&resource_url, &state.allowed_media_hosts).is_err() {
            return Err(());
        }
        let resource_index = replacements.len();
        let temporary_name = format!("resource-{resource_index:04}.download");
        let temporary_path = assets_dir.join(&temporary_name);
        let remaining = max_conversion_bytes().saturating_sub(downloaded_bytes);
        let (_, content_type, length) = download_allowlisted_resource(
            state,
            &resource_url,
            &credential_origin,
            request_headers,
            &temporary_path,
            remaining,
            false,
        )
        .await?;
        if is_key && length != 16 {
            return Err(());
        }
        let extension = hls_resource_extension(
            &resource_url,
            &content_type,
            is_key,
            line.starts_with("#EXT-X-MAP:"),
        );
        let local_name = format!("resource-{resource_index:04}.{extension}");
        tokio::fs::rename(&temporary_path, assets_dir.join(&local_name))
            .await
            .map_err(|_| ())?;
        downloaded_bytes = downloaded_bytes.saturating_add(length);
        replacements.insert(reference.clone(), format!("{asset_prefix}/{local_name}"));
    }
    let rewritten = replace_playlist_uris(&final_manifest, &spans, &replacements)?;
    let rewritten = if rewritten
        .lines()
        .any(|line| line.trim() == "#EXT-X-ENDLIST")
    {
        rewritten
    } else {
        format!(
            "{}{}#EXT-X-ENDLIST\n",
            rewritten,
            if rewritten.ends_with('\n') { "" } else { "\n" }
        )
    };
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)
        .await
        .map_err(|_| ())?;
    output
        .write_all(rewritten.as_bytes())
        .await
        .map_err(|_| ())?;
    output.flush().await.map_err(|_| ())?;
    Ok(downloaded_bytes.saturating_sub(already_downloaded))
}

async fn materialize_hls_byte_ranges(
    state: &AppState,
    manifest: &str,
    base_url: &url::Url,
    credential_origin: &url::Origin,
    request_headers: &HashMap<String, String>,
    assets_dir: &PathBuf,
    asset_prefix: &str,
    already_downloaded: u64,
) -> Result<(String, u64), ()> {
    let (mut output, requests) = rewrite_hls_byte_ranges(manifest, base_url, asset_prefix)?;
    let mut downloaded_bytes = 0u64;

    for request in requests {
        if validate_media_url(&request.url, &state.allowed_media_hosts).is_err() {
            return Err(());
        }
        let length = request.end - request.start + 1;
        let maximum = max_conversion_bytes()
            .saturating_sub(already_downloaded.saturating_add(downloaded_bytes));
        if length > maximum {
            return Err(());
        }
        let temporary_path = assets_dir.join(format!("{}.download", request.local_stem));
        let (_, content_type, received) = download_allowlisted_resource_with_range(
            state,
            &request.url,
            credential_origin,
            request_headers,
            &temporary_path,
            length,
            false,
            Some((request.start, request.end)),
        )
        .await?;
        if received != length {
            return Err(());
        }
        let extension = hls_resource_extension(&request.url, &content_type, false, request.is_map);
        let local_name = format!("{}.{}", request.local_stem, extension);
        tokio::fs::rename(&temporary_path, assets_dir.join(&local_name))
            .await
            .map_err(|_| ())?;
        output = output.replace(
            &request.placeholder,
            &format!("{asset_prefix}/{local_name}"),
        );
        downloaded_bytes = downloaded_bytes.saturating_add(received);
    }
    Ok((output, downloaded_bytes))
}

struct HlsByteRangeRequest {
    url: url::Url,
    start: u64,
    end: u64,
    local_stem: String,
    placeholder: String,
    is_map: bool,
}

fn rewrite_hls_byte_ranges(
    manifest: &str,
    base_url: &url::Url,
    assets_name: &str,
) -> Result<(String, Vec<HlsByteRangeRequest>), ()> {
    let mut output = String::with_capacity(manifest.len());
    let mut requests = Vec::new();
    let mut pending_range: Option<(u64, Option<u64>)> = None;
    let mut previous_range: Option<(String, u64)> = None;

    for raw_line in manifest.split_inclusive('\n') {
        let line = raw_line.trim_end_matches(|character| character == '\r' || character == '\n');
        let trimmed = line.trim();
        if let Some(attributes) = trimmed.strip_prefix("#EXT-X-MAP:") {
            let parsed = parse_hls_attribute_list(attributes)?;
            let uri = parsed
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("URI"))
                .map(|(_, value)| value.as_str());
            let byte_range = parsed
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("BYTERANGE"))
                .map(|(_, value)| value.as_str());
            if let Some(byte_range) = byte_range {
                let uri = uri.map(unquote_hls_attribute_value).ok_or(())?;
                let (length, offset) =
                    parse_hls_byte_range_attribute(unquote_hls_attribute_value(byte_range))?;
                let url = join_with_same_origin_query(base_url, uri)?;
                // RFC 8216 defines an omitted map offset as zero.
                let (start, end) =
                    resolve_hls_byte_range(length, Some(offset.unwrap_or(0)), url.as_str(), None)?;
                let index = requests.len();
                let placeholder = format!("{assets_name}/range-{index:04}");
                let local_stem = format!("range-{index:04}");
                requests.push(HlsByteRangeRequest {
                    url,
                    start,
                    end,
                    local_stem,
                    placeholder: placeholder.clone(),
                    is_map: true,
                });
                let mut rewritten_attributes = vec![format!("URI=\"{placeholder}\"")];
                rewritten_attributes.extend(parsed.iter().filter_map(|(name, value)| {
                    (!name.eq_ignore_ascii_case("URI") && !name.eq_ignore_ascii_case("BYTERANGE"))
                        .then(|| format!("{name}={value}"))
                }));
                output.push_str(&format!("#EXT-X-MAP:{}", rewritten_attributes.join(",")));
                if raw_line.ends_with('\n') {
                    if raw_line[..raw_line.len() - 1].ends_with('\r') {
                        output.push('\r');
                    }
                    output.push('\n');
                }
                continue;
            }
        }
        if let Some(value) = trimmed.strip_prefix("#EXT-X-BYTERANGE:") {
            if pending_range.is_some() {
                return Err(());
            }
            pending_range = Some(parse_hls_byte_range_attribute(value)?);
            continue;
        }
        if let Some((length, offset)) = pending_range.take() {
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return Err(());
            }
            let url = join_with_same_origin_query(base_url, trimmed)?;
            let resource_key = url.as_str().to_string();
            let (start, end) = resolve_hls_byte_range(
                length,
                offset,
                &resource_key,
                previous_range
                    .as_ref()
                    .map(|(url, end)| (url.as_str(), *end)),
            )?;
            let index = requests.len();
            let placeholder = format!("{assets_name}/range-{index:04}");
            let local_stem = format!("range-{index:04}");
            requests.push(HlsByteRangeRequest {
                url,
                start,
                end,
                local_stem,
                placeholder: placeholder.clone(),
                is_map: false,
            });
            let leading_whitespace = line.len() - line.trim_start().len();
            output.push_str(&line[..leading_whitespace]);
            output.push_str(&placeholder);
            if raw_line.ends_with('\n') {
                if raw_line[..raw_line.len() - 1].ends_with('\r') {
                    output.push('\r');
                }
                output.push('\n');
            }
            previous_range = Some((resource_key, end.saturating_add(1)));
            continue;
        }
        output.push_str(raw_line);
    }
    if pending_range.is_some() {
        return Err(());
    }
    Ok((output, requests))
}

fn parse_hls_byte_range_attribute(value: &str) -> Result<(u64, Option<u64>), ()> {
    let (length, offset) = match value.split_once('@') {
        Some((length, offset)) => (
            length.parse::<u64>().map_err(|_| ())?,
            Some(offset.parse::<u64>().map_err(|_| ())?),
        ),
        None => (value.parse::<u64>().map_err(|_| ())?, None),
    };
    if length == 0 {
        return Err(());
    }
    Ok((length, offset))
}

fn unquote_hls_attribute_value(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value)
}

fn parse_hls_attribute_list(input: &str) -> Result<Vec<(String, String)>, ()> {
    let mut fields = Vec::new();
    let mut start = 0usize;
    let mut in_quotes = false;
    for (index, character) in input.char_indices() {
        if character == '"' {
            in_quotes = !in_quotes;
        } else if character == ',' && !in_quotes {
            fields.push(&input[start..index]);
            start = index + 1;
        }
    }
    if in_quotes {
        return Err(());
    }
    fields.push(&input[start..]);
    fields
        .into_iter()
        .map(|field| {
            let (name, value) = field.split_once('=').ok_or(())?;
            let name = name.trim();
            let value = value.trim();
            if name.is_empty() || value.is_empty() {
                return Err(());
            }
            Ok((name.to_string(), value.to_string()))
        })
        .collect()
}

fn resolve_hls_variables(
    manifest: &str,
    playlist_url: &url::Url,
    inherited: &HashMap<String, String>,
) -> Result<(String, HashMap<String, String>), ()> {
    const MAX_VARIABLES: usize = 64;
    const MAX_VARIABLE_VALUE_BYTES: usize = 4_096;
    let mut variables = HashMap::new();
    let mut manifest_without_definitions = String::with_capacity(manifest.len());
    for raw_line in manifest.split_inclusive('\n') {
        let line = raw_line.trim_end_matches(['\r', '\n']).trim();
        let Some(attributes) = line.strip_prefix("#EXT-X-DEFINE:") else {
            manifest_without_definitions.push_str(raw_line);
            continue;
        };
        let attributes = parse_hls_attribute_list(attributes)?;
        let get = |name: &str| {
            attributes
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| unquote_hls_attribute_value(value))
        };
        let name = get("NAME");
        let value = get("VALUE");
        let query_parameter = get("QUERYPARAM");
        let import = get("IMPORT");
        let (name, value) = match (name, value, query_parameter, import) {
            (Some(name), Some(value), None, None) => (name, value.to_string()),
            (None, None, Some(name), None) => {
                let value = hls_query_parameter(playlist_url, name)?;
                (name, value)
            }
            (None, None, None, Some(name)) => {
                let value = inherited.get(name).cloned().ok_or(())?;
                (name, value)
            }
            _ => return Err(()),
        };
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || value.len() > MAX_VARIABLE_VALUE_BYTES
            || value.chars().any(char::is_control)
            || variables.contains_key(name)
            || variables.len() >= MAX_VARIABLES
        {
            return Err(());
        }
        variables.insert(name.to_string(), value);
    }

    let spans = playlist_uri_spans(&manifest_without_definitions)?;
    let mut replacements = HashMap::new();
    for (_, _, reference) in &spans {
        replacements.insert(
            reference.clone(),
            replace_hls_variable_references(reference, &variables)?,
        );
    }
    let resolved = replace_playlist_uris(&manifest_without_definitions, &spans, &replacements)?;
    Ok((resolved, variables))
}

fn hls_query_parameter(playlist_url: &url::Url, name: &str) -> Result<String, ()> {
    let query = playlist_url.query().ok_or(())?;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode_hls_query_component(key)? == name {
            return percent_decode_hls_query_component(value);
        }
    }
    Err(())
}

fn percent_decode_hls_query_component(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1).ok_or(())?;
            let low = *bytes.get(index + 2).ok_or(())?;
            let high = (high as char).to_digit(16).ok_or(())? as u8;
            let low = (low as char).to_digit(16).ok_or(())? as u8;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn replace_hls_variable_references(
    input: &str,
    variables: &HashMap<String, String>,
) -> Result<String, ()> {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0usize;
    while let Some(relative_start) = input[cursor..].find("{$") {
        let start = cursor + relative_start;
        let name_start = start + 2;
        let relative_end = input[name_start..].find('}').ok_or(())?;
        let end = name_start + relative_end;
        let name = &input[name_start..end];
        let value = variables.get(name).ok_or(())?;
        output.push_str(&input[cursor..start]);
        output.push_str(value);
        cursor = end + 1;
        if output.len() > MAX_HLS_MANIFEST_BYTES {
            return Err(());
        }
    }
    output.push_str(&input[cursor..]);
    if output.len() > MAX_HLS_MANIFEST_BYTES {
        return Err(());
    }
    Ok(output)
}

fn resolve_hls_byte_range(
    length: u64,
    offset: Option<u64>,
    resource_url: &str,
    previous_range: Option<(&str, u64)>,
) -> Result<(u64, u64), ()> {
    if length == 0 {
        return Err(());
    }
    let start = match offset {
        Some(offset) => offset,
        None => {
            let (previous_url, previous_end) = previous_range.ok_or(())?;
            if previous_url != resource_url {
                return Err(());
            }
            previous_end
        }
    };
    let end = start.checked_add(length - 1).ok_or(())?;
    Ok((start, end))
}

fn hls_resource_extension(
    url: &url::Url,
    content_type: &str,
    is_key: bool,
    is_map: bool,
) -> &'static str {
    if is_key {
        return "key";
    }
    let content_type = content_type.split(';').next().unwrap_or("").trim();
    match content_type {
        "video/mp2t" | "video/mpeg" => return "ts",
        "video/mp4" | "application/mp4" => return if is_map { "mp4" } else { "m4s" },
        "audio/aac" | "audio/aacp" => return "aac",
        "audio/mpeg" => return "mp3",
        "text/vtt" => return "vtt",
        _ => {}
    }
    match url
        .path()
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "ts" => "ts",
        "m4s" => "m4s",
        "mp4" => "mp4",
        "m4v" => "m4v",
        "m4a" => "m4a",
        "aac" => "aac",
        "ac3" => "ac3",
        "ec3" => "ec3",
        "mp3" => "mp3",
        "vtt" | "webvtt" => "vtt",
        "cmfv" => "cmfv",
        "cmfa" => "cmfa",
        _ if is_map => "mp4",
        _ => "ts",
    }
}

fn strip_hls_low_latency_parts(manifest: &str) -> Result<String, ()> {
    if !manifest.trim_start().starts_with("#EXTM3U") {
        return Err(());
    }
    let lines = manifest.lines().collect::<Vec<_>>();
    let last_complete_segment = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .map(|(index, _)| index)
        .last();
    let mut snapshot = String::with_capacity(manifest.len());
    let mut independent_part_sequence = false;
    let mut previous_part_range: Option<(String, u64)> = None;
    for (index, line) in lines.iter().enumerate() {
        let tag = line.trim_start();
        if let Some(attributes) = tag.strip_prefix("#EXT-X-PART:") {
            if last_complete_segment.is_some_and(|last| index <= last) {
                previous_part_range = None;
                continue;
            }
            let attributes = parse_hls_attribute_list(attributes)?;
            let get = |name: &str| {
                attributes
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
                    .map(|(_, value)| unquote_hls_attribute_value(value))
            };
            if get("GAP").is_some_and(|value| value.eq_ignore_ascii_case("YES")) {
                independent_part_sequence = false;
                previous_part_range = None;
                continue;
            }
            if get("INDEPENDENT").is_some_and(|value| value.eq_ignore_ascii_case("YES")) {
                independent_part_sequence = true;
            }
            if !independent_part_sequence {
                continue;
            }
            let duration = get("DURATION").ok_or(())?.parse::<f64>().map_err(|_| ())?;
            if !duration.is_finite() || duration <= 0.0 {
                return Err(());
            }
            let uri = get("URI").filter(|uri| !uri.is_empty()).ok_or(())?;
            let resolved_range = if let Some(range) = get("BYTERANGE") {
                let (length, offset) = parse_hls_byte_range_attribute(range)?;
                let start = match offset {
                    Some(offset) => offset,
                    None => match previous_part_range
                        .as_ref()
                        .filter(|(previous_uri, _)| previous_uri == uri)
                    {
                        Some((_, previous_end)) => *previous_end,
                        None => {
                            independent_part_sequence = false;
                            previous_part_range = None;
                            continue;
                        }
                    },
                };
                let end = start.checked_add(length).ok_or(())?;
                previous_part_range = Some((uri.to_string(), end));
                Some((length, start))
            } else {
                previous_part_range = None;
                None
            };
            snapshot.push_str(&format!("#EXTINF:{duration:.6},\n"));
            if let Some((length, start)) = resolved_range {
                snapshot.push_str(&format!("#EXT-X-BYTERANGE:{length}@{start}\n"));
            }
            snapshot.push_str(uri);
            snapshot.push('\n');
        } else if tag.starts_with("#EXT-X-PRELOAD-HINT:")
            || tag.starts_with("#EXT-X-PART-INF:")
            || tag.starts_with("#EXT-X-RENDITION-REPORT:")
            || tag.starts_with("#EXT-X-SERVER-CONTROL:")
        {
            continue;
        }
        snapshot.push_str(line);
        snapshot.push('\n');
        if snapshot.len() > MAX_HLS_MANIFEST_BYTES {
            return Err(());
        }
    }
    Ok(snapshot)
}

fn hls_conversion_resource_spans(manifest: &str) -> Result<Vec<(usize, usize, String)>, ()> {
    if !manifest.trim_start().starts_with("#EXTM3U")
        || manifest.lines().any(|line| {
            let line = line.trim();
            line.starts_with("#EXT-X-SKIP:") || line.starts_with("#EXT-X-MEDIA:TYPE=AUDIO")
        })
    {
        return Err(());
    }
    let spans = playlist_uri_spans(manifest)?;
    if spans.is_empty() || spans.len() > MAX_HLS_REFERENCES {
        return Err(());
    }
    if !spans.iter().any(|(start, _, _)| {
        let line_start = manifest[..*start]
            .rfind('\n')
            .map(|offset| offset + 1)
            .unwrap_or(0);
        !manifest[line_start..*start].trim_start().starts_with('#')
    }) {
        return Err(());
    }
    for (start, _, reference) in &spans {
        let line_start = manifest[..*start]
            .rfind('\n')
            .map(|offset| offset + 1)
            .unwrap_or(0);
        let line = manifest[line_start..*start].trim_start();
        let is_segment = !line.starts_with('#');
        let is_key = line.starts_with("#EXT-X-KEY:");
        let is_map = line.starts_with("#EXT-X-MAP:");
        if (!is_segment && !is_key && !is_map)
            || (is_key && !is_supported_hls_key_tag(line))
            || (is_map && line.contains("BYTERANGE="))
            || reference.starts_with("data:")
            || reference.starts_with("skd:")
        {
            return Err(());
        }
    }
    Ok(spans)
}

fn is_supported_hls_key_tag(line: &str) -> bool {
    let Some(attributes) = line.strip_prefix("#EXT-X-KEY:") else {
        return false;
    };
    let mut method = None;
    let mut key_format = None;
    for field in attributes.split(',') {
        let Some((name, value)) = field.trim().split_once('=') else {
            continue;
        };
        if name.eq_ignore_ascii_case("METHOD") {
            method = Some(value.trim_matches('"'));
        } else if name.eq_ignore_ascii_case("KEYFORMAT") {
            key_format = Some(value.trim_matches('"'));
        }
    }
    match method {
        Some(value) if value.eq_ignore_ascii_case("NONE") => true,
        Some(value) if value.eq_ignore_ascii_case("AES-128") => {
            key_format.is_none_or(|format| format.eq_ignore_ascii_case("identity"))
        }
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HlsVariantSelection {
    uri: String,
    bandwidth: u64,
    audio_renditions: Vec<HlsAudioRendition>,
    subtitle_renditions: Vec<HlsSubtitleRendition>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HlsAudioRendition {
    uri: String,
    name: String,
    language: Option<String>,
    is_default: bool,
    autoselect: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HlsSubtitleRendition {
    uri: String,
    language: Option<String>,
    is_default: bool,
    autoselect: bool,
    forced: bool,
}

#[derive(Clone, Debug)]
struct MaterializedHlsSubtitle {
    uri: String,
    language: Option<String>,
    label: Option<String>,
    is_default: bool,
    autoselect: bool,
    forced: bool,
}

#[derive(Clone, Debug)]
struct MaterializedHlsAudio {
    uri: String,
    language: Option<String>,
    label: String,
    is_default: bool,
    autoselect: bool,
}

fn select_hls_conversion_variant(manifest: &str) -> Result<Option<HlsVariantSelection>, ()> {
    select_hls_conversion_variant_for_mobile(manifest, false)
}

fn select_hls_conversion_variant_for_mobile(
    manifest: &str,
    mobile_compatibility: bool,
) -> Result<Option<HlsVariantSelection>, ()> {
    let mut audio_renditions = Vec::new();
    let mut subtitle_renditions = Vec::new();
    for line in manifest.lines().map(str::trim) {
        let Some(attributes) = line.strip_prefix("#EXT-X-MEDIA:") else {
            continue;
        };
        let attributes = parse_hls_attribute_list(attributes)?;
        let attribute = |name: &str| {
            attributes
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| unquote_hls_attribute_value(value))
        };
        if attribute("TYPE").is_some_and(|value| value.eq_ignore_ascii_case("AUDIO")) {
            audio_renditions.push((
                attribute("GROUP-ID").ok_or(())?.to_string(),
                attribute("URI").map(str::to_string),
                attribute("NAME").map(str::to_string),
                attribute("LANGUAGE").map(str::to_string),
                attribute("DEFAULT").is_some_and(|value| value.eq_ignore_ascii_case("YES")),
                attribute("AUTOSELECT").is_some_and(|value| value.eq_ignore_ascii_case("YES")),
            ));
        } else if attribute("TYPE").is_some_and(|value| value.eq_ignore_ascii_case("SUBTITLES")) {
            subtitle_renditions.push((
                attribute("GROUP-ID").ok_or(())?.to_string(),
                attribute("URI").map(str::to_string),
                attribute("LANGUAGE").map(str::to_string),
                attribute("DEFAULT").is_some_and(|value| value.eq_ignore_ascii_case("YES")),
                attribute("AUTOSELECT").is_some_and(|value| value.eq_ignore_ascii_case("YES")),
                attribute("FORCED").is_some_and(|value| value.eq_ignore_ascii_case("YES")),
            ));
        }
    }

    let mut pending: Option<(
        u64,
        Option<String>,
        Option<String>,
        Option<(u64, u64)>,
        Option<f64>,
    )> = None;
    let mut selected: Option<HlsVariantSelection> = None;
    let mut selected_resolution: Option<(u64, u64)> = None;
    let mut selected_frame_rate: Option<f64> = None;
    for line in manifest.lines().map(str::trim) {
        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let attributes = parse_hls_attribute_list(attributes)?;
            let bandwidth = attributes
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("BANDWIDTH"))
                .map(|(_, value)| value.parse::<u64>().map_err(|_| ()))
                .transpose()?
                .ok_or(())?;
            let audio_group = attributes
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("AUDIO"))
                .map(|(_, value)| unquote_hls_attribute_value(value).to_string());
            let subtitle_group = attributes
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("SUBTITLES"))
                .map(|(_, value)| unquote_hls_attribute_value(value).to_string());
            let resolution = attributes
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("RESOLUTION"))
                .and_then(|(_, value)| {
                    let (width, height) = unquote_hls_attribute_value(value).split_once('x')?;
                    Some((width.parse::<u64>().ok()?, height.parse::<u64>().ok()?))
                });
            let frame_rate = attributes
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("FRAME-RATE"))
                .and_then(|(_, value)| parse_frame_rate(Some(unquote_hls_attribute_value(value))));
            pending = Some((
                bandwidth,
                audio_group,
                subtitle_group,
                resolution,
                frame_rate,
            ));
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some((bandwidth, audio_group, subtitle_group, resolution, frame_rate)) =
                pending.take()
            {
                let should_replace = selected.as_ref().is_none_or(|selection| {
                    if !mobile_compatibility {
                        return bandwidth > selection.bandwidth;
                    }
                    mobile_video_variant_is_better(
                        resolution,
                        frame_rate,
                        bandwidth,
                        selected_resolution,
                        selected_frame_rate,
                        selection.bandwidth,
                    )
                });
                if should_replace {
                    let audio_renditions = if let Some(group) = audio_group {
                        let mut matching_group = audio_renditions
                            .iter()
                            .filter(|(candidate_group, uri, _, _, _, _)| {
                                candidate_group == &group && uri.is_some()
                            })
                            .collect::<Vec<_>>();
                        matching_group.sort_by_key(|(_, _, _, _, is_default, autoselect)| {
                            (!*is_default, !*autoselect)
                        });
                        matching_group
                            .into_iter()
                            .take(MAX_CONVERTED_AUDIO_TRACKS)
                            .filter_map(|(_, uri, name, language, is_default, autoselect)| {
                                Some(HlsAudioRendition {
                                    uri: uri.clone()?,
                                    name: name.clone().unwrap_or_else(|| "Audio".to_string()),
                                    language: language.clone(),
                                    is_default: *is_default,
                                    autoselect: *autoselect,
                                })
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let subtitle_renditions = if let Some(group) = subtitle_group {
                        subtitle_renditions
                            .iter()
                            .filter(|(candidate_group, uri, _, _, _, _)| {
                                candidate_group == &group && uri.is_some()
                            })
                            .filter_map(|(_, uri, language, is_default, autoselect, forced)| {
                                uri.clone().map(|uri| HlsSubtitleRendition {
                                    uri,
                                    language: language.clone(),
                                    is_default: *is_default,
                                    autoselect: *autoselect,
                                    forced: *forced,
                                })
                            })
                            .take(MAX_CONVERTED_SUBTITLE_TRACKS)
                            .collect()
                    } else {
                        Vec::new()
                    };
                    selected = Some(HlsVariantSelection {
                        uri: line.to_string(),
                        bandwidth,
                        audio_renditions,
                        subtitle_renditions,
                    });
                    selected_resolution = resolution;
                    selected_frame_rate = frame_rate;
                }
            }
        }
    }
    match selected {
        Some(selection) => Ok(Some(selection)),
        None if manifest.contains("#EXT-X-STREAM-INF:") => Err(()),
        None => Ok(None),
    }
}

#[cfg(test)]
fn local_hls_master_manifest(asset_directory: &str, bandwidth: u64) -> String {
    local_hls_master_manifest_with_subtitles(asset_directory, bandwidth, true, &[])
}

#[cfg(test)]
fn local_hls_master_manifest_with_subtitles(
    asset_directory: &str,
    bandwidth: u64,
    has_external_audio: bool,
    subtitles: &[MaterializedHlsSubtitle],
) -> String {
    let audio_tracks = if has_external_audio {
        vec![MaterializedHlsAudio {
            uri: format!("{asset_directory}/audio.m3u8"),
            language: None,
            label: "Default".to_string(),
            is_default: true,
            autoselect: true,
        }]
    } else {
        Vec::new()
    };
    local_hls_master_manifest_with_tracks(asset_directory, bandwidth, &audio_tracks, subtitles)
}

fn local_hls_master_manifest_with_tracks(
    asset_directory: &str,
    bandwidth: u64,
    audio_tracks: &[MaterializedHlsAudio],
    subtitles: &[MaterializedHlsSubtitle],
) -> String {
    let mut output = String::from("#EXTM3U\n");
    let mut audio_default_assigned = false;
    for (index, audio) in audio_tracks.iter().enumerate() {
        let language = audio
            .language
            .as_deref()
            .filter(|language| is_safe_hls_language(language));
        let label = if is_safe_hls_label(&audio.label) {
            audio.label.as_str()
        } else {
            "Audio"
        };
        let is_default = if audio.is_default && !audio_default_assigned {
            audio_default_assigned = true;
            true
        } else {
            false
        };
        let is_default =
            is_default || (index == 0 && !audio_tracks.iter().any(|track| track.is_default));
        output.push_str(&format!(
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aurales-audio\",NAME=\"{label}\",DEFAULT={},AUTOSELECT={},URI=\"{}\"{}\n",
            if is_default { "YES" } else { "NO" },
            if audio.autoselect || is_default { "YES" } else { "NO" },
            audio.uri,
            language.map(|language| format!(",LANGUAGE=\"{language}\"" )).unwrap_or_default(),
        ));
    }
    for (index, subtitle) in subtitles.iter().enumerate() {
        let language = subtitle
            .language
            .as_deref()
            .filter(|language| is_safe_hls_language(language));
        let label = subtitle
            .label
            .as_deref()
            .filter(|label| is_safe_hls_label(label))
            .map(str::to_owned)
            .or_else(|| language.map(|language| format!("{language} subtitles")))
            .unwrap_or_else(|| format!("Subtitle {}", index + 1));
        output.push_str(&format!(
            "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"aurales-subtitles\",NAME=\"{label}\",DEFAULT={},AUTOSELECT={},FORCED={},URI=\"{}\"{}\n",
            if subtitle.is_default { "YES" } else { "NO" },
            if subtitle.autoselect { "YES" } else { "NO" },
            if subtitle.forced { "YES" } else { "NO" },
            subtitle.uri,
            language.map(|language| format!(",LANGUAGE=\"{language}\"" )).unwrap_or_default(),
        ));
    }
    output.push_str(&format!("#EXT-X-STREAM-INF:BANDWIDTH={bandwidth}"));
    if !audio_tracks.is_empty() {
        output.push_str(",AUDIO=\"aurales-audio\"");
    }
    if !subtitles.is_empty() {
        output.push_str(",SUBTITLES=\"aurales-subtitles\"");
    }
    output.push_str(&format!("\n{asset_directory}/video.m3u8\n"));
    output
}

fn is_safe_hls_language(language: &str) -> bool {
    !language.is_empty()
        && language.len() <= 35
        && language
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn is_safe_hls_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 64
        && label.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    ' ' | ',' | '(' | ')' | '[' | ']' | '-' | '_' | '.'
                )
        })
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

fn validate_playback_headers(
    headers: &HashMap<String, String>,
) -> Result<HashMap<String, String>, ()> {
    if headers.len() > 20 {
        return Err(());
    }
    let mut safe = HashMap::new();
    for (name, value) in headers {
        let normalized = name.to_ascii_lowercase();
        let allowed = matches!(
            normalized.as_str(),
            "accept" | "authorization" | "cookie" | "origin" | "referer" | "user-agent"
        ) || (normalized.starts_with("x-")
            && normalized.len() <= 66
            && !normalized.starts_with("x-forwarded-")
            && normalized != "x-real-ip"
            && !normalized.starts_with("x-original-")
            && !normalized.starts_with("x-rewrite-")
            && !normalized.starts_with("x-http-method"));
        if !allowed
            || value.len() > 4096
            || value
                .bytes()
                .any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
        {
            return Err(());
        }
        safe.insert(normalized, value.clone());
    }
    Ok(safe)
}

fn apply_playback_request_headers(
    mut request: reqwest::RequestBuilder,
    headers: &HashMap<String, String>,
    same_origin: bool,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        // CDNs commonly require the provider's User-Agent or Accept value. Keep
        // credentials and origin-scoped headers on the original media origin.
        if same_origin || matches!(name.as_str(), "accept" | "user-agent") {
            request = request.header(name, value);
        }
    }
    request
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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
    if !is_authorized(&headers, &state.api_key, &state.session_key) {
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

fn is_authorized(headers: &HeaderMap, api_key: &[u8], session_key: &[u8]) -> bool {
    let api_key_authorized = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .is_some_and(|provided| {
            provided.len() == api_key.len() && bool::from(provided.as_bytes().ct_eq(api_key))
        });
    api_key_authorized || verify_access_session(headers, session_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn materialize_dash_track_for_test(
        track: &DashTrackPlan,
        kind: &str,
        assets_root: &FsPath,
    ) -> (Option<String>, Vec<String>) {
        let track_assets = assets_root.join(kind);
        tokio::fs::create_dir_all(&track_assets).await.unwrap();
        let mut initialization_name = None;
        let mut segment_names = Vec::new();
        if let Some(part) = &track.initialization {
            let filename = format!(
                "init.{}",
                dash_resource_extension(&part.url, &track.mime_type, true)
            );
            copy_dash_part_for_test(part, &track_assets.join(&filename)).await;
            initialization_name = Some(filename);
        }
        for (index, part) in track.segments.iter().enumerate() {
            let filename = format!(
                "segment-{index:04}.{}",
                dash_resource_extension(&part.url, &track.mime_type, false)
            );
            copy_dash_part_for_test(part, &track_assets.join(&filename)).await;
            segment_names.push(filename);
        }
        (initialization_name, segment_names)
    }

    async fn copy_dash_part_for_test(part: &DashPart, destination: &FsPath) {
        let source_path = part.url.to_file_path().unwrap();
        let source_bytes = tokio::fs::read(source_path).await.unwrap();
        let bytes = if let Some((start, end)) = part.range {
            &source_bytes[start as usize..=end as usize]
        } else {
            source_bytes.as_slice()
        };
        tokio::fs::write(destination, bytes).await.unwrap();
    }
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[test]
    fn rejects_wildcard_and_non_https_cors_origins() {
        assert!(parse_origins("*").is_err());
        assert!(parse_origins("http://example.com").is_err());
        assert!(parse_origins("http://localhost:5174").is_ok());
    }

    #[test]
    fn automatic_conversion_candidates_follow_copy_audio_video_order() {
        assert_eq!(
            conversion_candidates(Some(FfmpegCapabilities {
                audio_aac: true,
                video_h264: true,
                video_hardware_encoder: None,
                mp4_output: true,
                hls_output: true,
            })),
            vec![
                ConversionMode::Remux,
                ConversionMode::AudioAac,
                ConversionMode::H264Aac
            ]
        );
        assert_eq!(
            conversion_candidates(Some(FfmpegCapabilities {
                audio_aac: true,
                video_h264: false,
                video_hardware_encoder: Some("h264_videotoolbox"),
                mp4_output: true,
                hls_output: true,
            })),
            vec![
                ConversionMode::Remux,
                ConversionMode::AudioAac,
                ConversionMode::H264Aac
            ]
        );
        assert_eq!(conversion_candidates(None), vec![ConversionMode::Remux]);
    }

    #[test]
    fn mobile_audio_order_puts_preferred_language_first_and_keeps_other_tracks() {
        let source = serde_json::json!({
            "streams": [
                {"codec_type": "video"},
                {"codec_type": "audio", "tags": {"language": "jpn"}},
                {"codec_type": "audio", "tags": {"language": "eng"}},
                {"codec_type": "audio", "tags": {"language": "deu"}},
            ]
        });
        let preferences = vec!["en-US".to_owned(), "ja".to_owned()];
        assert_eq!(
            ordered_audio_track_indices(&source, &preferences),
            vec![1, 0, 2]
        );
        assert_eq!(
            ordered_audio_track_indices(&source, &[]),
            Vec::<usize>::new()
        );
    }

    #[tokio::test]
    async fn mobile_mp4_places_the_preferred_audio_track_first() {
        let ffmpeg = PathBuf::from("ffmpeg");
        let ffmpeg_ready = tokio::process::Command::new(&ffmpeg)
            .arg("-version")
            .output()
            .await;
        if !ffmpeg_ready.is_ok_and(|result| result.status.success()) {
            eprintln!("Skipping FFmpeg audio-order integration: ffmpeg is not installed");
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "aurales-audio-order-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let input = dir.join("multiple-languages.mkv");
        let output = dir.join("mobile-output.mp4");
        let generated = tokio::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=24:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=400:sample_rate=48000:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=700:sample_rate=48000:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=900:sample_rate=48000:duration=1",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-map",
                "2:a:0",
                "-map",
                "3:a:0",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
                "-shortest",
                "-metadata:s:a:0",
                "language=jpn",
                "-metadata:s:a:1",
                "language=eng",
                "-metadata:s:a:2",
                "language=deu",
            ])
            .arg(&input)
            .output()
            .await
            .unwrap();
        assert!(
            generated.status.success(),
            "failed to prepare multi-language fixture"
        );

        let source_info = probe_local_media(&ffmpeg, &input).await.unwrap();
        let audio_count = source_info["streams"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|stream| stream["codec_type"] == "audio")
            .count();
        let preferences = vec!["en".to_owned(), "ja".to_owned()];
        let preferred_order = ordered_audio_track_indices(&source_info, &preferences);
        assert_eq!(preferred_order, vec![1, 0, 2]);
        transcode_conversion_candidate(
            &ffmpeg,
            &input,
            &output,
            ConversionMode::Remux,
            None,
            ConversionOutputFormat::Mp4,
            true,
            audio_count,
            &preferred_order,
        )
        .await
        .expect("preferred audio order should produce a mobile MP4");

        let output_probe = tokio::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type:stream_tags=language:stream_disposition=default",
                "-of",
                "json",
            ])
            .arg(&output)
            .output()
            .await
            .unwrap();
        assert!(
            output_probe.status.success(),
            "ffprobe could not inspect mobile MP4"
        );
        let output_info: Value = serde_json::from_slice(&output_probe.stdout).unwrap();
        let output_audio: Vec<_> = output_info["streams"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|stream| stream["codec_type"] == "audio")
            .collect();
        let output_languages: Vec<_> = output_audio
            .iter()
            .map(|stream| stream["tags"]["language"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(output_languages, vec!["eng", "jpn", "deu"]);
        assert_eq!(output_audio[0]["disposition"]["default"], 1);
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn conversion_output_formats_are_checked_independently() {
        let capabilities = Some(FfmpegCapabilities {
            audio_aac: true,
            video_h264: true,
            video_hardware_encoder: None,
            mp4_output: true,
            hls_output: false,
        });
        assert!(conversion_output_available(
            capabilities,
            ConversionOutputFormat::Mp4
        ));
        assert!(!conversion_output_available(
            capabilities,
            ConversionOutputFormat::Hls
        ));
        assert!(!conversion_output_available(
            None,
            ConversionOutputFormat::Mp4
        ));
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
        let high_fps_mobile_input = dir.join("high-fps-mobile-input.mp4");
        let mut make_high_fps_input = tokio::process::Command::new(&ffmpeg);
        make_high_fps_input
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=60:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:sample_rate=48000:duration=1",
                "-c:v",
                "mpeg4",
                "-q:v",
                "5",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&high_fps_mobile_input);
        let generated = make_high_fps_input.output().await.unwrap();
        assert!(
            generated.status.success(),
            "failed to prepare a high-frame-rate mobile fixture"
        );

        let hevc_main10_input = dir.join("hevc-main10-ac3-input.mkv");
        let hevc_generated = tokio::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=24:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=800:sample_rate=48000:duration=1",
                "-c:v",
                "libx265",
                "-preset",
                "ultrafast",
                "-x265-params",
                "pools=1:frame-threads=1:log-level=error",
                "-pix_fmt",
                "yuv420p10le",
                "-c:a",
                "ac3",
                "-shortest",
            ])
            .arg(&hevc_main10_input)
            .output()
            .await
            .unwrap();

        let av1_opus_input = dir.join("av1-opus-input.mkv");
        let av1_generated = tokio::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=24:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=800:sample_rate=48000:duration=1",
                "-c:v",
                "libsvtav1",
                "-preset",
                "12",
                "-crf",
                "50",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "libopus",
                "-shortest",
            ])
            .arg(&av1_opus_input)
            .output()
            .await
            .unwrap();

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

        let mut cases = vec![
            (
                "remux",
                fixtures.join("h264-aac.mp4"),
                ConversionMode::Remux,
            ),
            ("audio-aac", h264_opus, ConversionMode::AudioAac),
            (
                "h264-aac",
                high_fps_mobile_input.clone(),
                ConversionMode::H264Aac,
            ),
            (
                "h264-aac-low",
                high_fps_mobile_input.clone(),
                ConversionMode::H264AacLow,
            ),
            (
                "h264-aac-compat",
                high_fps_mobile_input.clone(),
                ConversionMode::H264AacCompat,
            ),
        ];
        if hevc_generated.status.success() {
            cases.push((
                "hevc-main10-ac3",
                hevc_main10_input,
                ConversionMode::H264Aac,
            ));
        }
        if av1_generated.status.success() {
            cases.push(("av1-opus", av1_opus_input, ConversionMode::H264Aac));
        }
        for (name, input, mode) in cases {
            let output = dir.join(format!("{name}.mp4"));
            let source_info = probe_local_media(&ffmpeg, &input).await.unwrap();
            assert!(source_info["container"].as_str().is_some());
            assert!(source_info["streams"].as_array().is_some_and(|streams| {
                streams.iter().any(|stream| stream["codec_type"] == "video")
                    && streams.iter().any(|stream| stream["codec_type"] == "audio")
            }));
            let source_probe = tokio::process::Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_name",
                    "-of",
                    "csv=p=0",
                ])
                .arg(&input)
                .output()
                .await
                .unwrap();
            assert!(
                source_probe.status.success(),
                "ffprobe rejected {name} input"
            );
            let source_codecs = String::from_utf8_lossy(&source_probe.stdout)
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let bytes = transcode_local_input(&ffmpeg, &input, &output, mode)
                .await
                .unwrap();
            assert!(bytes > 0);
            let probe = tokio::process::Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_type,codec_name,profile,level,width,height,pix_fmt,r_frame_rate",
                    "-of",
                    "json",
                ])
                .arg(&output)
                .output()
                .await
                .unwrap();
            assert!(probe.status.success(), "ffprobe rejected {name} output");
            let output_info: Value = serde_json::from_slice(&probe.stdout).unwrap();
            let output_streams = output_info["streams"].as_array().unwrap();
            let output_codecs = output_streams
                .iter()
                .filter_map(|stream| stream["codec_name"].as_str().map(str::to_owned))
                .collect::<Vec<_>>();
            let codecs = output_codecs.join("\n");
            if mode == ConversionMode::Remux {
                assert_eq!(
                    output_codecs, source_codecs,
                    "remux must preserve video and audio codecs"
                );
            } else if mode == ConversionMode::AudioAac {
                assert_eq!(
                    output_codecs.first(),
                    source_codecs.first(),
                    "audio-only conversion must copy video"
                );
                assert_eq!(
                    source_codecs.last().map(String::as_str),
                    Some("opus"),
                    "audio-only fixture must start with incompatible Opus audio"
                );
            } else {
                assert_ne!(
                    output_codecs.first(),
                    source_codecs.first(),
                    "video encoding is expected only in the final fallback"
                );
            }
            assert!(
                codecs.lines().any(|codec| codec == "h264"),
                "{name} output is not H.264: {codecs}"
            );
            assert!(
                codecs.lines().any(|codec| codec == "aac"),
                "{name} output is not AAC: {codecs}"
            );
            if matches!(
                mode,
                ConversionMode::H264Aac
                    | ConversionMode::H264AacLow
                    | ConversionMode::H264AacCompat
            ) {
                let video = output_streams
                    .iter()
                    .find(|stream| stream["codec_type"] == "video")
                    .unwrap();
                assert!(
                    video["profile"]
                        .as_str()
                        .is_some_and(|profile| profile.contains("Baseline")),
                    "{name} output must use an H.264 Baseline profile: {video}"
                );
                assert_eq!(video["pix_fmt"], "yuv420p", "{name} pixel format");
                let level = video["level"].as_u64().unwrap();
                let (max_level, max_width, max_height) = match mode {
                    ConversionMode::H264AacLow => (31, 1280, 720),
                    ConversionMode::H264AacCompat => (30, 720, 480),
                    _ => (42, 1920, 1080),
                };
                assert!(
                    level <= max_level,
                    "{name} H.264 level {level} exceeds {max_level}"
                );
                let width = video["width"].as_u64().unwrap();
                let height = video["height"].as_u64().unwrap();
                assert!(
                    (width <= max_width && height <= max_height)
                        || (width <= max_height && height <= max_width),
                    "{name} dimensions {width}x{height} exceed the mobile profile bound"
                );
                let frame_rate = video["r_frame_rate"]
                    .as_str()
                    .and_then(|value| value.split_once('/'))
                    .and_then(|(numerator, denominator)| {
                        Some(numerator.parse::<f64>().ok()? / denominator.parse::<f64>().ok()?)
                    })
                    .unwrap();
                let max_frame_rate = if mode == ConversionMode::H264Aac {
                    60.0
                } else {
                    30.0
                };
                assert!(
                    frame_rate <= max_frame_rate,
                    "{name} frame rate {frame_rate} exceeds {max_frame_rate} fps"
                );
            }
        }
        let materialized_playlist = dir.join("materialized.m3u8");
        let materialized_assets = dir.join("materialized.input-assets");
        tokio::fs::create_dir_all(&materialized_assets)
            .await
            .unwrap();
        tokio::fs::copy(
            fixtures.join("hls-segment-000.m2ts"),
            materialized_assets.join("resource-0000.ts"),
        )
        .await
        .unwrap();
        tokio::fs::write(
            &materialized_playlist,
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\nmaterialized.input-assets/resource-0000.ts\n#EXT-X-ENDLIST\n",
        )
        .await
        .unwrap();
        let materialized_info = probe_local_media(&ffmpeg, &materialized_playlist)
            .await
            .unwrap();
        assert!(materialized_info["streams"]
            .as_array()
            .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "video")));
        let mobile_hls_mp4 = dir.join("materialized-hls-mobile.mp4");
        transcode_local_output(
            &ffmpeg,
            &materialized_playlist,
            &mobile_hls_mp4,
            ConversionMode::H264AacCompat,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should encode materialized HLS segments as mobile MP4");
        let mobile_hls_info = probe_local_media(&ffmpeg, &mobile_hls_mp4)
            .await
            .expect("FFmpeg should probe the mobile MP4 made from HLS segments");
        assert!(mobile_hls_info["streams"]
            .as_array()
            .is_some_and(|streams| {
                streams
                    .iter()
                    .any(|stream| stream["codec_type"] == "video" && stream["codec_name"] == "h264")
                    && streams.iter().any(|stream| {
                        stream["codec_type"] == "audio" && stream["codec_name"] == "aac"
                    })
            }));

        let segment_bytes = tokio::fs::read(fixtures.join("hls-segment-000.m2ts"))
            .await
            .unwrap();
        let range_media = dir.join("range-media.ts");
        let mut combined_ranges = segment_bytes.clone();
        combined_ranges.extend_from_slice(&segment_bytes);
        tokio::fs::write(&range_media, &combined_ranges)
            .await
            .unwrap();
        let segment_length = segment_bytes.len() as u64;
        let range_source = format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\n#EXT-X-BYTERANGE:{segment_length}@0\nrange-media.ts\n#EXTINF:12,\n#EXT-X-BYTERANGE:{segment_length}\nrange-media.ts\n#EXT-X-ENDLIST\n"
        );
        let range_assets = dir.join("range.input-assets");
        tokio::fs::create_dir_all(&range_assets).await.unwrap();
        let (mut range_manifest, range_requests) = rewrite_hls_byte_ranges(
            &range_source,
            &url::Url::parse("https://cdn.example/range.m3u8").unwrap(),
            "range.input-assets",
        )
        .unwrap();
        for request in range_requests {
            let start = request.start as usize;
            let end = request.end as usize + 1;
            let data = &combined_ranges[start..end];
            assert_eq!(data.len(), end - start);
            let local_name = format!("{}.ts", request.local_stem);
            tokio::fs::write(range_assets.join(&local_name), data)
                .await
                .unwrap();
            range_manifest = range_manifest.replace(
                &request.placeholder,
                &format!("range.input-assets/{local_name}"),
            );
        }
        let range_playlist = dir.join("range-input.m3u8");
        tokio::fs::write(&range_playlist, range_manifest)
            .await
            .unwrap();
        let range_info = probe_local_media(&ffmpeg, &range_playlist).await.unwrap();
        assert!(range_info["streams"]
            .as_array()
            .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "video")));

        let fmp4_source_playlist = dir.join("fmp4-source.m3u8");
        let fmp4_source_media = dir.join("fmp4-source.m4s");
        let mut make_fmp4_hls = tokio::process::Command::new(&ffmpeg);
        make_fmp4_hls
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(fixtures.join("h264-aac.mp4"))
            .args([
                "-c",
                "copy",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_segment_type",
                "fmp4",
                "-hls_flags",
                "single_file",
                "-hls_segment_filename",
            ])
            .arg(&fmp4_source_media)
            .arg(&fmp4_source_playlist);
        let generated = make_fmp4_hls.output().await.unwrap();
        assert!(
            generated.status.success(),
            "failed to prepare fMP4 HLS fixture"
        );
        let fmp4_manifest = tokio::fs::read_to_string(&fmp4_source_playlist)
            .await
            .unwrap();
        assert!(fmp4_manifest.contains("#EXT-X-MAP:") && fmp4_manifest.contains("BYTERANGE="));
        let fmp4_bytes = tokio::fs::read(&fmp4_source_media).await.unwrap();
        let fmp4_assets = dir.join("fmp4-assets");
        tokio::fs::create_dir_all(&fmp4_assets).await.unwrap();
        let (mut materialized_fmp4_manifest, fmp4_requests) = rewrite_hls_byte_ranges(
            &fmp4_manifest,
            &url::Url::parse("https://cdn.example/fmp4-source.m3u8").unwrap(),
            "fmp4-assets",
        )
        .unwrap();
        assert!(fmp4_requests.iter().any(|request| request.is_map));
        for request in fmp4_requests {
            let start = request.start as usize;
            let end = request.end as usize + 1;
            let data = &fmp4_bytes[start..end];
            let extension =
                hls_resource_extension(&request.url, "video/mp4", false, request.is_map);
            let local_name = format!("{}.{}", request.local_stem, extension);
            tokio::fs::write(fmp4_assets.join(&local_name), data)
                .await
                .unwrap();
            materialized_fmp4_manifest = materialized_fmp4_manifest
                .replace(&request.placeholder, &format!("fmp4-assets/{local_name}"));
        }
        let materialized_fmp4_playlist = dir.join("materialized-fmp4.m3u8");
        tokio::fs::write(&materialized_fmp4_playlist, materialized_fmp4_manifest)
            .await
            .unwrap();
        let fmp4_info = probe_local_media(&ffmpeg, &materialized_fmp4_playlist)
            .await
            .expect("FFmpeg should probe HLS with a byte-range init map");
        assert!(fmp4_info["streams"]
            .as_array()
            .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "video")));
        transcode_local_output(
            &ffmpeg,
            &materialized_fmp4_playlist,
            &dir.join("materialized-fmp4.mp4"),
            ConversionMode::Remux,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should remux materialized fMP4 HLS VOD input");

        let external_audio_assets = dir.join("external-audio-assets");
        tokio::fs::create_dir_all(&external_audio_assets)
            .await
            .unwrap();
        let external_video_playlist = external_audio_assets.join("video.m3u8");
        let mut make_video_hls = tokio::process::Command::new(&ffmpeg);
        make_video_hls
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(fixtures.join("h264-aac.mp4"))
            .args([
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-an",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_segment_filename",
            ])
            .arg(external_audio_assets.join("video-%03d.ts"))
            .arg(&external_video_playlist);
        assert!(make_video_hls.output().await.unwrap().status.success());

        let external_audio_playlist = external_audio_assets.join("audio.m3u8");
        let mut make_audio_hls = tokio::process::Command::new(&ffmpeg);
        make_audio_hls
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(fixtures.join("h264-aac.mp4"))
            .args([
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "copy",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_segment_filename",
            ])
            .arg(external_audio_assets.join("audio-%03d.ts"))
            .arg(&external_audio_playlist);
        assert!(make_audio_hls.output().await.unwrap().status.success());
        let external_audio_master = dir.join("external-audio-input.m3u8");
        tokio::fs::write(
            &external_audio_master,
            local_hls_master_manifest("external-audio-assets", 2_000_000),
        )
        .await
        .unwrap();
        let ffprobe_output = tokio::process::Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe,crypto,data",
                "-show_entries",
                "format=format_name:stream=codec_type,codec_name",
                "-of",
                "json",
            ])
            .arg(&external_audio_master)
            .output()
            .await
            .unwrap();
        assert!(
            ffprobe_output.status.success(),
            "ffprobe failed on external audio fixture: {}",
            String::from_utf8_lossy(&ffprobe_output.stderr)
        );
        let external_audio_info = probe_local_media(&ffmpeg, &external_audio_master)
            .await
            .expect("FFmpeg should read selected external audio renditions");
        let external_streams = external_audio_info["streams"].as_array().unwrap();
        assert!(external_streams
            .iter()
            .any(|stream| stream["codec_type"] == "video"));
        assert!(external_streams
            .iter()
            .any(|stream| stream["codec_type"] == "audio"));
        transcode_local_output(
            &ffmpeg,
            &external_audio_master,
            &dir.join("external-audio-output.mp4"),
            ConversionMode::Remux,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should remux video with external audio renditions");

        let dash_source_mpd = dir.join("dash-source.mpd");
        let mut make_dash = tokio::process::Command::new(&ffmpeg);
        make_dash
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(fixtures.join("h264-aac.mp4"))
            .args([
                "-map",
                "0",
                "-c",
                "copy",
                "-f",
                "dash",
                "-use_template",
                "0",
                "-use_timeline",
                "0",
                "-seg_duration",
                "2",
                "-adaptation_sets",
                "id=0,streams=v id=1,streams=a",
            ])
            .arg(&dash_source_mpd);
        let generated = make_dash.output().await.unwrap();
        assert!(
            generated.status.success(),
            "failed to prepare DASH SegmentList fixture"
        );
        let dash_manifest = tokio::fs::read_to_string(&dash_source_mpd).await.unwrap();
        let dash_url = url::Url::from_file_path(&dash_source_mpd).unwrap();
        let dash_plan = plan_static_dash_mpd(&dash_manifest, &dash_url)
            .expect("worker should parse static DASH SegmentList input");
        let dash_assets = dir.join("dash-assets");
        let (dash_video_init, dash_video_segments) =
            materialize_dash_track_for_test(&dash_plan.periods[0].video, "video", &dash_assets)
                .await;
        let dash_audio_parts = if let Some(audio) = dash_plan.periods[0].audio.first() {
            materialize_dash_track_for_test(&audio.track, "audio", &dash_assets).await
        } else {
            (None, Vec::new())
        };
        let local_dash_input = dir.join("materialized-dash.m3u8");
        if let Some(audio) = dash_plan.periods[0].audio.first() {
            tokio::fs::write(
                dash_assets.join("video.m3u8"),
                serialize_dash_media_playlist(
                    &dash_plan.periods[0].video,
                    "video",
                    dash_video_init.as_deref(),
                    &dash_video_segments,
                )
                .unwrap(),
            )
            .await
            .unwrap();
            tokio::fs::write(
                dash_assets.join("audio.m3u8"),
                serialize_dash_media_playlist(
                    &audio.track,
                    "audio",
                    dash_audio_parts.0.as_deref(),
                    &dash_audio_parts.1,
                )
                .unwrap(),
            )
            .await
            .unwrap();
            tokio::fs::write(
                &local_dash_input,
                local_hls_master_manifest("dash-assets", dash_plan.periods[0].video.bandwidth),
            )
            .await
            .unwrap();
        } else {
            tokio::fs::write(
                &local_dash_input,
                serialize_dash_media_playlist(
                    &dash_plan.periods[0].video,
                    "dash-assets/video",
                    dash_video_init.as_deref(),
                    &dash_video_segments,
                )
                .unwrap(),
            )
            .await
            .unwrap();
        }
        let dash_info = probe_local_media(&ffmpeg, &local_dash_input)
            .await
            .expect("FFmpeg should read the materialized static DASH input");
        assert!(dash_info["streams"]
            .as_array()
            .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "video")));
        assert!(dash_info["streams"]
            .as_array()
            .is_some_and(|streams| streams.iter().any(|stream| stream["codec_type"] == "audio")));
        transcode_local_output(
            &ffmpeg,
            &local_dash_input,
            &dir.join("materialized-dash.mp4"),
            ConversionMode::Remux,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should remux materialized DASH VOD input");

        let dash_template_mpd = dir.join("dash-template-source.mpd");
        let mut make_dash_template = tokio::process::Command::new(&ffmpeg);
        make_dash_template
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(fixtures.join("h264-aac.mp4"))
            .args([
                "-map",
                "0",
                "-c",
                "copy",
                "-f",
                "dash",
                "-use_template",
                "1",
                "-use_timeline",
                "1",
                "-seg_duration",
                "2",
                "-adaptation_sets",
                "id=0,streams=v id=1,streams=a",
            ])
            .arg(&dash_template_mpd);
        let generated_template = make_dash_template.output().await.unwrap();
        assert!(
            generated_template.status.success(),
            "failed to prepare DASH SegmentTemplate fixture"
        );
        let dash_template_manifest = tokio::fs::read_to_string(&dash_template_mpd).await.unwrap();
        let dash_template_url = url::Url::from_file_path(&dash_template_mpd).unwrap();
        let dash_template_plan = plan_static_dash_mpd(&dash_template_manifest, &dash_template_url)
            .expect("worker should parse static DASH SegmentTemplate input");
        let dash_template_assets = dir.join("dash-template-assets");
        let (template_video_init, template_video_segments) = materialize_dash_track_for_test(
            &dash_template_plan.periods[0].video,
            "video",
            &dash_template_assets,
        )
        .await;
        let template_video_playlist = serialize_dash_media_playlist(
            &dash_template_plan.periods[0].video,
            "video",
            template_video_init.as_deref(),
            &template_video_segments,
        )
        .unwrap();
        tokio::fs::write(
            dash_template_assets.join("video.m3u8"),
            template_video_playlist,
        )
        .await
        .unwrap();
        let audio = dash_template_plan.periods[0]
            .audio
            .first()
            .expect("DASH audio track");
        let (template_audio_init, template_audio_segments) =
            materialize_dash_track_for_test(&audio.track, "audio", &dash_template_assets).await;
        tokio::fs::write(
            dash_template_assets.join("audio.m3u8"),
            serialize_dash_media_playlist(
                &audio.track,
                "audio",
                template_audio_init.as_deref(),
                &template_audio_segments,
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let local_dash_template_input = dir.join("materialized-dash-template.m3u8");
        tokio::fs::write(
            &local_dash_template_input,
            local_hls_master_manifest(
                "dash-template-assets",
                dash_template_plan.periods[0].video.bandwidth,
            ),
        )
        .await
        .unwrap();
        let template_info = probe_local_media(&ffmpeg, &local_dash_template_input)
            .await
            .expect("FFmpeg should read the materialized DASH SegmentTemplate input");
        assert!(template_info["streams"].as_array().is_some_and(|streams| {
            streams.iter().any(|stream| stream["codec_type"] == "video")
                && streams.iter().any(|stream| stream["codec_type"] == "audio")
        }));
        transcode_local_output(
            &ffmpeg,
            &local_dash_template_input,
            &dir.join("materialized-dash-template.mp4"),
            ConversionMode::Remux,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should remux materialized DASH SegmentTemplate VOD input");

        let two_period_assets = dir.join("two-period-dash-assets");
        tokio::fs::create_dir_all(&two_period_assets).await.unwrap();
        let mut repeated_video = Vec::new();
        let mut repeated_audio = Vec::new();
        for _ in 0..2 {
            repeated_video.push(DashMaterializedTrack {
                track: dash_template_plan.periods[0].video.clone(),
                asset_prefix: "../dash-template-assets/video".to_string(),
                initialization_name: template_video_init.clone(),
                segment_names: template_video_segments.clone(),
            });
            repeated_audio.push(DashMaterializedTrack {
                track: audio.track.clone(),
                asset_prefix: "../dash-template-assets/audio".to_string(),
                initialization_name: template_audio_init.clone(),
                segment_names: template_audio_segments.clone(),
            });
        }
        tokio::fs::write(
            two_period_assets.join("video.m3u8"),
            serialize_dash_period_playlist(&repeated_video).unwrap(),
        )
        .await
        .unwrap();
        tokio::fs::write(
            two_period_assets.join("audio.m3u8"),
            serialize_dash_period_playlist(&repeated_audio).unwrap(),
        )
        .await
        .unwrap();
        let two_period_input = dir.join("materialized-two-period-dash.m3u8");
        tokio::fs::write(
            &two_period_input,
            local_hls_master_manifest("two-period-dash-assets", 1_000_000),
        )
        .await
        .unwrap();
        let two_period_info = probe_local_media(&ffmpeg, &two_period_input)
            .await
            .expect("FFmpeg should read DASH periods joined with HLS discontinuities");
        assert!(two_period_info["streams"]
            .as_array()
            .is_some_and(|streams| {
                streams.iter().any(|stream| stream["codec_type"] == "video")
                    && streams.iter().any(|stream| stream["codec_type"] == "audio")
            }));
        transcode_local_output(
            &ffmpeg,
            &two_period_input,
            &dir.join("materialized-two-period-dash.mp4"),
            ConversionMode::Remux,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should remux DASH periods joined with HLS discontinuities");

        tokio::fs::copy(
            fixtures.join("h264-aac.mp4"),
            dir.join("segment-base-muxed.mp4"),
        )
        .await
        .unwrap();
        let segment_base_mpd = dir.join("segment-base-source.mpd");
        tokio::fs::write(
            &segment_base_mpd,
            r#"<MPD type="static" mediaPresentationDuration="PT12S"><Period duration="PT12S"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="muxed" bandwidth="1500000"><BaseURL>segment-base-muxed.mp4</BaseURL><SegmentBase indexRange="0-999"><Initialization range="0-999"/></SegmentBase></Representation></AdaptationSet></Period></MPD>"#,
        )
        .await
        .unwrap();
        let segment_base_manifest = tokio::fs::read_to_string(&segment_base_mpd).await.unwrap();
        let segment_base_url = url::Url::from_file_path(&segment_base_mpd).unwrap();
        let segment_base_plan = plan_static_dash_mpd(&segment_base_manifest, &segment_base_url)
            .expect("worker should parse static DASH SegmentBase input");
        let segment_base_assets = dir.join("segment-base-assets");
        let (segment_base_init, segment_base_segments) = materialize_dash_track_for_test(
            &segment_base_plan.periods[0].video,
            "video",
            &segment_base_assets,
        )
        .await;
        assert!(segment_base_init.is_none());
        let segment_base_playlist = dir.join("materialized-dash-segment-base.m3u8");
        tokio::fs::write(
            &segment_base_playlist,
            serialize_dash_period_playlist(&[DashMaterializedTrack {
                track: segment_base_plan.periods[0].video.clone(),
                asset_prefix: "segment-base-assets/video".to_string(),
                initialization_name: None,
                segment_names: segment_base_segments,
            }])
            .unwrap(),
        )
        .await
        .unwrap();
        let segment_base_info = probe_local_media(&ffmpeg, &segment_base_playlist)
            .await
            .expect("FFmpeg should probe a progressive MP4 used as a DASH SegmentBase resource");
        assert!(segment_base_info["streams"]
            .as_array()
            .is_some_and(|streams| {
                streams.iter().any(|stream| stream["codec_type"] == "video")
                    && streams.iter().any(|stream| stream["codec_type"] == "audio")
            }));
        transcode_local_output(
            &ffmpeg,
            &segment_base_playlist,
            &dir.join("materialized-dash-segment-base.mp4"),
            ConversionMode::Remux,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should remux a DASH SegmentBase resource via HLS");

        transcode_local_output(
            &ffmpeg,
            &materialized_playlist,
            &dir.join("materialized.mp4"),
            ConversionMode::Remux,
            ConversionOutputFormat::Mp4,
        )
        .await
        .expect("FFmpeg should read materialized local HLS VOD input");

        let hls_playlist = dir.join("0123456789abcdef0123456789abcdef-remux.m3u8");
        let hls_bytes = transcode_local_output(
            &ffmpeg,
            &fixtures.join("h264-aac.mp4"),
            &hls_playlist,
            ConversionMode::Remux,
            ConversionOutputFormat::Hls,
        )
        .await
        .unwrap();
        let hls_text = tokio::fs::read_to_string(&hls_playlist).await.unwrap();
        assert!(hls_text.contains("#EXT-X-BYTERANGE:"));
        assert!(hls_text.contains("0123456789abcdef0123456789abcdef-remux.ts"));
        assert!(hls_bytes > hls_text.len() as u64);
        let rewritten = rewrite_local_hls_manifest(
            &hls_text,
            "abcdef0123456789abcdef0123456789",
            1_900_000_000,
            "opaque-signature",
            "0123456789abcdef0123456789abcdef-remux.ts",
        )
        .unwrap();
        assert!(rewritten.contains("/v1/media/abcdef0123456789abcdef0123456789/0123456789abcdef0123456789abcdef-remux.ts?expires=1900000000&signature=opaque-signature"));
        assert!(!rewritten.contains("0123456789abcdef0123456789abcdef-remux.ts\n"));
        let segment_path = hls_playlist.with_extension("ts");
        let mut range_headers = HeaderMap::new();
        range_headers.insert(RANGE, HeaderValue::from_static("bytes=0-15"));
        let segment = serve_local_media(
            segment_path.clone(),
            range_headers,
            Method::GET,
            Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
            "video/mp2t",
        )
        .await;
        assert_eq!(segment.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(segment.headers().get(CONTENT_TYPE).unwrap(), "video/mp2t");
        assert_eq!(
            segment
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .len(),
            16
        );
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
    fn provider_request_headers_are_bounded_and_reject_hop_routing_headers() {
        let valid = HashMap::from([
            ("Authorization".to_string(), "Bearer secret".to_string()),
            ("Referer".to_string(), "https://addon.example/".to_string()),
        ]);
        assert_eq!(
            validate_playback_headers(&valid)
                .unwrap()
                .get("authorization")
                .unwrap(),
            "Bearer secret"
        );
        assert!(validate_playback_headers(&HashMap::from([(
            "x-forwarded-host".to_string(),
            "127.0.0.1".to_string()
        )]))
        .is_err());
        assert!(validate_playback_headers(&HashMap::from([(
            "Cookie".to_string(),
            "bad\r\nHost: localhost".to_string()
        )]))
        .is_err());
        assert!(validate_playback_headers(&HashMap::from([(
            "Host".to_string(),
            "localhost".to_string()
        )]))
        .is_err());
    }

    #[test]
    fn stale_conversion_file_names_allow_only_uuid_owned_variants() {
        let valid = [
            "0123456789abcdef0123456789abcdef.input",
            "0123456789abcdef0123456789abcdef.input.m3u8",
            "0123456789abcdef0123456789abcdef.mp4",
            "0123456789abcdef0123456789abcdef-remux.mp4",
            "0123456789abcdef0123456789abcdef-audio-aac.mp4",
            "0123456789abcdef0123456789abcdef-h264-aac.mp4",
            "0123456789abcdef0123456789abcdef-remux.m3u8",
            "0123456789abcdef0123456789abcdef-remux.ts",
        ];
        for name in valid {
            assert!(is_worker_conversion_filename(name));
        }
        assert!(is_worker_conversion_directory(
            "0123456789abcdef0123456789abcdef.input-assets"
        ));
        assert!(!is_worker_conversion_filename(
            "0123456789abcdef0123456789abcdef-untrusted.mp4"
        ));
        assert!(!is_worker_conversion_filename(
            "../0123456789abcdef0123456789abcdef.mp4"
        ));
    }

    #[test]
    fn ll_hls_reload_parameters_preserve_upstream_credentials_and_are_validated() {
        let upstream =
            url::Url::parse("https://cdn.example/live.m3u8?token=a%2Fb&keep=x%2By&_HLS_msn=old")
                .unwrap();
        let params = HashMap::from([
            ("_HLS_msn".to_string(), "120".to_string()),
            ("_HLS_part".to_string(), "3".to_string()),
            ("_HLS_skip".to_string(), "v2".to_string()),
            ("signature".to_string(), "attacker-value".to_string()),
        ]);
        let reload = hls_reload_url(&upstream, &params).unwrap();
        assert!(reload.as_str().contains("token=a%2Fb"));
        assert!(reload.as_str().contains("keep=x%2By"));
        let query = reload.query_pairs().into_owned().collect::<HashMap<_, _>>();
        assert_eq!(query.get("_HLS_msn").map(String::as_str), Some("120"));
        assert_eq!(query.get("_HLS_part").map(String::as_str), Some("3"));
        assert_eq!(query.get("_HLS_skip").map(String::as_str), Some("v2"));
        assert!(!query.contains_key("signature"));

        let invalid = HashMap::from([("_HLS_msn".to_string(), "-1".to_string())]);
        assert!(hls_reload_url(&upstream, &invalid).is_err());
        let mp4 = url::Url::parse("https://cdn.example/video.mp4?token=secret").unwrap();
        assert_eq!(hls_reload_url(&mp4, &params).unwrap(), mp4);
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

    #[test]
    fn hls_conversion_accepts_vod_and_finite_live_snapshots_but_rejects_drm_playlists() {
        let vod = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n";
        assert_eq!(hls_conversion_resource_spans(vod).unwrap().len(), 1);

        let aes = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nsegment.m4s\n#EXT-X-ENDLIST\n";
        assert_eq!(hls_conversion_resource_spans(aes).unwrap().len(), 3);
        let byte_range = "#EXTM3U\n#EXT-X-BYTERANGE:4@0\nmedia.mp4\n#EXT-X-BYTERANGE:4\nmedia.mp4\n#EXT-X-ENDLIST\n";
        assert_eq!(hls_conversion_resource_spans(byte_range).unwrap().len(), 2);

        let live = "#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
        let sample_aes = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key.bin\"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n";
        let drm_keyformat = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,KEYFORMAT=\"com.example.drm\",URI=\"key.bin\"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n";
        assert_eq!(hls_conversion_resource_spans(live).unwrap().len(), 1);
        assert!(hls_conversion_resource_spans(sample_aes).is_err());
        assert!(hls_conversion_resource_spans(drm_keyformat).is_err());
    }

    #[test]
    fn hls_byte_ranges_resolve_explicit_and_implicit_offsets_safely() {
        let resource = "https://cdn.example/media.mp4";
        assert_eq!(
            resolve_hls_byte_range(4, Some(8), resource, None),
            Ok((8, 11))
        );
        assert_eq!(
            resolve_hls_byte_range(4, None, resource, Some((resource, 12))),
            Ok((12, 15))
        );
        assert!(resolve_hls_byte_range(4, None, resource, None).is_err());
        assert!(resolve_hls_byte_range(
            4,
            None,
            resource,
            Some(("https://cdn.example/other.mp4", 12))
        )
        .is_err());
        assert!(resolve_hls_byte_range(0, Some(0), resource, None).is_err());
        assert!(resolve_hls_byte_range(2, Some(u64::MAX), resource, None).is_err());
    }

    #[test]
    fn hls_byte_range_download_requires_an_exact_valid_partial_response() {
        assert!(valid_hls_range_response(
            StatusCode::PARTIAL_CONTENT,
            Some("bytes 8-11/100"),
            8,
            11
        ));
        assert!(!valid_hls_range_response(
            StatusCode::OK,
            Some("bytes 8-11/100"),
            8,
            11
        ));
        assert!(!valid_hls_range_response(
            StatusCode::PARTIAL_CONTENT,
            Some("bytes 7-11/100"),
            8,
            11
        ));
        assert!(!valid_hls_range_response(
            StatusCode::PARTIAL_CONTENT,
            Some("bytes 8-11/11"),
            8,
            11
        ));
        assert!(!valid_hls_range_response(
            StatusCode::PARTIAL_CONTENT,
            Some("bytes 8-11/*"),
            8,
            11
        ));
    }

    #[test]
    fn hls_byte_range_rewriter_removes_tags_and_assigns_separate_local_segments() {
        let base = url::Url::parse("https://cdn.example/path/index.m3u8").unwrap();
        let manifest = "#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:4@0\nmedia.mp4\n#EXTINF:4,\n#EXT-X-BYTERANGE:4\nmedia.mp4\n#EXT-X-ENDLIST\n";
        let (rewritten, requests) =
            rewrite_hls_byte_ranges(manifest, &base, "job.input-assets").unwrap();
        assert!(!rewritten.contains("#EXT-X-BYTERANGE:"));
        assert!(rewritten.contains("job.input-assets/range-0000\n"));
        assert!(rewritten.contains("job.input-assets/range-0001\n"));
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].url.as_str(),
            "https://cdn.example/path/media.mp4"
        );
        assert_eq!((requests[0].start, requests[0].end), (0, 3));
        assert_eq!((requests[1].start, requests[1].end), (4, 7));

        let invalid = "#EXTM3U\n#EXT-X-BYTERANGE:4\nmedia.mp4\n#EXT-X-ENDLIST\n";
        assert!(rewrite_hls_byte_ranges(invalid, &base, "assets").is_err());

        let map_manifest = "#EXTM3U\n#EXT-X-MAP:URI=\"media.mp4\",BYTERANGE=\"8@0\",X-INFO=\"a,b\"\n#EXTINF:4,\nsegment.m4s\n#EXT-X-ENDLIST\n";
        let (rewritten_map, map_requests) =
            rewrite_hls_byte_ranges(map_manifest, &base, "job.input-assets").unwrap();
        assert!(
            rewritten_map.contains("#EXT-X-MAP:URI=\"job.input-assets/range-0000\",X-INFO=\"a,b\"")
        );
        assert!(!rewritten_map.contains("BYTERANGE"));
        assert_eq!(map_requests.len(), 1);
        assert!(map_requests[0].is_map);
        assert_eq!(
            map_requests[0].url.as_str(),
            "https://cdn.example/path/media.mp4"
        );
        assert_eq!((map_requests[0].start, map_requests[0].end), (0, 7));
    }

    #[test]
    fn hls_conversion_chooses_highest_bandwidth_variant_and_preserves_external_audio() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2200000\nhi.m3u8\n";
        assert_eq!(
            select_hls_conversion_variant(master).unwrap(),
            Some(HlsVariantSelection {
                uri: "hi.m3u8".to_string(),
                bandwidth: 2_200_000,
                audio_renditions: Vec::new(),
                subtitle_renditions: Vec::new(),
            })
        );
        let audio = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"French\",DEFAULT=NO,AUTOSELECT=YES,URI=\"audio/fr.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English, Stereo\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio/en.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"audio\"\nvideo.m3u8\n";
        assert_eq!(
            select_hls_conversion_variant(audio).unwrap(),
            Some(HlsVariantSelection {
                uri: "video.m3u8".to_string(),
                bandwidth: 800_000,
                audio_renditions: vec![
                    HlsAudioRendition {
                        uri: "audio/en.m3u8".to_string(),
                        name: "English, Stereo".to_string(),
                        language: None,
                        is_default: true,
                        autoselect: true,
                    },
                    HlsAudioRendition {
                        uri: "audio/fr.m3u8".to_string(),
                        name: "French".to_string(),
                        language: None,
                        is_default: false,
                        autoselect: true,
                    },
                ],
                subtitle_renditions: Vec::new(),
            })
        );
    }

    #[test]
    fn hls_playlist_variables_support_values_query_params_and_imports() {
        let master_url =
            url::Url::parse("https://cdn.example/master.m3u8?token=abc%2Fdef+ghi&other=x").unwrap();
        let master = "#EXTM3U\n#EXT-X-DEFINE:NAME=\"prefix\",VALUE=\"assets\"\n#EXT-X-DEFINE:QUERYPARAM=\"token\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n{$prefix}/{$token}.m3u8\n";
        let (resolved_master, inherited) =
            resolve_hls_variables(master, &master_url, &HashMap::new()).unwrap();
        assert!(!resolved_master.contains("#EXT-X-DEFINE:"));
        assert!(resolved_master.contains("assets/abc/def+ghi.m3u8"));
        assert_eq!(
            inherited.get("token").map(String::as_str),
            Some("abc/def+ghi")
        );

        let media_url = url::Url::parse("https://cdn.example/assets/media.m3u8").unwrap();
        let media = "#EXTM3U\n#EXT-X-DEFINE:IMPORT=\"token\"\n#EXTINF:4,\nseg.ts?token={$token}\n#EXT-X-ENDLIST\n";
        let (resolved_media, _) = resolve_hls_variables(media, &media_url, &inherited).unwrap();
        assert!(resolved_media.contains("seg.ts?token=abc/def+ghi"));

        let missing = "#EXTM3U\n#EXTINF:4,\n{$missing}.ts\n#EXT-X-ENDLIST\n";
        assert!(resolve_hls_variables(missing, &media_url, &HashMap::new()).is_err());
        assert!(percent_decode_hls_query_component("bad%2").is_err());
    }

    #[test]
    fn dash_segment_lists_select_video_and_main_audio_and_bound_live_snapshots() {
        let mpd = r#"<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S">
  <Period duration="PT8S">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <Representation id="v-low" bandwidth="500000"><BaseURL>low/</BaseURL><SegmentList timescale="1000" duration="4000"><Initialization sourceURL="init.mp4"/><SegmentURL media="low.m4s"/></SegmentList></Representation>
      <Representation id="v-high" bandwidth="2000000"><BaseURL>high/</BaseURL><SegmentList timescale="1000" duration="4000"><Initialization sourceURL="init.mp4" range="0-99"/><SegmentURL media="high.m4s?token=a&amp;key=b" mediaRange="100-399"/><SegmentURL media="high.m4s" mediaRange="400-699"/></SegmentList></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Representation id="a-main" bandwidth="192000"><BaseURL>audio/</BaseURL><SegmentList timescale="1000" duration="4000"><Initialization sourceURL="init.mp4"/><SegmentURL media="audio.m4s"/></SegmentList></Representation></AdaptationSet>
  </Period>
</MPD>"#;
        let manifest_url = url::Url::parse("https://cdn.example/movie/manifest.mpd").unwrap();
        let plan = plan_static_dash_mpd(mpd, &manifest_url).unwrap();
        assert_eq!(plan.periods[0].video.bandwidth, 2_000_000);
        assert_eq!(
            plan.periods[0]
                .video
                .initialization
                .as_ref()
                .unwrap()
                .url
                .as_str(),
            "https://cdn.example/movie/high/init.mp4"
        );
        assert_eq!(
            plan.periods[0].video.initialization.as_ref().unwrap().range,
            Some((0, 99))
        );
        assert_eq!(plan.periods[0].video.segments.len(), 2);
        assert_eq!(
            plan.periods[0].video.segments[0].url.as_str(),
            "https://cdn.example/movie/high/high.m4s?token=a&key=b"
        );
        assert_eq!(plan.periods[0].video.segments[0].range, Some((100, 399)));
        assert_eq!(plan.periods[0].audio.first().unwrap().track.kind, "audio");

        let output = serialize_dash_media_playlist(
            &plan.periods[0].video,
            "job.input-assets/video",
            Some("init.mp4"),
            &[
                "segment-0000.m4s".to_string(),
                "segment-0001.m4s".to_string(),
            ],
        )
        .unwrap();
        assert!(output.contains("#EXT-X-MAP:URI=\"job.input-assets/video/init.mp4\""));
        assert!(output.contains("job.input-assets/video/segment-0001.m4s"));
        assert!(output.contains("#EXTINF:4.000000,"));

        let dynamic = mpd.replace("type=\"static\"", "type=\"dynamic\"");
        let dynamic_plan = plan_static_dash_mpd(&dynamic, &manifest_url)
            .expect("bounded dynamic DASH SegmentLists should be usable as finite snapshots");
        assert!(dynamic_plan.dynamic);
        let drm = mpd.replace(
            "<Period duration=\"PT8S\">",
            "<Period duration=\"PT8S\"><ContentProtection schemeIdUri=\"urn:uuid:test\"/>",
        );
        assert!(plan_static_dash_mpd(&drm, &manifest_url).is_err());

        let ranged_list = r#"<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1000"><SegmentList timescale="1"><Initialization sourceURL="init.mp4"/><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline><SegmentURL media="1.m4s"/><SegmentURL media="2.m4s"/><SegmentURL media="3.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>"#;
        let plan = plan_static_dash_mpd(ranged_list, &manifest_url).unwrap();
        assert_eq!(
            dash_segment_durations(&plan.periods[0].video).unwrap(),
            vec![2.0, 2.0, 2.0]
        );

        let segment_base = r#"<MPD type="static" mediaPresentationDuration="PT12S"><Period duration="PT12S"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="muxed" bandwidth="1200000"><BaseURL>muxed.mp4?token=abc</BaseURL><SegmentBase indexRange="0-999"><Initialization range="0-999"/></SegmentBase></Representation></AdaptationSet></Period></MPD>"#;
        let plan = plan_static_dash_mpd(segment_base, &manifest_url).unwrap();
        assert_eq!(plan.periods[0].video.segments.len(), 1);
        assert_eq!(
            plan.periods[0].video.segments[0].url.as_str(),
            "https://cdn.example/movie/muxed.mp4?token=abc"
        );
        assert!(plan.periods[0].video.initialization.is_none());
        assert_eq!(
            dash_segment_durations(&plan.periods[0].video).unwrap(),
            vec![12.0]
        );
    }

    #[test]
    fn dash_static_segment_templates_expand_timeline_and_duration_urls() {
        let manifest_url = url::Url::parse("https://cdn.example/movie/manifest.mpd").unwrap();
        let timeline = r#"<MPD type="static" mediaPresentationDuration="PT6S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$-$Time$.m4s" startNumber="7"><SegmentTimeline><S t="0" d="2"/><S d="4"/></SegmentTimeline></SegmentTemplate><Representation id="main" bandwidth="1000000"/></AdaptationSet></Period></MPD>"#;
        let plan = plan_static_dash_mpd(timeline, &manifest_url).unwrap();
        assert_eq!(
            plan.periods[0]
                .video
                .initialization
                .as_ref()
                .unwrap()
                .url
                .as_str(),
            "https://cdn.example/movie/main/init.mp4"
        );
        assert_eq!(plan.periods[0].video.segments.len(), 2);
        assert_eq!(
            plan.periods[0].video.segments[0].url.as_str(),
            "https://cdn.example/movie/main/seg-007-0.m4s"
        );
        assert_eq!(
            plan.periods[0].video.segments[1].url.as_str(),
            "https://cdn.example/movie/main/seg-008-2.m4s"
        );
        assert_eq!(
            dash_segment_durations(&plan.periods[0].video).unwrap(),
            vec![2.0, 4.0]
        );

        let duration = r#"<MPD type="static" mediaPresentationDuration="PT5S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="init.mp4" media="segment-$Number$.m4s"/><Representation id="v1" bandwidth="500000"/></AdaptationSet></Period></MPD>"#;
        let plan = plan_static_dash_mpd(duration, &manifest_url).unwrap();
        assert_eq!(plan.periods[0].video.segments.len(), 3);
        assert_eq!(
            plan.periods[0].video.segments[2].url.as_str(),
            "https://cdn.example/movie/segment-3.m4s"
        );
        assert_eq!(
            dash_segment_durations(&plan.periods[0].video).unwrap(),
            vec![2.0, 2.0, 2.0]
        );

        let bounded_repeat = r#"<MPD type="static" mediaPresentationDuration="PT5S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate timescale="1" initialization="init.mp4" media="segment-$Time$.m4s"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="v1" bandwidth="500000"/></AdaptationSet></Period></MPD>"#;
        let plan = plan_static_dash_mpd(bounded_repeat, &manifest_url).unwrap();
        assert_eq!(plan.periods[0].video.segments.len(), 3);
        assert_eq!(
            plan.periods[0].video.segments[2].url.as_str(),
            "https://cdn.example/movie/segment-4.m4s"
        );
        assert_eq!(
            dash_segment_durations(&plan.periods[0].video).unwrap(),
            vec![2.0, 2.0, 2.0]
        );
    }

    #[test]
    fn dash_static_multi_period_tracks_materialize_as_discontinuous_hls_vod() {
        let manifest = r#"<MPD type="static" mediaPresentationDuration="PT4S"><Period start="PT0S" duration="PT2S"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v0" bandwidth="500000"><SegmentTemplate timescale="1" duration="2" initialization="p0-init.mp4" media="p0-$Number$.m4s"/></Representation></AdaptationSet></Period><Period start="PT2S" duration="PT2S"><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v1" bandwidth="600000"><SegmentTemplate timescale="1" duration="2" initialization="p1-init.mp4" media="p1-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>"#;
        let manifest_url = url::Url::parse("https://cdn.example/movie/manifest.mpd").unwrap();
        let plan = plan_static_dash_mpd(manifest, &manifest_url).unwrap();
        assert_eq!(plan.periods.len(), 2);
        assert_eq!(plan.periods[1].video.bandwidth, 600_000);
        assert!(plan.periods.iter().all(|period| period.audio.is_empty()));

        let playlist = serialize_dash_period_playlist(&[
            DashMaterializedTrack {
                track: plan.periods[0].video.clone(),
                asset_prefix: "period-000/video".to_string(),
                initialization_name: Some("init-0.mp4".to_string()),
                segment_names: vec!["segment-0.m4s".to_string()],
            },
            DashMaterializedTrack {
                track: plan.periods[1].video.clone(),
                asset_prefix: "period-001/video".to_string(),
                initialization_name: Some("init-1.mp4".to_string()),
                segment_names: vec!["segment-0.m4s".to_string()],
            },
        ])
        .unwrap();
        assert_eq!(playlist.matches("#EXT-X-MAP:").count(), 2);
        assert_eq!(playlist.matches("#EXT-X-DISCONTINUITY").count(), 1);
        assert!(playlist.contains("period-001/video/segment-0.m4s"));
        assert!(playlist.ends_with("#EXT-X-ENDLIST\n"));
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
                    request_headers: HashMap::new(),
                    request_header_origin: "https://cdn.example".to_string(),
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
            conversion_tasks: Arc::new(Mutex::new(HashMap::new())),
            access_code: None,
            access_attempts: Arc::new(Mutex::new(HashMap::new())),
            allowed_origins: Arc::new(HashSet::new()),
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
            "video/mp4",
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

    #[tokio::test]
    async fn signed_local_hls_manifest_and_segments_support_ranges_and_expiry() {
        let id = "0123456789abcdef0123456789abcdef";
        let signing_key = Arc::new(b"hls-test-session-signing-key-at-least-32-bytes".to_vec());
        let dir = std::env::temp_dir().join(format!(
            "aurales-hls-session-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let playlist = dir.join("source.m3u8");
        let segment_name = "source.ts";
        tokio::fs::write(
            &playlist,
            format!("#EXTM3U\n#EXT-X-BYTERANGE:4@0\n{segment_name}\n#EXT-X-ENDLIST\n"),
        )
        .await
        .unwrap();
        tokio::fs::write(dir.join(segment_name), b"abcdefgh")
            .await
            .unwrap();
        let state = AppState {
            api_key: Arc::new(vec![b'x'; 32]),
            ranking_slots: Arc::new(Semaphore::new(1)),
            session_key: signing_key.clone(),
            allowed_media_hosts: Arc::new(HashSet::new()),
            media_sessions: Arc::new(Mutex::new(HashMap::from([(
                id.to_string(),
                MediaSession {
                    url: url::Url::parse("https://local-media.invalid/").unwrap(),
                    request_headers: HashMap::new(),
                    request_header_origin: String::new(),
                    local_file: Some(playlist.clone()),
                    expires_at: Instant::now() + MEDIA_SESSION_TTL,
                    children: HashMap::new(),
                    is_root: true,
                    parent_id: None,
                    nesting_depth: 0,
                },
            )]))),
            media_slots: Arc::new(Semaphore::new(4)),
            probe_slots: Arc::new(Semaphore::new(1)),
            pmdb_slots: Arc::new(Semaphore::new(1)),
            ffmpeg_path: None,
            ffmpeg_caps: None,
            conversion_dir: Arc::new(dir.clone()),
            conversion_slots: Arc::new(Semaphore::new(1)),
            conversion_jobs: Arc::new(Mutex::new(HashMap::new())),
            conversion_tasks: Arc::new(Mutex::new(HashMap::new())),
            access_code: None,
            access_attempts: Arc::new(Mutex::new(HashMap::new())),
            allowed_origins: Arc::new(HashSet::new()),
        };
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let signature = sign_session(&signing_key, id, expires).unwrap();
        let manifest = proxy_media(
            State(state.clone()),
            Path(id.to_string()),
            Query(SignedSession {
                expires,
                signature: signature.clone(),
                extra_params: HashMap::new(),
            }),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(manifest.status(), StatusCode::OK);
        assert_eq!(
            manifest.headers().get(CONTENT_TYPE).unwrap(),
            "application/vnd.apple.mpegurl"
        );
        let manifest_text = manifest.into_body().collect().await.unwrap().to_bytes();
        let manifest_text = String::from_utf8(manifest_text.to_vec()).unwrap();
        assert!(manifest_text.contains(&format!(
            "/v1/media/{id}/{segment_name}?expires={expires}&signature={signature}"
        )));

        let mut range = HeaderMap::new();
        range.insert(RANGE, HeaderValue::from_static("bytes=2-5"));
        let segment = proxy_local_media_asset(
            State(state.clone()),
            Path((id.to_string(), segment_name.to_string())),
            Query(SignedSession {
                expires,
                signature,
                extra_params: HashMap::new(),
            }),
            range,
            Method::GET,
        )
        .await;
        assert_eq!(segment.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(segment.headers().get(CONTENT_TYPE).unwrap(), "video/mp2t");
        assert_eq!(
            segment.into_body().collect().await.unwrap().to_bytes(),
            "cdef"
        );

        let expired = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 1;
        let expired_signature = sign_session(&signing_key, id, expired).unwrap();
        let expired_response = proxy_local_media_asset(
            State(state),
            Path((id.to_string(), segment_name.to_string())),
            Query(SignedSession {
                expires: expired,
                signature: expired_signature,
                extra_params: HashMap::new(),
            }),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(expired_response.status(), StatusCode::NOT_FOUND);
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn api_key_comparison_requires_a_bearer_value_and_exact_length() {
        let key = b"a-private-api-key-that-is-long-enough";
        let mut headers = HeaderMap::new();
        assert!(!is_authorized(
            &headers,
            key,
            b"test-session-key-that-is-long-enough"
        ));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer shorter"));
        assert!(!is_authorized(
            &headers,
            key,
            b"test-session-key-that-is-long-enough"
        ));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer a-private-api-key-that-is-long-enough"),
        );
        assert!(is_authorized(
            &headers,
            key,
            b"test-session-key-that-is-long-enough"
        ));
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
            conversion_tasks: Arc::new(Mutex::new(HashMap::new())),
            access_code: Some(Arc::new(b"test-access-code-long-enough".to_vec())),
            access_attempts: Arc::new(Mutex::new(HashMap::new())),
            allowed_origins: Arc::new(HashSet::from(["https://app.example".to_string()])),
        };
        let app = router(state, origins);
        let wrong_origin = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/access/session")
                    .header(CONTENT_TYPE, "application/json")
                    .header("origin", "https://attacker.example")
                    .body(Body::from(
                        r#"{"accessCode":"test-access-code-long-enough"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_origin.status(), StatusCode::FORBIDDEN);
        let wrong_code = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/access/session")
                    .header(CONTENT_TYPE, "application/json")
                    .header("origin", "https://app.example")
                    .body(Body::from(r#"{"accessCode":"wrong"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong_code.status(), StatusCode::UNAUTHORIZED);
        for _ in 0..MAX_ACCESS_ATTEMPTS {
            let failed = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/v1/access/session")
                        .header(CONTENT_TYPE, "application/json")
                        .header("origin", "https://app.example")
                        .header("x-forwarded-for", "198.51.100.25")
                        .body(Body::from(r#"{"accessCode":"wrong"}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(failed.status(), StatusCode::UNAUTHORIZED);
        }
        let rate_limited = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/access/session")
                    .header(CONTENT_TYPE, "application/json")
                    .header("origin", "https://app.example")
                    .header("x-forwarded-for", "198.51.100.25")
                    .body(Body::from(r#"{"accessCode":"wrong"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rate_limited.status(), StatusCode::TOO_MANY_REQUESTS);
        let access_response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/access/session")
                    .header(CONTENT_TYPE, "application/json")
                    .header("origin", "https://app.example")
                    .body(Body::from(
                        r#"{"accessCode":"test-access-code-long-enough"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(access_response.status(), StatusCode::NO_CONTENT);
        let session_cookie = access_response
            .headers()
            .get(SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        assert!(session_cookie.starts_with(&format!("{ACCESS_COOKIE}=")));
        let cookie_authorized = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/capabilities")
                    .header(COOKIE, session_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cookie_authorized.status(), StatusCode::OK);

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

    #[tokio::test]
    async fn cancelling_a_conversion_aborts_its_task_and_expires_the_job() {
        let key = "a-private-worker-key-that-exceeds-32-bytes";
        let id = "0123456789abcdef0123456789abcdef".to_string();
        let origins = parse_origins("https://app.example").unwrap();
        let jobs = Arc::new(Mutex::new(HashMap::from([(
            id.clone(),
            ConversionJob {
                status: ConversionStatus::Processing,
                expires_at: Instant::now() + MEDIA_SESSION_TTL,
            },
        )])));
        let tasks = Arc::new(Mutex::new(HashMap::new()));
        let task = tokio::spawn(std::future::pending::<()>());
        let abort_handle = task.abort_handle();
        tasks.lock().await.insert(id.clone(), task);
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
            conversion_dir: Arc::new(std::env::temp_dir().join("aurales-media-worker-cancel-test")),
            conversion_slots: Arc::new(Semaphore::new(2)),
            conversion_jobs: jobs.clone(),
            conversion_tasks: tasks.clone(),
            access_code: None,
            access_attempts: Arc::new(Mutex::new(HashMap::new())),
            allowed_origins: Arc::new(HashSet::from(["https://app.example".to_string()])),
        };
        let response = router(state, origins)
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/media/conversions/{id}"))
                    .header(AUTHORIZATION, format!("Bearer {key}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(abort_handle.is_finished());
        assert!(matches!(
            jobs.lock().await.get(&id).unwrap().status,
            ConversionStatus::Cancelled
        ));
    }
}
