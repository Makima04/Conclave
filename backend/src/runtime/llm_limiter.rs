use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const DEFAULT_LLM_CONCURRENCY_LIMIT: usize = 4;
pub const MIN_LLM_CONCURRENCY_LIMIT: usize = 1;
pub const MAX_LLM_CONCURRENCY_LIMIT: usize = 32;

#[derive(Clone)]
pub struct LlmConcurrencyLimiter {
    semaphore: Arc<Semaphore>,
    limit: Arc<AtomicUsize>,
}

impl LlmConcurrencyLimiter {
    pub fn new(limit: usize) -> Self {
        let limit = normalize_limit(limit);
        Self {
            semaphore: Arc::new(Semaphore::new(limit)),
            limit: Arc::new(AtomicUsize::new(limit)),
        }
    }

    pub async fn acquire(&self) -> Result<OwnedSemaphorePermit, tokio::sync::AcquireError> {
        self.semaphore.clone().acquire_owned().await
    }

    pub fn current_limit(&self) -> usize {
        self.limit.load(Ordering::SeqCst)
    }

    pub fn set_limit(&self, next: usize) -> usize {
        let next = normalize_limit(next);
        let previous = self.limit.swap(next, Ordering::SeqCst);

        if next > previous {
            self.semaphore.add_permits(next - previous);
        } else if next < previous {
            // Closing permits lowers the number of future available permits without cancelling
            // in-flight requests. Existing requests finish naturally.
            let semaphore = self.semaphore.clone();
            tokio::spawn(async move {
                for _ in 0..(previous - next) {
                    match semaphore.clone().acquire_owned().await {
                        Ok(permit) => permit.forget(),
                        Err(_) => break,
                    }
                }
            });
        }

        next
    }
}

pub fn normalize_limit(value: usize) -> usize {
    value.clamp(MIN_LLM_CONCURRENCY_LIMIT, MAX_LLM_CONCURRENCY_LIMIT)
}
