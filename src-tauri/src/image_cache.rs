// Disk-backed image cache behind the `imgcache://` protocol.
//
// The frontend rewrites artwork URLs to `imgcache://localhost/<urlencoded-remote-url>`
// (via convertFileSrc). Each image is downloaded once into
// <app-data>/image_cache and served locally afterwards, which lets the app
// enforce the Settings → Image Cache size cap and max age — the WebView's own
// HTTP cache offers no such control.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

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
    dir.join(format!("{:016x}.{}", hasher.finish(), file_extension(url)))
}

fn is_expired(path: &PathBuf, keep_secs: u64) -> bool {
    let Ok(meta) = fs::metadata(path) else { return true };
    let Ok(modified) = meta.modified() else { return false };
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age.as_secs() > keep_secs)
        .unwrap_or(false)
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let response = ureq::get(url)
        .timeout(Duration::from_secs(20))
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

/// Delete expired entries, then oldest-first until under the size cap.
fn enforce_limits(dir: &PathBuf) {
    let (max_bytes, keep_secs) = {
        let config = CONFIG.lock().unwrap();
        (config.max_bytes, config.keep_secs)
    };
    let Ok(entries) = fs::read_dir(dir) else { return };
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

    let Ok(dir) = cache_dir(app) else { return respond_redirect(&url) };
    let path = cache_path(&dir, &url);
    let keep_secs = CONFIG.lock().unwrap().keep_secs;

    let bytes = if path.exists() && !is_expired(&path, keep_secs) {
        match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return respond_redirect(&url),
        }
    } else {
        match download(&url) {
            Ok(bytes) => {
                let tmp = path.with_extension("part");
                if fs::write(&tmp, &bytes).is_ok() {
                    let _ = fs::rename(&tmp, &path);
                }
                if WRITES_SINCE_SWEEP.fetch_add(1, Ordering::Relaxed) >= SWEEP_EVERY_WRITES {
                    WRITES_SINCE_SWEEP.store(0, Ordering::Relaxed);
                    enforce_limits(&dir);
                }
                bytes
            }
            // Never break artwork over a cache problem — fall back to the source.
            Err(_) => return respond_redirect(&url),
        }
    };

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("img")
        .to_ascii_lowercase();
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", content_type(&ext))
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
        responder.respond(serve(&app, &path));
    });
}

#[tauri::command]
pub fn image_cache_configure(app: tauri::AppHandle, max_mb: u64, keep_days: u64) {
    {
        let mut config = CONFIG.lock().unwrap();
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
