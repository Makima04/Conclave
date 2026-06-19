use crate::error::AppError;
use crate::importer::types::*;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};

/// Build a prompt asking LLM to explain unknown actions.
pub fn build_explain_actions_prompt(actions: &[ActionDeclaration], html_context: &str) -> String {
    let action_list: Vec<String> = actions
        .iter()
        .map(|a| {
            format!(
                "- id: {}, label: \"{}\", kind: {:?}, selector: {:?}",
                a.id, a.label, a.kind, a.selector
            )
        })
        .collect();

    format!(
        r#"你是一个角色卡导入助手。以下是从角色卡中提取的动作声明，请解释每个动作的含义并建议合适的 kind 分类。

动作列表：
{actions}

HTML 上下文片段（仅供参考）：
{context}

请以 JSON 数组格式回答，每个元素包含：
- id: 动作 id
- explanation: 动作含义解释（中文）
- suggested_kind: 建议的 kind（start/load_save/set_message/set_variable/open_panel/form_submit/unknown）
- reasoning: 推理依据

只输出 JSON，不要其他文字。"#,
        actions = action_list.join("\n"),
        context = &html_context[..html_context.len().min(2000)],
    )
}

/// Build a prompt asking LLM to generate labels for variable paths.
pub fn build_label_variables_prompt(variables: &[VariableDeclaration], context: &str) -> String {
    let var_list: Vec<String> = variables
        .iter()
        .map(|v| {
            format!(
                "- path: \"{}\", type: {:?}, source: {}",
                v.path, v.var_type, v.source
            )
        })
        .collect();

    format!(
        r#"你是一个角色卡导入助手。以下是从角色卡中提取的变量声明，请为每个变量生成中文标签。

变量列表：
{variables}

代码上下文（仅供参考）：
{context}

请以 JSON 数组格式回答，每个元素包含：
- path: 变量路径
- label: 中文标签（简短，2-6个字）
- description: 变量用途描述（中文，一句话）

只输出 JSON，不要其他文字。"#,
        variables = var_list.join("\n"),
        context = &context[..context.len().min(2000)],
    )
}

/// Build a prompt asking LLM to summarize unsupported APIs.
pub fn build_summarize_unsupported_prompt(apis: &[String]) -> String {
    format!(
        r#"你是一个角色卡导入助手。以下是从角色卡中检测到的不支持的 API 列表，请总结每个 API 的问题和建议的替代方案。

不支持的 API：
{apis}

请以 JSON 数组格式回答，每个元素包含：
- api: API 名称
- problem: 问题描述（中文）
- suggestion: 建议的替代方案或处理方式（中文）

只输出 JSON，不要其他文字。"#,
        apis = apis
            .iter()
            .map(|a| format!("- {}", a))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Parse LLM response as JSON value.
pub fn parse_llm_json_response(response: &str) -> Result<serde_json::Value, ImportError> {
    // Try to extract JSON from the response (handle markdown code fences)
    let trimmed = response.trim();
    let json_str = if trimmed.starts_with("```") {
        // Strip ```json ... ``` fences
        let start = trimmed.find('\n').unwrap_or(3);
        let end = trimmed.rfind("```").unwrap_or(trimmed.len());
        &trimmed[start..end]
    } else {
        trimmed
    };

    serde_json::from_str(json_str)
        .map_err(|e| ImportError::Internal(format!("Failed to parse LLM response: {}", e)))
}

/// Call the LLM provider with a prompt and return the parsed JSON response.
pub async fn call_llm_json(
    provider: &OpenAiProvider,
    model: &str,
    prompt: &str,
) -> Result<serde_json::Value, AppError> {
    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: "You are a helpful assistant that responds only in valid JSON."
                    .to_string(),
                reasoning_content: None,
                tool_calls: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: prompt.to_string(),
                reasoning_content: None,
                tool_calls: None,
            },
        ],
        temperature: Some(0.1),
        top_p: Some(1.0),
        max_tokens: Some(4000),
        frequency_penalty: None,
        presence_penalty: None,
        tools: None,
        tool_choice: None,
        stream: false,
        ..Default::default()
    };

    let response = provider
        .chat_completion_with_retry(request, 2)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    parse_llm_json_response(&text).map_err(|e| AppError::Internal(e.to_string()))
}
