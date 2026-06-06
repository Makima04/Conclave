use crate::error::AppError;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::structured_output;
use crate::runtime::types::{ContextBundle, ParsedIntent, SubAgent};
use tracing::instrument;

/// Run the Parser Agent: extract structured intent from user input.
#[instrument(skip(provider, context, user_input, agent), fields(model = model))]
pub async fn run_parser(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    context: &ContextBundle,
    agent: Option<&SubAgent>,
) -> Result<ParsedIntent, AppError> {
    // Build recent context summary (last 3 messages max)
    let recent: Vec<String> = context
        .recent_context
        .iter()
        .rev()
        .take(3)
        .rev()
        .map(|m| format!("[{}] {}", m.role, truncate(&m.content, 200)))
        .collect();

    let recent_text = if recent.is_empty() {
        String::new()
    } else {
        format!("\n最近对话:\n{}", recent.join("\n"))
    };

    let default_prompt = r#"你是解析Agent。分析用户输入，提取结构化意图信息。输出纯JSON，不要其他文字。

JSON格式：
{
  "intent": "dialogue|action|query|command|narrative",
  "action_type": "speak|attack|move|examine|interact|describe|other",
  "target_characters": ["角色名称列表"],
  "compressed_input": "去除修辞后的核心信息",
  "tone": "hostile|friendly|neutral|curious|anxious|playful|serious"
}"#;

    // Use agent's DB prompt if available, otherwise fall back to hardcoded default
    let system_prompt = agent
        .filter(|a| !a.system_prompt.is_empty())
        .map(|a| a.system_prompt.clone())
        .unwrap_or_else(|| default_prompt.to_string());

    let user_content = format!("用户输入:\n{}{}", user_input, recent_text);

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                reasoning_content: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_content,
                reasoning_content: None,
            },
        ],
        temperature: Some(0.2),
        top_p: Some(1.0),
        max_tokens: Some(10000),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
    };

    tracing::debug!("Parser Agent: sending LLM request");

    let response = provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    tracing::info!("Parser Agent output: {}", truncate(&text, 200));

    let schema_hint = r#"{"intent":"dialogue|action|query|command","action_type":"speak|attack|move|examine","target_characters":["角色名"],"compressed_input":"核心信息","tone":"hostile|friendly|neutral"}"#;
    match structured_output::parse_with_repair(provider, model, &text, parse_intent, schema_hint)
        .await
    {
        Ok(intent) => Ok(intent),
        Err(e) => {
            tracing::warn!(
                "Parser output parse failed after repair: {}, using fallback",
                e
            );
            Ok(fallback_intent(user_input))
        }
    }
}

fn parse_intent(text: &str) -> Result<ParsedIntent, String> {
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    serde_json::from_str::<ParsedIntent>(json_str).map_err(|e| format!("JSON parse error: {}", e))
}

fn fallback_intent(user_input: &str) -> ParsedIntent {
    ParsedIntent {
        intent: "dialogue".to_string(),
        action_type: "speak".to_string(),
        target_characters: vec![],
        compressed_input: user_input.to_string(),
        tone: "neutral".to_string(),
    }
}

fn truncate(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}
