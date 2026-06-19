use super::str_utils::{truncate_str, truncate_str_tail};
use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::types::{
    AgentType, ContextBundle, MasterPlan, ParsedIntent, SubAgent, TurnState,
};
use crate::runtime::{structured_output, turn_state};
use tracing::instrument;

/// Master agent 执行的调试元 —— 给 Agent 工作台顶部的 DAG 补一条 master snapshot 用。
/// 字段对应 run_master 内部已算好的 system_prompt / user_prompt / token / 耗时。
#[derive(Debug, Clone, Default)]
pub struct MasterRunDebug {
    pub system_prompt: String,
    pub user_prompt: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// Prompt-cache hit tokens for the master's LLM call (0 when not reported).
    pub cached_tokens: u32,
    pub duration_ms: i32,
}

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
) -> Result<(MasterPlan, MasterRunDebug), AppError> {
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
3. user_auto：当 action_type 为 attack/move 等需要自动补完玩家物理动作的回合，或玩家明确放权（如"让他来打"、"自动战斗"）时，设 user_auto=true，运行时会自动把玩家Agent注入DAG；普通对话/言语互动保持 user_auto=false
4. 如果用户只是普通对话，通常只需调用相关NPC + writer
5. lifecycle可以为空数组[]，calls也可以为空（但通常至少要有一个writer来生成回复）
6. final_writer_id：当有多个writer时，指定最终产出叙事文本的writer的agent_id
7. 如果没有子Agent，先创建需要的Agent
8. 根据用户意图解析结果，精准调度相关Agent"#
    );

    // Use agent's DB prompt if available, otherwise fall back to hardcoded default
    let system_prompt = agent
        .filter(|a| !a.system_prompt.is_empty())
        .map(|a| a.system_prompt.clone())
        .unwrap_or(default_prompt);

    // Build recent conversation section.
    // Tail-priority + generous cap: the end of a long opening greeting reflects the
    // current story position (e.g. a transformation that already happened), which is
    // what the plan must be based on. Truncating the head would lose that and make the
    // Master misjudge the scene as "still at the opening", cascading re-narration.
    let recent_section = if context.recent_context.is_empty() {
        String::new()
    } else {
        let recent: Vec<_> = context.recent_context.iter().rev().take(6).rev().collect();
        let lines: Vec<String> = recent
            .iter()
            .map(|m| {
                let role_label = if m.role == "user" { "用户" } else { "助手" };
                let content = truncate_str_tail(&m.content, 10000);
                format!("[{}] {}", role_label, content)
            })
            .collect();
        format!("\n最近对话:\n{}", lines.join("\n"))
    };

    // Dynamic per-turn context (scene/state/events/foreshadow) goes in the USER message, not the
    // system message — this keeps the system message fully static (rules + JSON schema) so the
    // prompt-cache prefix hits across turns. Previously these were format!-spliced into the
    // system message body, which broke the cache every turn. This also fixes a latent gap: when
    // a custom agent.system_prompt was used, those sections were dropped entirely.
    let user_content = format!(
        "当前活跃子Agent:\n{}\n\n{}用户输入:\n{}{}\n\n本轮已有输出:\n{}{}{}{}{}",
        agent_summaries,
        recent_section,
        user_input,
        intent_section,
        turn_summaries,
        scene_section,
        state_section,
        events_section,
        foreshadow_section,
    );

    let request = ChatRequest {
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
                content: user_content.clone(),
                reasoning_content: None,
                tool_calls: None,
            },
        ],
        temperature: Some(0.3),
        top_p: Some(1.0),
        max_tokens: Some(10000),
        frequency_penalty: None,
        presence_penalty: None,
        tools: None,
        tool_choice: None,
        stream: false,
        ..Default::default()
    };

    tracing::debug!(model = model, "Master Agent: sending LLM request");

    let master_start = std::time::Instant::now();
    let response = provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let duration_ms = master_start.elapsed().as_millis() as i32;
    let (prompt_tokens, completion_tokens, cached_tokens) = response
        .usage
        .as_ref()
        .map(|u| (u.prompt_tokens, u.completion_tokens, u.cached_tokens()))
        .unwrap_or((0, 0, 0));

    let debug = MasterRunDebug {
        system_prompt: system_prompt.clone(),
        user_prompt: user_content.clone(),
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        duration_ms,
    };

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
        Ok(plan) => Ok((plan, debug)),
        Err(e) => {
            tracing::warn!(
                "Master Agent output parse failed after repair: {}, falling back to default plan",
                e
            );
            Ok((fallback_plan(active_agents, user_input), debug))
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
    let writer = active_agents
        .iter()
        .find(|a| a.agent_type == AgentType::Writer);

    let mut calls = Vec::new();
    let mut lifecycle = Vec::new();

    // Try to call relevant NPC agents based on simple keyword matching
    for agent in active_agents {
        if agent.agent_type == AgentType::Npc && user_input.contains(&agent.label) {
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
            agent_type: AgentType::Writer,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::SubAgent;

    fn make_sub_agent(id: &str, agent_type: AgentType, label: &str) -> SubAgent {
        SubAgent {
            id: id.to_string(),
            session_id: "test_session".to_string(),
            agent_type,
            character_id: None,
            label: label.to_string(),
            system_prompt: String::new(),
            context: String::new(),
            status: "active".to_string(),
            last_active_turn: 1,
            config: serde_json::json!({}),
        }
    }

    // --- parse_master_plan tests ---

    #[test]
    fn parse_master_plan_valid_json() {
        let json = r#"{
            "calls": [{"agent_id": "npc_1", "task": "respond", "inject_from": []}],
            "lifecycle": [],
            "user_auto": false,
            "final_writer_id": null
        }"#;
        let plan = parse_master_plan(json).expect("should parse");
        assert_eq!(plan.calls.len(), 1);
        assert_eq!(plan.calls[0].agent_id, "npc_1");
        assert!(!plan.user_auto);
        assert!(plan.final_writer_id.is_none());
    }

    #[test]
    fn parse_master_plan_from_markdown_code_block() {
        let json = r#"```json
{
    "calls": [],
    "lifecycle": [],
    "user_auto": true,
    "final_writer_id": "writer_1"
}
```"#;
        let plan = parse_master_plan(json).expect("should parse from code block");
        assert!(plan.calls.is_empty());
        assert!(plan.user_auto);
        assert_eq!(plan.final_writer_id, Some("writer_1".to_string()));
    }

    #[test]
    fn parse_master_plan_with_lifecycle_actions() {
        let json = r#"{
            "calls": [],
            "lifecycle": [
                {"action": "create", "agent_type": "npc", "character_id": "bob", "label": "Bob", "reason": "new character", "context": "a blacksmith"},
                {"action": "cooldown", "character_id": "alice", "reason": "inactive"}
            ],
            "user_auto": false,
            "final_writer_id": null
        }"#;
        let plan = parse_master_plan(json).expect("should parse");
        assert_eq!(plan.lifecycle.len(), 2);
        assert_eq!(plan.lifecycle[0].action, "create");
        assert_eq!(plan.lifecycle[0].agent_type, AgentType::Npc);
        assert_eq!(plan.lifecycle[1].action, "cooldown");
    }

    #[test]
    fn parse_master_plan_invalid_json_returns_error() {
        let result = parse_master_plan("not json at all");
        assert!(result.is_err());
    }

    #[test]
    fn parse_master_plan_missing_required_field_returns_error() {
        let json = r#"{"calls": [], "lifecycle": []}"#;
        // user_auto is missing but has #[serde(default)], so it should parse with defaults
        let plan = parse_master_plan(json).expect("should parse with defaults");
        assert!(!plan.user_auto);
    }

    // --- fallback_plan tests ---

    #[test]
    fn fallback_plan_no_agents_creates_writer_lifecycle() {
        let agents: Vec<SubAgent> = vec![];
        let plan = fallback_plan(&agents, "hello");

        assert!(plan.calls.is_empty());
        assert_eq!(plan.lifecycle.len(), 1);
        assert_eq!(plan.lifecycle[0].action, "create");
        assert_eq!(plan.lifecycle[0].agent_type, AgentType::Writer);
        assert!(!plan.user_auto);
    }

    #[test]
    fn fallback_plan_with_writer_calls_writer() {
        let writer = make_sub_agent("w1", AgentType::Writer, "writer");
        let agents = vec![writer];
        let plan = fallback_plan(&agents, "hello");

        assert_eq!(plan.calls.len(), 1);
        assert_eq!(plan.calls[0].agent_id, "w1");
        assert!(plan.lifecycle.is_empty());
    }

    #[test]
    fn fallback_plan_keyword_matching_calls_matching_npc() {
        let npc = make_sub_agent("npc_alice", AgentType::Npc, "Alice");
        let writer = make_sub_agent("w1", AgentType::Writer, "writer");
        let agents = vec![npc, writer];
        let plan = fallback_plan(&agents, "talk to Alice about the quest");

        // NPC Alice should be called because "Alice" matches the label
        let npc_call = plan.calls.iter().find(|c| c.agent_id == "npc_alice");
        assert!(npc_call.is_some());
        assert!(
            npc_call
                .unwrap()
                .task
                .contains("talk to Alice about the quest")
        );

        // Writer should inject from NPC output
        let writer_call = plan.calls.iter().find(|c| c.agent_id == "w1");
        assert!(writer_call.is_some());
        assert!(
            writer_call
                .unwrap()
                .inject_from
                .contains(&"npc_alice".to_string())
        );
    }

    #[test]
    fn fallback_plan_non_matching_npc_not_called() {
        let npc = make_sub_agent("npc_bob", AgentType::Npc, "Bob");
        let writer = make_sub_agent("w1", AgentType::Writer, "writer");
        let agents = vec![npc, writer];
        let plan = fallback_plan(&agents, "hello Alice");

        // Bob should not be called since "Alice" doesn't match "Bob"
        let npc_call = plan.calls.iter().find(|c| c.agent_id == "npc_bob");
        assert!(npc_call.is_none());
    }

    #[test]
    fn fallback_plan_always_sets_user_auto_false() {
        let agents: Vec<SubAgent> = vec![];
        let plan = fallback_plan(&agents, "anything");
        assert!(!plan.user_auto);
    }
}
