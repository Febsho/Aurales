use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeTitleSelectionRequest {
    pub titles: AnimeTitles,
    pub preference: String,
}

#[derive(Deserialize)]
pub struct AnimeTitles {
    pub english: Option<String>,
    pub romaji: Option<String>,
    pub native: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeTitleSelection {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub localized_title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeSeasonTitleRequest {
    pub title: Option<String>,
    pub season_number: i64,
    pub preference: String,
    pub use_generic_labels: bool,
    pub avoid_japanese: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeSeasonTitle {
    pub display_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_title: Option<String>,
}

fn is_likely_japanese_only(value: &str) -> bool {
    value.chars().any(
        |character| matches!(character as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9faf),
    )
}

pub fn resolve_season_title(request: AnimeSeasonTitleRequest) -> AnimeSeasonTitle {
    if request.season_number == 0 {
        return AnimeSeasonTitle {
            display_title: "Specials".into(),
            original_title: None,
            native_title: None,
        };
    }
    let Some(title) = request.title.filter(|title| !title.is_empty()) else {
        return AnimeSeasonTitle {
            display_title: format!("Season {}", request.season_number),
            original_title: None,
            native_title: None,
        };
    };
    let japanese = is_likely_japanese_only(&title);
    if japanese && request.avoid_japanese {
        return AnimeSeasonTitle {
            display_title: format!("Season {}", request.season_number),
            original_title: Some(title.clone()),
            native_title: Some(title),
        };
    }
    if request.use_generic_labels && !japanese {
        return AnimeSeasonTitle {
            display_title: format!("Season {}", request.season_number),
            original_title: None,
            native_title: None,
        };
    }
    if request.preference == "native" || !request.avoid_japanese {
        return AnimeSeasonTitle {
            display_title: title,
            original_title: None,
            native_title: None,
        };
    }
    AnimeSeasonTitle {
        display_title: format!("Season {}", request.season_number),
        original_title: Some(title),
        native_title: None,
    }
}

pub fn select_title(request: AnimeTitleSelectionRequest) -> AnimeTitleSelection {
    let titles = request.titles;
    let english = titles.english.as_deref().filter(|value| !value.is_empty());
    let romaji = titles.romaji.as_deref().filter(|value| !value.is_empty());
    let native = titles.native.as_deref().filter(|value| !value.is_empty());
    let auto = english.or(romaji).or(native).unwrap_or("Unknown");
    let selected = match request.preference.as_str() {
        "english" => english.or(romaji).or(native),
        "romaji" => romaji.or(english).or(native),
        "native" => native.or(romaji).or(english),
        _ => Some(auto),
    }
    .unwrap_or("Unknown");
    AnimeTitleSelection {
        title: selected.to_string(),
        original_title: titles.native,
        localized_title: english.or(romaji).map(str::to_string),
    }
}

/// A normalized Fribb entry selected by the native indexed dataset or supplied
/// by the browser compatibility path. This operation owns the deterministic
/// cour/episode arithmetic for either source.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeEpisodeResolutionRequest {
    pub operation: String,
    #[serde(default)]
    pub entries: Vec<AnimeEpisodeMappingEntry>,
    pub season: i64,
    pub episode: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeEpisodeMappingEntry {
    pub anilist_id: Option<i64>,
    pub mal_id: Option<i64>,
    pub simkl_id: Option<i64>,
    pub trakt_id: Option<i64>,
    pub tvdb_id: Option<i64>,
    pub tmdb_id: Option<i64>,
    pub tvdb_season: Option<i64>,
    #[serde(default)]
    pub tvdb_episode_offset: i64,
    #[serde(default)]
    pub tmdb_episode_offset: i64,
    pub trakt_season: Option<i64>,
    pub tmdb_season: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeTvdbEpisodeMapping {
    pub tvdb_id: i64,
    pub season: i64,
    pub episode: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeAniListEpisodeMapping {
    pub anilist_id: i64,
    pub absolute_episode: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeProviderEpisodeMapping {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anilist_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mal_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simkl_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trakt_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmdb_id: Option<i64>,
    pub episode: i64,
    pub season: i64,
    pub tmdb_season: i64,
    pub tmdb_episode: i64,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AnimeEpisodeResolution {
    Tvdb(AnimeTvdbEpisodeMapping),
    AniList(AnimeAniListEpisodeMapping),
    Providers(AnimeProviderEpisodeMapping),
}

/// Resolve episode positions between TVDB's canonical structure and the
/// provider/cour layout described by Fribb.  Season zero is deliberately not
/// special-cased: specials only map when Fribb explicitly supplies a season 0
/// entry, matching the legacy resolver.
pub fn resolve_episode_mapping(
    request: AnimeEpisodeResolutionRequest,
) -> Option<AnimeEpisodeResolution> {
    match request.operation.as_str() {
        "anilistToTvdb" => {
            let mut entries = request
                .entries
                .into_iter()
                .filter(|entry| entry.tvdb_season.is_some() && entry.tvdb_id.is_some())
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.tvdb_episode_offset);
            let mut matched = entries.first()?;
            for entry in &entries {
                if request.episode > entry.tvdb_episode_offset {
                    matched = entry;
                } else {
                    break;
                }
            }
            Some(AnimeEpisodeResolution::Tvdb(AnimeTvdbEpisodeMapping {
                tvdb_id: matched.tvdb_id?,
                season: matched.tvdb_season?,
                episode: request.episode - matched.tvdb_episode_offset,
            }))
        }
        "tvdbToAnilist" => {
            let mut entries = request
                .entries
                .into_iter()
                .filter(|entry| {
                    entry.tvdb_season == Some(request.season) && entry.anilist_id.is_some()
                })
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.tvdb_episode_offset);
            let mut matched = entries.first()?;
            for entry in &entries {
                if request.episode > entry.tvdb_episode_offset {
                    matched = entry;
                } else {
                    break;
                }
            }
            Some(AnimeEpisodeResolution::AniList(
                AnimeAniListEpisodeMapping {
                    anilist_id: matched.anilist_id?,
                    absolute_episode: request.episode - matched.tvdb_episode_offset,
                },
            ))
        }
        "tvdbToProviders" => {
            let matched = request
                .entries
                .into_iter()
                .filter(|entry| {
                    entry.tvdb_season == Some(request.season)
                        && entry.tvdb_episode_offset < request.episode
                })
                .max_by_key(|entry| entry.tvdb_episode_offset)?;
            let relative_episode = request.episode - matched.tvdb_episode_offset;
            Some(AnimeEpisodeResolution::Providers(
                AnimeProviderEpisodeMapping {
                    anilist_id: matched.anilist_id,
                    mal_id: matched.mal_id,
                    simkl_id: matched.simkl_id,
                    trakt_id: matched.trakt_id,
                    tmdb_id: matched.tmdb_id,
                    episode: relative_episode,
                    season: matched.trakt_season.unwrap_or(request.season),
                    tmdb_season: matched.tmdb_season.unwrap_or(request.season),
                    tmdb_episode: relative_episode + matched.tmdb_episode_offset,
                },
            ))
        }
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeStructureRequest {
    pub seasons: Vec<AnimeSeasonInput>,
    #[serde(default)]
    pub expected_multi_season: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeSeasonInput {
    pub season_number: i64,
    #[serde(default)]
    pub episodes: Vec<AnimeEpisodeInput>,
    pub air_date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeEpisodeInput {
    pub episode_number: i64,
    pub absolute_episode_number: Option<i64>,
    pub is_released: Option<bool>,
    pub air_date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeStructureValidation {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub suspicious_single_season_flattening: bool,
    pub has_multiple_real_seasons: bool,
    pub season_count: usize,
    pub total_episode_count: usize,
    pub score: i64,
}

pub fn validate_structure(request: AnimeStructureRequest) -> AnimeStructureValidation {
    let non_special: Vec<_> = request
        .seasons
        .iter()
        .filter(|season| season.season_number > 0)
        .collect();
    let season_count = non_special.len();
    let total_episode_count = non_special.iter().map(|season| season.episodes.len()).sum();
    let mut suspicious = false;
    let mut reason = None;

    if season_count == 1
        && non_special[0].season_number == 1
        && non_special[0].episodes.len() > 13
        && request.expected_multi_season
    {
        if non_special[0].episodes.iter().any(|episode| {
            episode.episode_number >= 13
                || episode
                    .absolute_episode_number
                    .is_some_and(|number| number >= 13)
        }) {
            suspicious = true;
            reason =
                Some("Single season with 13+ episodes where multi-season expected from relations");
        }
    }
    if season_count == 1 && non_special[0].episodes.len() > 24 && request.expected_multi_season {
        suspicious = true;
        reason = reason.or(Some(
            "Single season with 24+ episodes where multi-season expected",
        ));
    }

    AnimeStructureValidation {
        valid: !suspicious,
        reason,
        suspicious_single_season_flattening: suspicious,
        has_multiple_real_seasons: season_count > 1,
        season_count,
        total_episode_count,
        score: score_structure(&request.seasons, request.expected_multi_season),
    }
}

fn score_structure(seasons: &[AnimeSeasonInput], expected_multi_season: bool) -> i64 {
    let non_special: Vec<_> = seasons
        .iter()
        .filter(|season| season.season_number > 0)
        .collect();
    let mut score = 0;
    if non_special.len() > 1 && expected_multi_season {
        score += 50;
    }
    if non_special.iter().any(|season| {
        season
            .episodes
            .iter()
            .any(|episode| episode.is_released == Some(true))
    }) {
        score += 30;
    }
    if non_special.iter().any(|season| season.season_number >= 2) {
        score += 20;
    }
    let episodes_reset = non_special.iter().all(|season| {
        season
            .episodes
            .first()
            .map_or(true, |episode| episode.episode_number <= 2)
    });
    if episodes_reset && non_special.len() > 1 {
        score += 20;
    }
    if seasons.iter().any(|season| season.season_number == 0) {
        score += 10;
    }
    if non_special.len() == 1 && non_special[0].episodes.len() > 13 {
        score -= 50;
    }
    let all_absolute_match = non_special.iter().all(|season| {
        season
            .episodes
            .iter()
            .all(|episode| episode.absolute_episode_number == Some(episode.episode_number))
    });
    if all_absolute_match && non_special.len() == 1 {
        score -= 40;
    }
    let unreleased_dominate = non_special
        .iter()
        .filter(|season| {
            !season.episodes.is_empty()
                && season
                    .episodes
                    .iter()
                    .all(|episode| episode.is_released != Some(true))
        })
        .count() as f64
        > non_special.len() as f64 / 2.0;
    if unreleased_dominate {
        score -= 30;
    }
    let no_air_dates = non_special.iter().all(|season| {
        season
            .episodes
            .iter()
            .all(|episode| episode.air_date.is_none())
            && season.air_date.is_none()
    });
    if no_air_dates && non_special.len() <= 1 {
        score -= 20;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_flattened_multi_season_anime() {
        let request = AnimeStructureRequest {
            expected_multi_season: true,
            seasons: vec![AnimeSeasonInput {
                season_number: 1,
                air_date: Some("2020-01-01".into()),
                episodes: (1..=14)
                    .map(|episode_number| AnimeEpisodeInput {
                        episode_number,
                        absolute_episode_number: Some(episode_number),
                        is_released: Some(true),
                        air_date: Some("2020-01-01".into()),
                    })
                    .collect(),
            }],
        };
        let result = validate_structure(request);
        assert!(!result.valid);
        assert_eq!(result.score, -60);
        assert_eq!(
            result.reason,
            Some("Single season with 13+ episodes where multi-season expected from relations")
        );
    }

    #[test]
    fn keeps_anime_title_preference_order() {
        let selected = select_title(AnimeTitleSelectionRequest {
            titles: AnimeTitles {
                english: Some("English".into()),
                romaji: Some("Romaji".into()),
                native: Some("Native".into()),
            },
            preference: "native".into(),
        });
        assert_eq!(selected.title, "Native");
        assert_eq!(selected.localized_title.as_deref(), Some("English"));
    }

    #[test]
    fn preserves_specials_and_japanese_season_title_handling() {
        assert_eq!(
            resolve_season_title(AnimeSeasonTitleRequest {
                title: Some("Ignored".into()),
                season_number: 0,
                preference: "auto".into(),
                use_generic_labels: true,
                avoid_japanese: true,
            })
            .display_title,
            "Specials"
        );
        let resolved = resolve_season_title(AnimeSeasonTitleRequest {
            title: Some("進撃の巨人".into()),
            season_number: 2,
            preference: "auto".into(),
            use_generic_labels: false,
            avoid_japanese: true,
        });
        assert_eq!(resolved.display_title, "Season 2");
        assert_eq!(resolved.native_title.as_deref(), Some("進撃の巨人"));
    }

    fn mapping_entry(
        season: i64,
        offset: i64,
        anilist_id: Option<i64>,
    ) -> AnimeEpisodeMappingEntry {
        AnimeEpisodeMappingEntry {
            anilist_id,
            mal_id: anilist_id.map(|id| id + 100),
            simkl_id: anilist_id.map(|id| id + 200),
            trakt_id: anilist_id.map(|id| id + 300),
            tvdb_id: Some(900),
            tmdb_id: Some(800),
            tvdb_season: Some(season),
            tvdb_episode_offset: offset,
            tmdb_episode_offset: offset + 1,
            trakt_season: Some(season + 10),
            tmdb_season: Some(season + 20),
        }
    }

    #[test]
    fn resolves_fribb_cours_with_legacy_offset_boundaries() {
        let entries = vec![
            mapping_entry(1, 0, Some(101)),
            mapping_entry(1, 12, Some(102)),
            mapping_entry(0, 0, Some(103)),
        ];
        let anilist_to_tvdb = resolve_episode_mapping(AnimeEpisodeResolutionRequest {
            operation: "anilistToTvdb".into(),
            entries: entries.clone(),
            season: 0,
            episode: 13,
        });
        assert!(matches!(
            anilist_to_tvdb,
            Some(AnimeEpisodeResolution::Tvdb(AnimeTvdbEpisodeMapping {
                tvdb_id: 900,
                season: 1,
                episode: 1,
            }))
        ));

        // The TypeScript resolver intentionally uses a strict offset boundary:
        // episode 12 stays with the first cour; episode 13 starts the second.
        let tvdb_to_anilist = resolve_episode_mapping(AnimeEpisodeResolutionRequest {
            operation: "tvdbToAnilist".into(),
            entries: entries.clone(),
            season: 1,
            episode: 12,
        });
        assert!(matches!(
            tvdb_to_anilist,
            Some(AnimeEpisodeResolution::AniList(
                AnimeAniListEpisodeMapping {
                    anilist_id: 101,
                    absolute_episode: 12,
                }
            ))
        ));

        let providers = resolve_episode_mapping(AnimeEpisodeResolutionRequest {
            operation: "tvdbToProviders".into(),
            entries,
            season: 1,
            episode: 13,
        });
        assert!(matches!(
            providers,
            Some(AnimeEpisodeResolution::Providers(
                AnimeProviderEpisodeMapping {
                    anilist_id: Some(102),
                    episode: 1,
                    season: 11,
                    tmdb_season: 21,
                    tmdb_episode: 14,
                    ..
                }
            ))
        ));
    }

    #[test]
    fn keeps_specials_explicit_and_does_not_map_unmatched_boundaries() {
        let entries = vec![mapping_entry(0, 0, Some(103))];
        let special = resolve_episode_mapping(AnimeEpisodeResolutionRequest {
            operation: "tvdbToProviders".into(),
            entries: entries.clone(),
            season: 0,
            episode: 1,
        });
        assert!(matches!(
            special,
            Some(AnimeEpisodeResolution::Providers(_))
        ));
        let unmatched = resolve_episode_mapping(AnimeEpisodeResolutionRequest {
            operation: "tvdbToProviders".into(),
            entries,
            season: 1,
            episode: 1,
        });
        assert!(unmatched.is_none());
    }
}
