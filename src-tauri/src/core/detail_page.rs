use crate::core::cache;
use crate::db::Database;
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch, Mutex, OwnedSemaphorePermit, Semaphore};

const TMDB_BASE_URL: &str = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL: &str = "https://image.tmdb.org/t/p";
const TVDB_BASE_URL: &str = "https://api4.thetvdb.com/v4";
const DETAIL_CACHE_TTL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadDetailPageRequest {
    pub provider: String,
    #[serde(default = "default_media_type")]
    pub media_type: String,
    pub id: String,
    pub api_key: String,
    pub image_quality: Option<String>,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub cancel_group: String,
    pub timeout_ms: Option<u64>,
}

fn default_media_type() -> String {
    "series".to_string()
}

fn default_priority() -> String {
    "visible".to_string()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadDetailPageResponse {
    pub data: Value,
    pub stale: bool,
    pub cache_status: String,
}

#[derive(Clone)]
pub(crate) struct SharedResult {
    pub(crate) data: Value,
    pub(crate) cache_status: String,
}

#[derive(Default)]
struct CoordinatorState {
    inflight: HashMap<String, watch::Sender<Option<Result<SharedResult, String>>>>,
    groups: HashMap<String, (String, u64)>,
}

pub struct DetailPageCoordinator {
    state: Mutex<CoordinatorState>,
    limiter: Arc<PriorityLimiter>,
    provider_limiters: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl Default for DetailPageCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(CoordinatorState::default()),
            limiter: Arc::new(PriorityLimiter::new(4)),
            provider_limiters: Mutex::new(HashMap::new()),
        }
    }
}

struct PriorityWaiter {
    priority: u8,
    sequence: u64,
    sender: oneshot::Sender<()>,
}

struct PriorityLimitState {
    active: usize,
    sequence: u64,
    waiting: Vec<PriorityWaiter>,
}

struct PriorityLimiter {
    limit: usize,
    state: Mutex<PriorityLimitState>,
}

impl PriorityLimiter {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            state: Mutex::new(PriorityLimitState {
                active: 0,
                sequence: 0,
                waiting: vec![],
            }),
        }
    }

    async fn acquire(self: &Arc<Self>, priority: u8) -> Result<PriorityPermit, String> {
        let receiver = {
            let mut state = self.state.lock().await;
            if state.active < self.limit {
                state.active += 1;
                None
            } else {
                let sequence = state.sequence;
                state.sequence = state.sequence.saturating_add(1);
                let (sender, receiver) = oneshot::channel();
                state.waiting.push(PriorityWaiter {
                    priority,
                    sequence,
                    sender,
                });
                Some(receiver)
            }
        };
        if let Some(receiver) = receiver {
            receiver
                .await
                .map_err(|_| "Detail request coordinator closed".to_string())?;
        }
        Ok(PriorityPermit {
            limiter: self.clone(),
        })
    }

    async fn release(&self) {
        let mut state = self.state.lock().await;
        state.active = state.active.saturating_sub(1);
        while state.active < self.limit && !state.waiting.is_empty() {
            let index = state
                .waiting
                .iter()
                .enumerate()
                .max_by(|(_, left), (_, right)| {
                    left.priority
                        .cmp(&right.priority)
                        .then_with(|| right.sequence.cmp(&left.sequence))
                })
                .map(|(index, _)| index)
                .unwrap_or_default();
            let waiter = state.waiting.swap_remove(index);
            if waiter.sender.send(()).is_ok() {
                state.active += 1;
                break;
            }
        }
    }
}

struct PriorityPermit {
    limiter: Arc<PriorityLimiter>,
}

impl Drop for PriorityPermit {
    fn drop(&mut self) {
        let limiter = self.limiter.clone();
        tokio::spawn(async move { limiter.release().await });
    }
}

pub(crate) fn priority_score(priority: &str) -> u8 {
    match priority {
        "playback" => 4,
        "interactive" => 3,
        "visible" => 2,
        "background" => 1,
        _ => 2,
    }
}

impl DetailPageCoordinator {
    /// Preserve the frontend coordinator's one-active-request-per-addon
    /// contract while allowing unrelated providers to progress concurrently.
    pub(crate) async fn acquire_provider(
        &self,
        provider: &str,
    ) -> Result<OwnedSemaphorePermit, String> {
        let limiter = {
            let mut limiters = self.provider_limiters.lock().await;
            limiters
                .entry(provider.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(1)))
                .clone()
        };
        limiter
            .acquire_owned()
            .await
            .map_err(|_| "Provider request coordinator closed".to_string())
    }

    async fn begin(
        &self,
        key: &str,
        group: &str,
    ) -> (
        u64,
        Option<watch::Receiver<Option<Result<SharedResult, String>>>>,
        Option<watch::Sender<Option<Result<SharedResult, String>>>>,
    ) {
        let mut state = self.state.lock().await;
        let generation = match state.groups.get(group) {
            Some((active_key, generation)) if active_key == key => *generation,
            Some((_, generation)) => generation.saturating_add(1),
            None => 1,
        };
        state
            .groups
            .insert(group.to_string(), (key.to_string(), generation));

        if let Some(sender) = state.inflight.get(key) {
            return (generation, Some(sender.subscribe()), None);
        }

        let (sender, _) = watch::channel(None);
        state.inflight.insert(key.to_string(), sender.clone());
        (generation, None, Some(sender))
    }

    async fn is_stale(&self, key: &str, group: &str, generation: u64) -> bool {
        self.state
            .lock()
            .await
            .groups
            .get(group)
            .map(|(active_key, active_generation)| {
                active_key != key || *active_generation != generation
            })
            .unwrap_or(true)
    }

    async fn finish(&self, key: &str) {
        self.state.lock().await.inflight.remove(key);
    }

    pub(crate) async fn run<F, Fut>(
        &self,
        key: String,
        group: String,
        priority: u8,
        timeout: Duration,
        operation: F,
    ) -> Result<LoadDetailPageResponse, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<SharedResult, String>>,
    {
        let (generation, follower, leader) = self.begin(&key, &group).await;
        let result = if let Some(mut receiver) = follower {
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    break result;
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| "Detail request was cancelled".to_string())?;
            }
        } else {
            let sender = leader.expect("a new request always owns a sender");
            let result = match tokio::time::timeout(timeout, async {
                let permit = self.limiter.acquire(priority).await?;
                if self.is_stale(&key, &group, generation).await {
                    drop(permit);
                    return Err("Detail request was superseded".to_string());
                }
                let result = operation().await;
                drop(permit);
                result
            })
            .await
            {
                Ok(result) => result,
                Err(_) => Err("Detail request timed out".to_string()),
            };
            let _ = sender.send(Some(result.clone()));
            self.finish(&key).await;
            result
        }?;

        Ok(LoadDetailPageResponse {
            data: result.data,
            stale: self.is_stale(&key, &group, generation).await,
            cache_status: result.cache_status,
        })
    }
}

pub async fn load_detail_page(
    coordinator: &DetailPageCoordinator,
    db: &Database,
    request: LoadDetailPageRequest,
) -> Result<LoadDetailPageResponse, String> {
    let provider = request.provider.trim().to_ascii_lowercase();
    if provider != "tmdb" && provider != "tvdb" {
        return Err(format!("Unsupported native detail provider: {provider}"));
    }
    let id = clean_provider_id(&request.id, &provider)?;
    let media_type = request.media_type.trim().to_ascii_lowercase();
    if media_type != "series" && media_type != "movie" {
        return Err(format!("Unsupported detail media type: {media_type}"));
    }
    if media_type == "movie" && provider != "tmdb" {
        return Err(format!(
            "Unsupported native movie detail provider: {provider}"
        ));
    }
    let key = format!("detail:{media_type}-provider:v2:{provider}:{id}");
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000));
    let group = request.cancel_group;
    let priority = priority_score(&request.priority);
    let api_key = request.api_key;
    let image_quality = request
        .image_quality
        .unwrap_or_else(|| "balanced".to_string());

    coordinator
        .run(key.clone(), group, priority, timeout, || async move {
            // Series provider shells historically serve the last SQLite value
            // even after expiry. Movie pages instead use their artwork-scoped
            // page cache and revalidate a stale entry, so do not add a second
            // persistent cache with different behavior here.
            if media_type == "series" {
                if let Some(entry) = cache::entry_get(db, key.clone()) {
                    if let Ok(data) = serde_json::from_str::<Value>(&entry.value) {
                        return Ok(SharedResult {
                            data,
                            cache_status: "hit".to_string(),
                        });
                    }
                }
            }

            let fetched = tokio::task::spawn_blocking(move || {
                match (media_type.as_str(), provider.as_str()) {
                    ("series", "tmdb") => fetch_tmdb_show(&id, &api_key, &image_quality),
                    ("series", "tvdb") => fetch_tvdb_show(&id, &api_key),
                    ("movie", "tmdb") => fetch_tmdb_movie(&id, &api_key, &image_quality),
                    _ => unreachable!("provider and media type validated before coordination"),
                }
            })
            .await
            .map_err(|error| format!("Detail worker failed: {error}"))??;
            if key.contains(":series-provider:") {
                let serialized = serde_json::to_string(&fetched)
                    .map_err(|error| format!("Failed to serialize detail: {error}"))?;
                cache::entry_set(
                    db,
                    key,
                    serialized,
                    "detail_page".to_string(),
                    Some(DETAIL_CACHE_TTL_SECONDS),
                )?;
            }
            Ok(SharedResult {
                data: fetched,
                cache_status: "miss".to_string(),
            })
        })
        .await
}

fn clean_provider_id(id: &str, provider: &str) -> Result<String, String> {
    let mut value = id.trim();
    for prefix in [format!("{provider}-"), format!("{provider}:")] {
        if value.to_ascii_lowercase().starts_with(&prefix) {
            value = &value[prefix.len()..];
            break;
        }
    }
    if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
        return Err(format!("Invalid {provider} detail ID"));
    }
    Ok(value.to_string())
}

fn tmdb_get(
    agent: &ureq::Agent,
    path: &str,
    api_key: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let url = format!("{TMDB_BASE_URL}{path}");
    let mut request = agent
        .get(&url)
        .query("api_key", api_key)
        .query("language", "en-US");
    for (key, value) in query {
        request = request.query(key, value);
    }
    let response = request.call().map_err(|error| match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            format!("TMDB detail request failed: HTTP {status}: {body}")
        }
        other => format!("TMDB detail request failed: {other}"),
    })?;
    response
        .into_json()
        .map_err(|error| format!("Failed to parse TMDB detail response: {error}"))
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn number(value: &Value, key: &str) -> Option<Value> {
    value.get(key).filter(|item| item.is_number()).cloned()
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        map.insert(key.to_string(), value);
    }
}

fn tvdb_get(agent: &ureq::Agent, path: &str, token: &str) -> Result<Value, String> {
    let response = agent
        .get(&format!("{TVDB_BASE_URL}{path}"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept-Language", "eng")
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(status, response) => {
                let body = response.into_string().unwrap_or_default();
                format!("TVDB detail request failed: HTTP {status}: {body}")
            }
            other => format!("TVDB detail request failed: {other}"),
        })?;
    response
        .into_json()
        .map_err(|error| format!("Failed to parse TVDB detail response: {error}"))
}

fn has_japanese_text(value: &str) -> bool {
    value.chars().any(|character| {
        ('\u{3040}'..='\u{30ff}').contains(&character)
            || ('\u{3400}'..='\u{9fff}').contains(&character)
    })
}

fn js_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(js_string)
                .collect::<Vec<_>>()
                .join(","),
        ),
        Value::Object(_) => Some("[object Object]".to_string()),
    }
}

fn truthy_id(item: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|key| item.get(*key))
        .find(|value| match value {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_f64().unwrap_or(0.0) != 0.0,
            Value::String(value) => !value.is_empty(),
            _ => true,
        })
        .map(Value::to_string)
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
}

fn fetch_tvdb_show(id: &str, api_key: &str) -> Result<Value, String> {
    if api_key.trim().is_empty() {
        return Err("TVDB API key is required".to_string());
    }
    let agent = ureq::builder().timeout(Duration::from_secs(12)).build();
    let login = agent
        .post(&format!("{TVDB_BASE_URL}/login"))
        .set("Content-Type", "application/json")
        .send_json(json!({ "apikey": api_key }))
        .map_err(|error| format!("TVDB login failed: {error}"))?
        .into_json::<Value>()
        .map_err(|error| format!("Failed to parse TVDB login response: {error}"))?;
    let token = login
        .pointer("/data/token")
        .and_then(Value::as_str)
        .ok_or_else(|| "TVDB login response did not contain a token".to_string())?;
    let response = tvdb_get(&agent, &format!("/series/{id}/extended"), token)?;
    let series = response
        .get("data")
        .cloned()
        .ok_or_else(|| "TVDB detail response did not contain series data".to_string())?;
    map_tvdb_show(id, &series, |path| tvdb_get(&agent, path, token))
}

fn map_tvdb_show<F>(id: &str, series: &Value, mut translate: F) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<Value, String>,
{
    let current_year = chrono::Local::now().year();
    let season_records = series
        .get("seasons")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|season| {
                    season.pointer("/type/type").and_then(Value::as_str) == Some("official")
                        && season
                            .get("year")
                            .and_then(Value::as_i64)
                            .map(|year| year <= i64::from(current_year + 1))
                            .unwrap_or(true)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut seasons = Vec::with_capacity(season_records.len());
    for season in season_records {
        let number_value = season.get("number").cloned().unwrap_or(Value::Null);
        let season_number = number_value.as_i64().unwrap_or_default();
        let mut name = string(season, "name").unwrap_or_else(|| format!("Season {season_number}"));
        if has_japanese_text(&name) {
            if let Some(season_id) = season.get("id").and_then(Value::as_i64) {
                if let Ok(value) = translate(&format!("/seasons/{season_id}/translations/eng")) {
                    if let Some(english) = value.pointer("/data/name").and_then(Value::as_str) {
                        name = english.to_string();
                    }
                }
            }
        }
        let mut mapped = Map::new();
        insert_optional(&mut mapped, "seasonNumber", Some(number_value));
        mapped.insert("name".into(), Value::String(name));
        mapped.insert("episodeCount".into(), Value::from(0));
        insert_optional(
            &mut mapped,
            "poster",
            string(season, "image").map(Value::String),
        );
        if let Some(year) = season.get("year").and_then(Value::as_i64) {
            mapped.insert("airDate".into(), Value::String(format!("{year}-01-01")));
        }
        seasons.push(Value::Object(mapped));
    }

    let genres = series
        .get("genres")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| string(item, "name").map(Value::String))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let characters = series
        .get("characters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cast = characters
        .iter()
        .filter(|character| {
            character.get("type").and_then(Value::as_i64) == Some(3)
                || string(character, "peopleType").as_deref() == Some("Actor")
                || (character
                    .get("personName")
                    .is_some_and(|value| !value.is_null())
                    && character.get("name").is_some_and(|value| !value.is_null()))
        })
        .take(20)
        .map(|character| {
            let mut member = Map::new();
            member.insert(
                "id".into(),
                Value::String(truthy_id(character, &["peopleId", "id"])),
            );
            member.insert("personProvider".into(), Value::String("tvdb".into()));
            member.insert(
                "name".into(),
                Value::String(
                    string(character, "personName")
                        .or_else(|| string(character, "name"))
                        .unwrap_or_default(),
                ),
            );
            member.insert(
                "character".into(),
                Value::String(
                    string(character, "name")
                        .or_else(|| string(character, "personName"))
                        .unwrap_or_default(),
                ),
            );
            insert_optional(
                &mut member,
                "profilePath",
                string(character, "personImgURL")
                    .or_else(|| string(character, "image"))
                    .map(Value::String),
            );
            Value::Object(member)
        })
        .collect::<Vec<_>>();

    let artworks = series
        .get("artworks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let landscape = |art: &&Value| {
        let width = art
            .get("width")
            .or_else(|| art.get("thumbnailWidth"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let height = art
            .get("height")
            .or_else(|| art.get("thumbnailHeight"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        width > 0.0 && height > 0.0 && width / height >= 1.35
    };
    let backdrop = artworks
        .iter()
        .find(|art| {
            (art.get("type").and_then(Value::as_i64) == Some(3)
                || string(art, "type").as_deref() == Some("background"))
                && landscape(art)
        })
        .or_else(|| artworks.iter().find(landscape))
        .and_then(|art| string(art, "image"));
    let logo = artworks
        .iter()
        .find(|art| {
            let kind = art
                .get("type")
                .or_else(|| art.get("artworkType"))
                .and_then(js_string)
                .unwrap_or_default()
                .to_ascii_lowercase();
            kind == "5" || kind == "6" || kind.contains("logo") || kind.contains("clearlogo")
        })
        .and_then(|art| string(art, "image"));

    let original_name = string(series, "name").unwrap_or_default();
    let original_overview = string(series, "overview").unwrap_or_default();
    let mut title = original_name.clone();
    let mut overview = original_overview.clone();
    if has_japanese_text(&title) || has_japanese_text(&overview) {
        if let Ok(value) = translate(&format!("/series/{id}/translations/eng")) {
            if let Some(english) = value.pointer("/data/name").and_then(Value::as_str) {
                title = english.to_string();
            }
            if let Some(english) = value.pointer("/data/overview").and_then(Value::as_str) {
                overview = english.to_string();
            }
        }
    }

    let mut result = Map::new();
    result.insert("id".into(), Value::String(format!("tvdb-{id}")));
    result.insert("title".into(), Value::String(title.clone()));
    if title != original_name {
        result.insert("originalTitle".into(), Value::String(original_name));
    }
    if let Some(date) = string(series, "firstAired") {
        if let Ok(year) = date.get(..4).unwrap_or_default().parse::<u64>() {
            result.insert("year".into(), Value::from(year));
        }
        result.insert("firstAirDate".into(), Value::String(date));
    }
    result.insert("overview".into(), Value::String(overview));
    result.insert("genres".into(), Value::Array(genres));
    insert_optional(
        &mut result,
        "poster",
        string(series, "image").map(Value::String),
    );
    insert_optional(&mut result, "backdrop", backdrop.map(Value::String));
    insert_optional(&mut result, "logo", logo.map(Value::String));
    insert_optional(
        &mut result,
        "status",
        series.get("status").and_then(js_string).map(Value::String),
    );
    result.insert("numberOfSeasons".into(), Value::from(seasons.len()));
    result.insert("seasons".into(), Value::Array(seasons));
    result.insert("cast".into(), Value::Array(cast));
    result.insert("crew".into(), Value::Array(vec![]));
    result.insert("recommendations".into(), Value::Array(vec![]));
    result.insert("trailers".into(), Value::Array(vec![]));
    result.insert("provider".into(), Value::String("tvdb".into()));
    Ok(Value::Object(result))
}

fn image_size(image_quality: &str, kind: &str) -> &'static str {
    match (image_quality, kind) {
        ("data-saver", "poster") => "w342",
        ("high", "poster") => "original",
        (_, "poster") => "w780",
        ("data-saver", "backdrop") => "w1280",
        (_, "backdrop") => "original",
        _ => "original",
    }
}

fn image_url(size: &str, path: Option<String>) -> Option<Value> {
    path.map(|path| Value::String(format!("{TMDB_IMAGE_BASE_URL}/{size}{path}")))
}

fn sorted_images(images: &Value, key: &str) -> Vec<Value> {
    let mut result = images
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|image| image.get("file_path").and_then(Value::as_str).is_some())
        .collect::<Vec<_>>();
    result.sort_by(|left, right| {
        let left_votes = left
            .get("vote_count")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let right_votes = right
            .get("vote_count")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        right_votes
            .partial_cmp(&left_votes)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let left_rating = left
                    .get("vote_average")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let right_rating = right
                    .get("vote_average")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                right_rating
                    .partial_cmp(&left_rating)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    result
}

fn best_poster(images: &Value, primary: Option<String>, quality: &str) -> Option<Value> {
    let size = image_size(quality, "poster");
    image_url(size, primary).or_else(|| {
        sorted_images(images, "posters")
            .first()
            .and_then(|image| image_url(size, string(image, "file_path")))
    })
}

fn best_backdrop(images: &Value, primary: Option<String>, quality: &str) -> Option<Value> {
    let size = image_size(quality, "backdrop");
    image_url(size, primary).or_else(|| {
        sorted_images(images, "backdrops")
            .first()
            .and_then(|image| image_url(size, string(image, "file_path")))
    })
}

fn map_search_result(item: &Value, media_type: &str, image_quality: &str) -> Value {
    let mut result = Map::new();
    let id = item
        .get("id")
        .map(|value| value.to_string())
        .unwrap_or_default();
    result.insert("id".into(), Value::String(format!("tmdb-{id}")));
    result.insert(
        "title".into(),
        Value::String(
            string(
                item,
                if media_type == "movie" {
                    "title"
                } else {
                    "name"
                },
            )
            .unwrap_or_default(),
        ),
    );
    result.insert("type".into(), Value::String(media_type.into()));
    if let Some(date) = string(
        item,
        if media_type == "movie" {
            "release_date"
        } else {
            "first_air_date"
        },
    ) {
        if let Ok(year) = date.get(..4).unwrap_or_default().parse::<u64>() {
            result.insert("year".into(), Value::from(year));
        }
        result.insert("releaseDate".into(), Value::String(date));
    }
    insert_optional(
        &mut result,
        "poster",
        image_url("w342", string(item, "poster_path")),
    );
    insert_optional(
        &mut result,
        "backdrop",
        image_url(
            image_size(image_quality, "backdrop"),
            string(item, "backdrop_path"),
        ),
    );
    insert_optional(
        &mut result,
        "overview",
        string(item, "overview").map(Value::String),
    );
    insert_optional(&mut result, "rating", number(item, "vote_average"));
    insert_optional(&mut result, "voteCount", number(item, "vote_count"));
    insert_optional(&mut result, "popularity", number(item, "popularity"));
    insert_optional(
        &mut result,
        "originalLanguage",
        string(item, "original_language").map(Value::String),
    );
    insert_optional(
        &mut result,
        "originCountry",
        item.get("origin_country").cloned(),
    );
    result.insert("provider".into(), Value::String("tmdb".into()));
    insert_optional(&mut result, "tmdbId", item.get("id").cloned());
    insert_optional(&mut result, "genreIds", item.get("genre_ids").cloned());
    Value::Object(result)
}

fn fetch_tmdb_show(id: &str, api_key: &str, image_quality: &str) -> Result<Value, String> {
    if api_key.trim().is_empty() {
        return Err("TMDB API key is required".to_string());
    }
    let agent = ureq::builder().timeout(Duration::from_secs(12)).build();
    let paths = [
        format!("/tv/{id}"),
        format!("/tv/{id}/credits"),
        format!("/tv/{id}/videos"),
        format!("/tv/{id}/recommendations"),
        format!("/tv/{id}/images"),
        format!("/tv/{id}/external_ids"),
    ];
    let mut values = Vec::with_capacity(paths.len());
    for batch in paths.chunks(2) {
        std::thread::scope(|scope| {
            let handles = batch
                .iter()
                .map(|path| {
                    let agent = agent.clone();
                    scope.spawn(move || {
                        let query = if path.ends_with("/images") {
                            vec![("include_image_language", "en,ja,xx,null")]
                        } else {
                            vec![]
                        };
                        tmdb_get(&agent, path, api_key, &query)
                    })
                })
                .collect::<Vec<_>>();
            for handle in handles {
                values.push(
                    handle
                        .join()
                        .map_err(|_| "TMDB detail worker panicked".to_string())?,
                );
            }
            Ok::<(), String>(())
        })?;
    }
    let mut values = values
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .into_iter();
    let details = values.next().unwrap_or(Value::Null);
    let credits = values.next().unwrap_or(Value::Null);
    let videos = values.next().unwrap_or(Value::Null);
    let recommendations = values.next().unwrap_or(Value::Null);
    let images = values.next().unwrap_or(Value::Null);
    let external_ids = values.next().unwrap_or(Value::Null);

    map_tmdb_show(
        id,
        image_quality,
        &details,
        &credits,
        &videos,
        &recommendations,
        &images,
        &external_ids,
    )
}

fn map_tmdb_show(
    id: &str,
    image_quality: &str,
    details: &Value,
    credits: &Value,
    videos: &Value,
    recommendations: &Value,
    images: &Value,
    external_ids: &Value,
) -> Result<Value, String> {
    let cast = credits
        .get("cast")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(20)
                .map(|item| {
                    let mut cast = Map::new();
                    cast.insert(
                        "id".into(),
                        Value::String(item.get("id").map(Value::to_string).unwrap_or_default()),
                    );
                    cast.insert("personProvider".into(), Value::String("tmdb".into()));
                    cast.insert(
                        "name".into(),
                        Value::String(string(item, "name").unwrap_or_default()),
                    );
                    insert_optional(
                        &mut cast,
                        "character",
                        string(item, "character").map(Value::String),
                    );
                    insert_optional(
                        &mut cast,
                        "profilePath",
                        image_url("w185", string(item, "profile_path")),
                    );
                    Value::Object(cast)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let trailers = videos
        .get("results")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| string(item, "site").as_deref() == Some("YouTube"))
                .map(|item| {
                    let key = string(item, "key").unwrap_or_default();
                    json!({
                        "id": string(item, "id").unwrap_or_default(),
                        "name": string(item, "name").unwrap_or_default(),
                        "key": key,
                        "site": "YouTube",
                        "type": string(item, "type").unwrap_or_default(),
                        "thumbnail": format!("https://img.youtube.com/vi/{key}/hqdefault.jpg"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let seasons = details
        .get("seasons")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("season_number")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        > 0
                })
                .map(|item| {
                    let mut season = Map::new();
                    insert_optional(&mut season, "seasonNumber", number(item, "season_number"));
                    season.insert(
                        "name".into(),
                        Value::String(string(item, "name").unwrap_or_default()),
                    );
                    insert_optional(&mut season, "episodeCount", number(item, "episode_count"));
                    insert_optional(
                        &mut season,
                        "poster",
                        image_url("w342", string(item, "poster_path")),
                    );
                    insert_optional(
                        &mut season,
                        "airDate",
                        string(item, "air_date").map(Value::String),
                    );
                    Value::Object(season)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let genres = details
        .get("genres")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| string(item, "name").map(Value::String))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let recs = recommendations
        .get("results")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(10)
                .map(|item| map_search_result(item, "series", image_quality))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let logos = images
        .get("logos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let logo = logos
        .iter()
        .find(|item| string(item, "iso_639_1").as_deref() == Some("en"))
        .or_else(|| logos.first());

    let mut result = Map::new();
    result.insert("id".into(), Value::String(format!("tmdb-{id}")));
    result.insert(
        "title".into(),
        Value::String(string(&details, "name").unwrap_or_default()),
    );
    insert_optional(
        &mut result,
        "originalTitle",
        string(&details, "original_name").map(Value::String),
    );
    if let Some(date) = string(&details, "first_air_date") {
        if let Ok(year) = date.get(..4).unwrap_or_default().parse::<u64>() {
            result.insert("year".into(), Value::from(year));
        }
        result.insert("firstAirDate".into(), Value::String(date));
    }
    insert_optional(
        &mut result,
        "overview",
        string(&details, "overview").map(Value::String),
    );
    insert_optional(
        &mut result,
        "tagline",
        string(&details, "tagline").map(Value::String),
    );
    insert_optional(&mut result, "rating", number(&details, "vote_average"));
    insert_optional(&mut result, "voteCount", number(&details, "vote_count"));
    result.insert("genres".into(), Value::Array(genres));
    insert_optional(
        &mut result,
        "poster",
        best_poster(&images, string(&details, "poster_path"), image_quality),
    );
    insert_optional(
        &mut result,
        "backdrop",
        best_backdrop(&images, string(&details, "backdrop_path"), image_quality),
    );
    insert_optional(
        &mut result,
        "logo",
        logo.and_then(|item| image_url("w300", string(item, "file_path"))),
    );
    insert_optional(
        &mut result,
        "status",
        string(&details, "status").map(Value::String),
    );
    insert_optional(
        &mut result,
        "seriesType",
        string(&details, "type").map(Value::String),
    );
    insert_optional(
        &mut result,
        "numberOfSeasons",
        number(&details, "number_of_seasons"),
    );
    insert_optional(
        &mut result,
        "numberOfEpisodes",
        number(&details, "number_of_episodes"),
    );
    result.insert("seasons".into(), Value::Array(seasons));
    result.insert("cast".into(), Value::Array(cast));
    result.insert("crew".into(), Value::Array(vec![]));
    result.insert("recommendations".into(), Value::Array(recs));
    result.insert("trailers".into(), Value::Array(trailers));
    insert_optional(
        &mut result,
        "imdbId",
        string(&external_ids, "imdb_id").map(Value::String),
    );
    insert_optional(&mut result, "tvdbId", number(&external_ids, "tvdb_id"));
    result.insert("tmdbId".into(), Value::String(id.to_string()));
    result.insert("provider".into(), Value::String("tmdb".into()));
    Ok(Value::Object(result))
}

fn fetch_tmdb_movie(id: &str, api_key: &str, image_quality: &str) -> Result<Value, String> {
    if api_key.trim().is_empty() {
        return Err("TMDB API key is required".to_string());
    }
    let agent = ureq::builder().timeout(Duration::from_secs(12)).build();
    let paths = [
        format!("/movie/{id}"),
        format!("/movie/{id}/credits"),
        format!("/movie/{id}/videos"),
        format!("/movie/{id}/recommendations"),
        format!("/movie/{id}/images"),
    ];
    let mut values = Vec::with_capacity(paths.len());
    for batch in paths.chunks(2) {
        std::thread::scope(|scope| {
            let handles = batch
                .iter()
                .map(|path| {
                    let agent = agent.clone();
                    scope.spawn(move || {
                        let query = if path.ends_with("/images") {
                            vec![("include_image_language", "en,ja,xx,null")]
                        } else {
                            vec![]
                        };
                        tmdb_get(&agent, path, api_key, &query)
                    })
                })
                .collect::<Vec<_>>();
            for handle in handles {
                values.push(
                    handle
                        .join()
                        .map_err(|_| "TMDB movie detail worker panicked".to_string())?,
                );
            }
            Ok::<(), String>(())
        })?;
    }
    let mut values = values
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .into_iter();
    map_tmdb_movie(
        id,
        image_quality,
        &values.next().unwrap_or(Value::Null),
        &values.next().unwrap_or(Value::Null),
        &values.next().unwrap_or(Value::Null),
        &values.next().unwrap_or(Value::Null),
        &values.next().unwrap_or(Value::Null),
    )
}

fn map_tmdb_movie(
    id: &str,
    image_quality: &str,
    details: &Value,
    credits: &Value,
    videos: &Value,
    recommendations: &Value,
    images: &Value,
) -> Result<Value, String> {
    let cast = credits
        .get("cast")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(20)
                .map(|item| {
                    let mut member = Map::new();
                    member.insert(
                        "id".into(),
                        Value::String(item.get("id").map(Value::to_string).unwrap_or_default()),
                    );
                    member.insert("personProvider".into(), Value::String("tmdb".into()));
                    member.insert(
                        "name".into(),
                        Value::String(string(item, "name").unwrap_or_default()),
                    );
                    insert_optional(
                        &mut member,
                        "character",
                        string(item, "character").map(Value::String),
                    );
                    insert_optional(
                        &mut member,
                        "profilePath",
                        image_url("w185", string(item, "profile_path")),
                    );
                    Value::Object(member)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let crew = credits
        .get("crew")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    matches!(
                        string(item, "job").as_deref(),
                        Some("Director" | "Writer" | "Screenplay" | "Original Music Composer")
                    )
                })
                .map(|item| {
                    let mut member = Map::new();
                    member.insert(
                        "id".into(),
                        Value::String(item.get("id").map(Value::to_string).unwrap_or_default()),
                    );
                    member.insert("personProvider".into(), Value::String("tmdb".into()));
                    member.insert(
                        "name".into(),
                        Value::String(string(item, "name").unwrap_or_default()),
                    );
                    insert_optional(&mut member, "job", string(item, "job").map(Value::String));
                    insert_optional(
                        &mut member,
                        "department",
                        string(item, "department").map(Value::String),
                    );
                    insert_optional(
                        &mut member,
                        "profilePath",
                        image_url("w185", string(item, "profile_path")),
                    );
                    Value::Object(member)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let trailers = videos.get("results").and_then(Value::as_array).map(|items| {
        items.iter().filter(|item| string(item, "site").as_deref() == Some("YouTube")).map(|item| {
            let key = string(item, "key").unwrap_or_default();
            json!({"id": string(item, "id").unwrap_or_default(), "name": string(item, "name").unwrap_or_default(),
                   "key": key, "site": "YouTube", "type": string(item, "type").unwrap_or_default(),
                   "thumbnail": format!("https://img.youtube.com/vi/{key}/hqdefault.jpg")})
        }).collect::<Vec<_>>()
    }).unwrap_or_default();
    let genres = details
        .get("genres")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| string(item, "name").map(Value::String))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let recs = recommendations
        .get("results")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(10)
                .map(|item| map_search_result(item, "movie", image_quality))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let logos = images
        .get("logos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let logo = logos
        .iter()
        .find(|item| string(item, "iso_639_1").as_deref() == Some("en"))
        .or_else(|| logos.first());

    let mut result = Map::new();
    result.insert("id".into(), Value::String(format!("tmdb-{id}")));
    result.insert(
        "title".into(),
        Value::String(string(details, "title").unwrap_or_default()),
    );
    insert_optional(
        &mut result,
        "originalTitle",
        string(details, "original_title").map(Value::String),
    );
    if let Some(date) = string(details, "release_date") {
        if let Ok(year) = date.get(..4).unwrap_or_default().parse::<u64>() {
            result.insert("year".into(), Value::from(year));
        }
        result.insert("releaseDate".into(), Value::String(date));
    }
    insert_optional(
        &mut result,
        "overview",
        string(details, "overview").map(Value::String),
    );
    insert_optional(
        &mut result,
        "tagline",
        string(details, "tagline").map(Value::String),
    );
    insert_optional(&mut result, "runtime", number(details, "runtime"));
    insert_optional(&mut result, "rating", number(details, "vote_average"));
    insert_optional(&mut result, "voteCount", number(details, "vote_count"));
    result.insert("genres".into(), Value::Array(genres));
    insert_optional(
        &mut result,
        "poster",
        best_poster(images, string(details, "poster_path"), image_quality),
    );
    insert_optional(
        &mut result,
        "backdrop",
        best_backdrop(images, string(details, "backdrop_path"), image_quality),
    );
    insert_optional(
        &mut result,
        "logo",
        logo.and_then(|item| image_url("w300", string(item, "file_path"))),
    );
    result.insert("cast".into(), Value::Array(cast));
    result.insert("crew".into(), Value::Array(crew));
    result.insert("recommendations".into(), Value::Array(recs));
    result.insert("trailers".into(), Value::Array(trailers));
    insert_optional(
        &mut result,
        "imdbId",
        string(details, "imdb_id").map(Value::String),
    );
    result.insert("tmdbId".into(), Value::String(id.to_string()));
    result.insert("provider".into(), Value::String("tmdb".into()));
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn validates_provider_ids() {
        assert_eq!(clean_provider_id("tmdb-42", "tmdb").unwrap(), "42");
        assert_eq!(clean_provider_id("TMDB:42", "tmdb").unwrap(), "42");
        assert!(clean_provider_id("../42", "tmdb").is_err());
    }

    #[test]
    fn tmdb_mapping_matches_the_typescript_show_contract() {
        let mapped = map_tmdb_show(
            "7",
            "balanced",
            &json!({
                "name": "Example", "original_name": "Original", "first_air_date": "2020-03-04",
                "overview": "Overview", "tagline": "Tagline", "vote_average": 8.2, "vote_count": 15,
                "genres": [{"name": "Drama"}], "poster_path": "/poster.jpg", "backdrop_path": "/backdrop.jpg",
                "status": "Ended", "type": "Scripted", "number_of_seasons": 1, "number_of_episodes": 8,
                "seasons": [{"season_number": 0, "name": "Specials", "episode_count": 1},
                            {"season_number": 1, "name": "Season 1", "episode_count": 8, "poster_path": "/s1.jpg", "air_date": "2020-03-04"}]
            }),
            &json!({"cast": [{"id": 3, "name": "Actor", "character": "Lead", "profile_path": "/actor.jpg"}]}),
            &json!({"results": [{"id": "v1", "name": "Trailer", "key": "abc", "site": "YouTube", "type": "Trailer"},
                                      {"id": "v2", "site": "Vimeo"}]}),
            &json!({"results": [{"id": 8, "name": "Next", "first_air_date": "2021-01-01", "poster_path": "/next.jpg",
                                             "backdrop_path": "/next-bg.jpg", "overview": "Next overview", "vote_average": 7.0,
                                             "vote_count": 2, "popularity": 5.0, "original_language": "en", "origin_country": ["US"],
                                             "genre_ids": [18]}]}),
            &json!({"logos": [{"file_path": "/logo.png", "iso_639_1": "en"}], "posters": [], "backdrops": []}),
            &json!({"imdb_id": "tt0000007", "tvdb_id": 70}),
        ).unwrap();

        assert_eq!(
            mapped,
            json!({
                "id": "tmdb-7", "title": "Example", "originalTitle": "Original", "year": 2020,
                "firstAirDate": "2020-03-04", "overview": "Overview", "tagline": "Tagline", "rating": 8.2,
                "voteCount": 15, "genres": ["Drama"],
                "poster": "https://image.tmdb.org/t/p/w780/poster.jpg",
                "backdrop": "https://image.tmdb.org/t/p/original/backdrop.jpg",
                "logo": "https://image.tmdb.org/t/p/w300/logo.png", "status": "Ended", "seriesType": "Scripted",
                "numberOfSeasons": 1, "numberOfEpisodes": 8,
                "seasons": [{"seasonNumber": 1, "name": "Season 1", "episodeCount": 8,
                               "poster": "https://image.tmdb.org/t/p/w342/s1.jpg", "airDate": "2020-03-04"}],
                "cast": [{"id": "3", "personProvider": "tmdb", "name": "Actor", "character": "Lead",
                           "profilePath": "https://image.tmdb.org/t/p/w185/actor.jpg"}],
                "crew": [],
                "recommendations": [{"id": "tmdb-8", "title": "Next", "type": "series", "year": 2021,
                    "releaseDate": "2021-01-01", "poster": "https://image.tmdb.org/t/p/w342/next.jpg",
                    "backdrop": "https://image.tmdb.org/t/p/original/next-bg.jpg", "overview": "Next overview",
                    "rating": 7.0, "voteCount": 2, "popularity": 5.0, "originalLanguage": "en",
                    "originCountry": ["US"], "provider": "tmdb", "tmdbId": 8, "genreIds": [18]}],
                "trailers": [{"id": "v1", "name": "Trailer", "key": "abc", "site": "YouTube", "type": "Trailer",
                               "thumbnail": "https://img.youtube.com/vi/abc/hqdefault.jpg"}],
                "imdbId": "tt0000007", "tvdbId": 70, "tmdbId": "7", "provider": "tmdb"
            })
        );
    }

    #[test]
    fn tvdb_mapping_matches_the_typescript_show_contract_and_translation_fallback() {
        let mapped = map_tvdb_show(
            "9",
            &json!({
                "name": "日本語", "overview": "概要", "firstAired": "2019-05-06", "image": "poster.jpg",
                "status": {"id": 3}, "genres": [{"name": "Animation"}],
                "seasons": [
                    {"id": 90, "number": 1, "name": "第一期", "year": 2019, "image": "season.jpg", "type": {"type": "official"}},
                    {"id": 91, "number": 2, "name": "Alternate", "year": 2019, "type": {"type": "alternate"}}
                ],
                "characters": [{"peopleId": 4, "personName": "Actor", "name": "Hero", "type": 3, "personImgURL": "actor.jpg"}],
                "artworks": [
                    {"type": 3, "image": "backdrop.jpg", "width": 1920, "height": 1080},
                    {"type": 5, "image": "logo.png", "width": 600, "height": 200}
                ]
            }),
            |path| match path {
                "/seasons/90/translations/eng" => Ok(json!({"data": {"name": "Season One"}})),
                "/series/9/translations/eng" => Ok(json!({"data": {"name": "English", "overview": "English overview"}})),
                _ => Err("unexpected translation".into()),
            },
        ).unwrap();
        assert_eq!(
            mapped,
            json!({
                "id": "tvdb-9", "title": "English", "originalTitle": "日本語", "year": 2019,
                "firstAirDate": "2019-05-06", "overview": "English overview", "genres": ["Animation"],
                "poster": "poster.jpg", "backdrop": "backdrop.jpg", "logo": "logo.png", "status": "[object Object]",
                "numberOfSeasons": 1,
                "seasons": [{"seasonNumber": 1, "name": "Season One", "episodeCount": 0,
                               "poster": "season.jpg", "airDate": "2019-01-01"}],
                "cast": [{"id": "4", "personProvider": "tvdb", "name": "Actor", "character": "Hero", "profilePath": "actor.jpg"}],
                "crew": [], "recommendations": [], "trailers": [], "provider": "tvdb"
            })
        );
    }

    #[test]
    fn tmdb_movie_mapping_matches_the_typescript_contract() {
        let mapped = map_tmdb_movie(
            "11",
            "balanced",
            &json!({"title": "Movie", "original_title": "Original", "release_date": "2022-02-03",
                "overview": "Overview", "tagline": "Tag", "runtime": 101, "vote_average": 7.5, "vote_count": 20,
                "genres": [{"name": "Drama"}], "poster_path": "/poster.jpg", "backdrop_path": "/backdrop.jpg",
                "imdb_id": "tt11"}),
            &json!({"cast": [{"id": 1, "name": "Actor", "character": "Lead"}],
                "crew": [{"id": 2, "name": "Director", "job": "Director", "department": "Directing"},
                          {"id": 3, "name": "Producer", "job": "Producer"}]}),
            &json!({"results": []}),
            &json!({"results": []}),
            &json!({"logos": [{"file_path": "/logo.png", "iso_639_1": "en"}]}),
        ).unwrap();
        assert_eq!(
            mapped,
            json!({
                "id": "tmdb-11", "title": "Movie", "originalTitle": "Original", "year": 2022,
                "releaseDate": "2022-02-03", "overview": "Overview", "tagline": "Tag", "runtime": 101,
                "rating": 7.5, "voteCount": 20, "genres": ["Drama"],
                "poster": "https://image.tmdb.org/t/p/w780/poster.jpg",
                "backdrop": "https://image.tmdb.org/t/p/original/backdrop.jpg",
                "logo": "https://image.tmdb.org/t/p/w300/logo.png",
                "cast": [{"id": "1", "personProvider": "tmdb", "name": "Actor", "character": "Lead"}],
                "crew": [{"id": "2", "personProvider": "tmdb", "name": "Director", "job": "Director", "department": "Directing"}],
                "recommendations": [], "trailers": [], "imdbId": "tt11", "tmdbId": "11", "provider": "tmdb"
            })
        );
    }

    #[tokio::test]
    async fn existing_sqlite_detail_entries_keep_the_legacy_stale_serve_semantics() {
        let path = std::env::temp_dir().join(format!(
            "aurales-detail-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let db = Database::new(path.clone()).unwrap();
        let cached = json!({"id": "tmdb-7", "title": "Cached", "genres": [], "seasons": [], "cast": [], "crew": [], "recommendations": [], "trailers": []});
        cache::entry_set(
            &db,
            "detail:series-provider:v2:tmdb:7".into(),
            cached.to_string(),
            "detail_page".into(),
            Some(-1),
        )
        .unwrap();
        let response = load_detail_page(
            &DetailPageCoordinator::default(),
            &db,
            LoadDetailPageRequest {
                provider: "tmdb".into(),
                media_type: "series".into(),
                id: "7".into(),
                api_key: "unused".into(),
                image_quality: Some("balanced".into()),
                priority: "visible".into(),
                cancel_group: "detail".into(),
                timeout_ms: Some(1_000),
            },
        )
        .await
        .unwrap();
        assert_eq!(response.data, cached);
        assert_eq!(response.cache_status, "hit");
        drop(db);
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn duplicate_operations_are_coalesced() {
        let coordinator = Arc::new(DetailPageCoordinator::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let run = |group: &str| {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            let group = group.to_string();
            async move {
                coordinator
                    .run(
                        "tmdb:1".into(),
                        group,
                        2,
                        Duration::from_secs(1),
                        || async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            Ok(SharedResult {
                                data: json!({"id": 1}),
                                cache_status: "miss".into(),
                            })
                        },
                    )
                    .await
            }
        };
        let (first, second) = tokio::join!(run("detail:first"), run("detail:second"));
        assert_eq!(first.unwrap().data, second.unwrap().data);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn older_navigation_results_are_marked_stale() {
        let coordinator = Arc::new(DetailPageCoordinator::default());
        let first_coordinator = coordinator.clone();
        let first = tokio::spawn(async move {
            first_coordinator
                .run(
                    "A".into(),
                    "detail".into(),
                    2,
                    Duration::from_secs(1),
                    || async {
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        Ok(SharedResult {
                            data: json!("A"),
                            cache_status: "miss".into(),
                        })
                    },
                )
                .await
                .unwrap()
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        let second_coordinator = coordinator.clone();
        let second = tokio::spawn(async move {
            second_coordinator
                .run(
                    "B".into(),
                    "detail".into(),
                    2,
                    Duration::from_secs(1),
                    || async {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok(SharedResult {
                            data: json!("B"),
                            cache_status: "miss".into(),
                        })
                    },
                )
                .await
                .unwrap()
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        let third = coordinator
            .run(
                "C".into(),
                "detail".into(),
                2,
                Duration::from_secs(1),
                || async {
                    Ok(SharedResult {
                        data: json!("C"),
                        cache_status: "miss".into(),
                    })
                },
            )
            .await
            .unwrap();
        assert!(!third.stale);
        assert!(first.await.unwrap().stale);
        assert!(second.await.unwrap().stale);
    }

    #[tokio::test]
    async fn operation_timeout_is_reported() {
        let coordinator = DetailPageCoordinator::default();
        let result = coordinator
            .run(
                "slow".into(),
                "detail".into(),
                2,
                Duration::from_millis(10),
                || async {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    Ok(SharedResult {
                        data: Value::Null,
                        cache_status: "miss".into(),
                    })
                },
            )
            .await;
        assert_eq!(result.unwrap_err(), "Detail request timed out");
    }

    #[tokio::test]
    async fn limits_coarse_detail_operations_to_four() {
        let coordinator = Arc::new(DetailPageCoordinator::default());
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for index in 0..6 {
            let coordinator = coordinator.clone();
            let active = active.clone();
            let maximum = maximum.clone();
            tasks.push(tokio::spawn(async move {
                coordinator
                    .run(
                        format!("item:{index}"),
                        format!("group:{index}"),
                        2,
                        Duration::from_secs(1),
                        || async move {
                            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                            maximum.fetch_max(now, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(25)).await;
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok(SharedResult {
                                data: json!(index),
                                cache_status: "miss".into(),
                            })
                        },
                    )
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn queued_visible_work_runs_before_background_work() {
        let limiter = Arc::new(PriorityLimiter::new(1));
        let blocking = limiter.acquire(2).await.unwrap();
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();

        let background_limiter = limiter.clone();
        let background_tx = started_tx.clone();
        let background = tokio::spawn(async move {
            let _permit = background_limiter.acquire(1).await.unwrap();
            background_tx.send("background").unwrap();
        });
        tokio::task::yield_now().await;
        let visible_limiter = limiter.clone();
        let visible = tokio::spawn(async move {
            let _permit = visible_limiter.acquire(2).await.unwrap();
            started_tx.send("visible").unwrap();
        });
        tokio::task::yield_now().await;
        drop(blocking);

        assert_eq!(started_rx.recv().await, Some("visible"));
        visible.await.unwrap();
        background.await.unwrap();
        assert_eq!(started_rx.recv().await, Some("background"));
    }
}
