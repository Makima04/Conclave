use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};

/// Try to parse JSON from LLM output, with repair retry on failure.
///
/// 1. Extract JSON from text (find first `{` to last `}`)
/// 2. Parse with caller-provided closure
/// 3. On failure: send repair prompt to LLM with the error
/// 4. Parse the repair response
/// 5. On second failure: return Err
pub async fn parse_with_repair<T, F>(
    provider: &OpenAiProvider,
    model: &str,
    text: &str,
    parse_fn: F,
    schema_hint: &str,
) -> Result<T, String>
where
    F: Fn(&str) -> Result<T, String>,
{
    // First attempt: parse directly
    let json_str = extract_json(text);
    match parse_fn(json_str) {
        Ok(result) => return Ok(result),
        Err(e) => {
            tracing::warn!("JSON parse failed (attempt 1): {}, attempting repair", e);
            // Fall through to repair
        }
    }

    // Repair attempt: ask LLM to fix the JSON
    let repair_prompt = format!(
        "你的上次输出JSON格式有误，请修复以下JSON，只输出修复后的纯JSON，不要其他文字。\n\n{}\n\n期望的JSON格式:\n{}",
        text, schema_hint
    );

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: "你是JSON修复助手。只输出修复后的纯JSON，不要其他文字。".to_string(),
                reasoning_content: None,
                tool_calls: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: repair_prompt,
                reasoning_content: None,
                tool_calls: None,
            },
        ],
        temperature: Some(0.1),
        top_p: Some(1.0),
        max_tokens: Some(4096),
        frequency_penalty: None,
        presence_penalty: None,
        tools: None,
        tool_choice: None,
        stream: false,
        ..Default::default()
    };

    let response = match provider.chat_completion(request).await {
        Ok(r) => r,
        Err(e) => {
            return Err(format!("Repair LLM call failed: {}", e));
        }
    };

    let repair_text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    let repair_json = extract_json(&repair_text);
    match parse_fn(repair_json) {
        Ok(result) => {
            tracing::info!("JSON repair succeeded");
            Ok(result)
        }
        Err(e) => {
            tracing::warn!("JSON repair also failed: {}", e);
            Err(format!("Parse failed after repair: {}", e))
        }
    }
}

/// Extract JSON from LLM output: find first `{` to last `}`.
/// Returns the JSON string slice, or the original text if no JSON found.
fn extract_json(text: &str) -> &str {
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if end > start {
                return &text[start..=end];
            }
        }
    }
    text
}
