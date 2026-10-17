// Disk-backed image cache behind the `imgcache://` protocol.
//
// The frontend rewrites artwork URLs to `imgcache://localhost/<urlencoded-remote-url>`
// (via convertFileSrc). Each image is downloaded once into
// <app-data>/image_cache and served locally afterwards, which lets the app
// enforce the Settings → Image Cache size cap and max age — the WebView's own
// HTTP cache offers no such control.

use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use image::GenericImageView;
use tauri::Manager;

struct CacheConfig {
    max_bytes: u64,
    keep_secs: u64,
}

static CONFIG: Mutex<CacheConfig> = Mutex::new(CacheConfig {
    max_bytes: 500 * 1024 * 1024,
    keep_secs: 3 * 24 * 60 * 60,
});

// Full-directory scans are O(files); run eviction only every N writes.
static WRITES_SINCE_SWEEP: AtomicU32 = AtomicU32::new(0);
// A clear can race with a download already in progress. Such a request may
// still serve its bytes to the current image, but must not repopulate disk
// after the user cleared the cache.
static CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);
const SWEEP_EVERY_WRITES: u32 = 25;
const MAX_DOWNLOAD_BYTES: u64 = 30 * 1024 * 1024;
const ABANDONED_PARTIAL_MAX_AGE: Duration = Duration::from_secs(60 * 60);
const MAX_IMAGE_EDGE: u32 = 768;
const MAX_BACKDROP_EDGE: u32 = 1920;
// A compressed image can expand to hundreds of megabytes when decoded. Keep
// the optional cache optimization from allocating an unbounded source bitmap.
const MAX_DECODE_PIXELS: u64 = 48_000_000;
const MAX_DECODE_ALLOC_BYTES: u64 = 256 * 1024 * 1024;
// Decoding a provider's multi-megapixel source can temporarily allocate far
// more than its compressed size in both Rust and WebKit. Two workers keep
// scrolling responsive on long shelves; additional requests are safely
// deduplicated or fall back after the bounded wait.
const MAX_CONCURRENT_DOWNLOADS: usize = 2;
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);
// A request that cannot get a worker slot in this long stops queueing and falls
// back to the origin. An <img> has no timeout of its own: if this handler never
// responds, the element stays `complete === false` forever with no error event
// and the artwork is simply blank, so waiting must always be bounded.
const SLOT_WAIT_TIMEOUT: Duration = Duration::from_secs(6);

struct DownloadState {
    active: usize,
    clearing: usize,
    in_flight: HashSet<PathBuf>,
    recent_failures: HashMap<PathBuf, Instant>,
}

static DOWNLOAD_STATE: OnceLock<Mutex<DownloadState>> = OnceLock::new();
static DOWNLOAD_READY: Condvar = Condvar::new();

fn download_state() -> &'static Mutex<DownloadState> {
    DOWNLOAD_STATE.get_or_init(|| {
        Mutex::new(DownloadState {
            active: 0,
            clearing: 0,
            in_flight: HashSet::new(),
            recent_failures: HashMap::new(),
        })
    })
}

/// Recover the guard after a panicking download rather than propagating the
/// poison. Poisoning this mutex would make every later cache miss panic inside
/// its worker, and a panicked worker never responds — one bad download would
/// silently blank all uncached artwork for the rest of the session.
fn lock_download_state() -> MutexGuard<'static, DownloadState> {
    download_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Releases the worker slot on every exit path, including an unwind out of the
/// download. Bookkeeping done by hand leaks a slot whenever a path returns
/// early, and six leaked slots wedge the pool permanently.
struct SlotGuard {
    path: PathBuf,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let mut state = lock_download_state();
        state.active = state.active.saturating_sub(1);
        state.in_flight.remove(&self.path);
        DOWNLOAD_READY.notify_all();
    }
}

/// Keep new cache misses out of the directory while a user initiated clear is
/// removing files. Requests already in flight are handled by the generation
/// check in `download_cached`.
struct CacheClearGuard;

impl Drop for CacheClearGuard {
    fn drop(&mut self) {
        let mut state = lock_download_state();
        state.clearing = state.clearing.saturating_sub(1);
        DOWNLOAD_READY.notify_all();
    }
}

/// Same poison tolerance as the download state: a panic while holding the
/// config must not turn every later artwork request into a panicking worker.
fn lock_config() -> MutexGuard<'static, CacheConfig> {
    CONFIG
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("image_cache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn file_extension(url: &str) -> &'static str {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "jpg",
        "png" => "png",
        "webp" => "webp",
        "gif" => "gif",
        "avif" => "avif",
        "svg" => "svg",
        _ => "img",
    }
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        "jpg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn cache_path(dir: &PathBuf, url: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    // Version the on-disk format so old full-resolution entries are not fed
    // back into the WebView after thumbnail-safe caching is introduced.
    dir.join(format!(
        "{:016x}.v3.{}",
        hasher.finish(),
        file_extension(url)
    ))
}

/// Provider CDNs routinely return 3K+ source art for small shelf cards. The
/// decoded RGBA surface, not the compressed download, is what freezes WebKit.
/// Resize once while writing the disk cache; non-images and decode failures
/// retain their original response as a safe fallback.
fn origin_url(url: &str) -> &str {
    // cachedImage appends the variant marker after any existing query or
    // fragment. Match only that suffix: signed source URLs may themselves
    // contain an `aurales-cache=backdrop` query parameter which must survive.
    url.strip_suffix("&aurales-cache=backdrop")
        .or_else(|| url.strip_suffix("#aurales-cache=backdrop"))
        .unwrap_or(url)
}

fn requested_max_image_edge(url: &str) -> u32 {
    if url.ends_with("&aurales-cache=backdrop") || url.ends_with("#aurales-cache=backdrop") {
        MAX_BACKDROP_EDGE
    } else {
        MAX_IMAGE_EDGE
    }
}

fn optimize_image_bytes(bytes: Vec<u8>, max_edge: u32) -> Vec<u8> {
    // Inspect dimensions before decoding. This prevents a tiny compressed
    // decompression-bomb image from allocating an enormous RGBA surface just
    // to be reduced to a card-sized thumbnail.
    let reader = image::ImageReader::new(Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .ok();
    // DynamicImage::decode returns one frame. Re-encoding an animated source
    // as PNG/JPEG would silently freeze artwork at its first frame.
    let format = reader.as_ref().and_then(|reader| reader.format());
    let is_animated = match format {
        Some(image::ImageFormat::Gif) => true,
        Some(image::ImageFormat::Png) => {
            image::codecs::png::PngDecoder::new(Cursor::new(bytes.as_slice()))
                .and_then(|decoder| decoder.is_apng())
                .unwrap_or(false)
        }
        Some(image::ImageFormat::WebP) => {
            image::codecs::webp::WebPDecoder::new(Cursor::new(bytes.as_slice()))
                .map(|decoder| decoder.has_animation())
                .unwrap_or(false)
        }
        _ => false,
    };
    if is_animated {
        return bytes;
    }
    let dimensions = reader.and_then(|reader| reader.into_dimensions().ok());
    let Some((width, height)) = dimensions else {
        return bytes;
    };
    if width as u64 * height as u64 > MAX_DECODE_PIXELS {
        return bytes;
    }

    let Ok(mut reader) =
        image::ImageReader::new(Cursor::new(bytes.as_slice())).with_guessed_format()
    else {
        return bytes;
    };
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    reader.limits(limits);
    let Ok(image) = reader.decode() else {
        return bytes;
    };
    let (width, height) = image.dimensions();
    if width.max(height) <= max_edge {
        return bytes;
    }
    let resized = image.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    let mut output = Cursor::new(Vec::new());
    let result = if image.color().has_alpha() {
        resized.write_to(&mut output, image::ImageFormat::Png)
    } else {
        resized.write_to(&mut output, image::ImageFormat::Jpeg)
    };
    if result.is_ok() && !output.get_ref().is_empty() {
        output.into_inner()
    } else {
        bytes
    }
}

fn is_expired(path: &PathBuf, keep_secs: u64) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return true;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age.as_secs() > keep_secs)
        .unwrap_or(false)
}

/// ureq applies the overall `timeout` to connect and body reads, but explicitly
/// not to DNS resolution, which can block a worker indefinitely on a flaky
/// resolver. The per-phase timeouts below bound the parts the deadline misses.
fn download_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(8))
            .timeout_read(Duration::from_secs(12))
            .timeout_write(Duration::from_secs(8))
            .build()
    })
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let response = download_agent()
        .get(url)
        // A failed artwork origin must not occupy one of the small bounded
        // worker pool slots long enough to starve the visible Home row.
        .timeout(Duration::from_secs(12))
        .call()
        .map_err(|e| e.to_string())?;
    // Some providers return a branded HTML or JSON error page with status 200.
    // Caching those bytes makes the custom protocol answer 200 forever, so the
    // <img> never reaches the origin fallback. Preserve octet-stream origins
    // because a few CDNs omit the image MIME type, but reject explicit non-image
    // payloads and let serve() redirect the WebView to the source URL.
    if let Some(content_type) = response.header("Content-Type") {
        let media_type = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !media_type.starts_with("image/") && media_type != "application/octet-stream" {
            return Err(format!(
                "unexpected image response content type: {media_type}"
            ));
        }
    }
    let mut bytes: Vec<u8> = Vec::new();
    response
        .into_reader()
        // Read one byte past the limit so oversized responses are rejected
        // rather than silently cached as a valid but truncated image.
        .take(MAX_DOWNLOAD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty response".into());
    }
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("image exceeds the cache download limit".into());
    }
    Ok(bytes)
}

/// Download a missing entry with bounded concurrency and per-path in-flight
/// deduplication. Requests waiting for the same poster read the file written by
/// the first request instead of opening duplicate HTTP connections.
fn download_cached(url: &str, path: &PathBuf, keep_secs: u64) -> Result<Vec<u8>, String> {
    let generation = CACHE_GENERATION.load(Ordering::SeqCst);
    let queue_deadline = Instant::now() + SLOT_WAIT_TIMEOUT;

    let _slot = loop {
        let mut state = lock_download_state();

        // Another request may have completed while this one waited.
        if state.clearing > 0 {
            let Some(remaining) = queue_deadline.checked_duration_since(Instant::now()) else {
                return Err("timed out waiting for the cache clear".into());
            };
            let (guard, _) = DOWNLOAD_READY
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            drop(guard);
            continue;
        }

        if path.exists() {
            if !is_expired(path, keep_secs) {
                drop(state);
                return fs::read(path).map_err(|error| error.to_string());
            }
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }

        state
            .recent_failures
            .retain(|_, failed_at| failed_at.elapsed() < FAILURE_COOLDOWN);
        if state.recent_failures.contains_key(path) {
            return Err("image origin is in retry cooldown".into());
        }

        if state.in_flight.contains(path) || state.active >= MAX_CONCURRENT_DOWNLOADS {
            let Some(remaining) = queue_deadline.checked_duration_since(Instant::now()) else {
                return Err("timed out waiting for a download slot".into());
            };
            // wait_timeout, not wait: a lost notification or a worker wedged in
            // a syscall the timeouts above cannot interrupt must not strand this
            // request — the caller can still serve the origin URL instead.
            let (guard, _) = DOWNLOAD_READY
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            drop(guard);
            continue;
        }

        state.active += 1;
        state.in_flight.insert(path.clone());
        drop(state);
        break SlotGuard { path: path.clone() };
    };

    let result = download(origin_url(url)).and_then(|bytes| {
        let bytes = optimize_image_bytes(bytes, requested_max_image_edge(url));
        let tmp = path.with_extension(format!("{}.part", file_extension(url)));
        fs::write(&tmp, &bytes).map_err(|error| error.to_string())?;
        fs::rename(&tmp, path).map_err(|error| error.to_string())?;
        if CACHE_GENERATION.load(Ordering::SeqCst) != generation {
            let _ = fs::remove_file(path);
        }
        Ok(bytes)
    });

    {
        let mut state = lock_download_state();
        if result.is_err() {
            state.recent_failures.insert(path.clone(), Instant::now());
        } else {
            state.recent_failures.remove(path);
        }
    }
    // `_slot` releases the worker and wakes the queue as it drops here.
    result
}

/// Delete expired entries, then oldest-first until under the size cap.
fn enforce_limits(dir: &PathBuf) {
    let (max_bytes, keep_secs) = {
        let config = lock_config();
        (config.max_bytes, config.keep_secs)
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, SystemTime, u64, bool)> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let path = entry.path();
            Some((
                path.clone(),
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                meta.len(),
                path.extension().and_then(|extension| extension.to_str()) != Some("part"),
            ))
        })
        .collect();

    let now = SystemTime::now();
    files.retain(|(path, modified, _, evictable)| {
        let age = now.duration_since(*modified).unwrap_or_default();
        // A concurrent download owns its .part file until it atomically
        // renames it. Never evict an active partial file during a size sweep;
        // only clean one up after it has clearly been abandoned.
        let expired = if *evictable {
            age.as_secs() > keep_secs
        } else {
            age > ABANDONED_PARTIAL_MAX_AGE
        };
        if expired {
            let _ = fs::remove_file(path);
        }
        !expired
    });

    let mut total: u64 = files.iter().map(|(_, _, len, _)| len).sum();
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(_, modified, _, _)| *modified);
    for (path, _, len, evictable) in files {
        if total <= max_bytes {
            break;
        }
        if !evictable {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

fn respond_redirect(url: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(307)
        .header("Location", url)
        .body(Vec::new())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn serve(app: &tauri::AppHandle, uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    let encoded = uri_path.trim_start_matches('/');
    let url = percent_decode(encoded);
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return tauri::http::Response::builder()
            .status(400)
            .body(Vec::new())
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
    }

    let Ok(dir) = cache_dir(app) else {
        return respond_redirect(origin_url(&url));
    };
    let path = cache_path(&dir, &url);
    let keep_secs = lock_config().keep_secs;

    let bytes = if path.exists() && !is_expired(&path, keep_secs) {
        match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return respond_redirect(origin_url(&url)),
        }
    } else {
        // Expiry check and removal happen under the download-state lock so a
        // slower request cannot remove a fresh entry written by a concurrent
        // refresh of the same URL.
        match download_cached(&url, &path, keep_secs) {
            Ok(bytes) => {
                let max_bytes = lock_config().max_bytes;
                let large_write_threshold = (max_bytes / SWEEP_EVERY_WRITES as u64).max(1);
                if WRITES_SINCE_SWEEP.fetch_add(1, Ordering::Relaxed) >= SWEEP_EVERY_WRITES
                    || bytes.len() as u64 >= large_write_threshold
                {
                    WRITES_SINCE_SWEEP.store(0, Ordering::Relaxed);
                    enforce_limits(&dir);
                }
                bytes
            }
            // Never break artwork over a cache problem — fall back to the source.
            Err(_) => return respond_redirect(origin_url(&url)),
        }
    };

    let content_type = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::WebP) => "image/webp",
        Ok(image::ImageFormat::Gif) => "image/gif",
        _ => path
            .extension()
            .and_then(|e| e.to_str())
            .map(content_type)
            .unwrap_or("application/octet-stream"),
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        // Keep the native cache settings authoritative. A long-lived WebView
        // HTTP entry would survive both a user-initiated clear and a shorter
        // configured retention period without invoking this disk cache.
        .header("Cache-Control", "no-cache")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

pub fn handle_request(
    app: tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // An unanswered responder is worse than any error response: the <img>
        // never fires load or error, so the artwork stays blank with no retry
        // path. Catch the unwind so a panic still produces a reply.
        let response =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| serve(&app, &path)))
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
                });
        responder.respond(response);
    });
}

#[tauri::command]
pub fn image_cache_configure(app: tauri::AppHandle, max_mb: u64, keep_days: u64) {
    {
        let mut config = lock_config();
        // Keep IPC inputs within the same range exposed by Settings and avoid
        // overflow turning the user's disk quota into an unintended value.
        config.max_bytes = max_mb.clamp(10, 2_000) * 1024 * 1024;
        config.keep_secs = keep_days.clamp(1, 30) * 24 * 60 * 60;
    }
    if let Ok(dir) = cache_dir(&app) {
        tauri::async_runtime::spawn_blocking(move || enforce_limits(&dir));
    }
}

#[tauri::command]
pub async fn image_cache_stats(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut bytes: u64 = 0;
        let mut files: u64 = 0;
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    bytes = bytes.saturating_add(meta.len());
                    files = files.saturating_add(1);
                }
            }
        }
        Ok(serde_json::json!({ "bytes": bytes, "files": files }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn image_cache_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    {
        let mut state = lock_download_state();
        state.clearing += 1;
        CACHE_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    let clear_guard = CacheClearGuard;
    tauri::async_runtime::spawn_blocking(move || {
        // The blocking filesystem job continues if the async command is
        // cancelled. Keep the clear reservation alive until deletion itself
        // finishes, or concurrent downloads could repopulate the cache.
        let _clear_guard = clear_guard;
        for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_file() || file_type.is_symlink() {
                match fs::remove_file(entry.path()) {
                    Ok(()) => {}
                    // An in-flight download may have removed its own entry
                    // after observing the generation bump.
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backdrop_variant_keeps_a_larger_cached_derivative() {
        let source = "https://image.tmdb.org/t/p/original/hero.jpg#aurales-cache=backdrop";
        assert_eq!(
            origin_url(source),
            "https://image.tmdb.org/t/p/original/hero.jpg"
        );
        assert_eq!(requested_max_image_edge(source), 1920);
        assert_eq!(
            requested_max_image_edge("https://example.test/poster.jpg"),
            768
        );
    }

    #[test]
    fn backdrop_marker_preserves_existing_source_fragments() {
        let source = "https://example.test/hero.jpg#source-fragment&aurales-cache=backdrop";
        assert_eq!(
            origin_url(source),
            "https://example.test/hero.jpg#source-fragment"
        );
    }

    #[test]
    fn image_optimization_respects_the_requested_variant_size() {
        let image = image::DynamicImage::new_rgb8(2000, 1000);
        let mut encoded = Cursor::new(Vec::new());
        image
            .write_to(&mut encoded, image::ImageFormat::Jpeg)
            .expect("encode source image");

        let card = optimize_image_bytes(encoded.get_ref().clone(), MAX_IMAGE_EDGE);
        let backdrop = optimize_image_bytes(encoded.into_inner(), MAX_BACKDROP_EDGE);
        assert_eq!(
            image::load_from_memory(&card)
                .expect("decode card")
                .dimensions(),
            (768, 384)
        );
        assert_eq!(
            image::load_from_memory(&backdrop)
                .expect("decode backdrop")
                .dimensions(),
            (1920, 960)
        );
    }
}
