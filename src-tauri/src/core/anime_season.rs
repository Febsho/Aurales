use crate::core::cache;
use crate::core::detail_page::{
    priority_score, DetailPageCoordinator, LoadDetailPageResponse, SharedResult,
};
use crate::db::Database;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::time::Duration;

const TVDB_BASE_URL: &str = "https://api4.thetvdb.com/v4";
const SEASON_CACHE_TTL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAnimeSeasonRequest {
    pub tvdb_id: String,
    pub season: i64,
    pub api_key: String,
    pub cache_key: String,
    pub cancel_group: String,
    pub priority: String,
    pub force_refresh: Option<bool>,
    pub timeout_ms: Option<u64>,
}

pub async fn load_anime_season(
    coordinator: &DetailPageCoordinator,
    db: &Database,
    request: LoadAnimeSeasonRequest,
) -> Result<LoadDetailPageResponse, String> {
    let tvdb_id = request
        .tvdb_id
        .trim()
        .trim_start_matches("tvdb-")
        .trim_start_matches("tvdb:")
        .to_string();
    if tvdb_id.is_empty() || !tvdb_id.chars().all(|character| character.is_ascii_digit()) {
        return Err("Invalid TVDB series ID".to_string());
    }
    if request.season < 0 {
        return Err("Invalid TVDB season number".to_string());
    }
    let expected_key = format!("tvdb_season:english-v2:{tvdb_id}:{}", request.season);
    if request.cache_key != expected_key {
        return Err("Invalid TVDB season cache key".to_string());
    }
    let operation_key = format!("anime-season:{tvdb_id}:{}", request.season);
    let priority = priority_score(&request.priority);
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000));
    let api_key = request.api_key;
    let season = request.season;
    let cache_key = request.cache_key;
    let force_refresh = request.force_refresh.unwrap_or(false);

    coordinator
        .run(
            operation_key,
            request.cancel_group,
            priority,
            timeout,
            || async move {
                if !force_refresh {
                    if let Some(entry) = cache::entry_get(db, cache_key.clone()) {
                        if !cache_entry_expired(entry.expires_at.as_deref()) {
                            if let Ok(data) = serde_json::from_str::<Value>(&entry.value) {
                                return Ok(SharedResult {
                                    data,
                                    cache_status: "hit".into(),
                                });
                            }
                        }
                    }
                }
                let data = tokio::task::spawn_blocking(move || {
                    fetch_tvdb_season(&tvdb_id, season, &api_key)
                })
                .await
                .map_err(|error| format!("TVDB season worker failed: {error}"))??;
                cache::entry_set(
                    db,
                    cache_key,
                    data.to_string(),
                    "tvdb_season".into(),
                    Some(SEASON_CACHE_TTL_SECONDS),
                )?;
                Ok(SharedResult {
                    data,
                    cache_status: "miss".into(),
                })
            },
        )
        .await
}

fn cache_entry_expired(expires_at: Option<&str>) -> bool {
    let Some(expires_at) = expires_at else {
        return false;
    };
    chrono::NaiveDateTime::parse_from_str(expires_at, "%Y-%m-%d %H:%M:%S")
        .map(|expires_at| expires_at < chrono::Utc::now().naive_utc())
        .unwrap_or(false)
}

fn tvdb_get(agent: &ureq::Agent, path: &str, token: &str) -> Result<Value, String> {
    agent
        .get(&format!("{TVDB_BASE_URL}{path}"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept-Language", "eng")
        .call()
        .map_err(|error| format!("TVDB season request failed: {error}"))?
        .into_json()
        .map_err(|error| format!("Failed to parse TVDB season response: {error}"))
}

fn has_japanese_text(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| {
        text.chars().any(|character| {
            ('\u{3040}'..='\u{30ff}').contains(&character)
                || ('\u{3400}'..='\u{9fff}').contains(&character)
        })
    })
}

fn fetch_tvdb_season(tvdb_id: &str, season_number: i64, api_key: &str) -> Result<Value, String> {
    if api_key.trim().is_empty() {
        return Err("TVDB API key is required".into());
    }
    let agent = ureq::builder().timeout(Duration::from_secs(12)).build();
    let login = agent
        .post(&format!("{TVDB_BASE_URL}/login"))
        .set("Content-Type", "application/json")
        .send_json(serde_json::json!({"apikey": api_key}))
        .map_err(|error| format!("TVDB login failed: {error}"))?
        .into_json::<Value>()
        .map_err(|error| format!("Failed to parse TVDB login response: {error}"))?;
    let token = login
        .pointer("/data/token")
        .and_then(Value::as_str)
        .ok_or_else(|| "TVDB login response did not contain a token".to_string())?;
    let series_response = tvdb_get(&agent, &format!("/series/{tvdb_id}/extended"), token)?;
    let target = series_response
        .pointer("/data/seasons")
        .and_then(Value::as_array)
        .and_then(|seasons| {
            seasons.iter().find(|season| {
                season.pointer("/type/type").and_then(Value::as_str) == Some("official")
                    && season.get("number").and_then(Value::as_i64) == Some(season_number)
            })
        })
        .cloned()
        .ok_or_else(|| format!("TVDB season {season_number} not found for series {tvdb_id}"))?;
    let season_id = target
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| "TVDB season record did not contain an ID".to_string())?;
    let season_response = tvdb_get(&agent, &format!("/seasons/{season_id}/extended"), token)?;
    let mut episodes = season_response
        .pointer("/data/episodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let translation_indices = episodes
        .iter()
        .enumerate()
        .filter_map(|(index, episode)| {
            if has_japanese_text(episode.get("name")) || has_japanese_text(episode.get("overview"))
            {
                episode
                    .get("id")
                    .and_then(Value::as_i64)
                    .map(|id| (index, id))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for batch in translation_indices.chunks(2) {
        let translations = std::thread::scope(|scope| {
            batch
                .iter()
                .map(|(index, episode_id)| {
                    let agent = agent.clone();
                    let token = token.to_string();
                    scope.spawn(move || {
                        (
                            *index,
                            tvdb_get(
                                &agent,
                                &format!("/episodes/{episode_id}/translations/eng"),
                                &token,
                            )
                            .ok(),
                        )
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .collect::<Vec<_>>()
        });
        for (index, translation) in translations {
            let Some(english) = translation.and_then(|value| value.get("data").cloned()) else {
                continue;
            };
            let Some(episode) = episodes.get_mut(index).and_then(Value::as_object_mut) else {
                continue;
            };
            if let Some(name) = english.get("name").filter(|value| !value.is_null()) {
                episode.insert("name".into(), name.clone());
            }
            if let Some(overview) = english.get("overview").filter(|value| !value.is_null()) {
                episode.insert("overview".into(), overview.clone());
            }
        }
    }
    Ok(map_tvdb_season(season_number, &target, &episodes))
}

fn map_tvdb_season(season_number: i64, target: &Value, episodes: &[Value]) -> Value {
    let mut mapped_episodes = episodes
        .iter()
        .filter(|episode| {
            episode
                .get("seasonNumber")
                .and_then(Value::as_i64)
                .map(|number| number == season_number)
                .unwrap_or(true)
        })
        .map(|episode| {
            let mut mapped = Map::new();
            mapped.insert(
                "id".into(),
                Value::String(episode.get("id").map(Value::to_string).unwrap_or_default()),
            );
            let episode_number = episode
                .get("number")
                .filter(|value| !value.is_null())
                .or_else(|| episode.get("airedEpisodeNumber"))
                .cloned()
                .unwrap_or(Value::Null);
            mapped.insert("episodeNumber".into(), episode_number.clone());
            mapped.insert("seasonNumber".into(), Value::from(season_number));
            for (source, target) in [
                ("name", "name"),
                ("overview", "overview"),
                ("aired", "airDate"),
                ("runtime", "runtime"),
                ("image", "still"),
            ] {
                if let Some(value) = episode.get(source).filter(|value| !value.is_null()) {
                    mapped.insert(target.into(), value.clone());
                }
            }
            mapped.insert("debugSource".into(), Value::String("tvdb".into()));
            mapped.insert(
                "debugResolverStep".into(),
                Value::String("tvdbProvider.getSeason".into()),
            );
            if let Some(value) = episode
                .get("seasonNumber")
                .filter(|value| value.is_number())
            {
                mapped.insert("debugOriginalSeasonNumber".into(), value.clone());
            }
            if episode_number.is_number() {
                mapped.insert("debugOriginalEpisodeNumber".into(), episode_number);
            }
            if let Some(value) = episode
                .get("absoluteNumber")
                .filter(|value| value.is_number())
            {
                mapped.insert("debugOriginalAbsoluteNumber".into(), value.clone());
            }
            Value::Object(mapped)
        })
        .collect::<Vec<_>>();
    mapped_episodes.sort_by_key(|episode| {
        episode
            .get("episodeNumber")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    serde_json::json!({
        "seasonNumber": season_number,
        "name": target.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("Season {season_number}")),
        "episodes": mapped_episodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_and_filters_tvdb_episodes_like_the_typescript_provider() {
        let mapped = map_tvdb_season(
            1,
            &serde_json::json!({"name": "Season 1"}),
            &[
                serde_json::json!({"id": 2, "number": 2, "seasonNumber": 1, "name": "Two", "aired": "2020-01-02", "absoluteNumber": 12}),
                serde_json::json!({"id": 1, "number": 1, "seasonNumber": 1, "name": "One"}),
                serde_json::json!({"id": 3, "number": 1, "seasonNumber": 2, "name": "Wrong season"}),
            ],
        );
        assert_eq!(
            mapped.pointer("/episodes/0/id"),
            Some(&Value::String("1".into()))
        );
        assert_eq!(
            mapped.pointer("/episodes/1/debugOriginalAbsoluteNumber"),
            Some(&Value::from(12))
        );
        assert_eq!(mapped.pointer("/episodes/2"), None);
    }

    #[test]
    fn native_cache_read_does_not_turn_expired_entries_into_permanent_hits() {
        assert!(cache_entry_expired(Some("2000-01-01 00:00:00")));
        assert!(!cache_entry_expired(Some("2999-01-01 00:00:00")));
        assert!(!cache_entry_expired(None));
    }
}
