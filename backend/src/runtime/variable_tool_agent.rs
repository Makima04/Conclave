use crate::error::AppError;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest, ChatTool, ChatToolFunction, ToolCall};
use crate::runtime::card_state_adapter;
use crate::runtime::types::{ContextBundle, StateChangeCandidate, StateChangeProposal};
use sqlx::{Sqlite, Transaction};

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

/// Build the `update_variables` tool schema dynamically from writable platform state.
/// Character-card variables are projections; the State Agent writes canonical paths only.
pub fn build_update_variables_tool(writable_state: &serde_json::Value) -> ChatTool {
    let mut properties = serde_json::Map::new();

    if let Some(obj) = writable_state.as_object() {
        for (key, value) in obj {
            properties.insert(key.clone(), variable_to_schema(value));
        }
    }

    ChatTool {
        tool_type: "function".to_string(),
        function: ChatToolFunction {
            name: TOOL_NAME.to_string(),
            description: "提交本轮需要写入平台 canonical state 的精确变更。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "changes": {
                        "type": "array",
                        "description": "本轮变量变更列表。每个元素描述一条路径的新值。没有变化时传空数组。",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "path": {
                                    "type": "string",
                                    "description": "要更新的平台状态路径。支持嵌套，用点号分隔，例如 world.current_location。"
                                },
                                "target": {
                                    "type": "string",
                                    "description": "path 的兼容别名，与 path 二选一。"
                                },
                                "value": {
                                    "description": "变量的新值。必须与变量当前类型匹配。"
                                },
                                "to": {
                                    "description": "value 的兼容别名，与 value 二选一。"
                                },
                                "from": {
                                    "description": "当前原值（用于冲突检测）。尽量填写。"
                                }
                            },
                            "required": ["path"]
                        }
                    },
                    "state_definitions": {
                        "type": "object",
                        "description": "当前可写平台状态定义（只读参考）",
                        "properties": properties
                    }
                },
                "required": ["changes"]
            }),
        },
    }
}

/// Convert a variable value to a JSON Schema type descriptor for the tool definition.
fn variable_to_schema(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                serde_json::json!({ "type": "integer", "example": n })
            } else {
                serde_json::json!({ "type": "number", "example": n })
            }
        }
        serde_json::Value::Bool(b) => serde_json::json!({ "type": "boolean", "example": b }),
        serde_json::Value::String(s) => serde_json::json!({ "type": "string", "example": s }),
        serde_json::Value::Array(arr) => {
            if arr.len() >= 2 {
                serde_json::json!({
                    "type": "array",
                    "description": format!("[当前值, 说明] — 只更新第0项"),
                    "example": arr
                })
            } else {
                serde_json::json!({ "type": "array", "example": arr })
            }
        }
        serde_json::Value::Object(_) => serde_json::json!({ "type": "object" }),
        serde_json::Value::Null => serde_json::json!({}),
    }
}

/// Single-agent mode: call LLM with dynamic `update_variables` tool, return proposal.
/// Uses the same dynamic tool schema as the DAG-based State Agent.
pub async fn propose_variable_changes(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    narrative_text: &str,
    context: &ContextBundle,
) -> Result<Option<StateChangeProposal>, AppError> {
    let writable_state = context
        .structured_state
        .get("_state_agent_writable")
        .cloned()
        .unwrap_or_else(|| {
            context
                .structured_state
                .get("platform_state")
                .cloned()
                .or_else(|| context.structured_state.get("variables").cloned())
                .unwrap_or_else(|| serde_json::json!({}))
        });

    if writable_state
        .as_object()
        .map_or(true, |obj| obj.is_empty())
    {
        return Ok(None);
    }

    let system_prompt = r#"你是受控状态更新工具调用器。你只判断本轮叙事是否需要更新平台 canonical state。

必须调用 update_variables 工具；没有变量变化时传 {"changes":[]}。

规则：
1. 只更新 state_definitions 中已经存在的路径，不要创造新路径。
2. 只更新本轮明确发生变化的状态。
3. path 使用平台路径，例如 world.current_location，不要使用角色卡私有 variables 路径。
4. value/to 必须是状态的新真实值，不要写 Yes/No、是否更新、理由、说明文本。
5. from 尽量填写当前原值，用于冲突检测。
6. 数值变化要保守，除非叙事明确发生重大转折。"#;

    let user_content = format!(
        "当前可写平台状态:\n{}\n\n用户输入:\n{}\n\n最终叙事:\n{}",
        serde_json::to_string_pretty(&writable_state).unwrap_or_default(),
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

    let tool = build_update_variables_tool(&writable_state);
    let request = ChatRequest {
        model: model.to_string(),
        messages,
        temperature: Some(0.1),
        top_p: Some(1.0),
        max_tokens: Some(4096),
        frequency_penalty: None,
        presence_penalty: None,
        tools: Some(vec![tool]),
        tool_choice: Some(serde_json::json!({
            "type": "function",
            "function": { "name": TOOL_NAME }
        })),
        stream: false,
    };

    tracing::debug!("Variable tool agent: sending tool-call request (single-agent)");
    let response = provider
        .chat_completion(request)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let tool_calls = response
        .choices
        .first()
        .and_then(|choice| choice.message.tool_calls.as_deref());

    let Some(calls) = tool_calls else {
        tracing::warn!("Variable tool agent returned no tool calls");
        return Ok(None);
    };

    let changes = extract_tool_call(calls, &writable_state);
    let Some(changes) = changes else {
        return Ok(None);
    };

    Ok(Some(StateChangeProposal {
        proposed_by: "variable_tool_agent".to_string(),
        risk: "low".to_string(),
        changes,
    }))
}

/// Extract tool call arguments from a State Agent LLM response.
/// Returns the parsed changes if the response contains an `update_variables` tool call.
pub fn extract_tool_call(
    tool_calls: &[ToolCall],
    writable_state: &serde_json::Value,
) -> Option<Vec<StateChangeCandidate>> {
    let call = tool_calls
        .iter()
        .find(|call| call.function.name == TOOL_NAME)?;

    let args: ToolArguments = match serde_json::from_str(&call.function.arguments) {
        Ok(args) => args,
        Err(e) => {
            tracing::warn!("Failed to parse update_variables arguments: {}", e);
            return None;
        }
    };

    let changes = normalize_changes(args.changes, writable_state);
    if changes.is_empty() {
        None
    } else {
        Some(changes)
    }
}

/// Persist variable changes directly to the database (no LLM validation).
/// Used when State Agent runs inside the DAG — the LLM already made the decision.
pub async fn persist_variable_changes(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    changes: &[StateChangeCandidate],
) -> Result<(), AppError> {
    if changes.is_empty() {
        return Ok(());
    }

    card_state_adapter::persist_normalized_changes_tx(tx, session_id, changes, "state_agent_tool")
        .await?;

    tracing::info!(
        session = session_id,
        changes = changes.len(),
        "State Agent tool call: normalized state changes persisted"
    );
    Ok(())
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

fn normalize_changes(
    changes: Vec<ToolChange>,
    writable_state: &serde_json::Value,
) -> Vec<StateChangeCandidate> {
    changes
        .into_iter()
        .filter_map(normalize_change)
        .filter(|change| {
            let relative = change
                .target
                .strip_prefix("platform_state.")
                .unwrap_or(&change.target);
            card_state_adapter::get_path_value(writable_state, relative).is_some()
                || card_state_adapter::get_path_value(
                    writable_state,
                    relative.strip_suffix("[0]").unwrap_or(relative),
                )
                .is_some()
        })
        .collect()
}

fn normalize_change(change: ToolChange) -> Option<StateChangeCandidate> {
    let target = change.path.or(change.target)?;
    let to = change.value.or(change.to)?;
    if is_yes_no_explanation(&to) {
        return None;
    }
    let normalized = if target.trim().starts_with("platform_state.") {
        target.trim().to_string()
    } else {
        format!(
            "platform_state.{}",
            target.trim().trim_start_matches("variables.")
        )
    };
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

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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

    #[test]
    fn dynamic_tool_schema_includes_variable_definitions() {
        let variables = serde_json::json!({
            "hp": 10,
            "trust": 3,
            "name": "浅野堇"
        });
        let tool = build_update_variables_tool(&variables);
        assert_eq!(tool.function.name, "update_variables");
        let defs = tool
            .function
            .parameters
            .get("properties")
            .unwrap()
            .get("state_definitions")
            .unwrap()
            .get("properties")
            .unwrap();
        assert!(defs.get("hp").is_some());
        assert!(defs.get("trust").is_some());
        assert!(defs.get("name").is_some());
    }

    #[test]
    fn dynamic_tool_schema_handles_empty_variables() {
        let variables = serde_json::json!({});
        let tool = build_update_variables_tool(&variables);
        assert_eq!(tool.function.name, "update_variables");
        let defs = tool
            .function
            .parameters
            .get("properties")
            .unwrap()
            .get("state_definitions")
            .unwrap()
            .get("properties")
            .unwrap();
        assert!(defs.as_object().unwrap().is_empty());
    }

    #[test]
    fn extract_tool_call_parses_arguments() {
        let variables = serde_json::json!({ "hp": 10, "trust": 3 });
        let tool_calls = vec![ToolCall {
            id: Some("call_1".to_string()),
            tool_type: Some("function".to_string()),
            function: crate::provider::types::ToolCallFunction {
                name: "update_variables".to_string(),
                arguments: r#"{"changes":[{"path":"hp","value":8}]}"#.to_string(),
            },
        }];
        let changes = extract_tool_call(&tool_calls, &variables);
        assert!(changes.is_some());
        let changes = changes.unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].target, "platform_state.hp");
        assert_eq!(changes[0].to, serde_json::json!(8));
    }

    #[test]
    fn extract_tool_call_returns_none_for_no_matching_tool() {
        let variables = serde_json::json!({ "hp": 10 });
        let tool_calls = vec![ToolCall {
            id: Some("call_1".to_string()),
            tool_type: Some("function".to_string()),
            function: crate::provider::types::ToolCallFunction {
                name: "other_tool".to_string(),
                arguments: "{}".to_string(),
            },
        }];
        assert!(extract_tool_call(&tool_calls, &variables).is_none());
    }
}
