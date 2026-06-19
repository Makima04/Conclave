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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Duration, sleep, timeout};

    #[test]
    fn normalize_limit_clamps_bounds() {
        assert_eq!(normalize_limit(0), MIN_LLM_CONCURRENCY_LIMIT);
        assert_eq!(
            normalize_limit(DEFAULT_LLM_CONCURRENCY_LIMIT),
            DEFAULT_LLM_CONCURRENCY_LIMIT
        );
        assert_eq!(normalize_limit(999), MAX_LLM_CONCURRENCY_LIMIT);
    }

    #[tokio::test]
    async fn set_limit_expands_available_permits() {
        let limiter = LlmConcurrencyLimiter::new(1);
        assert_eq!(limiter.current_limit(), 1);

        let first = timeout(Duration::from_millis(50), limiter.acquire()).await;
        assert!(first.is_ok(), "expected initial permit to be available");
        let first = first.unwrap().expect("permit acquisition should succeed");

        let second = timeout(Duration::from_millis(50), limiter.acquire()).await;
        assert!(
            second.is_err(),
            "expected second permit to block at limit 1"
        );

        let applied = limiter.set_limit(2);
        assert_eq!(applied, 2);
        assert_eq!(limiter.current_limit(), 2);

        let second = timeout(Duration::from_millis(50), limiter.acquire()).await;
        assert!(
            second.is_ok(),
            "expected second permit to become available after expanding limit"
        );

        drop(first);
    }

    #[tokio::test]
    async fn set_limit_shrinks_future_capacity_without_cancelling_in_flight_work() {
        let limiter = LlmConcurrencyLimiter::new(3);
        let permit_a = limiter.acquire().await.expect("first permit");
        let permit_b = limiter.acquire().await.expect("second permit");

        let applied = limiter.set_limit(1);
        assert_eq!(applied, 1);
        assert_eq!(limiter.current_limit(), 1);

        drop(permit_a);
        drop(permit_b);

        sleep(Duration::from_millis(50)).await;

        let first = timeout(Duration::from_millis(50), limiter.acquire()).await;
        assert!(
            first.is_ok(),
            "expected exactly one permit to remain available after shrink"
        );
        let first = first.unwrap().expect("permit acquisition should succeed");

        let second = timeout(Duration::from_millis(50), limiter.acquire()).await;
        assert!(
            second.is_err(),
            "expected additional acquisitions to block after shrink drained extra permits"
        );

        drop(first);
    }
}
