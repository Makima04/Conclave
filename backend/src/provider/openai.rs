use super::adapter::{ProviderAdapter, ProviderError};
use super::types::{ChatRequest, ChatResponse, StreamChunk};
use async_trait::async_trait;
use futures::Stream;
use reqwest::Client;
use std::pin::Pin;

pub struct OpenAiProvider {
    client: Client,
    base_url: String,
    api_key: String,
}

impl OpenAiProvider {
    pub fn new(base_url: &str, api_key: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        }
    }
}

#[async_trait]
impl ProviderAdapter for OpenAiProvider {
    async fn chat_completion(&self, request: ChatRequest) -> Result<ChatResponse, ProviderError> {
        let url = format!("{}/chat/completions", self.base_url);

        tracing::info!(url = %url, model = %request.model, messages = request.messages.len(), "LLM request: non-streaming");

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| ProviderError::Http(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(url = %url, status = %status, "LLM request failed");
            return Err(ProviderError::Http(format!("HTTP {}: {}", status, body)));
        }

        tracing::info!(url = %url, "LLM response OK, parsing JSON");
        response
            .json::<ChatResponse>()
            .await
            .map_err(|e| ProviderError::Parse(e.to_string()))
    }

    async fn chat_completion_stream(
        &self,
        mut request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamChunk, ProviderError>> + Send>>, ProviderError>
    {
        request.stream = true;
        let url = format!("{}/chat/completions", self.base_url);

        tracing::info!(url = %url, model = %request.model, messages = request.messages.len(), "LLM request: streaming");

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| ProviderError::Http(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(url = %url, status = %status, "LLM streaming request failed");
            return Err(ProviderError::Http(format!("HTTP {}: {}", status, body)));
        }

        tracing::info!(url = %url, "LLM stream connected, reading chunks");
        let byte_stream = response.bytes_stream();
        use futures::StreamExt;

        let stream = async_stream::stream! {
            let mut buffer = String::new();
            let mut pinned = std::pin::pin!(byte_stream);

            // We accumulate bytes into a string buffer and split on newlines
            while let Some(chunk_result) = pinned.next().await {
                let bytes = chunk_result.map_err(|e| ProviderError::Stream(e.to_string()))?;
                let text = String::from_utf8_lossy(&bytes);
                buffer.push_str(&text);

                // Process complete lines
                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.is_empty() || line.starts_with(':') {
                        continue;
                    }

                    if line == "data: [DONE]" {
                        return;
                    }

                    if let Some(data) = line.strip_prefix("data: ") {
                        match serde_json::from_str::<StreamChunk>(data) {
                            Ok(chunk) => yield Ok(chunk),
                            Err(e) => yield Err(ProviderError::Parse(e.to_string())),
                        }
                    }
                }
            }

            // Flush any remaining data in the buffer
            let remaining = buffer.trim().to_string();
            if !remaining.is_empty() && remaining != "data: [DONE]" {
                if let Some(data) = remaining.strip_prefix("data: ") {
                    match serde_json::from_str::<StreamChunk>(data) {
                        Ok(chunk) => yield Ok(chunk),
                        Err(_) => {} // best-effort on trailing incomplete data
                    }
                }
            }
        };

        Ok(Box::pin(stream))
    }
}
