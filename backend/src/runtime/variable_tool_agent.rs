use crate::error::AppError;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest, ChatTool, ChatToolFunction};
use crate::runtime::types::{ContextBundle, StateChangeCandidate, StateChangeProposal};

const TOOL_NAME: &str = "update_variables";

#[derive(Debug, serde::Deserialize)]
struct ToolArguments {
    #[serde(default)]
    changes: Vec<ToolChange>,
}

#[derive(Debug, serde::Deserialize)]
struct ToolChange {
    path: Option<String>,
    target: Option<String>,
    value: Option<serde_json::Value>,
    to: Option<serde_json::Value>,
    from: Option<serde_json::Value>,
}

pub async fn propose_variable_tool_changes(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    narrative_text: &str,
    context: &ContextBundle,
) -> Result<Option<StateChangeProposal>, AppError> {
    let variables = context
        .structured_state
        .get("variables")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    if variables.as_object().map_or(true, |obj| obj.is_empty()) {
        return Ok(None);
    }

    let system_prompt = r#"你是受控变量更新工具调用器。你只判断本轮叙事是否需要更新角色卡运行变量。

必须调用 update_variables 工具；没有变量变化时传 {"changes":[]}。

规则：
1. 只更新当前变量状态中已经存在的路径，不要创造新路径。
2. 只更新本轮明确发生变化的变量。
3. 如果变量原值是 [当前值, 说明] 数组，只更新第 0 项；可以传不带 [0] 的路径，平台会规范到 [0]。
4. value/to 必须是变量的新真实值，不要写 Yes/No、是否更新、理由、说明文本。
5. from 尽量填写当前原值，用于冲突检测。
6. 数值变化要保守，除非叙事明确发生重大转折。"#;

    let user_content = format!(
        "当前变量状态:\n{}\n\n用户输入:\n{}\n\n最终叙事:\n{}",
        serde_json::to_string_pretty(&variables).unwrap_or_default(),
        user_input,
        narrative_text
    );

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_prompt.to_string(),
        reasoning_content: None,
        tool_calls: None,
    }];

    if let Some(rule_reference) = format_variable_rule_reference(context) {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: rule_reference,
            reasoning_content: None,
            tool_calls: None,
        });
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_content,
        reasoning_content: None,
        tool_calls: None,
    });

    let request = ChatRequest {
        model: model.to_string(),
        messages,
        temperature: Some(0.1),
        top_p: Some(1.0),
        max_tokens: Some(4096),
        frequency_penalty: None,
        presence_penalty: None,
        tools: Some(vec![update_variables_tool()]),
        tool_choice: Some(serde_json::json!({
            "type": "function",
            "function": { "name": TOOL_NAME }
        })),
        stream: false,
    };

    tracing::debug!("Variable tool agent: sending tool-call request");
    let response = provider
        .chat_completion(request)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let Some(tool_call) = response
        .choices
        .first()
        .and_then(|choice| choice.message.tool_calls.as_ref())
        .and_then(|calls| calls.iter().find(|call| call.function.name == TOOL_NAME))
    else {
        tracing::warn!("Variable tool agent returned no update_variables tool call");
        return Ok(None);
    };

    let args: ToolArguments = serde_json::from_str(&tool_call.function.arguments)
        .map_err(|e| AppError::Provider(format!("Variable tool arguments parse failed: {}", e)))?;

    let changes = normalize_changes(args.changes, &variables);
    if changes.is_empty() {
        return Ok(None);
    }

    Ok(Some(StateChangeProposal {
        proposed_by: "state_agent".to_string(),
        risk: "low".to_string(),
        changes,
    }))
}

fn format_variable_rule_reference(context: &ContextBundle) -> Option<String> {
    let mut entries: Vec<_> = context
        .world_book_entries
        .iter()
        .filter(|entry| is_variable_rule_entry(entry))
        .filter(|entry| !entry.content.trim().is_empty())
        .collect();

    if entries.is_empty() {
        return None;
    }

    entries.sort_by_key(|entry| -entry.priority);
    let mut content = String::from("[World Book Variable Update Rules]\n");
    for entry in entries {
        content.push_str(&entry.content);
        content.push_str("\n\n");
    }
    Some(content)
}

fn is_variable_rule_entry(entry: &crate::runtime::types::WorldBookContextEntry) -> bool {
    if entry.category == "state_agent" {
        return true;
    }
    let text = format!("{}\n{}", entry.keys.join(" "), entry.content).to_lowercase();
    text.contains("updatevariable")
        || text.contains("status_current_variables")
        || text.contains("get_message_variable")
        || (text.contains("stat_data")
            && (text.contains("变量更新")
                || text.contains("变量输出")
                || text.contains("状态更新")))
}

fn update_variables_tool() -> ChatTool {
    ChatTool {
        tool_type: "function".to_string(),
        function: ChatToolFunction {
            name: TOOL_NAME.to_string(),
            description: "提交本轮需要写入角色卡 runtime variables 的精确变更。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "changes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "path": { "type": "string", "description": "变量路径，例如 variables.<user>.精神状态数值.调教值 或 variables.<user>.精神状态数值.调教值[0]" },
                                "target": { "type": "string", "description": "path 的兼容别名" },
                                "value": { "description": "新变量值" },
                                "to": { "description": "value 的兼容别名" },
                                "from": { "description": "当前原值，用于冲突检测" }
                            }
                        }
                    }
                },
                "required": ["changes"]
            }),
        },
    }
}

fn normalize_changes(
    changes: Vec<ToolChange>,
    variables: &serde_json::Value,
) -> Vec<StateChangeCandidate> {
    changes
        .into_iter()
        .filter_map(|change| normalize_change(change, variables))
        .collect()
}

fn normalize_change(
    change: ToolChange,
    variables: &serde_json::Value,
) -> Option<StateChangeCandidate> {
    let target = change.path.or(change.target)?;
    let to = change.value.or(change.to)?;
    if is_yes_no_explanation(&to) {
        return None;
    }
    let normalized = normalize_existing_variable_target(&target, variables)?;
    let from = normalize_from_value(change.from, &normalized);
    Some(StateChangeCandidate {
        op: "update".to_string(),
        target: normalized,
        from,
        to,
        evidence_turns: vec![],
    })
}

fn normalize_from_value(
    from: Option<serde_json::Value>,
    normalized_target: &str,
) -> Option<serde_json::Value> {
    let value = from?;
    if normalized_target.ends_with("[0]") {
        if let Some(first) = value.as_array().and_then(|arr| arr.first()) {
            return Some(first.clone());
        }
    }
    Some(value)
}

fn normalize_existing_variable_target(
    target: &str,
    variables: &serde_json::Value,
) -> Option<String> {
    let normalized = if target.trim().starts_with("variables.") {
        target.trim().to_string()
    } else {
        format!("variables.{}", target.trim())
    };
    let relative = normalized.strip_prefix("variables.")?;

    if get_path_value(variables, relative).is_some() {
        if get_path_value(variables, relative)
            .is_some_and(|value| value.as_array().map_or(false, |arr| arr.len() >= 2))
        {
            return Some(format!("{}[0]", normalized));
        }
        return Some(normalized);
    }

    if let Some(base) = relative.strip_suffix("[0]") {
        if get_path_value(variables, base)
            .is_some_and(|value| value.as_array().map_or(false, |arr| arr.len() >= 2))
        {
            return Some(normalized);
        }
    }

    None
}

fn get_path_value<'a>(root: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for part in path.split('.') {
        let (key, index) = parse_path_part(part);
        current = current.get(key)?;
        if let Some(index) = index {
            current = current.get(index)?;
        }
    }
    Some(current)
}

fn parse_path_part(part: &str) -> (&str, Option<usize>) {
    if let Some(open) = part.rfind('[') {
        if part.ends_with(']') {
            let key = &part[..open];
            let index = part[open + 1..part.len() - 1].parse::<usize>().ok();
            return (key, index);
        }
    }
    (part, None)
}

fn is_yes_no_explanation(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|text| {
        let trimmed = text.trim();
        trimmed.starts_with("Yes (") || trimmed.starts_with("No (")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_array_variable_to_first_slot() {
        let variables = serde_json::json!({
            "<user>": { "精神状态数值": { "调教值": ["0 | 最初", "说明"] } }
        });
        assert_eq!(
            normalize_existing_variable_target("variables.<user>.精神状态数值.调教值", &variables),
            Some("variables.<user>.精神状态数值.调教值[0]".to_string())
        );
    }

    #[test]
    fn rejects_missing_paths_and_yes_no_values() {
        let variables = serde_json::json!({ "<user>": { "内心想法": ["旧", "说明"] } });
        assert!(
            normalize_existing_variable_target("variables.<user>.不存在", &variables).is_none()
        );
        assert!(is_yes_no_explanation(&serde_json::json!("Yes (需要更新)")));
    }

    #[test]
    fn normalizes_array_from_value_to_first_slot() {
        assert_eq!(
            normalize_from_value(
                Some(serde_json::json!(["0 | 最初", "说明"])),
                "variables.<user>.精神状态数值.调教值[0]",
            ),
            Some(serde_json::json!("0 | 最初"))
        );
    }
}
