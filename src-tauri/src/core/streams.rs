use crate::core::detail_page::{priority_score, DetailPageCoordinator, SharedResult};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::Duration;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamReliabilityRecord {
    #[serde(default)]
    pub success: i64,
    #[serde(default)]
    pub failed_start: i64,
    #[serde(default)]
    pub unstable: i64,
    #[serde(default)]
    pub reported_bad: i64,
    #[serde(default)]
    pub preferred: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPreference {
    pub addon_id: Option<String>,
    pub addon_family: Option<String>,
    pub source_type: Option<String>,
    pub resolution: Option<String>,
    pub hdr_format: Option<String>,
    pub release_type: Option<String>,
    pub audio_language: Option<String>,
    #[serde(default)]
    pub success_count: i64,
    #[serde(default)]
    pub failure_count: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartScoreContext {
    #[serde(default)]
    pub title: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    #[serde(default)]
    pub preferred_audio: Vec<String>,
    #[serde(default)]
    pub preferred_subtitles: Vec<String>,
    #[serde(default)]
    pub subtitles: Vec<Value>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_player")]
    pub player: String,
    pub max_size_gb: Option<f64>,
    #[serde(default)]
    pub history: HashMap<String, StreamReliabilityRecord>,
    #[serde(default)]
    pub playback_memories: Vec<PlaybackPreference>,
    pub app_origin: Option<String>,
}

fn default_mode() -> String {
    "best".to_string()
}

fn default_player() -> String {
    "mpv".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankStreamCandidatesRequest {
    pub streams: Vec<Value>,
    pub context: SmartScoreContext,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub cancel_group: String,
    pub timeout_ms: Option<u64>,
}

fn default_priority() -> String {
    "playback".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoredStream {
    pub stream: Value,
    pub score: f64,
    pub reasons: Vec<String>,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankStreamCandidatesResponse {
    pub candidates: Vec<ScoredStream>,
    pub stale: bool,
}

pub async fn rank_stream_candidates(
    coordinator: &DetailPageCoordinator,
    request: RankStreamCandidatesRequest,
) -> Result<RankStreamCandidatesResponse, String> {
    let payload = serde_json::to_vec(&(&request.streams, &request.context))
        .map_err(|error| format!("Failed to serialize stream candidates: {error}"))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    payload.hash(&mut hasher);
    let key = format!("stream-rank:{:016x}", hasher.finish());
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(3_000).clamp(250, 10_000));
    let priority = priority_score(&request.priority);
    let group = request.cancel_group;
    let streams = request.streams;
    let context = request.context;

    let coordinated = coordinator
        .run(key, group, priority, timeout, || async move {
            let candidates = tokio::task::spawn_blocking(move || rank_streams(streams, &context))
                .await
                .map_err(|error| format!("Stream ranking worker failed: {error}"))?;
            Ok(SharedResult {
                data: serde_json::to_value(candidates)
                    .map_err(|error| format!("Failed to serialize ranked streams: {error}"))?,
                // Ranking depends on live, profile-local reliability and playback
                // memory. Persisting it would make newer evidence rank incorrectly.
                cache_status: "bypass".to_string(),
            })
        })
        .await?;
    Ok(RankStreamCandidatesResponse {
        candidates: serde_json::from_value(coordinated.data)
            .map_err(|error| format!("Failed to decode ranked streams: {error}"))?,
        stale: coordinated.stale,
    })
}

pub fn rank_streams(streams: Vec<Value>, context: &SmartScoreContext) -> Vec<ScoredStream> {
    let mut ranked: Vec<ScoredStream> = streams
        .into_iter()
        .map(|stream| score_stream(stream, context))
        .collect();
    ranked.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.fingerprint.cmp(&right.fingerprint))
    });
    ranked
}

fn score_stream(stream: Value, context: &SmartScoreContext) -> ScoredStream {
    let value = scoring_text(&stream);
    let mut reasons = Vec::new();
    let torbox_cached = bool_path(&stream, &["behaviorHints", "torboxCached"]);
    let mut score = if playable_url(&stream, context.app_origin.as_deref()) {
        20.0
    } else if torbox_cached {
        30.0
    } else {
        -1000.0
    };
    if torbox_cached {
        reasons.push("TorBox cached".to_string());
    }

    let resolution = resolution(&value);
    let size = parse_size_gb(&value);
    let quality_points = match resolution {
        2160 => 30.0,
        1080 => 24.0,
        720 => 14.0,
        480 => 5.0,
        _ => 8.0,
    };
    score += if context.mode == "highest-quality" {
        quality_points * 2.0
    } else {
        quality_points
    };
    if resolution > 0 {
        reasons.push(format!("{resolution}p quality"));
    }
    if context.mode == "fastest" {
        score += if (720..=1080).contains(&resolution) {
            18.0
        } else if resolution == 2160 {
            -12.0
        } else {
            4.0
        };
    }
    if let Some(size) = size {
        score += if context.mode == "smallest-file" {
            (-25.0_f64).max(30.0 - size * 3.0)
        } else if context.mode == "highest-quality" {
            12.0_f64.min(size / 3.0)
        } else {
            (-15.0_f64).max(8.0 - size)
        };
        reasons.push(if size < 1.0 {
            format!("{size:.1} GB")
        } else {
            format!("{size:.0} GB")
        });
        if let Some(max_size) = context.max_size_gb.filter(|value| *value != 0.0) {
            if size > max_size {
                score -= 45.0 + (size - max_size);
                reasons.push("over size preference".to_string());
            }
        }
    }

    let incompatible_web =
        context.player == "web" && is_match(r"\b(hevc|h\.?265|x265|av1|truehd|dts)\b", &value);
    score += if incompatible_web { -55.0 } else { 10.0 };
    reasons.push(if incompatible_web {
        "codec may be incompatible".to_string()
    } else {
        "player compatible".to_string()
    });

    if let Some(audio) = context.preferred_audio.iter().find(|language| {
        let base = language.split(['-', '_']).next().unwrap_or(language);
        Regex::new(&format!(r"(?i)\b{}\b", base))
            .map(|regex| regex.is_match(&value))
            .unwrap_or(false)
    }) {
        score += 18.0;
        reasons.push(format!("preferred audio: {audio}"));
    } else if !context.preferred_audio.is_empty()
        && is_match(
            r"\b(french|german|italian|spanish|rus|jpn|japanese|dub)\b",
            &value,
        )
    {
        score -= 25.0;
        reasons.push("possible wrong language".to_string());
    }

    let preferred_subtitle = context.preferred_subtitles.iter().any(|preferred| {
        stream_subtitle_languages(&stream, &context.subtitles)
            .iter()
            .any(|language| {
                language
                    .to_lowercase()
                    .starts_with(&preferred.to_lowercase())
            })
    });
    if preferred_subtitle {
        score += 8.0;
        reasons.push("preferred subtitles".to_string());
    }

    let expected: Vec<String> = normalized(&context.title)
        .split_whitespace()
        .filter(|word| word.len() > 2)
        .map(str::to_string)
        .collect();
    let normalized_value = normalized(&value);
    let overlap = expected
        .iter()
        .filter(|word| normalized_value.contains(word.as_str()))
        .count() as f64
        / expected.len().max(1) as f64;
    if overlap >= 0.6 {
        score += 18.0;
        reasons.push("strong title match".to_string());
    } else if !expected.is_empty() && overlap == 0.0 && string_field(&stream, "filename").is_some()
    {
        score -= 35.0;
        reasons.push("weak title match".to_string());
    }

    if let (Some(season), Some(episode)) = (context.season, context.episode) {
        let episode_match = Regex::new(&format!(
            r"(?i)(?:s0?{}e0?{}|{}x0?{})",
            season, episode, season, episode
        ))
        .map(|regex| regex.is_match(&value))
        .unwrap_or(false);
        if episode_match {
            score += 24.0;
        } else if is_match(r"\bs\d{1,2}e\d{1,3}\b", &value) {
            score -= 90.0;
            reasons.push("wrong episode".to_string());
        }
    }
    if is_match(r"\b(cam|camrip|hdcam|telesync|tsrip)\b", &value) {
        score -= 65.0;
        reasons.push("cam quality".to_string());
    }
    if is_match(r"\b(sample|trailer|teaser|featurette|fake)\b", &value) {
        score -= 120.0;
        reasons.push("sample/trailer/fake".to_string());
    }

    let fingerprint = stream_fingerprint(&stream);
    if let Some(history) = context.history.get(&fingerprint) {
        let delta = history.success * 9 + history.preferred * 14
            - history.failed_start * 30
            - history.unstable * 18
            - history.reported_bad * 100;
        score += delta.clamp(-240, 60) as f64;
        if history.success > 0 {
            reasons.push(format!(
                "{} local success{}",
                history.success,
                if history.success == 1 { "" } else { "es" }
            ));
        }
        if history.failed_start > 0 || history.unstable > 0 || history.reported_bad > 0 {
            reasons.push("local failure history".to_string());
        }
    }

    let (memory_score, memory_reasons) = playback_memory_score(&stream, &context.playback_memories);
    score += memory_score;
    reasons.extend(memory_reasons);
    ScoredStream {
        stream,
        score: js_round(score * 10.0) / 10.0,
        reasons,
        fingerprint,
    }
}

fn scoring_text(stream: &Value) -> String {
    [
        string_field(stream, "name"),
        string_field(stream, "title"),
        string_field(stream, "description"),
        string_field(stream, "filename"),
        string_path(stream, &["behaviorHints", "filename"]),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}

fn stream_search_text(stream: &Value) -> String {
    let joined = ["name", "title", "description", "filename"]
        .into_iter()
        .filter_map(|field| string_field(stream, field))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let chars: Vec<char> = joined.chars().collect();
    chars
        .iter()
        .enumerate()
        .map(|(index, character)| {
            if (*character == '.' || *character == '_')
                && !(index > 0
                    && index + 1 < chars.len()
                    && chars[index - 1].is_ascii_digit()
                    && chars[index + 1].is_ascii_digit())
            {
                ' '
            } else {
                *character
            }
        })
        .collect()
}

fn playback_memory_score(stream: &Value, memories: &[PlaybackPreference]) -> (f64, Vec<String>) {
    let current = playback_preference(stream);
    let mut score = 0.0;
    let mut reasons = Vec::new();
    for memory in memories {
        let strength = 1.0_f64.min((memory.success_count + 1) as f64 / 3.0);
        let mut add = |same: bool, points: f64, label: &str| {
            if same {
                let value = js_round(points * strength);
                score += value;
                reasons.push(format!("playback memory: +{} {label}", value as i64));
            }
        };
        add(
            same_some(&memory.addon_id, &current.addon_id),
            12.0,
            "same successful addon",
        );
        add(
            same_some(&memory.addon_family, &current.addon_family),
            6.0,
            "same addon family",
        );
        add(
            same_some(&memory.source_type, &current.source_type),
            8.0,
            "same source type",
        );
        add(
            same_some(&memory.resolution, &current.resolution),
            6.0,
            "preferred resolution",
        );
        add(
            same_some(&memory.hdr_format, &current.hdr_format),
            5.0,
            "preferred HDR",
        );
        add(
            same_some(&memory.release_type, &current.release_type),
            5.0,
            "same release type",
        );
        add(
            same_some(&memory.audio_language, &current.audio_language),
            4.0,
            "preferred audio",
        );
        if memory.failure_count > memory.success_count
            && memory.addon_id.is_some()
            && memory.addon_id == current.addon_id
        {
            score -= 10.0;
            reasons.push("playback memory: -10 previous failure pattern".to_string());
        }
    }
    (score.clamp(-25.0, 45.0), reasons)
}

fn playback_preference(stream: &Value) -> PlaybackPreference {
    let text = stream_search_text(stream);
    let addon_id = string_field(stream, "addonId").map(str::to_string);
    PlaybackPreference {
        addon_family: addon_id.as_deref().map(addon_family),
        addon_id,
        source_type: capture(&text, r"\b(usenet|torrent|direct|hls|web)\b"),
        resolution: capture(&text, r"\b(2160p|4k|1080p|720p|480p)\b"),
        hdr_format: capture(&text, r"\b(dv|dovi|dolby vision|hdr10\+|hdr10|hdr)\b"),
        release_type: capture(&text, r"\b(remux|blu-?ray|web[- ]?dl|web[- ]?rip)\b"),
        audio_language: None,
        success_count: 0,
        failure_count: 0,
    }
}

fn addon_family(addon_id: &str) -> String {
    let without_scheme = Regex::new(r"(?i)^https?://").unwrap().replace(addon_id, "");
    let without_path = Regex::new(r"[?/#].*$")
        .unwrap()
        .replace(&without_scheme, "");
    Regex::new(r"(?i)[-_]?\d+$")
        .unwrap()
        .replace(&without_path, "")
        .to_string()
}

fn same_some(left: &Option<String>, right: &Option<String>) -> bool {
    left.as_ref()
        .is_some_and(|left| right.as_ref() == Some(left))
}

fn capture(value: &str, pattern: &str) -> Option<String> {
    Regex::new(&format!("(?i){pattern}"))
        .ok()?
        .captures(value)?
        .get(1)
        .map(|value| value.as_str().to_lowercase())
}

fn parse_size_gb(value: &str) -> Option<f64> {
    let captures = Regex::new(r"(?i)\b(\d+(?:\.\d+)?)\s*(tb|gb|gib|mb|mib)\b")
        .unwrap()
        .captures(value)?;
    let amount = captures.get(1)?.as_str().parse::<f64>().ok()?;
    let unit = captures.get(2)?.as_str().to_lowercase();
    Some(if unit == "tb" {
        amount * 1024.0
    } else if unit.starts_with('m') {
        amount / 1024.0
    } else {
        amount
    })
}

fn resolution(value: &str) -> i64 {
    if is_match(r"\b(4k|2160p|uhd)\b", value) {
        2160
    } else if is_match(r"\b1080p\b", value) {
        1080
    } else if is_match(r"\b720p\b", value) {
        720
    } else if is_match(r"\b(480p|sd)\b", value) {
        480
    } else {
        0
    }
}

fn normalized(value: &str) -> String {
    Regex::new(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&value.to_lowercase(), " ")
        .trim()
        .to_string()
}

fn is_match(pattern: &str, value: &str) -> bool {
    Regex::new(&format!("(?i){pattern}"))
        .map(|regex| regex.is_match(value))
        .unwrap_or(false)
}

fn playable_url(stream: &Value, app_origin: Option<&str>) -> bool {
    for field in ["url", "externalUrl"] {
        if let Some(value) = string_field(stream, field) {
            if let Ok(url) = url::Url::parse(value.trim()) {
                if matches!(url.scheme(), "http" | "https") {
                    let origin = url.origin().ascii_serialization();
                    if app_origin.map(|current| current != origin).unwrap_or(true) {
                        return true;
                    }
                }
            }
        }
    }
    string_field(stream, "ytId").is_some_and(|value| !value.is_empty())
}

fn stream_subtitle_languages(stream: &Value, context_subtitles: &[Value]) -> Vec<String> {
    stream
        .get("subtitles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(context_subtitles.iter())
        .filter_map(|subtitle| subtitle.get("lang").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn stream_fingerprint(stream: &Value) -> String {
    let addon = string_field(stream, "addonId").unwrap_or("unknown");
    if let Some(info_hash) = string_field(stream, "infoHash") {
        let index = stream.get("fileIdx").and_then(Value::as_i64).unwrap_or(0);
        return format!("{addon}:torrent:{}:{index}", info_hash.to_lowercase());
    }
    if let Some(raw_url) = string_field(stream, "url") {
        if let Ok(url) = url::Url::parse(raw_url) {
            return format!(
                "{addon}:url:{}{}",
                url.origin().ascii_serialization(),
                url.path()
            );
        }
    }
    let label = format!(
        "{}|{}|{}",
        string_field(stream, "name").unwrap_or(""),
        string_field(stream, "title").unwrap_or(""),
        string_field(stream, "filename").unwrap_or("")
    )
    .to_lowercase();
    let mut hash = 2_166_136_261_u32;
    for code_unit in label.encode_utf16() {
        hash = (hash ^ code_unit as u32).wrapping_mul(16_777_619);
    }
    format!("{addon}:label:{hash:x}")
}

fn string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn string_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for part in path {
        current = current.get(part)?;
    }
    current.as_str()
}

fn bool_path(value: &Value, path: &[&str]) -> bool {
    let mut current = value;
    for part in path {
        let Some(next) = current.get(part) else {
            return false;
        };
        current = next;
    }
    current.as_bool().unwrap_or(false)
}

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> SmartScoreContext {
        SmartScoreContext {
            title: "Example Movie".into(),
            season: None,
            episode: None,
            preferred_audio: vec![],
            preferred_subtitles: vec![],
            subtitles: vec![],
            mode: "best".into(),
            player: "mpv".into(),
            max_size_gb: None,
            history: HashMap::new(),
            playback_memories: vec![],
            app_origin: None,
        }
    }

    fn stream(title: &str, addon: &str) -> Value {
        json!({
            "title": title,
            "addonId": addon,
            "addonName": addon,
            "url": format!("https://example.com/{title}.mp4")
        })
    }

    #[test]
    fn ranking_matches_established_quality_and_fake_penalties() {
        let ranked = rank_streams(
            vec![
                stream("Example Movie trailer 2160p", "one"),
                stream("Example Movie CAM 720p", "two"),
                stream("Example Movie 1080p WEB-DL", "three"),
            ],
            &context(),
        );
        assert_eq!(ranked[0].stream["addonId"], "three");
        assert_eq!(
            ranked
                .iter()
                .map(|candidate| candidate.score)
                .collect::<Vec<_>>(),
            vec![72.0, -3.0, -42.0]
        );
    }

    #[test]
    fn reliability_and_playback_memory_are_part_of_the_native_score() {
        let preferred = stream("Example Movie 1080p WEB-DL", "preferred-1");
        let other = stream("Example Movie 1080p WEB-DL", "other");
        let preferred_fingerprint = stream_fingerprint(&preferred);
        let mut context = context();
        context.history.insert(
            preferred_fingerprint,
            StreamReliabilityRecord {
                success: 2,
                failed_start: 0,
                unstable: 0,
                reported_bad: 0,
                preferred: 1,
            },
        );
        context.playback_memories.push(PlaybackPreference {
            addon_id: Some("preferred-1".into()),
            addon_family: Some("preferred".into()),
            source_type: Some("web".into()),
            resolution: Some("1080p".into()),
            release_type: Some("web-dl".into()),
            success_count: 2,
            ..PlaybackPreference::default()
        });
        let ranked = rank_streams(vec![other, preferred], &context);
        assert_eq!(ranked[0].stream["addonId"], "preferred-1");
        assert!(ranked[0]
            .reasons
            .iter()
            .any(|reason| reason.contains("playback memory")));
        assert!(ranked[0]
            .reasons
            .iter()
            .any(|reason| reason.contains("local success")));
    }

    #[test]
    fn wrong_episode_is_penalized_and_unicode_is_serializable() {
        let mut context = context();
        context.title = "Frieren: Beyond Journey's End".into();
        context.season = Some(1);
        context.episode = Some(3);
        let ranked = rank_streams(
            vec![
                stream("Frieren S01E02 1080p 日本語", "wrong"),
                stream("Frieren S01E03 1080p 日本語", "right"),
            ],
            &context,
        );
        assert_eq!(ranked[0].stream["addonId"], "right");
        assert_eq!(
            serde_json::to_string(&ranked).unwrap().contains("日本語"),
            true
        );
    }

    #[test]
    fn malformed_and_empty_candidates_keep_legacy_non_playable_semantics() {
        let ranked = rank_streams(vec![json!(null), json!({"addonId": "empty"})], &context());
        assert_eq!(ranked.len(), 2);
        assert!(ranked.iter().all(|candidate| candidate.score < -500.0));
        assert!(rank_streams(vec![], &context()).is_empty());
    }
}
