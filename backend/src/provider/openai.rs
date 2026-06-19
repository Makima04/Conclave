use super::adapter::{ProviderAdapter, ProviderError};
use super::types::{ChatRequest, ChatResponse, StreamChunk};
use async_trait::async_trait;
use futures::Stream;
use reqwest::Client;
use std::pin::Pin;
use std::time::Duration;

/// Base delay for the first retry; doubles each attempt (≈ 0.8s → 1.6s → 3.2s).
/// Transient network blips (the common case) usually clear on the first retry.
const RETRY_BASE_DELAY_MS: u64 = 800;
/// A small jitter cap added to each backoff to avoid synchronized retry storms.
const RETRY_JITTER_MS: u64 = 250;

/// Classify a `reqwest::Error` (from `.send()`) as transient-or-not.
/// Connect/timeout failures are the classic momentary blip → retryable.
fn classify_send_error(e: reqwest::Error) -> ProviderError {
    if e.is_connect() || e.is_timeout() {
        ProviderError::Network(e.to_string())
    } else {
        ProviderError::Http(e.to_string())
    }
}

/// Classify a non-success HTTP status: server errors + 429 are transient and
/// worth retrying; other 4xx (auth/param/model-not-found) are not.
fn classify_http_status(status: reqwest::StatusCode, body: String) -> ProviderError {
    if status.is_server_error() || status.as_u16() == 429 {
        ProviderError::Network(format!("HTTP {}: {}", status, body))
    } else {
        ProviderError::Http(format!("HTTP {}: {}", status, body))
    }
}

/// Backoff for retry attempt `attempt` (1-based): base * 2^(attempt-1) + jitter.
fn backoff_delay(attempt: u32) -> Duration {
    let exp = attempt.saturating_sub(1);
    let ms = RETRY_BASE_DELAY_MS
        .saturating_mul(2u64.saturating_pow(exp))
        .saturating_add(rand_jitter_ms());
    Duration::from_millis(ms)
}

/// Best-effort jitter without pulling in a rand crate — uses a cheap thread-local
/// seed. Only needs to spread retries, not be cryptographically sound.
fn rand_jitter_ms() -> u64 {
    use std::cell::Cell;
    thread_local!(static SEED: Cell<u64> = Cell::new({
        // Seed from time + thread id approximation at first use.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15);
        now.wrapping_mul(0x9E3779B97F4A7C15)
    }));
    SEED.with(|cell| {
        let mut s = cell.get();
        // xorshift64
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        cell.set(s);
        s % RETRY_JITTER_MS
    })
}

#[derive(Clone)]
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

    /// Call chat_completion with automatic retry for transient failures:
    /// (1) the model returned empty content, or (2) a momentary network/server
    /// error (`ProviderError::Network`). Non-retryable errors (4xx / parse) fail
    /// fast. Retries use exponential backoff (≈0.8s → 1.6s → 3.2s + jitter) so a
    /// momentary blip at `llm.makima2233.top` clears on retry instead of aborting
    /// the whole multi-agent turn.
    pub async fn chat_completion_with_retry(
        &self,
        request: ChatRequest,
        max_retries: u32,
    ) -> Result<ChatResponse, ProviderError> {
        let mut last_err: Option<ProviderError> = None;
        for attempt in 0..=max_retries {
            if attempt > 0 {
                let reason = match &last_err {
                    Some(ProviderError::Network(m)) => format!("网络错误: {}", m),
                    _ => "空内容".to_string(),
                };
                tracing::warn!(attempt, reason = %reason, "Retrying LLM call");
                tokio::time::sleep(backoff_delay(attempt)).await;
            }

            match self.chat_completion(request.clone()).await {
                Ok(response) => {
                    // A response is "empty" only if it has neither content nor tool_calls.
                    // Tool-calling requests (e.g. the variable-update State Agent, forced via
                    // tool_choice) legitimately return content="" with the answer in tool_calls —
                    // those must NOT trigger a retry.
                    let has_output = response
                        .choices
                        .first()
                        .map(|c| {
                            !c.message.content.trim().is_empty() || c.message.tool_calls.is_some()
                        })
                        .unwrap_or(false);

                    if has_output {
                        return Ok(response);
                    }
                    tracing::warn!(attempt, "LLM returned empty content");
                    last_err = Some(ProviderError::Parse("模型返回空内容".to_string()));
                }
                Err(ProviderError::Network(msg)) => {
                    last_err = Some(ProviderError::Network(msg));
                }
                // Non-retryable (4xx Http / Parse / Stream): fail fast — retrying
                // would just reproduce the same error.
                Err(e) => return Err(e),
            }
        }

        // Retries exhausted. Prefer the last transient network error so the user
        // sees "网络错误"; fall back to the empty-content parse error.
        Err(last_err.unwrap_or_else(|| {
            ProviderError::Parse(format!(
                "LLM returned empty content after {} retries",
                max_retries + 1
            ))
        }))
    }

    /// Establish an SSE stream with retry on transient *connection* errors
    /// (the request never got a response — connect/timeout/5xx/429). Mid-stream
    /// failures are NOT retried: tokens already on the wire are unreproducible, so
    /// they bubble up as a stream error and the frontend "重试本轮" button re-runs the turn.
    pub async fn chat_completion_stream_with_connect_retry(
        &self,
        request: ChatRequest,
        max_retries: u32,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamChunk, ProviderError>> + Send>>, ProviderError>
    {
        let mut last_err: Option<ProviderError> = None;
        for attempt in 0..=max_retries {
            if attempt > 0 {
                tracing::warn!(attempt, "Retrying LLM stream connection");
                tokio::time::sleep(backoff_delay(attempt)).await;
            }
            match self.chat_completion_stream(request.clone()).await {
                Ok(s) => return Ok(s),
                Err(e) if e.is_retryable() => {
                    last_err = Some(e);
                }
                Err(e) => return Err(e),
            }
        }
        Err(last_err
            .unwrap_or_else(|| ProviderError::Network("LLM stream connect failed".to_string())))
    }
}

#[async_trait]
impl ProviderAdapter for OpenAiProvider {
    async fn chat_completion(&self, request: ChatRequest) -> Result<ChatResponse, ProviderError> {
        let url = format!("{}/chat/completions", self.base_url);

        tracing::debug!(model = %request.model, messages = request.messages.len(), "LLM request");

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(classify_send_error)?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(url = %url, status = %status, "LLM request failed");
            return Err(classify_http_status(status, body));
        }

        tracing::debug!("LLM response OK");
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ProviderError::Parse(e.to_string()))?;
        match serde_json::from_slice::<ChatResponse>(&bytes) {
            Ok(resp) => Ok(resp),
            Err(e) => {
                let body_preview = String::from_utf8_lossy(&bytes);
                let preview = if body_preview.len() > 500 {
                    &body_preview[..500]
                } else {
                    &body_preview
                };
                tracing::error!(error = %e, body = %preview, "Failed to decode LLM response body");
                Err(ProviderError::Parse(e.to_string()))
            }
        }
    }

    async fn chat_completion_stream(
        &self,
        mut request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamChunk, ProviderError>> + Send>>, ProviderError>
    {
        request.stream = true;
        let url = format!("{}/chat/completions", self.base_url);

        tracing::debug!(model = %request.model, messages = request.messages.len(), "LLM request: streaming");

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(classify_send_error)?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(url = %url, status = %status, "LLM streaming request failed");
            return Err(classify_http_status(status, body));
        }

        tracing::debug!("LLM stream connected");
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

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    fn status(code: u16) -> StatusCode {
        StatusCode::from_u16(code).unwrap()
    }

    #[test]
    fn server_errors_and_429_are_retryable() {
        // Transient server-side / rate-limit responses map to Network (retryable).
        for code in [500u16, 502, 503, 504, 429] {
            let err = classify_http_status(status(code), String::new());
            assert!(
                err.is_retryable(),
                "HTTP {code} should be retryable, got {:?}",
                err
            );
        }
    }

    #[test]
    fn client_4xx_errors_are_not_retryable() {
        // 4xx auth/param/model-not-found would just reproduce the same failure.
        for code in [400u16, 401, 403, 404, 422] {
            let err = classify_http_status(status(code), String::new());
            assert!(
                !err.is_retryable(),
                "HTTP {code} should NOT be retryable, got {:?}",
                err
            );
        }
    }

    #[test]
    fn is_retryable_only_for_network_class() {
        assert!(ProviderError::Network("connect reset".into()).is_retryable());
        assert!(!ProviderError::Http("HTTP 401".into()).is_retryable());
        assert!(!ProviderError::Parse("bad json".into()).is_retryable());
        assert!(!ProviderError::Stream("eof".into()).is_retryable());
    }

    #[test]
    fn backoff_delay_is_monotonic_and_bounded() {
        // The intervals [800,1050], [1600,1850], [3200,3450] never overlap, so
        // successive retries must always wait strictly longer.
        let d1 = backoff_delay(1).as_millis();
        let d2 = backoff_delay(2).as_millis();
        let d3 = backoff_delay(3).as_millis();
        assert!(d1 >= 800 && d1 <= 1050, "attempt 1 backoff out of range: {d1}");
        assert!(d2 > d1, "backoff must grow: d2={d2} d1={d1}");
        assert!(d3 > d2, "backoff must grow: d3={d3} d2={d2}");
    }
}
