use crate::error::AppError;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::recall;
use crate::runtime::turn_state;
use crate::runtime::types::{
    AgentCall, AgentConfig, AgentOutput, ContextBundle, ContextMessage, LifecycleAction, SubAgent,
    TurnState,
};
use sqlx::SqlitePool;
use tracing::instrument;

/// Execute a sub-agent: build context-aware prompt, call LLM, return output
#[instrument(skip(pool, provider, agent, state, context, call), fields(agent_id = %agent.id, agent_type = %agent.agent_type))]
pub async fn execute_sub_agent(
    pool: &SqlitePool,
    provider: &OpenAiProvider,
    model: &str,
    agent: &SubAgent,
    call: &AgentCall,
    state: &TurnState,
    context: &ContextBundle,
) -> Result<AgentOutput, AppError> {
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
        recall::RecalledContext {
            events: vec![],
            query_keywords: vec![],
            recall_mode: "none".to_string(),
        }
    });

    // Build system prompt: agent's own prompt + context + recent conversation + recalled events
    let system_prompt = build_contextual_system_prompt(agent, context, &agent_config, &recalled);

    // Build user content: task + injected outputs
    let mut user_content = call.task.clone();
    if !call.inject_from.is_empty() {
        let injected = turn_state::get_outputs_text(state, &call.inject_from);
        if !injected.is_empty() {
            user_content.push_str(&format!("\n\n---\n相关Agent的输出:\n{}", injected));
        }
    }

    let effective_temperature = agent_config.temperature.unwrap_or(0.8);
    let effective_max_tokens = agent_config.max_tokens.unwrap_or(10000);

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
        temperature: Some(effective_temperature),
        top_p: Some(1.0),
        max_tokens: Some(effective_max_tokens),
        frequency_penalty: Some(0.0),
        presence_penalty: Some(0.0),
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

    Ok(AgentOutput {
        agent_id: agent.id.clone(),
        agent_type: agent.agent_type.clone(),
        text,
        prompt_tokens: pt,
        completion_tokens: ct,
        duration_ms,
    })
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

/// Filter structured state by visibility rules.
/// Removes fields matching sensitive patterns (hidden_*, secret_*, internal_*).
fn filter_state_for_visibility(state: &serde_json::Value, agent_type: &str) -> serde_json::Value {
    // Director, master, state/compression get full access
    if matches!(agent_type, "director" | "master" | "state" | "parser") {
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
    agent_type: &str,
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
fn is_visible(visibility: &str, agent_type: &str, character_id: Option<&str>) -> bool {
    match visibility {
        "public" => true,
        "gm_only" => matches!(agent_type, "director" | "master"),
        "writer_only" => matches!(agent_type, "writer" | "director" | "master"),
        v if v.starts_with("character:") => {
            let vis_char_id = &v[10..]; // after "character:"
            // Director/master see everything; the matching character agent sees it
            if matches!(agent_type, "director" | "master") {
                return true;
            }
            character_id.map_or(false, |cid| cid == vis_char_id)
        }
        _ => true, // Unknown visibility → default to visible
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
    let mut prompt = agent.system_prompt.clone();

    // Agent-specific context (static, from DB)
    if !agent.context.is_empty() {
        prompt.push_str(&format!("\n\n---\n你的专属上下文:\n{}", agent.context));
    }

    match agent.agent_type.as_str() {
        "npc" => {
            // NPC gets: scene summary + recent events + foreshadowing (filtered by visibility)
            if let Some(ref summary) = context.scene_summary {
                prompt.push_str(&format!("\n\n---\n当前场景:\n{}", summary));
            }
            let visible_events = filter_by_visibility(
                &context.events,
                &context.event_visibilities,
                &agent.agent_type,
                agent.character_id.as_deref(),
                10,
            );
            if !visible_events.is_empty() {
                prompt.push_str(&format!(
                    "\n\n---\n已知事件:\n{}",
                    visible_events.join("\n")
                ));
            }
            let visible_foreshadowing = filter_by_visibility(
                &context.foreshadowing,
                &context.foreshadow_visibilities,
                &agent.agent_type,
                agent.character_id.as_deref(),
                100,
            );
            if !visible_foreshadowing.is_empty() {
                prompt.push_str(&format!(
                    "\n\n---\n伏笔线索:\n{}",
                    visible_foreshadowing.join("\n")
                ));
            }
        }
        "writer" => {
            // Writer gets: scene summary + foreshadowing (filtered by visibility)
            if let Some(ref summary) = context.scene_summary {
                prompt.push_str(&format!("\n\n---\n当前场景:\n{}", summary));
            }
            let visible_foreshadowing = filter_by_visibility(
                &context.foreshadowing,
                &context.foreshadow_visibilities,
                &agent.agent_type,
                agent.character_id.as_deref(),
                100,
            );
            if !visible_foreshadowing.is_empty() {
                prompt.push_str(&format!(
                    "\n\n---\n伏笔线索:\n{}",
                    visible_foreshadowing.join("\n")
                ));
            }
        }
        "director" => {
            // Director gets full access to everything
            if let Some(ref summary) = context.scene_summary {
                prompt.push_str(&format!("\n\n---\n当前场景:\n{}", summary));
            }
            if !context.events.is_empty() {
                prompt.push_str(&format!(
                    "\n\n---\n已知事件:\n{}",
                    context.events.join("\n")
                ));
            }
            if !context.foreshadowing.is_empty() {
                prompt.push_str(&format!(
                    "\n\n---\n伏笔线索:\n{}",
                    context.foreshadowing.join("\n")
                ));
            }
        }
        "user" => {
            // User proxy gets: scene summary + public events only
            if let Some(ref summary) = context.scene_summary {
                prompt.push_str(&format!("\n\n---\n当前场景:\n{}", summary));
            }
            let visible_events = filter_by_visibility(
                &context.events,
                &context.event_visibilities,
                &agent.agent_type,
                agent.character_id.as_deref(),
                5,
            );
            if !visible_events.is_empty() {
                prompt.push_str(&format!(
                    "\n\n---\n已知事件:\n{}",
                    visible_events.join("\n")
                ));
            }
        }
        // parser, master, state, and others get minimal extra context
        _ => {}
    }

    // Inject structured state for agents that benefit from it (filtered by visibility)
    if matches!(
        agent.agent_type.as_str(),
        "npc" | "writer" | "director" | "user"
    ) && !context
        .structured_state
        .as_object()
        .map_or(true, |o| o.is_empty())
    {
        let filtered_state =
            filter_state_for_visibility(&context.structured_state, &agent.agent_type);
        if !filtered_state.as_object().map_or(true, |o| o.is_empty()) {
            prompt.push_str(&format!(
                "\n\n---\n世界状态:\n{}",
                serde_json::to_string_pretty(&filtered_state).unwrap_or_default()
            ));
        }
    }

    // World book context injection (visibility-filtered per agent type)
    if !context.world_book_entries.is_empty() {
        let wb_entries: Vec<_> = context
            .world_book_entries
            .iter()
            .filter(|e| {
                // Filter by visibility based on agent type
                match e.visibility.as_str() {
                    "public" => true,
                    "writer_only" => matches!(agent.agent_type.as_str(), "writer" | "director"),
                    "gm_only" => matches!(agent.agent_type.as_str(), "director"),
                    v if v.starts_with("character:") => {
                        let char_id = &v[10..];
                        matches!(agent.agent_type.as_str(), "director")
                            || agent.character_id.as_deref() == Some(char_id)
                    }
                    _ => true,
                }
            })
            .collect();

        if !wb_entries.is_empty() {
            let mut wb_content = String::from("\n\n---\n世界书设定:\n");
            for entry in &wb_entries {
                if !entry.content.is_empty() {
                    wb_content.push_str(&format!("{}\n", entry.content));
                }
            }
            prompt.push_str(&wb_content);
        }
    }

    // Inject recent conversation history for narrative agents
    if matches!(
        agent.agent_type.as_str(),
        "npc" | "writer" | "director" | "user"
    ) {
        let max_turns = agent_config.max_context_turns.unwrap_or(5);
        let recent_text = format_recent_context(&context.recent_context, max_turns);
        if !recent_text.is_empty() {
            prompt.push_str(&format!("\n\n---\n最近对话:\n{}", recent_text));
        }
    }

    // Inject recalled structured events
    if !recalled.events.is_empty() {
        let event_lines: Vec<String> = recalled
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
            .collect();
        prompt.push_str(&format!(
            "\n\n---\n召回的相关事件:\n{}",
            event_lines.join("\n")
        ));
    }

    prompt
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

pub async fn create_agent(
    pool: &SqlitePool,
    session_id: &str,
    action: &LifecycleAction,
    turn_number: i32,
) -> Result<SubAgent, AppError> {
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
    let system_prompt = default_system_prompt_for_type(&action.agent_type);

    sqlx::query(
        "INSERT INTO sub_agents (id, session_id, agent_type, character_id, label, system_prompt, context, status, last_active_turn, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, '{}', ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(&action.agent_type)
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
        agent_type: action.agent_type.clone(),
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

fn default_system_prompt_for_type(agent_type: &str) -> String {
    match agent_type {
        "master" => "你是总控Agent。根据用户输入和子Agent状态，分析意图并输出执行计划。输出纯JSON格式的执行计划。".to_string(),
        "parser" => "你是解析Agent。分析用户输入的意图、动作类型、目标对象，压缩不必要的修辞，提取核心信息。输出结构化JSON。".to_string(),
        "npc" => "你是一个角色扮演NPC。根据你的角色设定和上下文，以第一人称回应场景中的互动。保持角色一致性。".to_string(),
        "user" => "你是用户的自动代理。根据用户角色设定和当前场景，代替用户进行合理的互动动作。保持与用户之前行为的一致性。".to_string(),
        "writer" => "你是写手Agent。根据所有角色的互动和导演的安排，创作最终的叙事文本。保持文风一致，描写生动。".to_string(),
        "director" => "你是导演Agent。分析当前场景中各角色的输出，安排叙事节奏、场景切换和重点突出。输出叙事结构建议。".to_string(),
        "state" => "你是状态管理Agent。分析本轮叙事中的数值变化、关系变化、新伏笔等，输出结构化的状态变更提案。".to_string(),
        _ => "你是子Agent。根据分配的任务和上下文执行工作。".to_string(),
    }
}
