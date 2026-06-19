use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(deserialize_with = "deserialize_null_as_empty")]
    pub content: String,
    /// Some reasoning models (e.g. mimo, deepseek) put chain-of-thought here.
    /// We extract it as a fallback when `content` is empty/null.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

/// Deserialize null JSON values as empty string instead of failing.
fn deserialize_null_as_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ChatTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<serde_json::Value>,
    pub stream: bool,
    /// DeepSeek thinking-mode control. `{"type":"enabled"}` / `{"type":"disabled"}`.
    /// Disabling thinking is required for models whose thinking mode rejects `tool_choice`
    /// (e.g. the variable-update State Agent on deepseek-v4-flash).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<serde_json::Value>,
    /// Thinking effort: `"high"` | `"max"` (DeepSeek OpenAI-format). Paired with thinking enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

impl ChatRequest {
    /// Build a low-temperature, single-shot classification request (system + user message,
    /// no tools/stream). Shared by the world-book entry categorizer and preset module
    /// classifier — both want the same deterministic generation settings.
    pub fn classification_request(
        model: &str,
        system_prompt: &str,
        user_content: String,
        max_tokens: u32,
    ) -> Self {
        ChatRequest {
            model: model.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt.to_string(),
                    reasoning_content: None,
                    tool_calls: None,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: user_content,
                    reasoning_content: None,
                    tool_calls: None,
                },
            ],
            temperature: Some(0.3),
            top_p: Some(1.0),
            max_tokens: Some(max_tokens),
            frequency_penalty: Some(0.0),
            presence_penalty: Some(0.0),
            tools: None,
            tool_choice: None,
            stream: false,
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatTool {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ChatToolFunction,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub tool_type: Option<String>,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatResponse {
    pub choices: Vec<ChatChoice>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatChoice {
    pub message: ChatMessage,
    pub finish_reason: Option<String>,
}

/// `usage.prompt_tokens_details` — the OpenAI/DeepSeek-compatible breakdown of the
/// prompt token bill, including how many tokens were served from prompt cache.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
    /// OpenAI/DeepSeek report prompt-cache hits here as
    /// `prompt_tokens_details.cached_tokens`. Absent on providers that don't support
    /// caching → defaults to 0.
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

impl Usage {
    /// Tokens served from the prompt cache (0 when the provider doesn't report it).
    pub fn cached_tokens(&self) -> u32 {
        self.prompt_tokens_details
            .as_ref()
            .map_or(0, |d| d.cached_tokens)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChunk {
    pub choices: Vec<StreamChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChoice {
    pub delta: StreamDelta,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamDelta {
    pub role: Option<String>,
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<crate::runtime::types::AgentStatusEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_parses_cached_tokens_from_prompt_tokens_details() {
        let json = r#"{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,"prompt_tokens_details":{"cached_tokens":800}}"#;
        let usage: Usage = serde_json::from_str(json).expect("should parse");
        assert_eq!(usage.prompt_tokens, 1000);
        assert_eq!(usage.completion_tokens, 50);
        assert_eq!(usage.cached_tokens(), 800);
    }

    #[test]
    fn usage_defaults_cached_to_zero_when_absent() {
        // Providers that don't support prompt cache omit prompt_tokens_details entirely.
        let json = r#"{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050}"#;
        let usage: Usage = serde_json::from_str(json).expect("should parse");
        assert_eq!(usage.cached_tokens(), 0);
        assert!(usage.prompt_tokens_details.is_none());
    }
}
