use super::types::{ChatRequest, ChatResponse, StreamChunk};
use async_trait::async_trait;
use futures::Stream;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// Transient/network-class error worth retrying: connection failure, timeout,
    /// DNS/TLS, or a server-side response (5xx / 429). These are almost always
    /// momentary and a re-send usually succeeds — `chat_completion_with_retry`
    /// retries them with exponential backoff.
    #[error("网络错误（可重试）: {0}")]
    Network(String),
    /// Non-retryable client error: 4xx (auth/param/model-not-found). Retrying
    /// would just hit the same failure, so callers fail fast.
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Stream error: {0}")]
    Stream(String),
}

impl ProviderError {
    /// True for errors that are worth a re-send (transient network/server).
    pub fn is_retryable(&self) -> bool {
        matches!(self, ProviderError::Network(_))
    }
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    async fn chat_completion(&self, request: ChatRequest) -> Result<ChatResponse, ProviderError>;

    async fn chat_completion_stream(
        &self,
        request: ChatRequest,
    ) -> Result<
        std::pin::Pin<Box<dyn Stream<Item = Result<StreamChunk, ProviderError>> + Send>>,
        ProviderError,
    >;
}
