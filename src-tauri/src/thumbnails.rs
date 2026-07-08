use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

const DEFAULT_REFINED_INTERVAL: u32 = 10;
const DEFAULT_WIDTH: u32 = 240;
const DEFAULT_HEIGHT: u32 = 136;
const DEFAULT_COLUMNS: u32 = 10;
const DEFAULT_ROWS: u32 = 10;
const DEFAULT_QUALITY: u32 = 75;
const DEFAULT_MAX_FFMPEG_WORKERS: u32 = 2;
const SPRITE_CACHE_BUDGET_BYTES: u64 = 180 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailStartRequest {
    pub stream_url: String,
    pub cache_key: String,
    pub duration: Option<f64>,
    pub fast_interval: Option<u32>,
    pub refined_interval: Option<u32>,
    pub thumbnail_width: Option<u32>,
    pub thumbnail_height: Option<u32>,
    pub columns: Option<u32>,
    pub rows: Option<u32>,
    pub quality: Option<u32>,
    pub thumbnail_interval: Option<u32>,
    pub max_concurrent_ffmpeg_workers: Option<u32>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrubThumbnailRequest {
    pub media_id: String,
    pub stream_url: String,
    pub duration: Option<f64>,
    pub time: f64,
    pub thumbnail_interval: Option<u32>,
    pub thumbnail_width: Option<u32>,
    pub thumbnail_height: Option<u32>,
    pub quality: Option<u32>,
    pub max_concurrent_ffmpeg_workers: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailMetadata {
    pub cache_key: String,
    pub interval: u32,
    pub thumbnail_width: u32,
    pub thumbnail_height: u32,
    pub columns: u32,
    pub rows: u32,
    pub duration: Option<f64>,
    #[serde(default)]
    pub thumbnail_paths: Vec<String>,
    pub sprites: Vec<String>,
    #[serde(default)]
    pub sprite_thumbnail_counts: Vec<u32>,
    #[serde(default)]
    pub thumbnail_count: u32,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrubThumbnailResponse {
    pub cache_key: String,
    pub status: String,
    pub requested_time: f64,
    pub requested_index: u32,
    pub exact_path: Option<String>,
    pub nearest_path: Option<String>,
    pub nearest_index: Option<u32>,
    pub metadata: ThumbnailMetadata,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailCacheUpdated {
    metadata: ThumbnailMetadata,
}

#[derive(Default)]
struct SpriteMemoryCache {
    entries: HashMap<String, SpriteMemoryEntry>,
    order: VecDeque<String>,
    bytes: u64,
}

struct SpriteMemoryEntry {
    bytes: u64,
    _data: Vec<u8>,
}

#[derive(Clone)]
struct ThumbnailJobConfig {
    interval: u32,
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    quality: u32,
    max_workers: u32,
    duration: Option<f64>,
    max_count: u32,
}

#[derive(Clone)]
struct ThumbnailTask {
    index: u32,
    priority: i32,
    reason: &'static str,
    sequence: u64,
}

struct ThumbnailJobController {
    state: Mutex<ThumbnailJobState>,
    cv: Condvar,
}

struct ThumbnailJobState {
    queue: Vec<ThumbnailTask>,
    queued: HashSet<u32>,
    in_progress: HashSet<u32>,
    generated: HashSet<u32>,
    failed: HashSet<u32>,
    shutdown: bool,
    next_sequence: u64,
    first_thumbnail_ms: Option<u128>,
    total_generation_ms: u128,
    generation_samples: u32,
    cache_hits: u32,
    cache_misses: u32,
    failed_seeks: u32,
}

impl ThumbnailJobController {
    fn new(existing: HashSet<u32>) -> Self {
        Self {
            state: Mutex::new(ThumbnailJobState {
                queue: Vec::new(),
                queued: HashSet::new(),
                in_progress: HashSet::new(),
                generated: existing,
                failed: HashSet::new(),
                shutdown: false,
                next_sequence: 0,
                first_thumbnail_ms: None,
                total_generation_ms: 0,
                generation_samples: 0,
                cache_hits: 0,
                cache_misses: 0,
                failed_seeks: 0,
            }),
            cv: Condvar::new(),
        }
    }

    fn enqueue(&self, index: u32, priority: i32, reason: &'static str) -> bool {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        if state.shutdown || state.generated.contains(&index) || state.in_progress.contains(&index) {
            state.cache_hits += 1;
            return false;
        }
        state.cache_misses += 1;
        if state.queued.contains(&index) {
            if let Some(task) = state.queue.iter_mut().find(|task| task.index == index) {
                if priority < task.priority {
                    task.priority = priority;
                    task.reason = reason;
                }
            }
            self.cv.notify_one();
            return false;
        }
        let sequence = state.next_sequence;
        state.next_sequence += 1;
        state.queued.insert(index);
        state.queue.push(ThumbnailTask {
            index,
            priority,
            reason,
            sequence,
        });
        self.cv.notify_one();
        true
    }

    fn pop(&self) -> Option<ThumbnailTask> {
        let mut state = self.state.lock().ok()?;
        loop {
            if state.shutdown {
                return None;
            }
            if !state.queue.is_empty() {
                let best_index = state
                    .queue
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, task)| (task.priority, task.sequence))
                    .map(|(index, _)| index)?;
                let task = state.queue.swap_remove(best_index);
                state.queued.remove(&task.index);
                state.in_progress.insert(task.index);
                return Some(task);
            }
            state = self.cv.wait(state).ok()?;
        }
    }

    fn mark_generated(&self, index: u32, duration_ms: u128) {
        if let Ok(mut state) = self.state.lock() {
            state.in_progress.remove(&index);
            state.generated.insert(index);
            state.total_generation_ms += duration_ms;
            state.generation_samples += 1;
            if state.first_thumbnail_ms.is_none() {
                state.first_thumbnail_ms = thumbnail_debug_state()
                    .lock()
                    .ok()
                    .and_then(|debug| debug.generation_started_at_ms)
                    .map(|started| now_ms().saturating_sub(started));
            }
            update_speed_metrics(&state);
        }
        self.cv.notify_all();
    }

    fn mark_failed(&self, index: u32) {
        if let Ok(mut state) = self.state.lock() {
            state.in_progress.remove(&index);
            state.failed.insert(index);
            state.failed_seeks += 1;
            update_speed_metrics(&state);
        }
        self.cv.notify_all();
    }

    fn generated_count(&self) -> u32 {
        self.state
            .lock()
            .map(|state| state.generated.iter().copied().max().map(|index| index + 1).unwrap_or(0))
            .unwrap_or(0)
    }

    fn wait_until_idle(&self) {
        if let Ok(mut state) = self.state.lock() {
            loop {
                if state.shutdown {
                    break;
                }
                if state.queue.is_empty() && state.in_progress.is_empty() {
                    state = match self.cv.wait_timeout(state, Duration::from_millis(750)) {
                        Ok((state, timeout)) if timeout.timed_out() && state.queue.is_empty() && state.in_progress.is_empty() => break,
                        Ok((state, _)) => state,
                        Err(_) => return,
                    };
                    continue;
                }
                state = match self.cv.wait_timeout(state, Duration::from_millis(250)) {
                    Ok((state, _)) => state,
                    Err(_) => return,
                };
            }
        }
    }

    fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.shutdown = true;
        }
        self.cv.notify_all();
    }
}

static ACTIVE_JOBS: OnceLock<Mutex<HashMap<String, Arc<ThumbnailJobController>>>> = OnceLock::new();
static SPRITE_MEMORY_CACHE: OnceLock<Mutex<SpriteMemoryCache>> = OnceLock::new();
static THUMBNAIL_DEBUG_STATE: OnceLock<Mutex<ThumbnailDebugState>> = OnceLock::new();

fn active_jobs() -> &'static Mutex<HashMap<String, Arc<ThumbnailJobController>>> {
    ACTIVE_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sprite_memory_cache() -> &'static Mutex<SpriteMemoryCache> {
    SPRITE_MEMORY_CACHE.get_or_init(|| Mutex::new(SpriteMemoryCache::default()))
}

fn thumbnail_debug_state() -> &'static Mutex<ThumbnailDebugState> {
    THUMBNAIL_DEBUG_STATE.get_or_init(|| Mutex::new(ThumbnailDebugState::default()))
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailDebugState {
    pub active: bool,
    pub cache_key: Option<String>,
    pub cache_path: Option<String>,
    pub output_dir: Option<String>,
    pub current_stage: String,
    pub current_ffmpeg_status: String,
    pub current_thumbnail_index: Option<u32>,
    pub generated_thumbnails: u32,
    pub sprite_count: u32,
    pub last_ffmpeg_command: Option<String>,
    pub last_ffmpeg_stderr: Option<String>,
    pub last_ffmpeg_exit_code: Option<String>,
    pub last_ffmpeg_duration_ms: Option<u128>,
    pub generation_started_at_ms: Option<u128>,
    pub elapsed_ms: Option<u128>,
    pub last_output_path: Option<String>,
    pub last_output_exists: bool,
    pub last_output_size: Option<u64>,
    pub last_image_dimensions: Option<String>,
    pub stream_seekable: Option<bool>,
    pub network_wait_suspected: bool,
    pub time_to_first_thumbnail_ms: Option<u128>,
    pub average_thumbnail_generation_ms: Option<u128>,
    pub cache_hits: u32,
    pub cache_misses: u32,
    pub failed_seeks: u32,
    pub last_event: Option<String>,
    pub events: Vec<ThumbnailDebugEvent>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailDebugEvent {
    pub at_ms: u128,
    pub elapsed_ms: Option<u128>,
    pub stage: String,
    pub message: String,
}

pub fn get_thumbnail_debug_state() -> ThumbnailDebugState {
    let mut state = thumbnail_debug_state()
        .lock()
        .map(|state| state.clone())
        .unwrap_or_default();
    if let Some(started_at) = state.generation_started_at_ms {
        state.elapsed_ms = Some(now_ms().saturating_sub(started_at));
    }
    state
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn debug_reset(cache_key: &str, cache_dir: &Path) {
    if let Ok(mut state) = thumbnail_debug_state().lock() {
        let started_at = now_ms();
        *state = ThumbnailDebugState {
            active: true,
            cache_key: Some(cache_key.to_string()),
            cache_path: Some(cache_dir.to_string_lossy().to_string()),
            output_dir: Some(cache_dir.to_string_lossy().to_string()),
            current_stage: "generation-start".to_string(),
            current_ffmpeg_status: "idle".to_string(),
            generation_started_at_ms: Some(started_at),
            elapsed_ms: Some(0),
            last_event: Some("Thumbnail generation start".to_string()),
            ..ThumbnailDebugState::default()
        };
        state.events.push(ThumbnailDebugEvent {
            at_ms: started_at,
            elapsed_ms: Some(0),
            stage: "generation-start".to_string(),
            message: format!("cache={} path={}", cache_key, cache_dir.display()),
        });
    }
    crate::commands::player_debug_log(format!(
        "[THUMBNAILS][generation-start] cache={} path={}",
        cache_key,
        cache_dir.display()
    ));
}

fn debug_event(stage: &str, message: impl Into<String>) {
    let message = message.into();
    if let Ok(mut state) = thumbnail_debug_state().lock() {
        let at_ms = now_ms();
        let elapsed_ms = state
            .generation_started_at_ms
            .map(|started| at_ms.saturating_sub(started));
        state.current_stage = stage.to_string();
        state.elapsed_ms = elapsed_ms;
        state.last_event = Some(message.clone());
        state.events.push(ThumbnailDebugEvent {
            at_ms,
            elapsed_ms,
            stage: stage.to_string(),
            message: message.clone(),
        });
        if state.events.len() > 200 {
            state.events.drain(..50);
        }
    }
    crate::commands::player_debug_log(format!("[THUMBNAILS][{}] {}", stage, message));
}

fn debug_update(mut update: impl FnMut(&mut ThumbnailDebugState)) {
    if let Ok(mut state) = thumbnail_debug_state().lock() {
        update(&mut state);
        if let Some(started_at) = state.generation_started_at_ms {
            state.elapsed_ms = Some(now_ms().saturating_sub(started_at));
        }
    }
}

fn update_speed_metrics(state: &ThumbnailJobState) {
    debug_update(|debug| {
        debug.time_to_first_thumbnail_ms = state.first_thumbnail_ms;
        debug.average_thumbnail_generation_ms = if state.generation_samples > 0 {
            Some(state.total_generation_ms / state.generation_samples as u128)
        } else {
            None
        };
        debug.cache_hits = state.cache_hits;
        debug.cache_misses = state.cache_misses;
        debug.failed_seeks = state.failed_seeks;
    });
}

pub fn start_thumbnail_generation(
    app: tauri::AppHandle,
    request: ThumbnailStartRequest,
) -> Result<Option<ThumbnailMetadata>, String> {
    validate_request(&request)?;
    let cache_key = sanitize_cache_key(&request.cache_key);
    let cache_dir = thumbnail_cache_dir(&app, &cache_key)?;
    fs::create_dir_all(&cache_dir).map_err(|e| format!("create thumbnail cache: {e}"))?;
    debug_reset(&cache_key, &cache_dir);
    let job_request = ThumbnailStartRequest {
        cache_key: cache_key.clone(),
        ..request
    };
    let config = thumbnail_config(&job_request);
    let (pass_dir, frame_dir, sprite_dir) = pass_paths(&cache_dir, config.interval);
    fs::create_dir_all(&frame_dir).map_err(|e| format!("create thumbnail frame dir: {e}"))?;
    fs::create_dir_all(&sprite_dir).map_err(|e| format!("create thumbnail sprite dir: {e}"))?;
    debug_update(|state| {
        state.output_dir = Some(pass_dir.to_string_lossy().to_string());
    });

    if let Some(metadata) = read_metadata(&cache_dir) {
        if metadata.status == "ready" && metadata.interval == config.interval {
            debug_event(
                "cache-hit",
                format!(
                    "ready metadata loaded interval={} sprites={} thumbnails={}",
                    metadata.interval,
                    metadata.sprites.len(),
                    metadata.thumbnail_count
                ),
            );
            prefetch_first_sprites(&metadata);
            return Ok(Some(metadata));
        }
    }

    let existing_count = scan_generated_indices(&frame_dir)
        .iter()
        .copied()
        .max()
        .map(|index| index + 1)
        .unwrap_or(0);
    publish_metadata(
        &app,
        &job_request,
        &cache_dir,
        &frame_dir,
        &sprite_dir,
        config.interval,
        config.width,
        config.height,
        config.columns,
        config.rows,
        existing_count,
        if existing_count > 0 { "idle" } else { "empty" },
    );
    debug_update(|state| {
        state.active = false;
        state.current_stage = "cache-init".to_string();
        state.current_ffmpeg_status = "idle".to_string();
    });

    Ok(read_metadata(&cache_dir))
}

pub fn get_or_queue_scrub_thumbnail(
    app: tauri::AppHandle,
    request: ScrubThumbnailRequest,
) -> Result<ScrubThumbnailResponse, String> {
    if request.media_id.trim().is_empty() {
        return Err("scrub thumbnail mediaId is required".to_string());
    }
    if request.stream_url.trim().is_empty() {
        return Err("scrub thumbnail streamUrl is required".to_string());
    }
    if !request.time.is_finite() || request.time < 0.0 {
        return Err("scrub thumbnail time must be a positive finite value".to_string());
    }
    let cache_key = sanitize_cache_key(&request.media_id);
    let cache_dir = thumbnail_cache_dir(&app, &cache_key)?;
    fs::create_dir_all(&cache_dir).map_err(|e| format!("create thumbnail cache: {e}"))?;
    let job_request = ThumbnailStartRequest {
        stream_url: request.stream_url,
        cache_key: cache_key.clone(),
        duration: request.duration,
        fast_interval: None,
        refined_interval: None,
        thumbnail_width: request.thumbnail_width,
        thumbnail_height: request.thumbnail_height,
        columns: Some(DEFAULT_COLUMNS),
        rows: Some(DEFAULT_ROWS),
        quality: request.quality,
        thumbnail_interval: request.thumbnail_interval,
        max_concurrent_ffmpeg_workers: request.max_concurrent_ffmpeg_workers.map(|value| value.clamp(1, 2)),
    };
    let config = thumbnail_config(&job_request);
    let (_pass_dir, frame_dir, sprite_dir) = pass_paths(&cache_dir, config.interval);
    fs::create_dir_all(&frame_dir).map_err(|e| format!("create thumbnail frame dir: {e}"))?;
    fs::create_dir_all(&sprite_dir).map_err(|e| format!("create thumbnail sprite dir: {e}"))?;

    let requested_index = index_for_time(&config, request.time);
    let exact_path = frame_dir.join(format!("frame_{requested_index:05}.webp"));
    let exact = valid_thumbnail_path(&exact_path, config.width, config.height);
    let nearest = exact.clone().map(|path| (requested_index, path)).or_else(|| {
        find_nearest_thumbnail(&frame_dir, requested_index, config.max_count, config.width, config.height)
    });

    if exact.is_none() {
        let (controller, should_spawn) = {
            let mut jobs = active_jobs().lock().map_err(|e| e.to_string())?;
            if let Some(controller) = jobs.get(&cache_key) {
                (Arc::clone(controller), false)
            } else {
                let existing = scan_generated_indices(&frame_dir);
                let controller = Arc::new(ThumbnailJobController::new(existing));
                jobs.insert(cache_key.clone(), Arc::clone(&controller));
                (controller, true)
            }
        };
        enqueue_index(&controller, &config, requested_index, 0, "scrub-exact");
        debug_event(
            "scrub-request",
            format!(
                "cache={} time={:.3}s index={} nearest={:?}",
                cache_key,
                request.time,
                requested_index,
                nearest.as_ref().map(|(index, _)| *index)
            ),
        );
        if should_spawn {
            debug_reset(&cache_key, &cache_dir);
            spawn_thumbnail_job(
                app.clone(),
                job_request.clone(),
                cache_dir.clone(),
                Arc::clone(&controller),
                config.clone(),
            );
        }
    }

    let status = if exact.is_some() {
        "ready"
    } else if nearest.is_some() {
        "nearest"
    } else {
        "generating"
    };
    let generated_count = scan_generated_indices(&frame_dir)
        .iter()
        .copied()
        .max()
        .map(|index| index + 1)
        .unwrap_or(0)
        .max(requested_index + 1);
    let metadata = build_metadata(
        &frame_dir,
        &sprite_dir,
        &job_request,
        config.interval,
        status,
        generated_count,
        config.width,
        config.height,
        config.columns,
        config.rows,
    );
    write_metadata(&cache_dir, &metadata);
    Ok(ScrubThumbnailResponse {
        cache_key,
        status: status.to_string(),
        requested_time: request.time,
        requested_index,
        exact_path: exact.map(|path| path.to_string_lossy().to_string()),
        nearest_path: nearest.as_ref().map(|(_, path)| path.to_string_lossy().to_string()),
        nearest_index: nearest.map(|(index, _)| index),
        metadata,
    })
}

pub fn get_thumbnail_metadata(
    app: tauri::AppHandle,
    cache_key: String,
) -> Result<Option<ThumbnailMetadata>, String> {
    let cache_dir = thumbnail_cache_dir(&app, &sanitize_cache_key(&cache_key))?;
    Ok(read_metadata(&cache_dir))
}

pub fn prefetch_thumbnail_sprite(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(|e| format!("read sprite metadata: {e}"))?;
    if !metadata.is_file() {
        return Err("thumbnail sprite path is not a file".to_string());
    }
    if metadata.len() > 16 * 1024 * 1024 {
        return Err("thumbnail sprite is too large to prefetch".to_string());
    }
    debug_event(
        "sprite-prefetch",
        format!(
            "path={} exists=true size={} readable=true",
            path.display(),
            metadata.len()
        ),
    );

    let key = path.to_string_lossy().to_string();
    let data = fs::read(&path).map_err(|e| format!("read sprite: {e}"))?;
    let bytes = data.len() as u64;
    let mut cache = sprite_memory_cache().lock().map_err(|e| e.to_string())?;
    if let Some(entry) = cache.entries.remove(&key) {
        cache.bytes = cache.bytes.saturating_sub(entry.bytes);
        cache.order.retain(|item| item != &key);
    }
    cache.entries.insert(key.clone(), SpriteMemoryEntry { bytes, _data: data });
    cache.order.push_back(key);
    cache.bytes += bytes;

    while cache.bytes > SPRITE_CACHE_BUDGET_BYTES {
        let Some(old_key) = cache.order.pop_front() else { break };
        if let Some(entry) = cache.entries.remove(&old_key) {
            cache.bytes = cache.bytes.saturating_sub(entry.bytes);
        }
    }

    Ok(())
}

fn thumbnail_config(request: &ThumbnailStartRequest) -> ThumbnailJobConfig {
    let interval = clamp_interval(
        request
            .thumbnail_interval
            .or(request.refined_interval)
            .or(request.fast_interval)
            .unwrap_or(DEFAULT_REFINED_INTERVAL),
    );
    let duration = request.duration.filter(|value| value.is_finite() && *value > 0.0);
    let max_count = duration
        .map(|duration| ((duration / interval as f64).floor() as u32).saturating_add(1))
        .unwrap_or(10_000)
        .min(10_000);
    ThumbnailJobConfig {
        interval,
        width: request.thumbnail_width.unwrap_or(DEFAULT_WIDTH).clamp(120, 640),
        height: even_dimension(request.thumbnail_height.unwrap_or(DEFAULT_HEIGHT).clamp(68, 360)),
        columns: request.columns.unwrap_or(DEFAULT_COLUMNS).clamp(1, 20),
        rows: request.rows.unwrap_or(DEFAULT_ROWS).clamp(1, 20),
        quality: request.quality.unwrap_or(DEFAULT_QUALITY).clamp(1, 100),
        max_workers: request
            .max_concurrent_ffmpeg_workers
            .unwrap_or(DEFAULT_MAX_FFMPEG_WORKERS)
            .clamp(1, 2),
        duration,
        max_count,
    }
}

fn pass_paths(cache_dir: &Path, interval: u32) -> (PathBuf, PathBuf, PathBuf) {
    let pass_dir = cache_dir.join(format!("interval_{}", interval));
    let frame_dir = pass_dir.join("thumbs");
    let sprite_dir = pass_dir.join("sprites");
    (pass_dir, frame_dir, sprite_dir)
}

fn scan_generated_indices(frame_dir: &Path) -> HashSet<u32> {
    fs::read_dir(frame_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter_map(|entry| parse_frame_index(&entry.path()))
        .collect()
}

fn parse_frame_index(path: &Path) -> Option<u32> {
    let stem = path.file_stem()?.to_str()?;
    stem.strip_prefix("frame_")?.parse().ok()
}

fn enqueue_index(
    controller: &Arc<ThumbnailJobController>,
    config: &ThumbnailJobConfig,
    index: u32,
    priority: i32,
    reason: &'static str,
) {
    if index < config.max_count && controller.enqueue(index, priority, reason) {
        debug_event(
            "queue-enqueue",
            format!("index={} priority={} reason={}", index, priority, reason),
        );
    }
}

fn index_for_time(config: &ThumbnailJobConfig, time: f64) -> u32 {
    let index = (time.max(0.0) / config.interval as f64).floor() as u32;
    index.min(config.max_count.saturating_sub(1))
}

fn valid_thumbnail_path(path: &Path, width: u32, height: u32) -> Option<PathBuf> {
    if path.exists() && inspect_image(path, width, height).is_ok() {
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn find_nearest_thumbnail(
    frame_dir: &Path,
    requested_index: u32,
    max_count: u32,
    width: u32,
    height: u32,
) -> Option<(u32, PathBuf)> {
    let indices = scan_generated_indices(frame_dir);
    indices
        .into_iter()
        .filter(|index| *index < max_count)
        .min_by_key(|index| index.abs_diff(requested_index))
        .and_then(|index| {
            let path = frame_dir.join(format!("frame_{index:05}.webp"));
            valid_thumbnail_path(&path, width, height).map(|path| (index, path))
        })
}

fn spawn_thumbnail_job(
    app: tauri::AppHandle,
    job_request: ThumbnailStartRequest,
    cache_dir: PathBuf,
    controller: Arc<ThumbnailJobController>,
    config: ThumbnailJobConfig,
) {
    std::thread::spawn(move || {
        if let Err(error) = run_thumbnail_job(
            app.clone(),
            job_request.clone(),
            cache_dir.clone(),
            Arc::clone(&controller),
            config.clone(),
        ) {
            crate::commands::player_debug_log(format!(
                "[THUMBNAILS] scrub generation failed for {}: {}",
                job_request.cache_key, error
            ));
            let (_pass_dir, frame_dir, sprite_dir) = pass_paths(&cache_dir, config.interval);
            let metadata = build_metadata(
                &frame_dir,
                &sprite_dir,
                &job_request,
                config.interval,
                "error",
                controller.generated_count(),
                config.width,
                config.height,
                config.columns,
                config.rows,
            );
            write_metadata(&cache_dir, &metadata);
            let _ = app.emit("thumbnail-cache-updated", ThumbnailCacheUpdated { metadata });
        }
        if let Ok(mut jobs) = active_jobs().lock() {
            jobs.remove(&job_request.cache_key);
        }
        debug_update(|state| {
            state.active = false;
            state.current_ffmpeg_status = "idle".to_string();
        });
    });
}

fn run_thumbnail_job(
    app: tauri::AppHandle,
    request: ThumbnailStartRequest,
    cache_dir: PathBuf,
    controller: Arc<ThumbnailJobController>,
    config: ThumbnailJobConfig,
) -> Result<(), String> {
    let (pass_dir, frame_dir, sprite_dir) = pass_paths(&cache_dir, config.interval);
    fs::create_dir_all(&frame_dir).map_err(|e| format!("create thumbnail frame dir: {e}"))?;
    fs::create_dir_all(&sprite_dir).map_err(|e| format!("create thumbnail sprite dir: {e}"))?;
    debug_event(
        "queue-start",
        format!(
            "cache={} interval={} planned={} duration={:?} workers={} width={} quality={} frameDir={}",
            request.cache_key,
            config.interval,
            config.max_count,
            config.duration,
            config.max_workers,
            config.width,
            config.quality,
            frame_dir.display()
        ),
    );

    let mut workers = Vec::new();
    for worker_id in 0..config.max_workers {
        let app = app.clone();
        let request = request.clone();
        let cache_dir = cache_dir.clone();
        let frame_dir = frame_dir.clone();
        let sprite_dir = sprite_dir.clone();
        let controller = Arc::clone(&controller);
        let config = config.clone();
        workers.push(std::thread::spawn(move || {
            while let Some(task) = controller.pop() {
                let timestamp = task.index as f64 * config.interval as f64;
                let frame_path = frame_dir.join(format!("frame_{:05}.webp", task.index));
                debug_update(|state| {
                    state.current_thumbnail_index = Some(task.index);
                    state.current_stage = "frame-extract".to_string();
                });
                if frame_path.exists() {
                    match inspect_image(&frame_path, config.width, config.height) {
                        Ok(stats) => {
                            controller.mark_generated(task.index, 0);
                            debug_event(
                                "frame-cache-hit",
                                format!(
                                    "worker={} index={} time={:.3}s path={} size={} dims={}x{}",
                                    worker_id,
                                    task.index,
                                    timestamp,
                                    frame_path.display(),
                                    stats.bytes,
                                    stats.width,
                                    stats.height
                                ),
                            );
                            publish_metadata(
                                &app,
                                &request,
                                &cache_dir,
                                &frame_dir,
                                &sprite_dir,
                                config.interval,
                                config.width,
                                config.height,
                                config.columns,
                                config.rows,
                                controller.generated_count(),
                                "generating",
                            );
                            continue;
                        }
                        Err(error) => {
                            let _ = fs::remove_file(&frame_path);
                            debug_event(
                                "frame-cache-invalid",
                                format!("index={} path={} error={}", task.index, frame_path.display(), error),
                            );
                        }
                    }
                }

                let started = Instant::now();
                debug_event(
                    "frame-start",
                    format!(
                        "worker={} index={} time={:.3}s priority={} reason={}",
                        worker_id, task.index, timestamp, task.priority, task.reason
                    ),
                );
                match extract_frame(&request, timestamp, &frame_path, config.width, config.height, config.quality) {
                    Ok(frame_stats) => {
                        let duration_ms = started.elapsed().as_millis();
                        controller.mark_generated(task.index, duration_ms);
                        debug_update(|state| {
                            state.generated_thumbnails = state.generated_thumbnails.max(controller.generated_count());
                            state.last_output_path = Some(frame_path.to_string_lossy().to_string());
                            state.last_output_exists = frame_path.exists();
                            state.last_output_size = Some(frame_stats.bytes);
                            state.last_image_dimensions = Some(format!("{}x{}", frame_stats.width, frame_stats.height));
                        });
                        debug_event(
                            "frame-finished",
                            format!(
                                "worker={} index={} time={:.3}s path={} exists={} size={} dims={}x{} black={} durationMs={}",
                                worker_id,
                                task.index,
                                timestamp,
                                frame_path.display(),
                                frame_path.exists(),
                                frame_stats.bytes,
                                frame_stats.width,
                                frame_stats.height,
                                frame_stats.near_black,
                                duration_ms
                            ),
                        );
                        publish_metadata(
                            &app,
                            &request,
                            &cache_dir,
                            &frame_dir,
                            &sprite_dir,
                            config.interval,
                            config.width,
                            config.height,
                            config.columns,
                            config.rows,
                            controller.generated_count(),
                            "generating",
                        );
                    }
                    Err(error) => {
                        controller.mark_failed(task.index);
                        debug_event(
                            "frame-error",
                            format!(
                                "worker={} index={} time={:.3}s failedSeek=true error={}",
                                worker_id, task.index, timestamp, error
                            ),
                        );
                    }
                }
            }
        }));
    }

    controller.wait_until_idle();
    let contiguous_count = contiguous_generated_count(&frame_dir, config.max_count);
    if contiguous_count > 0 {
        publish_sprites(
            &app,
            &request,
            &cache_dir,
            &frame_dir,
            &sprite_dir,
            config.interval,
            config.width,
            config.height,
            config.columns,
            config.rows,
            config.quality,
            contiguous_count,
            "idle",
        )?;
    } else {
        publish_metadata(
            &app,
            &request,
            &cache_dir,
            &frame_dir,
            &sprite_dir,
            config.interval,
            config.width,
            config.height,
            config.columns,
            config.rows,
            controller.generated_count(),
            "idle",
        );
    }
    debug_event(
        "queue-finished",
        format!(
            "cache={} generated={} contiguous={} passDir={}",
            request.cache_key,
            controller.generated_count(),
            contiguous_count,
            pass_dir.display()
        ),
    );
    controller.shutdown();
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

fn even_dimension(value: u32) -> u32 {
    if value % 2 == 0 {
        value
    } else {
        value + 1
    }
}

fn extract_frame(
    request: &ThumbnailStartRequest,
    timestamp: f64,
    output_path: &Path,
    width: u32,
    height: u32,
    quality: u32,
) -> Result<ImageStats, String> {
    let ffmpeg = find_ffmpeg();
    let filter = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    );
    let mut command = Command::new(&ffmpeg);
    command
        .arg("-y")
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error");
    if timestamp > 0.0 {
        command.arg("-ss").arg(format!("{timestamp:.3}"));
    }
    if is_remote_http(&request.stream_url) {
        command
            .arg("-seekable")
            .arg("1")
            .arg("-rw_timeout")
            .arg("15000000")
            .arg("-probesize")
            .arg("1000000")
            .arg("-analyzeduration")
            .arg("1000000");
    }
    command
        .arg("-i")
        .arg(&request.stream_url)
        .arg("-frames:v")
        .arg("1")
        .arg("-an")
        .arg("-sn")
        .arg("-vf")
        .arg(filter)
        .arg("-threads")
        .arg("1")
        .arg("-quality")
        .arg(quality.to_string())
        .arg(output_path.to_string_lossy().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let output = run_ffmpeg_logged(
        command,
        "frame-extract",
        Some(output_path),
        Some(timestamp),
    )?;
    if !output.status.success() {
        let stderr = output.stderr.trim().to_string();
        return Err(format!(
            "ffmpeg frame seek exit={} stderr={}",
            output.status,
            if stderr.is_empty() { "<empty>" } else { &stderr }
        ));
    }
    inspect_image(output_path, width, height)
}

struct LoggedCommandOutput {
    status: ExitStatus,
    stderr: String,
    duration_ms: u128,
}

fn run_ffmpeg_logged(
    mut command: Command,
    stage: &str,
    output_path: Option<&Path>,
    timestamp: Option<f64>,
) -> Result<LoggedCommandOutput, String> {
    let command_line = command_to_string(&command);
    let started = Instant::now();
    debug_update(|state| {
        state.current_stage = stage.to_string();
        state.current_ffmpeg_status = "spawning".to_string();
        state.last_ffmpeg_command = Some(command_line.clone());
        state.last_ffmpeg_stderr = None;
        state.last_ffmpeg_exit_code = None;
        state.last_ffmpeg_duration_ms = None;
        state.last_output_path = output_path.map(|path| path.to_string_lossy().to_string());
        state.last_output_exists = output_path.map(Path::exists).unwrap_or(false);
        state.last_output_size = output_path
            .and_then(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len());
    });
    debug_event(
        "ffmpeg-spawn",
        format!(
            "stage={} timestamp={:?} command={}",
            stage, timestamp, command_line
        ),
    );

    let mut child = command
        .spawn()
        .map_err(|e| format!("spawn ffmpeg stage={} command={} error={}", stage, command_line, e))?;

    let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_reader = child.stderr.take().map(|mut stderr_pipe| {
        let stderr_buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let mut local = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut local);
            if let Ok(mut shared) = stderr_buf.lock() {
                shared.extend_from_slice(&local);
            }
        })
    });
    let mut warned_three_seconds = false;
    let mut last_stderr_len = 0usize;

    loop {
        if let Ok(shared) = stderr_buf.lock() {
            if shared.len() != last_stderr_len {
                last_stderr_len = shared.len();
                let stderr_text = String::from_utf8_lossy(&shared).to_string();
                debug_update(|state| {
                    state.last_ffmpeg_stderr = Some(trim_debug_text(&stderr_text));
                });
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if let Some(reader) = stderr_reader {
                    let _ = reader.join();
                }
                let duration_ms = started.elapsed().as_millis();
                let stderr_text = stderr_buf
                    .lock()
                    .map(|buf| String::from_utf8_lossy(&buf).to_string())
                    .unwrap_or_default();
                let output_exists = output_path.map(Path::exists).unwrap_or(false);
                let output_size = output_path
                    .and_then(|path| fs::metadata(path).ok())
                    .map(|metadata| metadata.len());
                debug_update(|state| {
                    state.current_ffmpeg_status = "finished".to_string();
                    state.last_ffmpeg_exit_code = Some(status.to_string());
                    state.last_ffmpeg_duration_ms = Some(duration_ms);
                    state.last_ffmpeg_stderr = Some(trim_debug_text(&stderr_text));
                    state.last_output_exists = output_exists;
                    state.last_output_size = output_size;
                    if !status.success() {
                        if let Some(seekable) = classify_seekability(&stderr_text) {
                            state.stream_seekable = Some(seekable);
                        }
                    }
                });
                debug_event(
                    "ffmpeg-exit",
                    format!(
                        "stage={} exit={} durationMs={} output={} exists={} size={:?} stderr={}",
                        stage,
                        status,
                        duration_ms,
                        output_path
                            .map(|path| path.display().to_string())
                            .unwrap_or_else(|| "<none>".to_string()),
                        output_exists,
                        output_size,
                        trim_debug_text(&stderr_text)
                    ),
                );
                return Ok(LoggedCommandOutput {
                    status,
                    stderr: stderr_text,
                    duration_ms,
                });
            }
            Ok(None) => {
                let elapsed = started.elapsed();
                if elapsed >= Duration::from_secs(3) && !warned_three_seconds {
                    warned_three_seconds = true;
                    let stderr_text = stderr_buf
                        .lock()
                        .map(|buf| String::from_utf8_lossy(&buf).to_string())
                        .unwrap_or_default();
                    let waiting_reason = infer_waiting_reason(&stderr_text, output_path);
                    debug_update(|state| {
                        state.current_ffmpeg_status = "running >3s".to_string();
                        state.network_wait_suspected = waiting_reason.contains("network");
                    });
                    debug_event(
                        "ffmpeg-slow",
                        format!(
                            "stage={} runningMs={} reason={} output={} exists={} stderrBytes={} stderr={}",
                            stage,
                            elapsed.as_millis(),
                            waiting_reason,
                            output_path
                                .map(|path| path.display().to_string())
                                .unwrap_or_else(|| "<none>".to_string()),
                            output_path.map(Path::exists).unwrap_or(false),
                            last_stderr_len,
                            trim_debug_text(&stderr_text)
                        ),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(format!("wait ffmpeg stage={} error={}", stage, error));
            }
        }
    }
}

fn command_to_string(command: &Command) -> String {
    let mut parts = vec![command.get_program().to_string_lossy().to_string()];
    parts.extend(command.get_args().map(|arg| {
        let value = arg.to_string_lossy();
        if value.contains(' ') {
            format!("\"{}\"", value)
        } else {
            value.to_string()
        }
    }));
    parts.join(" ")
}

fn trim_debug_text(value: &str) -> String {
    let value = value.trim();
    if value.len() > 2000 {
        format!("{}...<truncated {} chars>", &value[..2000], value.len() - 2000)
    } else {
        value.to_string()
    }
}

fn classify_seekability(stderr: &str) -> Option<bool> {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("seek")
        && (lower.contains("not seekable")
            || lower.contains("could not seek")
            || lower.contains("operation not permitted")
            || lower.contains("http error 416"))
    {
        return Some(false);
    }
    if lower.contains("byte seek") || lower.contains("range") {
        return Some(true);
    }
    None
}

fn infer_waiting_reason(stderr: &str, output_path: Option<&Path>) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("http")
        || lower.contains("tcp")
        || lower.contains("tls")
        || lower.contains("connection")
        || lower.contains("timeout")
        || lower.contains("range")
    {
        return "likely waiting on network I/O or remote stream probe".to_string();
    }
    if output_path.map(Path::exists).unwrap_or(false) {
        return "ffmpeg still running after output file appeared; likely encoder/finalization wait".to_string();
    }
    if stderr.trim().is_empty() {
        return "no stderr and no output yet; likely waiting on network probe, demuxer open, or first keyframe decode".to_string();
    }
    "ffmpeg still running; see stderr for demux/decode details".to_string()
}

fn is_remote_http(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn publish_sprites(
    app: &tauri::AppHandle,
    request: &ThumbnailStartRequest,
    cache_dir: &Path,
    frame_dir: &Path,
    sprite_dir: &Path,
    interval: u32,
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    quality: u32,
    thumbnail_count: u32,
    status: &str,
) -> Result<(), String> {
    let cells_per_sprite = columns * rows;
    let sprite_count = (thumbnail_count + cells_per_sprite - 1) / cells_per_sprite;
    for sprite_index in 0..sprite_count {
        let start = sprite_index * cells_per_sprite;
        let count = (thumbnail_count - start).min(cells_per_sprite);
        build_sprite(frame_dir, sprite_dir, sprite_index, start, count, columns, rows, width, height, quality)?;
    }

    publish_metadata(
        app,
        request,
        cache_dir,
        frame_dir,
        sprite_dir,
        interval,
        width,
        height,
        columns,
        rows,
        thumbnail_count,
        status,
    );
    Ok(())
}

fn publish_metadata(
    app: &tauri::AppHandle,
    request: &ThumbnailStartRequest,
    cache_dir: &Path,
    thumbnail_dir: &Path,
    sprite_dir: &Path,
    interval: u32,
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    thumbnail_count: u32,
    status: &str,
) {
    let metadata = build_metadata(
        thumbnail_dir,
        sprite_dir,
        request,
        interval,
        status,
        thumbnail_count,
        width,
        height,
        columns,
        rows,
    );
    write_metadata(cache_dir, &metadata);
    prefetch_first_sprites(&metadata);
    let _ = app.emit("thumbnail-cache-updated", ThumbnailCacheUpdated { metadata });
}

fn build_sprite(
    frame_dir: &Path,
    sprite_dir: &Path,
    sprite_index: u32,
    start: u32,
    count: u32,
    columns: u32,
    rows: u32,
    width: u32,
    height: u32,
    quality: u32,
) -> Result<(), String> {
    let ffmpeg = find_ffmpeg();
    let frame_pattern = frame_dir.join("frame_%05d.webp");
    let tmp_sprite = sprite_dir.join(format!("sprite_{sprite_index:05}.tmp.webp"));
    let sprite = sprite_dir.join(format!("sprite_{sprite_index:05}.webp"));
    let filter = format!("tile={}x{}:padding=0:margin=0", columns, rows);
    debug_event(
        "sprite-build-start",
        format!(
            "index={} startFrame={} tileCount={} output={}",
            sprite_index,
            start,
            count,
            sprite.display()
        ),
    );
    let mut command = Command::new(&ffmpeg);
    command.arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-framerate")
        .arg("1")
        .arg("-start_number")
        .arg(start.to_string())
        .arg("-i")
        .arg(frame_pattern.to_string_lossy().to_string())
        .arg("-frames:v")
        .arg(count.to_string())
        .arg("-vf")
        .arg(filter)
        .arg("-quality")
        .arg(quality.to_string())
        .arg(tmp_sprite.to_string_lossy().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let output = run_ffmpeg_logged(command, "sprite-build", Some(&tmp_sprite), None)?;
    if !output.status.success() {
        let stderr = output.stderr.trim().to_string();
        return Err(format!(
            "ffmpeg sprite build index={} exit={} stderr={}",
            sprite_index,
            output.status,
            if stderr.is_empty() { "<empty>" } else { &stderr }
        ));
    }

    fs::rename(&tmp_sprite, &sprite).map_err(|e| format!("publish sprite {}: {e}", sprite.display()))?;
    let stats = inspect_image(&sprite, width * columns, height * rows)?;
    debug_update(|state| {
        state.sprite_count = state.sprite_count.max(sprite_index + 1);
        state.last_output_path = Some(sprite.to_string_lossy().to_string());
        state.last_output_exists = sprite.exists();
        state.last_output_size = Some(stats.bytes);
        state.last_image_dimensions = Some(format!("{}x{}", stats.width, stats.height));
    });
    debug_event(
        "sprite-build-finish",
        format!(
            "index={} path={} exists=true size={} dims={}x{} tiles={} black={} durationMs={}",
            sprite_index,
            sprite.display(),
            stats.bytes,
            stats.width,
            stats.height,
            count,
            stats.near_black,
            output.duration_ms
        ),
    );
    Ok(())
}

fn build_metadata(
    thumbnail_dir: &Path,
    sprite_dir: &Path,
    request: &ThumbnailStartRequest,
    interval: u32,
    status: &str,
    thumbnail_count: u32,
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
) -> ThumbnailMetadata {
    let mut indexed_thumbnails = fs::read_dir(thumbnail_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("webp"))
        .filter_map(|path| parse_frame_index(&path).map(|index| (index, path)))
        .collect::<Vec<_>>();
    indexed_thumbnails.sort_by_key(|(index, _)| *index);
    let highest_index = indexed_thumbnails
        .iter()
        .map(|(index, _)| *index)
        .max()
        .map(|index| index + 1)
        .unwrap_or(0);
    let sparse_thumbnail_count = thumbnail_count.max(highest_index);
    let mut thumbnail_paths = vec![String::new(); sparse_thumbnail_count as usize];
    for (index, path) in indexed_thumbnails {
        if let Some(slot) = thumbnail_paths.get_mut(index as usize) {
            *slot = path.to_string_lossy().to_string();
        }
    }

    let mut sprites = fs::read_dir(sprite_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("webp"))
        .collect::<Vec<_>>();
    sprites.sort();

    ThumbnailMetadata {
        cache_key: request.cache_key.clone(),
        interval,
        thumbnail_width: width,
        thumbnail_height: height,
        columns,
        rows,
        duration: request.duration.filter(|value| value.is_finite() && *value > 0.0),
        thumbnail_paths,
        sprite_thumbnail_counts: sprite_counts(thumbnail_count, columns * rows),
        thumbnail_count: sparse_thumbnail_count,
        sprites: sprites
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        status: status.to_string(),
    }
}

fn sprite_counts(thumbnail_count: u32, cells_per_sprite: u32) -> Vec<u32> {
    if cells_per_sprite == 0 {
        return Vec::new();
    }
    let sprite_count = (thumbnail_count + cells_per_sprite - 1) / cells_per_sprite;
    (0..sprite_count)
        .map(|index| {
            let start = index * cells_per_sprite;
            (thumbnail_count - start).min(cells_per_sprite)
        })
        .collect()
}

fn contiguous_generated_count(frame_dir: &Path, max_count: u32) -> u32 {
    let mut count = 0;
    for index in 0..max_count {
        let path = frame_dir.join(format!("frame_{index:05}.webp"));
        if path.exists() {
            count += 1;
        } else {
            break;
        }
    }
    count
}

struct ImageStats {
    bytes: u64,
    width: u32,
    height: u32,
    near_black: bool,
}

fn inspect_image(path: &Path, expected_width: u32, expected_height: u32) -> Result<ImageStats, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("inspect {}: {e}", path.display()))?;
    if metadata.len() < 64 {
        return Err(format!("{} is too small to be a valid WebP ({})", path.display(), metadata.len()));
    }
    let bytes = fs::read(path).map_err(|e| format!("read image header {}: {e}", path.display()))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(format!("{} is not a RIFF WEBP image", path.display()));
    }

    let (width, height) = probe_dimensions(path).unwrap_or((expected_width, expected_height));
    if width != expected_width || height != expected_height {
        return Err(format!(
            "{} has dimensions {}x{}, expected {}x{}",
            path.display(),
            width,
            height,
            expected_width,
            expected_height
        ));
    }

    let near_black = image_is_near_black(path, width, height).unwrap_or(false);
    Ok(ImageStats {
        bytes: metadata.len(),
        width,
        height,
        near_black,
    })
}

fn probe_dimensions(path: &Path) -> Option<(u32, u32)> {
    let output = Command::new("ffprobe")
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("v:0")
        .arg("-show_entries")
        .arg("stream=width,height")
        .arg("-of")
        .arg("csv=s=x:p=0")
        .arg(path.to_string_lossy().to_string())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.trim().split('x');
    let width = parts.next()?.parse().ok()?;
    let height = parts.next()?.parse().ok()?;
    Some((width, height))
}

fn image_is_near_black(path: &Path, width: u32, height: u32) -> Option<bool> {
    let sample_width = width.min(64);
    let sample_height = height.min(64);
    let output = Command::new(&find_ffmpeg())
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(path.to_string_lossy().to_string())
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg(format!("scale={}x{}", sample_width, sample_height))
        .arg("-f")
        .arg("rawvideo")
        .arg("-pix_fmt")
        .arg("rgb24")
        .arg("-")
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    let pixels = output.stdout.chunks_exact(3);
    let mut total = 0u64;
    let mut count = 0u64;
    for pixel in pixels {
        total += pixel[0] as u64 + pixel[1] as u64 + pixel[2] as u64;
        count += 3;
    }
    if count == 0 {
        return None;
    }
    Some((total as f64 / count as f64) < 4.0)
}

fn read_metadata(cache_dir: &Path) -> Option<ThumbnailMetadata> {
    let path = cache_dir.join("metadata.json");
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_metadata(cache_dir: &Path, metadata: &ThumbnailMetadata) {
    let started = Instant::now();
    if let Ok(text) = serde_json::to_string_pretty(metadata) {
        let path = cache_dir.join("metadata.json");
        match fs::write(&path, text) {
            Ok(()) => {
                let size = fs::metadata(&path).map(|metadata| metadata.len()).ok();
                debug_event(
                    "metadata-write",
                    format!(
                        "path={} status={} interval={} sprites={} thumbnails={} durationMs={} size={:?}",
                        path.display(),
                        metadata.status,
                        metadata.interval,
                        metadata.sprites.len(),
                        metadata.thumbnail_count,
                        started.elapsed().as_millis(),
                        size
                    ),
                );
            }
            Err(error) => {
                debug_event(
                    "metadata-write-error",
                    format!("path={} error={}", path.display(), error),
                );
            }
        }
    } else {
        debug_event("metadata-serialize-error", "failed to serialize thumbnail metadata");
    }
}

fn prefetch_first_sprites(metadata: &ThumbnailMetadata) {
    for sprite in metadata.sprites.iter().take(2) {
        let _ = prefetch_thumbnail_sprite(sprite.clone());
    }
}

fn thumbnail_cache_dir(app: &tauri::AppHandle, cache_key: &str) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    Ok(app_dir.join("ThumbnailCache").join(cache_key))
}

fn validate_request(request: &ThumbnailStartRequest) -> Result<(), String> {
    if request.stream_url.trim().is_empty() {
        return Err("thumbnail stream URL is required".to_string());
    }
    if request.cache_key.trim().is_empty() {
        return Err("thumbnail cache key is required".to_string());
    }
    Ok(())
}

fn sanitize_cache_key(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    sanitized.truncate(96);
    if sanitized.trim_matches('_').is_empty() {
        stable_hash(value)
    } else {
        sanitized
    }
}

fn stable_hash(value: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn clamp_interval(value: u32) -> u32 {
    value.clamp(2, 300)
}

fn find_ffmpeg() -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ffmpeg.exe"));
            candidates.push(dir.join("ffmpeg"));
            candidates.push(dir.join("binaries").join("ffmpeg.exe"));
            candidates.push(dir.join("binaries").join("ffmpeg"));
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("ffmpeg.exe"),
    );
    candidates.push(
        PathBuf::from("src-tauri")
            .join("binaries")
            .join("ffmpeg.exe"),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}
