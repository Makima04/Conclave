use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest, ChatTool};
use crate::runtime::knowledge;
use crate::runtime::recall;
use crate::runtime::turn_state;
use crate::runtime::types::{
    AgentCall, AgentConfig, AgentInjectedOutputDebug, AgentOutput, AgentType, ContextBundle,
    ContextMessage, LifecycleAction, SubAgent, SubAgentExecutionDebug, TurnState,
};
use sqlx::SqlitePool;
use tracing::instrument;

/// Execute a sub-agent: build context-aware prompt, call LLM, return output
#[instrument(skip(pool, provider, agent, state, context, call, tools), fields(agent_id = %agent.id, agent_type = %agent.agent_type))]
pub async fn execute_sub_agent(
    pool: &SqlitePool,
    provider: &OpenAiProvider,
    model: &str,
    agent: &SubAgent,
    call: &AgentCall,
    state: &TurnState,
    context: &ContextBundle,
    tools: Option<Vec<ChatTool>>,
) -> Result<(AgentOutput, SubAgentExecutionDebug), AppError> {
    let start = std::time::Instant::now();

    // Parse per-agent config
    let agent_config: AgentConfig =
        serde_json::from_value(agent.config.clone()).unwrap_or_default();

    // Recall relevant structured events for this agent
    let recalled = recall::recall_context(
        pool,
        &agent.session_id,
        &call.task,
        &agent_config,
        state.turn_number,
    )
    .await
    .unwrap_or_else(|e| {
        tracing::warn!("Recall failed for agent {}: {}", agent.id, e);
        recall::RecalledContext { events: vec![] }
    });

    // Build system prompt: agent's own prompt + context + recent conversation + recalled events
    let system_prompt = build_contextual_system_prompt(agent, context, &agent_config, &recalled);

    // Build user content: task + injected outputs
    let mut user_content = call.task.clone();
    let mut injected_outputs = Vec::new();
    for source_id in &call.inject_from {
        if let Some(output) = state.agent_outputs.get(source_id) {
            injected_outputs.push(AgentInjectedOutputDebug {
                agent_id: output.agent_id.clone(),
                agent_type: output.agent_type.as_str().to_string(),
                text: output.text.clone(),
            });
        }
    }
    if !call.inject_from.is_empty() {
        let injected = turn_state::get_outputs_text(state, &call.inject_from);
        if !injected.is_empty() {
            user_content.push_str(&format!("\n\n---\n相关Agent的输出:\n{}", injected));
        }
    }

    let debug_snapshot = SubAgentExecutionDebug {
        task: call.task.clone(),
        system_prompt: system_prompt.clone(),
        user_prompt: user_content.clone(),
        injected_from: call.inject_from.clone(),
        injected_outputs,
        preset_modules: visible_preset_modules(agent, context),
        worldbook_entries: visible_worldbook_entries(agent, context),
        recent_messages: visible_recent_messages(agent, context, &agent_config),
        recalled_events: recalled
            .events
            .iter()
            .map(|event| {
                serde_json::json!({
                    "id": event.id,
                    "turn_number": event.turn_number,
                    "characters": event.characters,
                    "scene_type": event.scene_type,
                    "importance": event.importance,
                    "raw_text": event.raw_text,
                })
            })
            .collect(),
        state_slice: visible_state_slice(agent, context),
    };

    let effective_temperature = agent_config.temperature.unwrap_or(0.8);
    let effective_max_tokens = agent_config.max_tokens.unwrap_or(10000);

    let tool_choice = if tools.is_some() {
        Some(serde_json::json!({
            "type": "function",
            "function": { "name": "update_variables" }
        }))
    } else {
        None
    };

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt,
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
        temperature: Some(effective_temperature),
        top_p: Some(1.0),
        max_tokens: Some(effective_max_tokens),
        frequency_penalty: Some(0.0),
        presence_penalty: Some(0.0),
        tools,
        tool_choice,
        stream: false,
    };

    tracing::debug!(
        agent_id = %agent.id,
        model = model,
        inject_count = call.inject_from.len(),
        task_len = call.task.len(),
        temperature = effective_temperature,
        max_tokens = effective_max_tokens,
        "Sub-agent: sending LLM request"
    );

    let response = provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();
    let response_tool_calls = response
        .choices
        .first()
        .and_then(|c| c.message.tool_calls.clone());
    let pt = response
        .usage
        .as_ref()
        .map(|u| u.prompt_tokens)
        .unwrap_or(0);
    let ct = response
        .usage
        .as_ref()
        .map(|u| u.completion_tokens)
        .unwrap_or(0);
    let duration_ms = start.elapsed().as_millis() as i32;

    tracing::info!(
        agent_id = %agent.id,
        agent_type = %agent.agent_type,
        tokens_in = pt,
        tokens_out = ct,
        duration_ms = duration_ms,
        "Sub-agent executed"
    );

    Ok((AgentOutput {
        agent_id: agent.id.clone(),
        agent_type: agent.agent_type,
        text,
        tool_calls: response_tool_calls,
        prompt_tokens: pt,
        completion_tokens: ct,
        duration_ms,
    }, debug_snapshot))
}

/// Format recent conversation messages into a readable transcript.
fn format_recent_context(messages: &[ContextMessage], max_turns: usize) -> String {
    // max_turns * 2 because each turn has a user + assistant message
    let recent: Vec<_> = messages.iter().rev().take(max_turns * 2).rev().collect();
    if recent.is_empty() {
        return String::new();
    }
    recent
        .iter()
        .map(|m| {
            let role_label = if m.role == "user" { "用户" } else { "助手" };
            format!("[{}] {}", role_label, m.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_role_contexts(context: &ContextBundle) -> String {
    if context.role_contexts.is_empty() {
        return String::new();
    }
    context
        .role_contexts
        .iter()
        .map(|r| {
            let label = if r.label.trim().is_empty() {
                r.agent_type.as_str()
            } else {
                r.label.as_str()
            };
            if r.context.trim().is_empty() {
                format!("- {} ({})", label, r.agent_type)
            } else {
                format!("- {} ({}): {}", label, r.agent_type, r.context.trim())
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_visible_knowledge(agent: &SubAgent, context: &ContextBundle) -> String {
    if context.knowledge_events.is_empty() {
        return String::new();
    }
    let current_role = context.role_contexts.iter().find(|r| {
        r.agent_type == agent.agent_type
            && (r.label == agent.label
                || agent
                    .character_id
                    .as_deref()
                    .is_some_and(|id| r.character_id.as_deref() == Some(id)))
    });

    context
        .knowledge_events
        .iter()
        .filter(|event| {
            current_role
                .map(|role| knowledge::visible_to_agent(event, role, agent.agent_type))
                .unwrap_or_else(|| {
                    matches!(
                        agent.agent_type,
                        AgentType::Writer
                            | AgentType::Director
                            | AgentType::Master
                            | AgentType::State
                            | AgentType::Parser
                    )
                })
        })
        .map(|event| {
            format!(
                "[T{}|{}|{}] {}",
                event.turn_number, event.source_type, event.visibility, event.fact
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn visible_preset_modules(agent: &SubAgent, context: &ContextBundle) -> Vec<crate::runtime::types::PresetModuleContext> {
    context
        .preset_modules
        .iter()
        .filter(|m| {
            m.target_agents
                .iter()
                .any(|t| t == agent.agent_type.as_str())
                || m.target_agents.contains(&"inject_all".to_string())
        })
        .cloned()
        .collect()
}

fn visible_worldbook_entries(agent: &SubAgent, context: &ContextBundle) -> Vec<crate::runtime::types::WorldBookContextEntry> {
    context
        .world_book_entries
        .iter()
        .filter(|e| e.category != "user")
        .filter(|e| match e.visibility.as_str() {
            "public" => true,
            "writer_only" => {
                matches!(agent.agent_type, AgentType::Writer | AgentType::Director)
            }
            "gm_only" => matches!(agent.agent_type, AgentType::Director),
            v if v.starts_with("character:") => {
                let char_id = &v[10..];
                matches!(agent.agent_type, AgentType::Director)
                    || agent.character_id.as_deref() == Some(char_id)
            }
            _ => true,
        })
        .cloned()
        .collect()
}

fn visible_recent_messages(
    agent: &SubAgent,
    context: &ContextBundle,
    agent_config: &AgentConfig,
) -> Vec<ContextMessage> {
    if !matches!(
        agent.agent_type,
        AgentType::Npc | AgentType::Writer | AgentType::Director | AgentType::User
    ) {
        return vec![];
    }

    let max_turns = agent_config.max_context_turns.unwrap_or(5);
    context
        .recent_context
        .iter()
        .rev()
        .take(max_turns * 2)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn visible_state_slice(agent: &SubAgent, context: &ContextBundle) -> serde_json::Value {
    if matches!(
        agent.agent_type,
        AgentType::Npc | AgentType::Writer | AgentType::Director | AgentType::User
    ) && !context
        .structured_state
        .as_object()
        .map_or(true, |o| o.is_empty())
    {
        filter_state_for_visibility(&context.structured_state, agent.agent_type)
    } else {
        serde_json::json!({})
    }
}

/// Filter structured state by visibility rules.
/// Removes fields matching sensitive patterns (hidden_*, secret_*, internal_*).
fn filter_state_for_visibility(
    state: &serde_json::Value,
    agent_type: AgentType,
) -> serde_json::Value {
    // Director, master, state/compression get full access
    if matches!(
        agent_type,
        AgentType::Director | AgentType::Master | AgentType::State | AgentType::Parser
    ) {
        return state.clone();
    }
    // NPC, writer, user: strip sensitive fields
    filter_sensitive_keys(state)
}

fn filter_sensitive_keys(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let filtered: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .filter(|(key, _)| {
                    let lower = key.to_lowercase();
                    !lower.starts_with("hidden_")
                        && !lower.starts_with("secret_")
                        && !lower.starts_with("internal_")
                        && lower != "gm_notes"
                        && lower != "meta"
                })
                .map(|(k, v)| (k.clone(), filter_sensitive_keys(v)))
                .collect();
            serde_json::Value::Object(filtered)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(filter_sensitive_keys).collect())
        }
        other => other.clone(),
    }
}

/// Filter items by visibility rules for the given agent type.
/// Returns items that the agent is allowed to see, up to `limit`.
fn filter_by_visibility(
    items: &[String],
    visibilities: &[String],
    agent_type: AgentType,
    character_id: Option<&str>,
    limit: usize,
) -> Vec<String> {
    items
        .iter()
        .zip(visibilities.iter())
        .filter(|(_, vis)| is_visible(vis, agent_type, character_id))
        .map(|(item, _)| item.clone())
        .take(limit)
        .collect()
}

/// Check if a visibility value allows the given agent type to see the item.
fn is_visible(visibility: &str, agent_type: AgentType, character_id: Option<&str>) -> bool {
    match visibility {
        "public" => true,
        "gm_only" => matches!(agent_type, AgentType::Director | AgentType::Master),
        "writer_only" => matches!(
            agent_type,
            AgentType::Writer | AgentType::Director | AgentType::Master
        ),
        v if v.starts_with("character:") => {
            let vis_char_id = &v[10..]; // after "character:"
            // Director/master see everything; the matching character agent sees it
            if matches!(agent_type, AgentType::Director | AgentType::Master) {
                return true;
            }
            character_id.map_or(false, |cid| cid == vis_char_id)
        }
        _ => true, // Unknown visibility → default to visible
    }
}

/// A single section of the system prompt, delimited by `---`.
struct PromptSection {
    title: &'static str,
    content: String,
}

/// Structured builder for composing system prompts from discrete sections.
struct PromptBuilder {
    base: String,
    sections: Vec<PromptSection>,
}

impl PromptBuilder {
    fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into(),
            sections: Vec::new(),
        }
    }

    /// Add a section only if content is non-empty.
    fn section(mut self, title: &'static str, content: impl Into<String>) -> Self {
        let content = content.into();
        if !content.trim().is_empty() {
            self.sections.push(PromptSection { title, content });
        }
        self
    }

    /// Conditionally add a section (skipped entirely if condition is false).
    fn section_if(self, condition: bool, title: &'static str, content: impl Into<String>) -> Self {
        if condition {
            self.section(title, content)
        } else {
            self
        }
    }

    /// Build the final prompt string.
    fn build(self) -> String {
        let mut prompt = self.base;
        for section in &self.sections {
            prompt.push_str(&format!("\n\n---\n{}:\n{}", section.title, section.content));
        }
        prompt
    }
}

/// Build a context-aware system prompt for a sub-agent based on its type.
/// Each agent type gets different context slices — not the full raw history.
fn build_contextual_system_prompt(
    agent: &SubAgent,
    context: &ContextBundle,
    agent_config: &AgentConfig,
    recalled: &recall::RecalledContext,
) -> String {
    let current_role = context.role_contexts.iter().find(|r| {
        r.agent_type == agent.agent_type
            && (r.label == agent.label
                || agent
                    .character_id
                    .as_deref()
                    .is_some_and(|id| r.character_id.as_deref() == Some(id)))
    });

    // Self context: user agents get dynamic role context, others get their DB-owned context
    let self_context = if agent.agent_type == AgentType::User {
        current_role.map(|role| role.context.as_str()).unwrap_or("")
    } else {
        agent.context.as_str()
    };

    // Role context and knowledge (shared across multiple agent types)
    let role_context_text = format_role_contexts(context);
    let visible_knowledge_text = format_visible_knowledge(agent, context);

    // Preset modules assigned to this agent type
    let visible_modules = visible_preset_modules(agent, context);
    let preset_text = visible_modules
        .iter()
        .filter(|m| !m.content.is_empty())
        .map(|m| format!("[{}]\n{}", m.name, m.content))
        .collect::<Vec<_>>()
        .join("\n");

    // Agent-type-specific sections (scene, events, foreshadowing)
    let builder = PromptBuilder::new(&agent.system_prompt)
        .section("你的专属上下文", self_context.trim())
        .section_if(
            matches!(
                agent.agent_type,
                AgentType::Writer | AgentType::Director | AgentType::User
            ),
            "当前参与角色",
            &role_context_text,
        )
        .section_if(
            matches!(
                agent.agent_type,
                AgentType::Npc
                    | AgentType::User
                    | AgentType::Writer
                    | AgentType::Director
                    | AgentType::Master
            ),
            "已知事实",
            &visible_knowledge_text,
        )
        .section("预设指令", &preset_text);

    // Per-agent-type scene/events/foreshadowing
    let builder = match agent.agent_type {
        AgentType::Npc => {
            let visible_events = filter_by_visibility(
                &context.events,
                &context.event_visibilities,
                agent.agent_type,
                agent.character_id.as_deref(),
                10,
            );
            let visible_foreshadowing = filter_by_visibility(
                &context.foreshadowing,
                &context.foreshadow_visibilities,
                agent.agent_type,
                agent.character_id.as_deref(),
                100,
            );
            builder
                .section("当前场景", context.scene_summary.as_deref().unwrap_or(""))
                .section("已知事件", visible_events.join("\n"))
                .section("伏笔线索", visible_foreshadowing.join("\n"))
        }
        AgentType::Writer => {
            let visible_foreshadowing = filter_by_visibility(
                &context.foreshadowing,
                &context.foreshadow_visibilities,
                agent.agent_type,
                agent.character_id.as_deref(),
                100,
            );
            builder
                .section("当前场景", context.scene_summary.as_deref().unwrap_or(""))
                .section("伏笔线索", visible_foreshadowing.join("\n"))
        }
        AgentType::Director => builder
            .section("当前场景", context.scene_summary.as_deref().unwrap_or(""))
            .section("已知事件", context.events.join("\n"))
            .section("伏笔线索", context.foreshadowing.join("\n")),
        AgentType::User => {
            let visible_events = filter_by_visibility(
                &context.events,
                &context.event_visibilities,
                agent.agent_type,
                agent.character_id.as_deref(),
                5,
            );
            builder
                .section("当前场景", context.scene_summary.as_deref().unwrap_or(""))
                .section("已知事件", visible_events.join("\n"))
        }
        _ => builder,
    };

    // Structured state (filtered by visibility for non-privileged agents)
    let state_text = if matches!(
        agent.agent_type,
        AgentType::Npc | AgentType::Writer | AgentType::Director | AgentType::User
    ) && !context
        .structured_state
        .as_object()
        .map_or(true, |o| o.is_empty())
    {
        let filtered = filter_state_for_visibility(&context.structured_state, agent.agent_type);
        serde_json::to_string_pretty(&filtered).unwrap_or_default()
    } else {
        String::new()
    };
    let builder = builder.section("世界状态", &state_text);

    // World book entries (visibility-filtered, excluding user category)
    let wb_text = {
        let wb_entries = visible_worldbook_entries(agent, context);
        wb_entries
            .iter()
            .filter(|e| !e.content.is_empty())
            .map(|e| e.content.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let builder = builder.section("世界书设定", &wb_text);

    // Recent conversation history for narrative agents
    let recent_text = if matches!(
        agent.agent_type,
        AgentType::Npc | AgentType::Writer | AgentType::Director | AgentType::User
    ) {
        let max_turns = agent_config.max_context_turns.unwrap_or(5);
        format_recent_context(&context.recent_context, max_turns)
    } else {
        String::new()
    };
    let builder = builder.section("最近对话", &recent_text);

    // Recalled structured events
    let recalled_text = recalled
        .events
        .iter()
        .map(|e| {
            let chars: Vec<String> = serde_json::from_str(&e.characters).unwrap_or_default();
            let char_str = if chars.is_empty() {
                String::new()
            } else {
                format!(" [{}]", chars.join(", "))
            };
            format!(
                "[T{}|{}|{}] {}{}",
                e.turn_number, e.scene_type, e.importance, e.raw_text, char_str
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let builder = builder.section("召回的相关事件", &recalled_text);

    builder.build()
}

// --- Lifecycle management ---

pub async fn get_active_agents(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<SubAgent>, AppError> {
    let agents = sqlx::query_as::<_, SubAgent>(
        "SELECT id, session_id, agent_type, character_id, label, system_prompt, context, status, last_active_turn, config FROM sub_agents WHERE session_id = ? AND status = 'active' ORDER BY created_at"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(agents)
}

pub async fn get_all_agents(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<SubAgent>, AppError> {
    let agents = sqlx::query_as::<_, SubAgent>(
        "SELECT id, session_id, agent_type, character_id, label, system_prompt, context, status, last_active_turn, config FROM sub_agents WHERE session_id = ? ORDER BY created_at"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(agents)
}

pub async fn sync_user_agent_from_persona(
    pool: &SqlitePool,
    session_id: &str,
    label: &str,
    context: &str,
) -> Result<(), AppError> {
    let label = label.trim();
    let context = context.trim();
    if label.is_empty() && context.is_empty() {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE sub_agents SET status = 'dead', updated_at = ? WHERE session_id = ? AND agent_type = 'user' AND status != 'dead'",
        )
        .bind(&now)
        .bind(session_id)
        .execute(pool)
        .await?;
        return Ok(());
    }

    let label = if label.is_empty() { "用户" } else { label };
    let now = chrono::Utc::now().to_rfc3339();

    let existing_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM sub_agents WHERE session_id = ? AND agent_type = 'user' AND status != 'dead' ORDER BY created_at LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    if let Some(id) = existing_id {
        sqlx::query(
            "UPDATE sub_agents SET label = ?, context = ?, status = 'active', updated_at = ? WHERE id = ?",
        )
        .bind(label)
        .bind(context)
        .bind(&now)
        .bind(&id)
        .execute(pool)
        .await?;
    } else {
        let action = LifecycleAction {
            action: "create".to_string(),
            agent_type: AgentType::User,
            character_id: Some("user".to_string()),
            label: label.to_string(),
            reason: "sync user persona".to_string(),
            context: Some(context.to_string()),
        };
        create_agent(pool, session_id, &action, 0).await?;
    }

    Ok(())
}

pub async fn create_agent(
    pool: &SqlitePool,
    session_id: &str,
    action: &LifecycleAction,
    turn_number: i32,
) -> Result<SubAgent, AppError> {
    if action.agent_type == AgentType::User {
        if let Some(existing) = get_user_agent(pool, session_id).await? {
            return Ok(existing);
        }
    }

    tracing::debug!(
        session = session_id,
        agent_type = %action.agent_type,
        label = %action.label,
        turn = turn_number,
        "Creating sub-agent"
    );
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let label = if action.label.is_empty() {
        format!("{}_{}", action.agent_type, &id[..8])
    } else {
        action.label.clone()
    };
    let system_prompt = default_system_prompt_for_type(action.agent_type);

    sqlx::query(
        "INSERT INTO sub_agents (id, session_id, agent_type, character_id, label, system_prompt, context, status, last_active_turn, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, '{}', ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(action.agent_type.as_str())
    .bind(&action.character_id)
    .bind(&label)
    .bind(&system_prompt)
    .bind(action.context.as_deref().unwrap_or(""))
    .bind(turn_number)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let agent = SubAgent {
        id: id.clone(),
        session_id: session_id.to_string(),
        agent_type: action.agent_type,
        character_id: action.character_id.clone(),
        label,
        system_prompt,
        context: action.context.clone().unwrap_or_default(),
        status: "active".to_string(),
        last_active_turn: turn_number,
        config: serde_json::json!({}),
    };

    tracing::info!(
        session = session_id,
        agent_id = %id,
        agent_type = %action.agent_type,
        label = %agent.label,
        "Sub-agent created"
    );

    Ok(agent)
}

pub async fn cooldown_agent(
    pool: &SqlitePool,
    agent_id: &str,
    reason: &str,
    turn_number: i32,
) -> Result<(), AppError> {
    if is_user_agent(pool, agent_id).await? {
        tracing::warn!(
            agent_id = agent_id,
            "Ignoring cooldown for fixed User Agent"
        );
        return Ok(());
    }

    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE sub_agents SET status = 'cooldown', cooldown_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'"
    )
    .bind(reason)
    .bind(&now)
    .bind(agent_id)
    .execute(pool)
    .await?;

    tracing::info!(
        agent_id = agent_id,
        reason = reason,
        turn = turn_number,
        "Agent cooled down"
    );
    Ok(())
}

pub async fn delete_agent(pool: &SqlitePool, agent_id: &str) -> Result<(), AppError> {
    if is_user_agent(pool, agent_id).await? {
        tracing::warn!(agent_id = agent_id, "Ignoring delete for fixed User Agent");
        return Ok(());
    }

    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE sub_agents SET status = 'dead', updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(agent_id)
        .execute(pool)
        .await?;

    tracing::info!(agent_id = agent_id, "Agent deleted (marked dead)");
    Ok(())
}

pub async fn restore_agent(
    pool: &SqlitePool,
    agent_id: &str,
    turn_number: i32,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE sub_agents SET status = 'active', last_active_turn = ?, cooldown_reason = NULL, updated_at = ? WHERE id = ? AND status = 'cooldown'"
    )
    .bind(turn_number)
    .bind(&now)
    .bind(agent_id)
    .execute(pool)
    .await?;

    tracing::info!(
        agent_id = agent_id,
        turn = turn_number,
        "Agent restored from cooldown"
    );
    Ok(())
}

async fn is_user_agent(pool: &SqlitePool, agent_id: &str) -> Result<bool, AppError> {
    let agent_type: Option<String> =
        sqlx::query_scalar("SELECT agent_type FROM sub_agents WHERE id = ?")
            .bind(agent_id)
            .fetch_optional(pool)
            .await?;
    Ok(agent_type.as_deref() == Some(AgentType::User.as_str()))
}

async fn get_user_agent(pool: &SqlitePool, session_id: &str) -> Result<Option<SubAgent>, AppError> {
    let agent = sqlx::query_as::<_, SubAgent>(
        "SELECT id, session_id, agent_type, character_id, label, system_prompt, context, status, last_active_turn, config FROM sub_agents WHERE session_id = ? AND agent_type = 'user' AND status != 'dead' ORDER BY created_at LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    Ok(agent)
}

/// Auto-cooldown agents that haven't been active for too many turns
pub async fn check_cooldowns(
    pool: &SqlitePool,
    session_id: &str,
    cooldown_turns: i32,
    current_turn: i32,
) -> Result<i32, AppError> {
    let threshold = current_turn - cooldown_turns;
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE sub_agents SET status = 'cooldown', cooldown_reason = 'auto: inactive turns', updated_at = ? WHERE session_id = ? AND status = 'active' AND last_active_turn < ? AND agent_type = 'npc'"
    )
    .bind(&now)
    .bind(session_id)
    .bind(threshold)
    .execute(pool)
    .await?;

    let count = result.rows_affected() as i32;
    if count > 0 {
        tracing::info!(
            session = session_id,
            cooled = count,
            threshold_turn = threshold,
            "Auto-cooldown applied"
        );
    }
    Ok(count)
}

/// Update an agent's last_active_turn
pub async fn touch_agent(pool: &SqlitePool, agent_id: &str, turn_number: i32) {
    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query("UPDATE sub_agents SET last_active_turn = ?, updated_at = ? WHERE id = ?")
        .bind(turn_number)
        .bind(&now)
        .bind(agent_id)
        .execute(pool)
        .await;
}

fn default_system_prompt_for_type(agent_type: AgentType) -> String {
    match agent_type {
        AgentType::Master => "你是总控Agent。根据用户输入和子Agent状态，分析意图并输出执行计划。输出纯JSON格式的执行计划。".to_string(),
        AgentType::Parser => "你是解析Agent。分析用户输入的意图、动作类型、目标对象，压缩不必要的修辞，提取核心信息。输出结构化JSON。".to_string(),
        AgentType::Npc => "你是一个角色扮演NPC。根据你的角色设定和上下文，以第一人称回应场景中的互动。保持角色一致性。".to_string(),
        AgentType::User => "你是用户的自动代理。根据用户角色设定和当前场景，代替用户进行合理的互动动作。保持与用户之前行为的一致性。".to_string(),
        AgentType::Writer => "你是写手Agent。根据所有角色的互动和导演的安排，创作最终的叙事文本。保持文风一致，描写生动。".to_string(),
        AgentType::Director => "你是导演Agent。分析当前场景中各角色的输出，安排叙事节奏、场景切换和重点突出。输出叙事结构建议。".to_string(),
        AgentType::State => "你是状态管理Agent。分析本轮叙事中的数值变化、关系变化、新伏笔等，输出结构化的状态变更提案。".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::{ContextBundle, ContextMessage, RoleContext};

    fn empty_context() -> ContextBundle {
        ContextBundle {
            task: "test".to_string(),
            recent_context: vec![],
            role_contexts: vec![],
            knowledge_events: vec![],
            structured_state: serde_json::json!({}),
            events: vec![],
            event_visibilities: vec![],
            foreshadowing: vec![],
            foreshadow_visibilities: vec![],
            scene_summary: None,
            world_book_entries: vec![],
            preset_modules: vec![],
        }
    }

    // --- is_visible tests ---

    #[test]
    fn is_visible_public_accepts_all_types() {
        assert!(is_visible("public", AgentType::Npc, None));
        assert!(is_visible("public", AgentType::Writer, None));
        assert!(is_visible("public", AgentType::Director, None));
        assert!(is_visible("public", AgentType::User, None));
        assert!(is_visible("public", AgentType::Master, None));
    }

    #[test]
    fn is_visible_gm_only_accepts_director_and_master() {
        assert!(is_visible("gm_only", AgentType::Director, None));
        assert!(is_visible("gm_only", AgentType::Master, None));
        assert!(!is_visible("gm_only", AgentType::Npc, None));
        assert!(!is_visible("gm_only", AgentType::Writer, None));
        assert!(!is_visible("gm_only", AgentType::User, None));
    }

    #[test]
    fn is_visible_writer_only_accepts_writer_director_master() {
        assert!(is_visible("writer_only", AgentType::Writer, None));
        assert!(is_visible("writer_only", AgentType::Director, None));
        assert!(is_visible("writer_only", AgentType::Master, None));
        assert!(!is_visible("writer_only", AgentType::Npc, None));
        assert!(!is_visible("writer_only", AgentType::User, None));
    }

    #[test]
    fn is_visible_character_matching_id() {
        assert!(is_visible("character:alice", AgentType::Npc, Some("alice")));
        assert!(!is_visible("character:alice", AgentType::Npc, Some("bob")));
        assert!(!is_visible("character:alice", AgentType::Npc, None));
    }

    #[test]
    fn is_visible_character_director_sees_all() {
        assert!(is_visible("character:alice", AgentType::Director, None));
        assert!(is_visible(
            "character:alice",
            AgentType::Director,
            Some("bob")
        ));
        assert!(is_visible("character:alice", AgentType::Master, None));
    }

    #[test]
    fn is_visible_unknown_defaults_to_visible() {
        assert!(is_visible("something_else", AgentType::Npc, None));
        assert!(is_visible("custom_visibility", AgentType::Writer, None));
    }

    // --- filter_by_visibility tests ---

    #[test]
    fn filter_by_visibility_public_returns_all() {
        let items = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let vis = vec![
            "public".to_string(),
            "public".to_string(),
            "public".to_string(),
        ];
        let result = filter_by_visibility(&items, &vis, AgentType::Npc, None, 10);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn filter_by_visibility_respects_limit() {
        let items = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let vis = vec![
            "public".to_string(),
            "public".to_string(),
            "public".to_string(),
        ];
        let result = filter_by_visibility(&items, &vis, AgentType::Npc, None, 2);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn filter_by_visibility_mixed_visibilities() {
        let items = vec!["pub".to_string(), "gm".to_string(), "writer".to_string()];
        let vis = vec![
            "public".to_string(),
            "gm_only".to_string(),
            "writer_only".to_string(),
        ];

        let npc_result = filter_by_visibility(&items, &vis, AgentType::Npc, None, 10);
        assert_eq!(npc_result, vec!["pub"]);

        let writer_result = filter_by_visibility(&items, &vis, AgentType::Writer, None, 10);
        assert_eq!(writer_result, vec!["pub", "writer"]);

        let director_result = filter_by_visibility(&items, &vis, AgentType::Director, None, 10);
        assert_eq!(director_result, vec!["pub", "gm", "writer"]);
    }

    // --- filter_state_for_visibility tests ---

    #[test]
    fn filter_state_director_gets_full_access() {
        let state = serde_json::json!({
            "name": "Alice",
            "secret_plan": "betray everyone",
            "hidden_motivation": "revenge",
            "public_info": "merchant"
        });
        let result = filter_state_for_visibility(&state, AgentType::Director);
        assert_eq!(result, state);
    }

    #[test]
    fn filter_state_npc_strips_sensitive_keys() {
        let state = serde_json::json!({
            "name": "Alice",
            "secret_plan": "betray everyone",
            "hidden_motivation": "revenge",
            "internal_id": "abc",
            "gm_notes": "important notes",
            "meta": {"created": "2024-01-01"},
            "public_info": "merchant"
        });
        let result = filter_state_for_visibility(&state, AgentType::Npc);

        assert_eq!(result["name"], "Alice");
        assert_eq!(result["public_info"], "merchant");
        assert!(result.get("secret_plan").is_none());
        assert!(result.get("hidden_motivation").is_none());
        assert!(result.get("internal_id").is_none());
        assert!(result.get("gm_notes").is_none());
        assert!(result.get("meta").is_none());
    }

    #[test]
    fn filter_state_writer_strips_sensitive_keys() {
        let state = serde_json::json!({
            "visible": true,
            "hidden_truth": "the cake is a lie"
        });
        let result = filter_state_for_visibility(&state, AgentType::Writer);
        assert_eq!(result["visible"], true);
        assert!(result.get("hidden_truth").is_none());
    }

    #[test]
    fn filter_state_master_gets_full_access() {
        let state = serde_json::json!({"secret": "x"});
        let result = filter_state_for_visibility(&state, AgentType::Master);
        assert_eq!(result, state);
    }

    // --- default_system_prompt_for_type tests ---

    #[test]
    fn default_system_prompt_non_empty_for_all_types() {
        let types = [
            AgentType::Master,
            AgentType::Parser,
            AgentType::Npc,
            AgentType::User,
            AgentType::Writer,
            AgentType::Director,
            AgentType::State,
        ];
        for t in types {
            let prompt = default_system_prompt_for_type(t);
            assert!(!prompt.is_empty(), "prompt for {} should not be empty", t);
        }
    }

    #[test]
    fn default_system_prompt_contains_type_name_hint() {
        // Each prompt should mention its role in some way
        assert!(default_system_prompt_for_type(AgentType::Master).contains("总控"));
        assert!(default_system_prompt_for_type(AgentType::Writer).contains("写手"));
        assert!(default_system_prompt_for_type(AgentType::Director).contains("导演"));
        assert!(default_system_prompt_for_type(AgentType::Npc).contains("NPC"));
    }

    // --- format_recent_context tests ---

    #[test]
    fn format_recent_context_empty_messages() {
        let result = format_recent_context(&[], 5);
        assert!(result.is_empty());
    }

    #[test]
    fn format_recent_context_labels_user_and_assistant() {
        let messages = vec![
            ContextMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
                turn_number: 1,
            },
            ContextMessage {
                role: "assistant".to_string(),
                content: "Hi there".to_string(),
                turn_number: 1,
            },
        ];
        let result = format_recent_context(&messages, 5);
        assert!(result.contains("[用户] Hello"));
        assert!(result.contains("[助手] Hi there"));
    }

    #[test]
    fn format_recent_context_limits_turns() {
        // Create 6 messages (3 turns worth), limit to 2 turns = 4 messages
        let messages: Vec<ContextMessage> = (1..=3)
            .flat_map(|i| {
                vec![
                    ContextMessage {
                        role: "user".to_string(),
                        content: format!("u{}", i),
                        turn_number: i,
                    },
                    ContextMessage {
                        role: "assistant".to_string(),
                        content: format!("a{}", i),
                        turn_number: i,
                    },
                ]
            })
            .collect();

        let result = format_recent_context(&messages, 2);
        // Should contain turns 2 and 3, not turn 1
        assert!(!result.contains("u1"));
        assert!(result.contains("u2"));
        assert!(result.contains("u3"));
    }

    // --- format_role_contexts tests ---

    #[test]
    fn format_role_contexts_empty() {
        let ctx = empty_context();
        let result = format_role_contexts(&ctx);
        assert!(result.is_empty());
    }

    #[test]
    fn format_role_contexts_with_entries() {
        let ctx = ContextBundle {
            role_contexts: vec![
                RoleContext {
                    agent_type: AgentType::Npc,
                    label: "Alice".to_string(),
                    character_id: Some("alice".to_string()),
                    context: "A brave warrior".to_string(),
                },
                RoleContext {
                    agent_type: AgentType::Writer,
                    label: "".to_string(),
                    character_id: None,
                    context: String::new(),
                },
            ],
            ..empty_context()
        };
        let result = format_role_contexts(&ctx);
        assert!(result.contains("Alice"));
        assert!(result.contains("A brave warrior"));
        // Empty label falls back to agent_type string
        assert!(result.contains("writer"));
    }

    // --- filter_sensitive_keys tests ---

    #[test]
    fn filter_sensitive_keys_nested_objects() {
        let state = serde_json::json!({
            "level1": {
                "visible": 1,
                "hidden_data": "secret",
                "level2": {
                    "ok": true,
                    "internal_notes": "nope"
                }
            }
        });
        let result = filter_sensitive_keys(&state);
        assert_eq!(result["level1"]["visible"], 1);
        assert!(result["level1"].get("hidden_data").is_none());
        assert_eq!(result["level1"]["level2"]["ok"], true);
        assert!(result["level1"]["level2"].get("internal_notes").is_none());
    }

    #[test]
    fn filter_sensitive_keys_in_arrays() {
        let state = serde_json::json!([
            {"name": "Alice", "secret_role": "spy"},
            {"name": "Bob", "gm_notes": "knows everything"}
        ]);
        let result = filter_sensitive_keys(&state);
        assert_eq!(result[0]["name"], "Alice");
        assert!(result[0].get("secret_role").is_none());
        assert_eq!(result[1]["name"], "Bob");
        assert!(result[1].get("gm_notes").is_none());
    }
}
