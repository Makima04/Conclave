use crate::error::AppError;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::types::{ContextBundle, MasterPlan, ParsedIntent, SubAgent, TurnState};
use crate::runtime::{structured_output, turn_state};
use tracing::instrument;

/// Run the Master Agent: analyze user input + context + agent states → produce execution plan
#[instrument(skip(provider, active_agents, turn_state, context, user_input, parsed_intent, agent), fields(agent_count = active_agents.len()))]
pub async fn run_master(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    active_agents: &[SubAgent],
    turn_state: &TurnState,
    context: &ContextBundle,
    parsed_intent: Option<&ParsedIntent>,
    agent: Option<&SubAgent>,
) -> Result<MasterPlan, AppError> {
    // Build agent status summary
    let agent_summaries = if active_agents.is_empty() {
        "(无活跃子Agent)".to_string()
    } else {
        active_agents
            .iter()
            .map(|a| {
                let ctx_hint = if a.context.is_empty() {
                    String::new()
                } else {
                    let preview: String = a.context.chars().take(80).collect();
                    format!(": {}", preview)
                };
                format!("- {} ({}{}) [{}]", a.id, a.agent_type, ctx_hint, a.status)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let turn_summaries = turn_state::get_all_summaries(turn_state);

    // Build context sections
    let scene_section = context
        .scene_summary
        .as_ref()
        .map(|s| format!("\n当前场景摘要:\n{}", s))
        .unwrap_or_default();

    let state_section = if context
        .structured_state
        .as_object()
        .map_or(true, |o| o.is_empty())
    {
        String::new()
    } else {
        format!(
            "\n世界状态:\n{}",
            serde_json::to_string_pretty(&context.structured_state).unwrap_or_default()
        )
    };

    let events_section = if context.events.is_empty() {
        String::new()
    } else {
        format!("\n已知事件:\n{}", context.events.join("\n"))
    };

    let foreshadow_section = if context.foreshadowing.is_empty() {
        String::new()
    } else {
        format!("\n伏笔线索:\n{}", context.foreshadowing.join("\n"))
    };

    let intent_section = parsed_intent
        .map(|p| {
            format!(
                "\n用户意图解析:\n- 意图: {}\n- 动作: {}\n- 目标角色: {}\n- 压缩输入: {}\n- 语气: {}",
                p.intent,
                p.action_type,
                if p.target_characters.is_empty() {
                    "(无)".to_string()
                } else {
                    p.target_characters.join(", ")
                },
                p.compressed_input,
                p.tone
            )
        })
        .unwrap_or_default();

    let default_prompt = format!(
        r#"你是总控Agent（Master），负责协调多Agent系统的执行。

根据用户输入、上下文和当前子Agent状态，输出执行计划。输出纯JSON，不要其他文字。

JSON格式：
{{
  "calls": [
    {{"agent_id": "agent的id", "task": "给该agent的具体任务描述", "inject_from": ["需要注入输出的其他agent_id"]}}
  ],
  "lifecycle": [
    {{"action": "create", "agent_type": "npc", "character_id": "角色id", "label": "显示名称", "reason": "创建原因", "context": "初始上下文(可选)"}},
    {{"action": "cooldown", "character_id": "要冷却的agent_id", "reason": "冷却原因"}},
    {{"action": "delete", "character_id": "要删除的agent_id", "reason": "删除原因"}},
    {{"action": "restore", "character_id": "要恢复的agent_id", "reason": "恢复原因"}}
  ],
  "user_auto": false,
  "final_writer_id": null
}}

规则：
1. calls中的agent_id必须是已有子Agent的id，或新创建Agent的id
2. inject_from指定哪些Agent的输出需要注入到当前Agent的上下文中
3. user_auto=true表示启用用户自动代理（如战斗自动补完）
4. 如果用户只是普通对话，通常只需调用相关NPC + writer
5. lifecycle可以为空数组[]，calls也可以为空（但通常至少要有一个writer来生成回复）
6. final_writer_id：当有多个writer时，指定最终产出叙事文本的writer的agent_id
6. 如果没有子Agent，先创建需要的Agent
7. 根据用户意图解析结果，精准调度相关Agent{scene_section}{state_section}{events_section}{foreshadow_section}"#
    );

    // Use agent's DB prompt if available, otherwise fall back to hardcoded default
    let system_prompt = agent
        .filter(|a| !a.system_prompt.is_empty())
        .map(|a| a.system_prompt.clone())
        .unwrap_or(default_prompt);

    // Build recent conversation section
    let recent_section = if context.recent_context.is_empty() {
        String::new()
    } else {
        let recent: Vec<_> = context.recent_context.iter().rev().take(6).rev().collect();
        let lines: Vec<String> = recent
            .iter()
            .map(|m| {
                let role_label = if m.role == "user" { "用户" } else { "助手" };
                let content = truncate_str(&m.content, 300);
                format!("[{}] {}", role_label, content)
            })
            .collect();
        format!("\n最近对话:\n{}", lines.join("\n"))
    };

    let user_content = format!(
        "当前活跃子Agent:\n{}\n\n{}用户输入:\n{}{}\n\n本轮已有输出:\n{}",
        agent_summaries, recent_section, user_input, intent_section, turn_summaries
    );

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
        temperature: Some(0.3),
        top_p: Some(1.0),
        max_tokens: Some(10000),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
    };

    tracing::debug!(model = model, "Master Agent: sending LLM request");

    let response = provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    tracing::debug!("Master Agent output: {}", truncate_str(&text, 200));

    // Parse JSON response with repair retry
    let schema_hint = r#"{"calls":[{"agent_id":"...","task":"...","inject_from":["..."]}],"lifecycle":[{"action":"create|cooldown|delete|restore","agent_type":"...","character_id":"...","label":"...","reason":"...","context":"..."}],"user_auto":false,"final_writer_id":null}"#;
    match structured_output::parse_with_repair(
        provider,
        model,
        &text,
        parse_master_plan,
        schema_hint,
    )
    .await
    {
        Ok(plan) => Ok(plan),
        Err(e) => {
            tracing::warn!(
                "Master Agent output parse failed after repair: {}, falling back to default plan",
                e
            );
            Ok(fallback_plan(active_agents, user_input))
        }
    }
}

fn parse_master_plan(text: &str) -> Result<MasterPlan, String> {
    // Try to extract JSON from the response (handle markdown code blocks)
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    serde_json::from_str::<MasterPlan>(json_str).map_err(|e| format!("JSON parse error: {}", e))
}

fn fallback_plan(active_agents: &[SubAgent], user_input: &str) -> MasterPlan {
    // Find writer agent, or indicate we need to create one
    let writer = active_agents.iter().find(|a| a.agent_type == "writer");

    let mut calls = Vec::new();
    let mut lifecycle = Vec::new();

    // Try to call relevant NPC agents based on simple keyword matching
    for agent in active_agents {
        if agent.agent_type == "npc" && user_input.contains(&agent.label) {
            calls.push(crate::runtime::types::AgentCall {
                agent_id: agent.id.clone(),
                task: format!("回应用户: {}", user_input),
                inject_from: vec![],
            });
        }
    }

    if let Some(w) = writer {
        let inject_from: Vec<String> = calls.iter().map(|c| c.agent_id.clone()).collect();
        calls.push(crate::runtime::types::AgentCall {
            agent_id: w.id.clone(),
            task: "根据以上互动，创作叙事文本。".to_string(),
            inject_from,
        });
    } else {
        // No writer exists, create one
        lifecycle.push(crate::runtime::types::LifecycleAction {
            action: "create".to_string(),
            agent_type: "writer".to_string(),
            character_id: None,
            label: "writer".to_string(),
            reason: "fallback: no writer agent".to_string(),
            context: None,
        });
    }

    MasterPlan {
        calls,
        lifecycle,
        user_auto: false,
        final_writer_id: None,
    }
}

fn truncate_str(s: &str, max: usize) -> &str {
    if s.len() <= max {
        s
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }
}
