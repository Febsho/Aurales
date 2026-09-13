use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const SEEKR_API: &str = "https://api.seekr.tv/sprites";
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1_200);
// Sprite URLs are signed. Keep a successful lookup only for the active
// playback (or a short interrupted-resume window), never as a disk cache.
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekrPreviewRequest {
    pub duration: f64,
    pub tmdb_id: Option<u64>,
    pub imdb_id: Option<String>,
    pub show_tmdb_id: Option<u64>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekrPreviewData {
    pub scale: f64,
    pub cues: Vec<SeekrCue>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekrCue {
    pub start: f64,
    pub end: f64,
    pub sprite_url: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
struct LookupResponse {
    vtt_url: String,
    #[serde(default)]
    scale: f64,
}

struct CachedPreview {
    preview: SeekrPreviewData,
    cached_at: Instant,
}

static PREVIEW_CACHE: OnceLock<Mutex<HashMap<String, CachedPreview>>> = OnceLock::new();

fn preview_cache() -> &'static Mutex<HashMap<String, CachedPreview>> {
    PREVIEW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// This intentionally excludes duration: Seekr's VTT belongs to the media
/// identity, while duration can settle slightly after mpv starts.
fn cache_key(request: &SeekrPreviewRequest) -> Option<String> {
    if let (Some(show_tmdb_id), Some(season), Some(episode)) =
        (request.show_tmdb_id, request.season, request.episode)
    {
        return Some(format!("episode:{show_tmdb_id}:{season}:{episode}"));
    }
    if let Some(tmdb_id) = request.tmdb_id {
        return Some(format!("movie:tmdb:{tmdb_id}"));
    }
    request
        .imdb_id
        .as_deref()
        .filter(|id| id.starts_with("tt"))
        .map(|id| format!("movie:imdb:{}", id.to_ascii_lowercase()))
}

fn cache_keys(request: &SeekrPreviewRequest) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(primary) = cache_key(request) {
        keys.push(primary);
    }
    // A movie can start its optional lookup with IMDb and gain a TMDB ID a
    // moment later. Evict both aliases at EOF so an interrupted lookup never
    // lingers after the title has finished.
    if request.show_tmdb_id.is_none() {
        if let Some(imdb_id) = request.imdb_id.as_deref().filter(|id| id.starts_with("tt")) {
            let imdb_key = format!("movie:imdb:{}", imdb_id.to_ascii_lowercase());
            if !keys.contains(&imdb_key) {
                keys.push(imdb_key);
            }
        }
    }
    keys
}

/// Resolve the key only in native code. The compile-time value supports signed
/// release builds; the process value and a local `.env` support development.
fn api_key() -> Option<String> {
    if let Ok(value) = std::env::var("SEEKR_API_KEY") {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }
    // `tauri dev` starts the native binary from `src-tauri`, while Vite and
    // developers keep the shared local configuration at the repository root.
    // Packaged builds use the compile-time/realtime environment path above.
    let local_env = fs::read_to_string(".env").or_else(|_| fs::read_to_string("../.env"));
    if let Ok(contents) = local_env {
        for line in contents.lines() {
            if let Some(value) = line.trim().strip_prefix("SEEKR_API_KEY=") {
                let value = value.trim().trim_matches(['\'', '"']);
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    option_env!("SEEKR_API_KEY")
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

pub fn get_preview(request: SeekrPreviewRequest) -> Option<SeekrPreviewData> {
    if !request.duration.is_finite() || request.duration <= 0.0 {
        return None;
    }

    let cache_key = cache_key(&request)?;
    if let Ok(mut cache) = preview_cache().lock() {
        cache.retain(|_, entry| entry.cached_at.elapsed() < CACHE_TTL);
        if let Some(entry) = cache.get(&cache_key) {
            return Some(entry.preview.clone());
        }
    }

    let key = api_key()?;

    let mut query = vec![(
        "duration_ms",
        (request.duration * 1000.0).round().max(1.0).to_string(),
    )];
    if let (Some(show_tmdb_id), Some(season), Some(episode)) =
        (request.show_tmdb_id, request.season, request.episode)
    {
        query.extend([
            ("show_tmdb_id", show_tmdb_id.to_string()),
            ("season", season.to_string()),
            ("episode", episode.to_string()),
        ]);
    } else if let Some(tmdb_id) = request.tmdb_id {
        query.push(("tmdb_id", tmdb_id.to_string()));
    } else if let Some(imdb_id) = request.imdb_id.filter(|id| id.starts_with("tt")) {
        query.push(("imdb_id", imdb_id));
    } else {
        return None;
    }

    let agent = ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).build();
    let lookup = agent
        .get(SEEKR_API)
        .query_pairs(query.iter().map(|(key, value)| (*key, value.as_str())))
        .set("X-API-Key", &key)
        .call()
        .ok()?;
    let lookup: LookupResponse = lookup.into_json().ok()?;
    if lookup.vtt_url.is_empty() {
        return None;
    }
    let vtt = agent.get(&lookup.vtt_url).call().ok()?.into_string().ok()?;
    let cues = parse_vtt(&vtt);
    let preview = (!cues.is_empty()).then_some(SeekrPreviewData {
        scale: if lookup.scale > 0.0 {
            lookup.scale
        } else {
            1.0
        },
        cues,
    })?;
    if let Ok(mut cache) = preview_cache().lock() {
        cache.insert(
            cache_key,
            CachedPreview {
                preview: preview.clone(),
                cached_at: Instant::now(),
            },
        );
    }
    Some(preview)
}

/// Remove an active playback's signed sprite metadata after it reaches EOF.
/// The renderer never receives credentials, only its own media identity.
pub fn clear_preview(request: SeekrPreviewRequest) {
    let cache_keys = cache_keys(&request);
    if !cache_keys.is_empty() {
        if let Ok(mut cache) = preview_cache().lock() {
            for cache_key in cache_keys {
                cache.remove(&cache_key);
            }
        }
    }
}

fn parse_vtt(vtt: &str) -> Vec<SeekrCue> {
    let mut cues = Vec::new();
    let lines: Vec<_> = vtt.lines().map(str::trim).collect();
    let mut index = 0;
    while index < lines.len() {
        let Some((start, end)) = lines[index].split_once("-->").and_then(|(start, end)| {
            Some((
                parse_timestamp(start.trim())?,
                parse_timestamp(end.split_whitespace().next()?.trim())?,
            ))
        }) else {
            index += 1;
            continue;
        };
        index += 1;
        let Some(payload) = lines.get(index).filter(|line| !line.is_empty()) else {
            continue;
        };
        if let Some((sprite_url, xywh)) = payload.rsplit_once("#xywh=") {
            let values: Vec<_> = xywh
                .split(',')
                .filter_map(|value| value.parse::<u32>().ok())
                .collect();
            if values.len() == 4 && sprite_url.starts_with("https://") {
                cues.push(SeekrCue {
                    start,
                    end,
                    sprite_url: sprite_url.to_string(),
                    x: values[0],
                    y: values[1],
                    width: values[2],
                    height: values[3],
                });
            }
        }
        index += 1;
    }
    cues
}

fn parse_timestamp(value: &str) -> Option<f64> {
    let parts: Vec<_> = value.split(':').collect();
    let seconds = parts.last()?.parse::<f64>().ok()?;
    match parts.len() {
        2 => Some(parts[0].parse::<f64>().ok()? * 60.0 + seconds),
        3 => Some(
            parts[0].parse::<f64>().ok()? * 3600.0 + parts[1].parse::<f64>().ok()? * 60.0 + seconds,
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_signed_sprite_cues() {
        let cues = parse_vtt("WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nhttps://sprites.seekr.tv/sheet.jpg?sig=ok#xywh=0,180,320,180\n");
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].y, 180);
    }

    #[test]
    fn cache_key_is_stable_when_duration_settles() {
        let first = SeekrPreviewRequest {
            duration: 1200.1,
            tmdb_id: Some(42),
            imdb_id: None,
            show_tmdb_id: None,
            season: None,
            episode: None,
        };
        let settled = SeekrPreviewRequest {
            duration: 1200.9,
            tmdb_id: Some(42),
            imdb_id: None,
            show_tmdb_id: None,
            season: None,
            episode: None,
        };
        assert_eq!(cache_key(&first), cache_key(&settled));
    }

    #[test]
    fn cache_eviction_covers_movie_id_aliases() {
        let request = SeekrPreviewRequest {
            duration: 1200.0,
            tmdb_id: Some(42),
            imdb_id: Some("tt123".into()),
            show_tmdb_id: None,
            season: None,
            episode: None,
        };
        assert_eq!(
            cache_keys(&request),
            vec!["movie:tmdb:42", "movie:imdb:tt123"]
        );
    }
}
