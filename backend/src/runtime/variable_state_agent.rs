use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::structured_output;
use crate::runtime::types::{ContextBundle, StateChangeCandidate, StateChangeProposal, SubAgent};

const DEFAULT_VARIABLE_STATE_PROMPT: &str = r#"你是变量状态Agent。你只负责根据本轮用户输入和最终叙事，判断角色卡运行变量是否需要变化。

输出必须是纯JSON，不要Markdown，不要解释文字。

JSON格式：
{
  "changes": [
    {
      "op": "update",
      "target": "variables.<user>.精神状态数值.调教值",
      "from": "0 | 最初的苏醒",
      "to": "1 | 初步检查完成",
      "evidence_turns": []
    }
  ]
}

规则：
1. 只能更新 target 以 "variables." 开头的路径。
2. 路径必须来自当前状态中已有的变量结构；不要创造无关路径。
3. 只输出本轮明确发生变化的变量；没有变化时输出 {"changes":[]}。
4. 不要重写整棵对象，只更新具体叶子路径。
5. 变量值如果原本是数组 [当前值, 说明]，只更新第0项，例如 target: "variables.<user>.精神状态数值.调教值[0]", to: "1 | 初步检查完成"。不要覆盖第1项说明文本。
6. 数值变化要保守，除非叙事明确发生重大转折。
7. 必须尽量填写 from 为当前状态里的原值，用于冲突检测。"#;

#[derive(Debug, serde::Deserialize)]
struct VariableStateOutput {
    #[serde(default)]
    changes: Vec<StateChangeCandidate>,
}

pub async fn propose_variable_changes(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    narrative_text: &str,
    context: &ContextBundle,
    agent: Option<&SubAgent>,
) -> Result<Option<StateChangeProposal>, AppError> {
    let variables = context
        .structured_state
        .get("variables")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    if variables.as_object().map_or(true, |obj| obj.is_empty()) {
        return Ok(None);
    }

    let system_prompt = agent
        .filter(|a| !a.system_prompt.trim().is_empty())
        .map(|a| {
            format!(
                "{}\n\n---\n必须遵守以下平台输出协议：\n{}",
                a.system_prompt, DEFAULT_VARIABLE_STATE_PROMPT
            )
        })
        .unwrap_or_else(|| DEFAULT_VARIABLE_STATE_PROMPT.to_string());

    let user_content = format!(
        "当前变量状态:\n{}\n\n用户输入:\n{}\n\n最终叙事:\n{}",
        serde_json::to_string_pretty(&variables).unwrap_or_default(),
        user_input,
        narrative_text
    );

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt,
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
        max_tokens: Some(4096),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
    };

    tracing::debug!("Variable state agent: sending LLM request");

    let response = provider
        .chat_completion_with_retry(request, 2)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    let output = structured_output::parse_with_repair(
        provider,
        model,
        &text,
        parse_variable_state_output,
        r#"{"changes":[{"op":"update","target":"variables.<user>.精神状态数值.调教值","from":"0 | 最初的苏醒","to":"1 | 初步检查完成","evidence_turns":[]}]}"#,
    )
    .await
    .map_err(|e| AppError::Provider(format!("Variable state parse failed: {}", e)))?;

    let changes: Vec<StateChangeCandidate> = output
        .changes
        .into_iter()
        .filter(|change| is_allowed_variable_change(change))
        .collect();

    if changes.is_empty() {
        return Ok(None);
    }

    Ok(Some(StateChangeProposal {
        proposed_by: "state_agent".to_string(),
        risk: "low".to_string(),
        changes,
    }))
}

fn parse_variable_state_output(text: &str) -> Result<VariableStateOutput, String> {
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    serde_json::from_str::<VariableStateOutput>(json_str)
        .map_err(|e| format!("JSON parse error: {}", e))
}

fn is_allowed_variable_change(change: &StateChangeCandidate) -> bool {
    change.op == "update"
        && change.target.starts_with("variables.")
        && !change.target.to_lowercase().contains("secret_")
        && !change.target.to_lowercase().contains("hidden_")
        && !change.target.to_lowercase().contains("internal_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_changes_json() {
        let parsed = parse_variable_state_output(
            r#"{"changes":[{"op":"update","target":"variables.<user>.精神状态数值.调教值","from":"0","to":"1","evidence_turns":[]}]}"#,
        )
        .expect("valid output");

        assert_eq!(parsed.changes.len(), 1);
        assert_eq!(
            parsed.changes[0].target,
            "variables.<user>.精神状态数值.调教值"
        );
    }

    #[test]
    fn filters_non_variable_paths() {
        let change = StateChangeCandidate {
            op: "update".to_string(),
            target: "scene.location".to_string(),
            from: None,
            to: serde_json::json!("x"),
            evidence_turns: vec![],
        };

        assert!(!is_allowed_variable_change(&change));
    }
}
