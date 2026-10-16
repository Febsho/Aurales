use super::LoadDetailPageResponse;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;
use tokio::sync::{oneshot, watch, Mutex, OwnedSemaphorePermit, Semaphore};

#[derive(Clone)]
pub(crate) struct SharedResult {
    pub(crate) data: Value,
    pub(crate) cache_status: String,
}

#[derive(Default)]
struct CoordinatorState {
    next_generation: u64,
    inflight: HashMap<String, watch::Sender<Option<Result<SharedResult, String>>>>,
    groups: HashMap<String, RequestGroup>,
}

struct RequestGroup {
    key: String,
    generation: u64,
    users: usize,
}

struct InflightRequestGuard {
    state: Arc<Mutex<CoordinatorState>>,
    key: String,
    group: String,
    generation: u64,
    sender: watch::Sender<Option<Result<SharedResult, String>>>,
    armed: bool,
}

impl InflightRequestGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

fn cleanup_abandoned_request(
    state: &mut CoordinatorState,
    key: &str,
    group: &str,
    generation: u64,
    sender: &watch::Sender<Option<Result<SharedResult, String>>>,
) {
    if state
        .inflight
        .get(key)
        .is_some_and(|current| current.same_channel(sender))
    {
        state.inflight.remove(key);
    }
    let should_remove = match state.groups.get_mut(group) {
        Some(active) if active.key == key && active.generation == generation => {
            active.users = active.users.saturating_sub(1);
            active.users == 0
        }
        _ => false,
    };
    if should_remove {
        state.groups.remove(group);
    }
}

impl Drop for InflightRequestGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.sender
            .send_replace(Some(Err("Detail request was cancelled".to_string())));
        let state = self.state.clone();
        let key = self.key.clone();
        let group = self.group.clone();
        let generation = self.generation;
        let sender = self.sender.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut state = state.lock().await;
                cleanup_abandoned_request(&mut state, &key, &group, generation, &sender);
            });
        } else if let Ok(mut state) = self.state.try_lock() {
            cleanup_abandoned_request(
                &mut state,
                &self.key,
                &self.group,
                self.generation,
                &self.sender,
            );
        }
    }
}

pub struct DetailPageCoordinator {
    state: Arc<Mutex<CoordinatorState>>,
    limiter: Arc<PriorityLimiter>,
    provider_limiters: Mutex<HashMap<String, Weak<Semaphore>>>,
}

impl Default for DetailPageCoordinator {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(CoordinatorState::default())),
            limiter: Arc::new(PriorityLimiter::new(4)),
            provider_limiters: Mutex::new(HashMap::new()),
        }
    }
}

struct PriorityWaiter {
    key: String,
    priority: u8,
    sequence: u64,
    sender: oneshot::Sender<PriorityPermit>,
}

struct PriorityLimitState {
    active: usize,
    sequence: u64,
    waiting: Vec<PriorityWaiter>,
}

pub(super) struct PriorityLimiter {
    limit: usize,
    state: StdMutex<PriorityLimitState>,
}

impl PriorityLimiter {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit,
            state: StdMutex::new(PriorityLimitState {
                active: 0,
                sequence: 0,
                waiting: vec![],
            }),
        }
    }

    pub(super) async fn acquire(self: &Arc<Self>, priority: u8) -> Result<PriorityPermit, String> {
        self.acquire_for(String::new(), priority).await
    }

    async fn acquire_for(
        self: &Arc<Self>,
        key: String,
        priority: u8,
    ) -> Result<PriorityPermit, String> {
        let receiver = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.active < self.limit {
                state.active += 1;
                return Ok(PriorityPermit {
                    limiter: self.clone(),
                    armed: true,
                });
            } else {
                let sequence = state.sequence;
                state.sequence = state.sequence.saturating_add(1);
                let (sender, receiver) = oneshot::channel();
                state.waiting.push(PriorityWaiter {
                    key,
                    priority,
                    sequence,
                    sender,
                });
                (receiver, sequence)
            }
        };
        let (receiver, sequence) = receiver;
        let mut waiter_guard = PriorityWaiterGuard {
            limiter: self.clone(),
            sequence,
            armed: true,
        };
        let permit = receiver
            .await
            .map_err(|_| "Detail request coordinator closed".to_string())?;
        waiter_guard.armed = false;
        Ok(permit)
    }

    fn reprioritize(&self, key: &str, priority: u8) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(waiter) = state
            .waiting
            .iter_mut()
            .find(|waiter| waiter.key.as_str() == key)
        {
            waiter.priority = waiter.priority.max(priority);
        }
    }

    fn release(self: &Arc<Self>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
            state.active += 1;
            match waiter.sender.send(PriorityPermit {
                limiter: self.clone(),
                armed: true,
            }) {
                Ok(()) => break,
                Err(mut permit) => {
                    // A cancelled waiter may still be selected after its
                    // receiver was dropped. Reclaim the reservation here and
                    // continue so it cannot leak a global queue slot.
                    permit.armed = false;
                    state.active = state.active.saturating_sub(1);
                }
            }
        }
    }
}

struct PriorityWaiterGuard {
    limiter: Arc<PriorityLimiter>,
    sequence: u64,
    armed: bool,
}

impl Drop for PriorityWaiterGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self
            .limiter
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .waiting
            .retain(|waiter| waiter.sequence != self.sequence);
    }
}

pub(super) struct PriorityPermit {
    limiter: Arc<PriorityLimiter>,
    armed: bool,
}

impl Drop for PriorityPermit {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.limiter.release();
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
    pub(crate) async fn provider_limiter(&self, provider: &str) -> Arc<Semaphore> {
        let mut limiters = self.provider_limiters.lock().await;
        limiters.retain(|_, limiter| limiter.strong_count() > 0);
        if let Some(limiter) = limiters.get(provider).and_then(Weak::upgrade) {
            return limiter;
        }
        let limiter = Arc::new(Semaphore::new(1));
        limiters.insert(provider.to_string(), Arc::downgrade(&limiter));
        limiter
    }

    pub(crate) async fn acquire_provider(
        &self,
        provider: &str,
    ) -> Result<OwnedSemaphorePermit, String> {
        self.provider_limiter(provider)
            .await
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
            Some(active) if active.key == key => active.generation,
            _ => {
                state.next_generation = state.next_generation.saturating_add(1);
                state.next_generation
            }
        };
        if let Some(active) = state
            .groups
            .get_mut(group)
            .filter(|active| active.key == key && active.generation == generation)
        {
            active.users += 1;
        } else {
            state.groups.insert(
                group.to_string(),
                RequestGroup {
                    key: key.to_string(),
                    generation,
                    users: 1,
                },
            );
        }

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
            .map(|active| active.key != key || active.generation != generation)
            .unwrap_or(true)
    }

    /// Releases one caller's generation reference and removes completed group
    /// keys. The stale check and decrement share one lock so a new generation
    /// cannot race between validation and cleanup.
    async fn finish_group(
        &self,
        key: &str,
        group: &str,
        generation: u64,
        finish_request: bool,
    ) -> bool {
        let mut state = self.state.lock().await;
        if finish_request {
            state.inflight.remove(key);
        }
        let should_remove = {
            let Some(active) = state.groups.get_mut(group) else {
                return true;
            };
            if active.key != key || active.generation != generation {
                return true;
            }
            active.users = active.users.saturating_sub(1);
            active.users == 0
        };
        if should_remove {
            state.groups.remove(group);
        }
        false
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
        let owns_request = leader.is_some();
        let deadline = tokio::time::Instant::now() + timeout;
        let result = if let Some(mut receiver) = follower {
            // The shared operation may still be queued behind the global
            // limiter. A newly visible consumer must be able to raise its
            // priority instead of waiting behind unrelated background work.
            self.limiter.reprioritize(&key, priority);
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    break result;
                }
                match tokio::time::timeout_at(deadline, receiver.changed()).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break Err("Detail request was cancelled".to_string()),
                    Err(_) => break Err("Detail request timed out".to_string()),
                }
            }
        } else {
            let sender = leader.expect("a new request always owns a sender");
            let mut request_guard = InflightRequestGuard {
                state: self.state.clone(),
                key: key.clone(),
                group: group.clone(),
                generation,
                sender: sender.clone(),
                armed: true,
            };
            let result = match tokio::time::timeout_at(
                deadline,
                self.limiter.acquire_for(key.clone(), priority),
            )
            .await
            {
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
            request_guard.disarm();
            result
        };

        let stale = self
            .finish_group(&key, &group, generation, owns_request)
            .await;
        let result = result?;

        Ok(LoadDetailPageResponse {
            data: result.data,
            stale,
            cache_status: result.cache_status,
        })
    }
}
