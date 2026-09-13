use super::LoadDetailPageResponse;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch, Mutex, OwnedSemaphorePermit, Semaphore};

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

pub(super) struct PriorityLimiter {
    limit: usize,
    state: Mutex<PriorityLimitState>,
}

impl PriorityLimiter {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit,
            state: Mutex::new(PriorityLimitState {
                active: 0,
                sequence: 0,
                waiting: vec![],
            }),
        }
    }

    pub(super) async fn acquire(self: &Arc<Self>, priority: u8) -> Result<PriorityPermit, String> {
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

pub(super) struct PriorityPermit {
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
            let deadline = tokio::time::Instant::now() + timeout;
            let result =
                match tokio::time::timeout_at(deadline, self.limiter.acquire(priority)).await {
                    Ok(Ok(permit)) => {
                        let result = if self.is_stale(&key, &group, generation).await {
                            Err("Detail request was superseded".to_string())
                        } else {
                            // Blocking HTTP workers cannot be cancelled by dropping their
                            // join handle. Keep the slot and shared request until they
                            // finish, so a timeout cannot overlap a legacy retry.
                            let operation = operation();
                            tokio::pin!(operation);
                            match tokio::time::timeout_at(deadline, &mut operation).await {
                                Ok(result) => result,
                                // Preserve a successful late result instead of causing
                                // compatibility code to repeat completed provider work.
                                Err(_) => operation.await,
                            }
                        };
                        drop(permit);
                        result
                    }
                    Ok(Err(error)) => Err(error),
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
