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
use std::sync::atomic::{AtomicU32, Ordering};
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
const SWEEP_EVERY_WRITES: u32 = 25;
const MAX_DOWNLOAD_BYTES: u64 = 30 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 768;
const MAX_BACKDROP_EDGE: u32 = 1920;
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
    in_flight: HashSet<PathBuf>,
    recent_failures: HashMap<PathBuf, Instant>,
}

static DOWNLOAD_STATE: OnceLock<Mutex<DownloadState>> = OnceLock::new();
static DOWNLOAD_READY: Condvar = Condvar::new();

fn download_state() -> &'static Mutex<DownloadState> {
    DOWNLOAD_STATE.get_or_init(|| {
        Mutex::new(DownloadState {
            active: 0,
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
    let Some(marker) = url.find("aurales-cache=backdrop") else {
        return url;
    };
    url[..marker].trim_end_matches(&['#', '&'][..])
}

fn requested_max_image_edge(url: &str) -> u32 {
    if url.contains("aurales-cache=backdrop") {
        MAX_BACKDROP_EDGE
    } else {
        MAX_IMAGE_EDGE
    }
}

fn optimize_image_bytes(bytes: Vec<u8>, max_edge: u32) -> Vec<u8> {
    let Ok(image) = image::load_from_memory(&bytes) else {
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
    let mut bytes: Vec<u8> = Vec::new();
    response
        .into_reader()
        .take(MAX_DOWNLOAD_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty response".into());
    }
    Ok(bytes)
}

/// Download a missing entry with bounded concurrency and per-path in-flight
/// deduplication. Requests waiting for the same poster read the file written by
/// the first request instead of opening duplicate HTTP connections.
fn download_cached(url: &str, path: &PathBuf) -> Result<Vec<u8>, String> {
    let queue_deadline = Instant::now() + SLOT_WAIT_TIMEOUT;

    let _slot = loop {
        let mut state = lock_download_state();

        // Another request may have completed while this one waited.
        if path.exists() {
            drop(state);
            return fs::read(path).map_err(|error| error.to_string());
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
    let mut files: Vec<(PathBuf, SystemTime, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                entry.path(),
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                meta.len(),
            ))
        })
        .collect();

    let now = SystemTime::now();
    files.retain(|(path, modified, _)| {
        let expired = now
            .duration_since(*modified)
            .map(|age| age.as_secs() > keep_secs)
            .unwrap_or(false);
        if expired {
            let _ = fs::remove_file(path);
        }
        !expired
    });

    let mut total: u64 = files.iter().map(|(_, _, len)| len).sum();
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(_, modified, _)| *modified);
    for (path, _, len) in files {
        if total <= max_bytes {
            break;
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
        // Expired files must be removed before entering download_cached;
        // otherwise its post-wait existence check would serve stale bytes.
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        match download_cached(&url, &path) {
            Ok(bytes) => {
                if WRITES_SINCE_SWEEP.fetch_add(1, Ordering::Relaxed) >= SWEEP_EVERY_WRITES {
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
        .header("Cache-Control", "public, max-age=604800")
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
        config.max_bytes = max_mb.max(10) * 1024 * 1024;
        config.keep_secs = keep_days.max(1) * 24 * 60 * 60;
    }
    if let Ok(dir) = cache_dir(&app) {
        tauri::async_runtime::spawn_blocking(move || enforce_limits(&dir));
    }
}

#[tauri::command]
pub fn image_cache_stats(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = cache_dir(&app)?;
    let mut bytes: u64 = 0;
    let mut files: u64 = 0;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                bytes += meta.len();
                files += 1;
            }
        }
    }
    Ok(serde_json::json!({ "bytes": bytes, "files": files }))
}

#[tauri::command]
pub fn image_cache_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let _ = fs::remove_file(entry.path());
    }
    Ok(())
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
