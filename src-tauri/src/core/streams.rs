//! Tauri orchestration adapter around Aurales' shared stream-ranking domain.

use crate::core::detail_page::{priority_score, DetailPageCoordinator, SharedResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::hash::{Hash, Hasher};
use std::time::Duration;

pub use aurales_domain::streams::{rank_streams, RankStreamCandidatesResponse, SmartScoreContext};

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
