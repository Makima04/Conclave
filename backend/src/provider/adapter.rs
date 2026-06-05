use super::types::{ChatRequest, ChatResponse, StreamChunk};
use async_trait::async_trait;
use futures::Stream;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Stream error: {0}")]
    Stream(String),
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
