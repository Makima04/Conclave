use super::context;
use super::ejs_preprocess::{self, PreprocessableEntry};
use super::str_utils::truncate_str;
use super::types::{
    AgentDebugSnapshot, ContextBundle, ContextMessage, MemoryProposal, RoleContext,
    StateChangeProposal, TurnResult, WorldBookContextEntry, WriterDraft,
};
use crate::config::AppConfig;
use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest, StreamChunk};
use crate::routes::sessions::SessionConfig;
use crate::runtime::turn_finalizer;
use crate::runtime::variable_tool_agent;
use crate::runtime::variable_update;
use futures::Stream;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, broadcast};
use tracing::{info, instrument};

use super::sse_types::SseEvent;

/// Shared map of active turn broadcast senders, keyed by session_id.
/// Allows the reconnect endpoint to subscribe to an in-progress turn's event stream.
pub type ActiveTurns = Arc<Mutex<HashMap<String, broadcast::Sender<SseEvent>>>>;
pub type StreamCommitData = Arc<
    std::sync::Mutex<
        Option<(
            Vec<super::types::AgentTrace>,
            Vec<AgentDebugSnapshot>,
            Option<crate::runtime::types::CompressionResult>,
            Option<turn_finalizer::CompressionJob>,
        )>,
    >,
>;

pub struct StreamTurnResult {
    pub stream: Pin<Box<dyn Stream<Item = Result<StreamChunk, AppError>> + Send>>,
    pub turn_number: i32,
    pub session_id: String,
    pub title_source: String,
    /// Data from multi-agent turn for the route layer to persist after the stream completes.
    /// None for single-agent streaming.
    pub commit_data: Option<StreamCommitData>,
}

/// Extract user and character names from role contexts.
fn extract_user_char_names(roles: &[RoleContext]) -> (String, String) {
    let mut user_name = "User".to_string();
    let mut char_name = "Assistant".to_string();
    for role in roles {
        match role.agent_type {
            super::types::AgentType::User => {
                if !role.label.is_empty() {
                    user_name = role.label.clone();
                }
            }
            super::types::AgentType::Npc | super::types::AgentType::Writer => {
                if !role.label.is_empty() {
                    char_name = role.label.clone();
                }
            }
            _ => {}
        }
    }
    (user_name, char_name)
}

/// Extract chat variables from structured_state for EJS template evaluation.
fn extract_chat_variables(state: &serde_json::Value) -> serde_json::Value {
    state
        .get("variables")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}))
}

fn format_world_book_reference(entries: &[WorldBookContextEntry]) -> Option<String> {
    let mut visible_entries: Vec<_> = entries
        .iter()
        .filter(|entry| entry.category != "user")
        .filter(|entry| !is_variable_rule_entry(entry))
        .filter(|entry| !entry.content.trim().is_empty())
        .collect();
    if visible_entries.is_empty() {
        return None;
    }

    visible_entries.sort_by_key(|entry| -entry.priority);
    let mut content = String::from("[World Book Reference]\n");
    for entry in visible_entries {
        if entry.constant {
            content.push_str(&format!("[Always Active] {}\n\n", entry.content));
        } else {
            content.push_str(&format!("{}\n\n", entry.content));
        }
    }
    Some(content)
}

fn is_variable_rule_entry(entry: &WorldBookContextEntry) -> bool {
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

fn format_role_reference(roles: &[RoleContext]) -> Option<String> {
    let lines: Vec<String> = roles
        .iter()
        .filter(|role| !role.label.trim().is_empty() || !role.context.trim().is_empty())
        .map(|role| {
            let label = if role.label.trim().is_empty() {
                role.agent_type.as_str()
            } else {
                role.label.as_str()
            };
            if role.context.trim().is_empty() {
                format!("- {} ({})", label, role.agent_type)
            } else {
                format!("- {} ({}): {}", label, role.agent_type, role.context.trim())
            }
        })
        .collect();

    if lines.is_empty() {
        None
    } else {
        Some(format!("[Role Reference]\n{}", lines.join("\n")))
    }
}

fn build_single_agent_messages(
    system_prompt: String,
    context_bundle: &ContextBundle,
    current_user_input: Option<&str>,
) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_prompt,
        reasoning_content: None,
        tool_calls: None,
    }];

    messages.push(ChatMessage {
        role: "system".to_string(),
        content: "Runtime constraint: output only user-visible narrative text. Do not output <UpdateVariable>, <Analysis>, variable audits, state update instructions, JSON state changes, or tool-call text.".to_string(),
        reasoning_content: None,
        tool_calls: None,
    });

    if let Some(role_content) = format_role_reference(&context_bundle.role_contexts) {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: role_content,
            reasoning_content: None,
            tool_calls: None,
        });
    }

    for msg in &context_bundle.recent_context {
        messages.push(ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
            reasoning_content: None,
            tool_calls: None,
        });
    }

    if !context_bundle.events.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Known events:\n{}", context_bundle.events.join("\n")),
            reasoning_content: None,
            tool_calls: None,
        });
    }

    if !context_bundle.foreshadowing.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!(
                "Open foreshadowing items:\n{}",
                context_bundle.foreshadowing.join("\n")
            ),
            reasoning_content: None,
            tool_calls: None,
        });
    }

    if let Some(ref summary) = context_bundle.scene_summary {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Scene summary:\n{}", summary),
            reasoning_content: None,
            tool_calls: None,
        });
    }

    if !context_bundle
        .structured_state
        .as_object()
        .map_or(true, |o| o.is_empty())
    {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!(
                "Current world state:\n{}",
                serde_json::to_string_pretty(&context_bundle.structured_state).unwrap_or_default()
            ),
            reasoning_content: None,
            tool_calls: None,
        });
    }

    // User-character world-book entries are merged into Role Reference above.
    // EJS preprocessing: evaluate @@preprocessing entries before formatting.
    let mut wb_entries = context_bundle.world_book_entries.clone();
    let (user_name, char_name) = extract_user_char_names(&context_bundle.role_contexts);
    let variables = extract_chat_variables(&context_bundle.structured_state);
    let mut preprocessable: Vec<PreprocessableEntry> = wb_entries
        .iter()
        .enumerate()
        .map(|(i, e)| PreprocessableEntry {
            index: i,
            comment: String::new(), // comment not stored in WorldBookContextEntry
            content: e.content.clone(),
            keys: e.keys.clone(),
        })
        .collect();
    ejs_preprocess::preprocess_world_book_entries(
        &mut preprocessable,
        &user_name,
        &char_name,
        &variables,
    );
    // Write preprocessed content back
    for (i, entry) in preprocessable.iter().enumerate() {
        wb_entries[i].content = entry.content.clone();
    }
    if let Some(wb_content) = format_world_book_reference(&wb_entries) {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: wb_content,
            reasoning_content: None,
            tool_calls: None,
        });
    }

    if let Some(input) = current_user_input {
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: input.to_string(),
            reasoning_content: None,
            tool_calls: None,
        });
    }

    messages
}

fn context_with_current_turn(
    context_bundle: &ContextBundle,
    turn_number: i32,
    user_input: &str,
    assistant_output: Option<&str>,
) -> ContextBundle {
    let mut context_bundle = context_bundle.clone();
    context_bundle.recent_context.push(ContextMessage {
        role: "user".to_string(),
        content: user_input.to_string(),
        turn_number,
    });
    if let Some(output) = assistant_output {
        context_bundle.recent_context.push(ContextMessage {
            role: "assistant".to_string(),
            content: output.to_string(),
            turn_number,
        });
    }
    context_bundle
}

#[derive(Debug, sqlx::FromRow)]
struct SessionRow {
    mode: String,
    current_turn: i32,
    config: String,
    title_source: String,
}

#[derive(Debug, sqlx::FromRow)]
struct ProviderRow {
    id: String,
    base_url: String,
    api_key: String,
}

#[derive(Clone)]
pub struct ModelTarget {
    pub provider: OpenAiProvider,
    pub model: String,
    pub trace_model: String,
}

async fn load_provider(pool: &SqlitePool) -> Result<OpenAiProvider, AppError> {
    let row = sqlx::query_as::<_, ProviderRow>(
        "SELECT id, base_url, api_key FROM provider_configs WHERE is_default = 1 LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => Ok(OpenAiProvider::new(&r.base_url, &r.api_key)),
        None => Err(AppError::BadRequest(
            "未配置默认模型，请先在设置中添加。".to_string(),
        )),
    }
}

pub async fn load_default_provider(pool: &SqlitePool) -> Result<OpenAiProvider, AppError> {
    load_provider(pool).await
}

pub async fn load_provider_model(pool: &SqlitePool) -> Result<String, AppError> {
    let model: Option<String> =
        sqlx::query_scalar("SELECT model FROM provider_configs WHERE is_default = 1 LIMIT 1")
            .fetch_optional(pool)
            .await?;

    model.ok_or_else(|| AppError::BadRequest("未配置默认模型。".to_string()))
}

fn parse_provider_model_ref(value: &str) -> Option<(String, String)> {
    let rest = value.strip_prefix("provider:")?;
    let (provider_id, encoded_model) = rest.split_once(':')?;
    if provider_id.is_empty() || encoded_model.is_empty() {
        return None;
    }
    Some((provider_id.to_string(), percent_decode(encoded_model)))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                output.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        output.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| value.to_string())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub async fn resolve_model_target(
    pool: &SqlitePool,
    fallback_model: &str,
    model_ref: &str,
) -> Result<ModelTarget, AppError> {
    if let Some((provider_id, model)) = parse_provider_model_ref(model_ref) {
        let row = sqlx::query_as::<_, ProviderRow>(
            "SELECT id, base_url, api_key FROM provider_configs WHERE id = ?",
        )
        .bind(&provider_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::BadRequest("所选模型配置不存在。".to_string()))?;

        return Ok(ModelTarget {
            provider: OpenAiProvider::new(&row.base_url, &row.api_key),
            trace_model: format!("{}:{}", row.id, model),
            model,
        });
    }

    let provider = load_provider(pool).await?;
    let model = if model_ref.is_empty() {
        fallback_model.to_string()
    } else {
        model_ref.to_string()
    };
    Ok(ModelTarget {
        provider,
        trace_model: model.clone(),
        model,
    })
}

pub async fn propose_single_agent_variable_changes_for_session(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    user_input: &str,
    narrative_text: &str,
) -> Result<Option<StateChangeProposal>, AppError> {
    let fallback_model = load_provider_model(pool).await?;
    let config_json: String =
        sqlx::query_scalar("SELECT config FROM sessions WHERE id = ? AND deleted_at IS NULL")
            .bind(session_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;
    let session_config: SessionConfig = serde_json::from_str(&config_json).unwrap_or_default();
    let context_bundle = context::build_context(
        pool,
        session_id,
        turn_number,
        session_config.max_context_turns as usize,
    )
    .await?;
    let context_bundle = context_with_current_turn(
        &context_bundle,
        turn_number,
        user_input,
        Some(narrative_text),
    );

    propose_single_agent_variable_changes(
        pool,
        &fallback_model,
        &session_config,
        user_input,
        narrative_text,
        &context_bundle,
    )
    .await
}

async fn propose_single_agent_variable_changes(
    pool: &SqlitePool,
    fallback_model: &str,
    session_config: &SessionConfig,
    user_input: &str,
    narrative_text: &str,
    context_bundle: &ContextBundle,
) -> Result<Option<StateChangeProposal>, AppError> {
    if !session_config.parser_enabled {
        return Ok(None);
    }

    let model_ref = session_config.variable_tool_model.trim();
    let target = resolve_model_target(
        pool,
        fallback_model,
        if model_ref.is_empty() {
            fallback_model
        } else {
            model_ref
        },
    )
    .await?;

    variable_tool_agent::propose_variable_changes(
        &target.provider,
        &target.model,
        user_input,
        narrative_text,
        context_bundle,
    )
    .await
}

#[instrument(skip(pool, _app_config, user_input), fields(session = session_id))]
pub async fn execute_turn(
    pool: &SqlitePool,
    _app_config: &AppConfig,
    session_id: &str,
    user_input: &str,
) -> Result<TurnResult, AppError> {
    let provider = load_provider(pool).await?;

    let session = sqlx::query_as::<_, SessionRow>(
        "SELECT mode, current_turn, config, title_source FROM sessions WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    let session_config: SessionConfig = serde_json::from_str(&session.config).unwrap_or_default();
    let turn_number = session.current_turn + 1;

    // Per-session chat model: use session_config.model if set, otherwise the global
    // default provider model. (single-agent writer + multi-agent base model)
    let model = if session_config.model.trim().is_empty() {
        load_provider_model(pool).await?
    } else {
        session_config.model.clone()
    };

    tracing::info!(
        session = session_id,
        turn = turn_number,
        model = %model,
        "execute_turn: non-streaming turn start"
    );

    // Multi-agent execution: dispatch to dynamic Master Agent architecture
    if session.mode == "multi_agent" {
        tracing::info!(
            session = session_id,
            turn = turn_number,
            model = %model,
            mode = "multi_agent",
            "Multi-agent turn starting"
        );

        let ma_start = std::time::Instant::now();
        let commit = super::graph::execute_multi_agent_turn(
            pool,
            &provider,
            &model,
            session_id,
            turn_number,
            user_input,
            &session_config,
            None,
            true,
        )
        .await?;

        let ma_duration_ms = ma_start.elapsed().as_millis() as i32;
        tracing::info!(
            session = session_id,
            turn = turn_number,
            duration_ms = ma_duration_ms,
            content_len = commit.narrative.len(),
            trace_count = commit.traces.len(),
            has_compression = commit.compression.is_some(),
            "Multi-agent turn completed"
        );

        if commit.narrative.trim().is_empty() {
            return Err(AppError::Provider(
                "模型返回了空内容，请重试或检查模型配置。".to_string(),
            ));
        }

        // Single transaction: user msg + assistant msg + traces + current_turn
        tracing::info!(
            session = session_id,
            turn = turn_number,
            "Persisting multi-agent turn to database"
        );
        let mut tx = pool.begin().await?;
        turn_finalizer::finalize_turn(
            &mut tx,
            session_id,
            turn_number,
            user_input,
            &commit.narrative,
            &commit.traces,
        )
        .await?;
        tx.commit().await?;
        tracing::info!(
            session = session_id,
            turn = turn_number,
            "Multi-agent turn persisted successfully"
        );

        // Mirror session_variables (stat_data + display_data) into this turn's assistant
        // message metadata so the ST status bar can read it. `finalize_turn` writes
        // metadata='{}' for multi-agent turns; this populates the snapshot the card's MVU
        // status bar reads via `getChatMessages(id)[0].data.stat_data || .display_data`.
        if let Err(e) =
            snapshot_variables_to_message_metadata(pool, session_id, turn_number).await
        {
            tracing::warn!(
                "Failed to snapshot variables to message metadata: {}",
                e
            );
        }

        // Post-commit extras (non-fatal)
        turn_finalizer::persist_turn_extras(pool, session_id, turn_number, &commit.compression)
            .await;
        turn_finalizer::persist_turn_knowledge(
            pool,
            &provider,
            &model,
            session_id,
            turn_number,
            user_input,
            &commit.narrative,
        )
        .await;

        let display = variable_update::extract(&commit.narrative).display_text;
        let message_content = if display.is_empty() {
            commit.narrative.clone()
        } else {
            display
        };

        auto_title(
            pool,
            session_id,
            user_input,
            &message_content,
            turn_number,
            &session.title_source,
        )
        .await;

        return Ok(TurnResult {
            message_content,
            writer_draft: WriterDraft {
                narrative_text: commit.narrative,
                memory_candidates: MemoryProposal::default(),
            },
            turn_number,
        });
    }

    // Single-agent execution (existing path)
    let target = resolve_model_target(pool, &model, &model).await?;
    let context_bundle = context::build_context(
        pool,
        session_id,
        turn_number,
        session_config.max_context_turns as usize,
    )
    .await?;

    tracing::debug!(
        session = session_id,
        turn = turn_number,
        context_msgs = context_bundle.recent_context.len(),
        events = context_bundle.events.len(),
        foreshadowing = context_bundle.foreshadowing.len(),
        has_summary = context_bundle.scene_summary.is_some(),
        "Context bundle built"
    );

    // Build messages for LLM
    let system_prompt = if session_config.system_prompt.is_empty() {
        default_system_prompt()
    } else {
        session_config.system_prompt.clone()
    };

    let messages = build_single_agent_messages(system_prompt, &context_bundle, Some(user_input));

    let model_for_trace = target.trace_model.clone();

    let request = ChatRequest {
        model: target.model.clone(),
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        tools: None,
        tool_choice: None,
        stream: false,
        ..Default::default()
    };

    tracing::info!(
        session = session_id,
        turn = turn_number,
        model = %target.model,
        msg_count = request.messages.len(),
        max_tokens = request.max_tokens,
        temperature = request.temperature,
        "LLM call starting (non-streaming)"
    );

    let start = std::time::Instant::now();
    let response = target
        .provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let duration_ms = start.elapsed().as_millis() as i32;

    let content_len = response
        .choices
        .first()
        .map(|c| c.message.content.len())
        .unwrap_or(0);
    let has_reasoning = response
        .choices
        .first()
        .and_then(|c| c.message.reasoning_content.as_ref())
        .is_some();
    let prompt_tokens = response
        .usage
        .as_ref()
        .map(|u| u.prompt_tokens)
        .unwrap_or(0);
    let completion_tokens = response
        .usage
        .as_ref()
        .map(|u| u.completion_tokens)
        .unwrap_or(0);

    tracing::info!(
        session = session_id,
        turn = turn_number,
        duration_ms = duration_ms,
        content_len = content_len,
        has_reasoning_content = has_reasoning,
        prompt_tokens = prompt_tokens,
        completion_tokens = completion_tokens,
        "LLM call completed (non-streaming)"
    );

    let narrative_text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    if narrative_text.trim().is_empty() {
        return Err(AppError::Provider(
            "模型返回了空内容，请重试或检查模型配置。".to_string(),
        ));
    }

    // Build a trace for the single-agent LLM call
    let trace = super::types::AgentTrace {
        agent_id: "single_agent".to_string(),
        agent_type: "single_agent".to_string(),
        prompt_tokens: response
            .usage
            .as_ref()
            .map(|u| u.prompt_tokens)
            .unwrap_or(0),
        completion_tokens: response
            .usage
            .as_ref()
            .map(|u| u.completion_tokens)
            .unwrap_or(0),
        cached_tokens: response
            .usage
            .as_ref()
            .map(|u| u.cached_tokens())
            .unwrap_or(0),
        duration_ms,
        input_summary: format!("User: {}", truncate_str(user_input, 200)),
        output_summary: format!("Response: {}", truncate_str(&narrative_text, 200)),
        model: model_for_trace,
    };

    let context_with_turn = context_with_current_turn(
        &context_bundle,
        turn_number,
        user_input,
        Some(&narrative_text),
    );
    let variable_proposal = propose_single_agent_variable_changes(
        pool,
        &model,
        &session_config,
        user_input,
        &narrative_text,
        &context_with_turn,
    )
    .await
    .map_err(|e| {
        tracing::warn!(
            session = session_id,
            turn = turn_number,
            "Single-agent variable tool failed: {}",
            e
        );
        e
    })
    .ok()
    .flatten();

    // Single transaction: user msg + assistant msg + traces + current_turn
    tracing::info!(
        session = session_id,
        turn = turn_number,
        "Persisting turn to database"
    );
    let mut tx = pool.begin().await?;
    turn_finalizer::finalize_turn_with_options(
        &mut tx,
        session_id,
        turn_number,
        user_input,
        &narrative_text,
        &[trace],
        &[],
        // Persist inline <UpdateVariable> for MVU cards in single-agent mode (they emit
        // <UpdateVariable> rather than calling the update_variables tool). See messages.rs.
        true,
        &serde_json::json!({}),
    )
    .await?;
    tx.commit().await?;
    tracing::info!(
        session = session_id,
        turn = turn_number,
        "Turn persisted successfully"
    );

    // Auto-title
    let display = variable_update::extract(&narrative_text).display_text;
    let message_content = if display.is_empty() {
        narrative_text.clone()
    } else {
        display
    };

    auto_title(
        pool,
        session_id,
        user_input,
        &message_content,
        turn_number,
        &session.title_source,
    )
    .await;

    if let Some(proposal) = variable_proposal {
        match pool.begin().await {
            Ok(mut tx) => {
                match variable_tool_agent::persist_variable_changes(
                    &mut tx,
                    session_id,
                    &proposal.changes,
                )
                .await
                {
                    Ok(()) => {
                        if let Err(e) = tx.commit().await {
                            tracing::warn!("Failed to commit variable changes: {}", e);
                        } else {
                            // Mirror session_variables into this turn's assistant
                            // message metadata (stat_data + display_data) so the ST
                            // status bar can read it via
                            // `getChatMessages(id)[0].data.stat_data` (mapped to
                            // messages.metadata.stat_data via store.ts normalizeMessage).
                            if let Err(e) = snapshot_variables_to_message_metadata(
                                pool,
                                session_id,
                                turn_number,
                            )
                            .await
                            {
                                tracing::warn!(
                                    "Failed to snapshot variables to message metadata: {}",
                                    e
                                );
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to persist variable changes: {}", e);
                        let _ = tx.rollback().await;
                    }
                }
            }
            Err(e) => tracing::warn!("Failed to begin transaction: {}", e),
        }
    }

    info!(
        turn = turn_number,
        session = session_id,
        duration_ms,
        "Turn executed"
    );

    Ok(TurnResult {
        message_content: message_content.clone(),
        writer_draft: WriterDraft {
            narrative_text: message_content,
            memory_candidates: MemoryProposal::default(),
        },
        turn_number,
    })
}

/// Snapshot the full variable tree from `session_variables.variables` into the current
/// turn's assistant message `metadata.stat_data` (and `display_data` as fallback), so ST
/// status-bar cards can read it via `getChatMessages(id)[0].data.stat_data`
/// (`messages.metadata.stat_data` via `store.ts normalizeMessage`).
///
/// Why the whole tree: the card's MVU status bar does
///   `d = m[0].data.stat_data || m[0].data.display_data;`
/// then walks dotted paths (`SafeGetValue(d, "a.b.c")`) keyed by top-level variable names
/// like `"<user>"`, `"时幼微"`, `"世界"`. Those top-level keys are exactly what
/// `session_variables.variables` already holds (the card has no separate `stat_data`
/// subobject — variables are stored flat under character/world names). In native ST the
/// MVU extension writes this snapshot per message; Conclave has no MVU extension, so we
/// mirror it here. Both `stat_data` and `display_data` get the same value (the latter is
/// the documented fallback path).
///
/// `metadata` is merged via `json_set`, preserving other keys. Skips silently when
/// `session_variables` is empty/missing (avoids overwriting with an empty object).
pub async fn snapshot_variables_to_message_metadata(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
) -> Result<(), AppError> {
    let variables_json: Option<String> =
        sqlx::query_scalar("SELECT variables FROM session_variables WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;

    let variables = variables_json
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .filter(|v| v.as_object().map_or(false, |o| !o.is_empty()));

    let Some(variables) = variables else {
        return Ok(());
    };
    let vars_json = serde_json::to_string(&variables).unwrap_or_else(|_| "null".to_string());

    // json_set is nested: set $.display_data first, then $.stat_data on the result,
    // so both keys land on the same (merged) base object.
    sqlx::query(
        "UPDATE messages
         SET metadata = json_set(
             json_set(
                 CASE WHEN metadata IS NULL OR metadata = '' OR json_valid(metadata) = 0
                      THEN '{}' ELSE metadata END,
                 '$.display_data',
                 json(?)
             ),
             '$.stat_data',
             json(?)
         )
         WHERE session_id = ? AND turn_number = ? AND role = 'assistant'",
    )
    .bind(&vars_json)
    .bind(&vars_json)
    .bind(session_id)
    .bind(turn_number)
    .execute(pool)
    .await?;

    Ok(())
}

pub fn default_system_prompt() -> String {
    r#"You are a creative roleplay and writing assistant. You narrate immersive stories, portray characters with depth and consistency, and respond to user actions with vivid detail.

Guidelines:
- Stay in character and maintain narrative consistency
- Describe environments, emotions, and actions with sensory detail
- Advance the story naturally based on user input
- Keep track of established facts, relationships, and ongoing plot threads
- Output only narrative text — no meta-commentary or out-of-character notes
- Do not output <UpdateVariable>, <Analysis>, variable audits, state update instructions, or tool-call text"#.to_string()
}

async fn generate_title(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    assistant_reply: &str,
) -> Result<String, AppError> {
    let prompt = format!(
        "根据以下对话内容，生成一个简短的中文标题（不超过20个字）。只输出标题，不要引号或其他内容。\n\n用户：{}\n助手：{}",
        truncate_str(user_input, 200),
        truncate_str(assistant_reply, 200),
    );

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: prompt,
            reasoning_content: None,
            tool_calls: None,
        }],
        temperature: Some(0.3),
        top_p: None,
        max_tokens: Some(10000),
        frequency_penalty: None,
        presence_penalty: None,
        tools: None,
        tool_choice: None,
        stream: false,
        ..Default::default()
    };

    let response = provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let title = response
        .choices
        .first()
        .map(|c| c.message.content.trim().to_string())
        .unwrap_or_default();

    // Enforce max length
    let title = truncate_str(&title, 40).to_string();
    Ok(title)
}

/// Auto-generate and persist a session title after the first turn.
/// No-op if title_source is not 'auto' or if generation fails.
pub async fn auto_title(
    pool: &SqlitePool,
    session_id: &str,
    user_input: &str,
    assistant_reply: &str,
    turn_number: i32,
    title_source: &str,
) {
    if turn_number != 1 || title_source != "auto" {
        return;
    }
    let provider = match load_provider(pool).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                session = session_id,
                "auto_title: failed to load provider: {}",
                e
            );
            return;
        }
    };
    let model = match load_provider_model(pool).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(
                session = session_id,
                "auto_title: failed to load model: {}",
                e
            );
            return;
        }
    };
    match generate_title(&provider, &model, user_input, assistant_reply).await {
        Ok(title) => {
            if let Err(e) =
                sqlx::query("UPDATE sessions SET title = ? WHERE id = ? AND title_source = 'auto'")
                    .bind(&title)
                    .bind(session_id)
                    .execute(pool)
                    .await
            {
                tracing::warn!(
                    session = session_id,
                    "auto_title: failed to persist title: {}",
                    e
                );
            }
        }
        Err(e) => {
            tracing::warn!(session = session_id, "auto_title: generation failed: {}", e);
        }
    }
}

#[instrument(skip(pool, _app_config, user_input, active_turns, broadcast_tx), fields(session = session_id))]
pub async fn execute_turn_stream(
    pool: &SqlitePool,
    _app_config: &AppConfig,
    session_id: &str,
    user_input: &str,
    active_turns: &ActiveTurns,
    broadcast_tx: broadcast::Sender<SseEvent>,
) -> Result<StreamTurnResult, AppError> {
    let provider = load_provider(pool).await?;

    let session = sqlx::query_as::<_, SessionRow>(
        "SELECT mode, current_turn, config, title_source FROM sessions WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    let session_config: SessionConfig = serde_json::from_str(&session.config).unwrap_or_default();
    let turn_number = session.current_turn + 1;

    // Per-session chat model: prefer session_config.model, else global default.
    let model = if session_config.model.trim().is_empty() {
        load_provider_model(pool).await?
    } else {
        session_config.model.clone()
    };

    tracing::info!(
        session = session_id,
        turn = turn_number,
        model = %model,
        "execute_turn_stream: streaming turn start"
    );

    // Multi-agent streaming: run non-streaming, wrap result as single-chunk stream
    if session.mode == "multi_agent" {
        let (status_tx, mut status_rx) =
            tokio::sync::mpsc::unbounded_channel::<crate::runtime::types::AgentStatusEvent>();

        // Spawn task to run the multi-agent turn with status channel
        let turn_handle = tokio::spawn({
            let pool = pool.clone();
            let model = model.to_string();
            let session_id = session_id.to_string();
            let user_input = user_input.to_string();
            let session_config = session_config.clone();
            async move {
                let commit = super::graph::execute_multi_agent_turn(
                    &pool,
                    &provider,
                    &model,
                    &session_id,
                    turn_number,
                    &user_input,
                    &session_config,
                    Some(status_tx),
                    false,
                )
                .await?;

                // Return full commit — route layer handles persistence via turn_finalizer
                Ok::<_, crate::error::AppError>(commit)
            }
        });

        // Shared state for commit data extraction after stream completes
        let commit_data: StreamCommitData = std::sync::Arc::new(std::sync::Mutex::new(None));
        let commit_data_clone = commit_data.clone();
        let session_id_for_cleanup = session_id.to_string();
        let active_turns_cleanup = active_turns.clone();
        let broadcast_tx_clone = broadcast_tx.clone();

        // Stream that yields status events first, then the final narrative
        let stream = async_stream::stream! {
            // Yield status events as they arrive
            while let Some(status) = status_rx.recv().await {
                let _ = broadcast_tx_clone.send(SseEvent::AgentStatus {
                    agent_type: status.agent_type.clone(),
                    label: status.label.clone(),
                    status: status.status.clone(),
                });
                let chunk = StreamChunk {
                    choices: vec![crate::provider::types::StreamChoice {
                        delta: crate::provider::types::StreamDelta {
                            role: None,
                            content: None,
                            agent_status: Some(status),
                        },
                        finish_reason: None,
                    }],
                };
                yield Ok::<_, crate::error::AppError>(chunk);
            }

            // Status channel closed — turn is complete, get the result
            match turn_handle.await {
                Ok(Ok(commit)) => {
                    // Store commit data for route layer to persist
                    *commit_data_clone.lock().unwrap() =
                        Some((commit.traces, commit.debug_snapshots, commit.compression, commit.compression_job));
                    let _ = broadcast_tx_clone.send(SseEvent::MessageDelta {
                        content: commit.narrative.clone(),
                    });
                    let chunk = StreamChunk {
                        choices: vec![crate::provider::types::StreamChoice {
                            delta: crate::provider::types::StreamDelta {
                                role: Some("assistant".to_string()),
                                content: Some(commit.narrative),
                                agent_status: None,
                            },
                            finish_reason: Some("stop".to_string()),
                        }],
                    };
                    yield Ok(chunk);
                }
                Ok(Err(e)) => {
                    let _ = broadcast_tx_clone.send(SseEvent::StreamError {
                        error: e.to_string(),
                    });
                    yield Err(e);
                }
                Err(e) => {
                    let msg = format!("Turn task panicked: {}", e);
                    let _ = broadcast_tx_clone.send(SseEvent::StreamError {
                        error: msg.clone(),
                    });
                    yield Err(crate::error::AppError::Internal(msg));
                }
            }

            // Clean up: remove from active turns map
            active_turns_cleanup.lock().await.remove(&session_id_for_cleanup);
        };

        let pinned = Box::pin(stream);
        return Ok(StreamTurnResult {
            stream: pinned,
            turn_number,
            session_id: session_id.to_string(),
            title_source: session.title_source.clone(),
            commit_data: Some(commit_data),
        });
    }

    // Single-agent streaming path (existing)
    let target = resolve_model_target(pool, &model, &model).await?;
    // Build context
    let context_bundle = context::build_context(
        pool,
        session_id,
        turn_number,
        session_config.max_context_turns as usize,
    )
    .await?;

    tracing::debug!(
        session = session_id,
        turn = turn_number,
        context_msgs = context_bundle.recent_context.len(),
        events = context_bundle.events.len(),
        foreshadowing = context_bundle.foreshadowing.len(),
        has_summary = context_bundle.scene_summary.is_some(),
        "Context bundle built"
    );

    let system_prompt = if session_config.system_prompt.is_empty() {
        default_system_prompt()
    } else {
        session_config.system_prompt.clone()
    };

    let messages = build_single_agent_messages(system_prompt, &context_bundle, Some(user_input));

    let request = ChatRequest {
        model: target.model.clone(),
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        tools: None,
        tool_choice: None,
        stream: true,
        ..Default::default()
    };

    tracing::info!(
        session = session_id,
        turn = turn_number,
        model = %target.model,
        msg_count = request.messages.len(),
        max_tokens = request.max_tokens,
        temperature = request.temperature,
        stream = true,
        "LLM call starting (streaming)"
    );

    // Retry the SSE *connection* phase on transient network errors (connect/
    // timeout/5xx/429) before any tokens are on the wire. Mid-stream failures are
    // not retried here — they surface as stream_error and the frontend re-runs the turn.
    let provider_stream = target
        .provider
        .chat_completion_stream_with_connect_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    tracing::debug!(
        session = session_id,
        turn = turn_number,
        "LLM stream connected, forwarding chunks"
    );

    let mapped_stream = async_stream::stream! {
        use futures::StreamExt;
        let mut pinned = std::pin::pin!(provider_stream);
        while let Some(chunk) = pinned.next().await {
            yield chunk.map_err(|e| AppError::Provider(e.to_string()));
        }
    };

    // current_turn is advanced by the route layer (messages.rs) via turn_finalizer
    // after the stream completes and the assistant message is persisted.

    Ok(StreamTurnResult {
        stream: Box::pin(mapped_stream),
        turn_number,
        session_id: session_id.to_string(),
        title_source: session.title_source,
        commit_data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::types::AgentType;

    fn empty_context(recent_context: Vec<ContextMessage>) -> ContextBundle {
        ContextBundle {
            task: "Continue the roleplay narrative".to_string(),
            recent_context,
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

    #[test]
    fn single_agent_messages_append_current_user_input() {
        let context = empty_context(vec![
            ContextMessage {
                role: "assistant".to_string(),
                content: "旧回复".to_string(),
                turn_number: 1,
            },
            ContextMessage {
                role: "user".to_string(),
                content: "旧输入".to_string(),
                turn_number: 2,
            },
        ]);

        let messages =
            build_single_agent_messages("system prompt".to_string(), &context, Some("本轮输入"));

        assert_eq!(messages.last().unwrap().role, "user");
        assert_eq!(messages.last().unwrap().content, "本轮输入");
    }

    #[test]
    fn single_agent_messages_can_use_persisted_current_turn_without_duplicate() {
        let context = empty_context(vec![ContextMessage {
            role: "user".to_string(),
            content: "已落库输入".to_string(),
            turn_number: 3,
        }]);

        let messages = build_single_agent_messages("system prompt".to_string(), &context, None);
        let user_messages: Vec<_> = messages
            .iter()
            .filter(|message| message.role == "user")
            .collect();

        assert_eq!(user_messages.len(), 1);
        assert_eq!(user_messages[0].content, "已落库输入");
    }

    // --- parse_provider_model_ref tests ---

    #[test]
    fn parse_provider_model_ref_valid() {
        let result = parse_provider_model_ref("provider:abc123:gpt-4o");
        assert_eq!(result, Some(("abc123".to_string(), "gpt-4o".to_string())));
    }

    #[test]
    fn parse_provider_model_ref_with_encoded_model() {
        let result = parse_provider_model_ref("provider:def:deepseek%2Fv3");
        assert_eq!(result, Some(("def".to_string(), "deepseek/v3".to_string())));
    }

    #[test]
    fn parse_provider_model_ref_no_prefix() {
        assert_eq!(parse_provider_model_ref("gpt-4o"), None);
    }

    #[test]
    fn parse_provider_model_ref_empty_provider() {
        assert_eq!(parse_provider_model_ref("provider::model"), None);
    }

    #[test]
    fn parse_provider_model_ref_empty_model() {
        assert_eq!(parse_provider_model_ref("provider:abc:"), None);
    }

    // --- percent_decode tests ---

    #[test]
    fn percent_decode_no_encoding() {
        assert_eq!(percent_decode("hello"), "hello");
    }

    #[test]
    fn percent_decode_slash() {
        assert_eq!(percent_decode("deepseek%2Fv3"), "deepseek/v3");
    }

    #[test]
    fn percent_decode_space() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
    }

    #[test]
    fn percent_decode_multiple() {
        assert_eq!(percent_decode("a%2Fb%2Fc"), "a/b/c");
    }

    #[test]
    fn percent_decode_invalid_percent() {
        // %ZZ is not valid hex, should keep the % as-is
        assert_eq!(percent_decode("test%ZZ"), "test%ZZ");
    }

    // --- hex_value tests ---

    #[test]
    fn hex_value_digits() {
        assert_eq!(hex_value(b'0'), Some(0));
        assert_eq!(hex_value(b'9'), Some(9));
    }

    #[test]
    fn hex_value_lowercase() {
        assert_eq!(hex_value(b'a'), Some(10));
        assert_eq!(hex_value(b'f'), Some(15));
    }

    #[test]
    fn hex_value_uppercase() {
        assert_eq!(hex_value(b'A'), Some(10));
        assert_eq!(hex_value(b'F'), Some(15));
    }

    #[test]
    fn hex_value_invalid() {
        assert_eq!(hex_value(b'g'), None);
        assert_eq!(hex_value(b'z'), None);
        assert_eq!(hex_value(b'!'), None);
    }

    // --- is_variable_rule_entry tests ---

    #[test]
    fn is_variable_rule_entry_state_agent_category() {
        let entry = WorldBookContextEntry {
            content: "some content".to_string(),
            keys: vec!["key1".to_string()],
            constant: false,
            priority: 0,
            visibility: "public".to_string(),
            category: "state_agent".to_string(),
            ..Default::default()
        };
        assert!(is_variable_rule_entry(&entry));
    }

    #[test]
    fn is_variable_rule_entry_updatevariable_in_content() {
        let entry = WorldBookContextEntry {
            content: "Use UpdateVariable to change values".to_string(),
            keys: vec!["key1".to_string()],
            constant: false,
            priority: 0,
            visibility: "public".to_string(),
            category: "global".to_string(),
            ..Default::default()
        };
        assert!(is_variable_rule_entry(&entry));
    }

    #[test]
    fn is_variable_rule_entry_normal_entry() {
        let entry = WorldBookContextEntry {
            content: "The tavern is located in the market district".to_string(),
            keys: vec!["tavern".to_string()],
            constant: false,
            priority: 0,
            visibility: "public".to_string(),
            category: "global".to_string(),
            ..Default::default()
        };
        assert!(!is_variable_rule_entry(&entry));
    }

    #[test]
    fn is_variable_rule_entry_stat_data_with_keyword() {
        let entry = WorldBookContextEntry {
            content: "stat_data 变量更新规则".to_string(),
            keys: vec!["key".to_string()],
            constant: false,
            priority: 0,
            visibility: "public".to_string(),
            category: "global".to_string(),
            ..Default::default()
        };
        assert!(is_variable_rule_entry(&entry));
    }

    // --- format_world_book_reference tests ---

    #[test]
    fn format_world_book_reference_empty() {
        assert!(format_world_book_reference(&[]).is_none());
    }

    #[test]
    fn format_world_book_reference_filters_user_category() {
        let entries = vec![WorldBookContextEntry {
            content: "user stuff".to_string(),
            keys: vec![],
            constant: false,
            priority: 0,
            visibility: "public".to_string(),
            category: "user".to_string(),
            ..Default::default()
        }];
        assert!(format_world_book_reference(&entries).is_none());
    }

    #[test]
    fn format_world_book_reference_filters_variable_rules() {
        let entries = vec![WorldBookContextEntry {
            content: "UpdateVariable rules".to_string(),
            keys: vec![],
            constant: false,
            priority: 0,
            visibility: "public".to_string(),
            category: "global".to_string(),
            ..Default::default()
        }];
        assert!(format_world_book_reference(&entries).is_none());
    }

    #[test]
    fn format_world_book_reference_normal_entries() {
        let entries = vec![
            WorldBookContextEntry {
                content: "The kingdom is at war".to_string(),
                keys: vec!["kingdom".to_string()],
                constant: true,
                priority: 10,
                visibility: "public".to_string(),
                category: "global".to_string(),
                ..Default::default()
            },
            WorldBookContextEntry {
                content: "The tavern serves ale".to_string(),
                keys: vec!["tavern".to_string()],
                constant: false,
                priority: 5,
                visibility: "public".to_string(),
                category: "global".to_string(),
                ..Default::default()
            },
        ];
        let result = format_world_book_reference(&entries);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("[World Book Reference]"));
        assert!(text.contains("[Always Active] The kingdom is at war"));
        assert!(text.contains("The tavern serves ale"));
    }

    // --- format_role_reference tests ---

    #[test]
    fn format_role_reference_empty() {
        assert!(format_role_reference(&[]).is_none());
    }

    #[test]
    fn format_role_reference_filters_empty_roles() {
        let roles = vec![RoleContext {
            agent_type: AgentType::Npc,
            label: "".to_string(),
            character_id: None,
            context: String::new(),
        }];
        assert!(format_role_reference(&roles).is_none());
    }

    #[test]
    fn format_role_reference_with_entries() {
        let roles = vec![
            RoleContext {
                agent_type: AgentType::Npc,
                label: "Alice".to_string(),
                character_id: Some("alice".to_string()),
                context: "A brave warrior".to_string(),
            },
            RoleContext {
                agent_type: AgentType::Writer,
                label: "Narrator".to_string(),
                character_id: None,
                context: String::new(),
            },
        ];
        let result = format_role_reference(&roles);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("[Role Reference]"));
        assert!(text.contains("Alice (npc): A brave warrior"));
        assert!(text.contains("Narrator (writer)"));
    }

    // --- context_with_current_turn tests ---

    #[test]
    fn context_with_current_turn_appends_user_message() {
        let ctx = empty_context(vec![]);
        let updated = context_with_current_turn(&ctx, 5, "hello", None);

        assert_eq!(updated.recent_context.len(), 1);
        assert_eq!(updated.recent_context[0].role, "user");
        assert_eq!(updated.recent_context[0].content, "hello");
        assert_eq!(updated.recent_context[0].turn_number, 5);
    }

    #[test]
    fn context_with_current_turn_appends_both_messages() {
        let ctx = empty_context(vec![]);
        let updated = context_with_current_turn(&ctx, 5, "hello", Some("world"));

        assert_eq!(updated.recent_context.len(), 2);
        assert_eq!(updated.recent_context[0].role, "user");
        assert_eq!(updated.recent_context[1].role, "assistant");
        assert_eq!(updated.recent_context[1].content, "world");
    }

    #[test]
    fn context_with_current_turn_preserves_existing_context() {
        let ctx = empty_context(vec![ContextMessage {
            role: "user".to_string(),
            content: "old".to_string(),
            turn_number: 1,
        }]);
        let updated = context_with_current_turn(&ctx, 2, "new", Some("reply"));

        assert_eq!(updated.recent_context.len(), 3);
        assert_eq!(updated.recent_context[0].content, "old");
        assert_eq!(updated.recent_context[1].content, "new");
        assert_eq!(updated.recent_context[2].content, "reply");
    }

    // --- build_single_agent_messages additional tests ---

    #[test]
    fn single_agent_messages_start_with_system_prompt() {
        let context = empty_context(vec![]);
        let messages = build_single_agent_messages("my prompt".to_string(), &context, Some("hi"));

        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[0].content, "my prompt");
    }

    #[test]
    fn single_agent_messages_include_runtime_constraint() {
        let context = empty_context(vec![]);
        let messages = build_single_agent_messages("prompt".to_string(), &context, Some("hi"));

        let constraint_msg = messages
            .iter()
            .find(|m| m.content.contains("Runtime constraint"));
        assert!(constraint_msg.is_some());
    }

    #[test]
    fn single_agent_messages_include_scene_summary() {
        let ctx = ContextBundle {
            scene_summary: Some("A dark forest at midnight".to_string()),
            ..empty_context(vec![])
        };
        let messages = build_single_agent_messages("prompt".to_string(), &ctx, Some("hi"));

        let summary_msg = messages
            .iter()
            .find(|m| m.content.contains("A dark forest at midnight"));
        assert!(summary_msg.is_some());
    }

    #[test]
    fn single_agent_messages_include_events() {
        let ctx = ContextBundle {
            events: vec!["The dragon attacked".to_string()],
            ..empty_context(vec![])
        };
        let messages = build_single_agent_messages("prompt".to_string(), &ctx, Some("hi"));

        let events_msg = messages
            .iter()
            .find(|m| m.content.contains("The dragon attacked"));
        assert!(events_msg.is_some());
    }

    #[test]
    fn single_agent_messages_include_foreshadowing() {
        let ctx = ContextBundle {
            foreshadowing: vec!["A storm is coming".to_string()],
            ..empty_context(vec![])
        };
        let messages = build_single_agent_messages("prompt".to_string(), &ctx, Some("hi"));

        let fs_msg = messages
            .iter()
            .find(|m| m.content.contains("A storm is coming"));
        assert!(fs_msg.is_some());
    }

    #[test]
    fn single_agent_messages_include_structured_state() {
        let ctx = ContextBundle {
            structured_state: serde_json::json!({"hp": 100}),
            ..empty_context(vec![])
        };
        let messages = build_single_agent_messages("prompt".to_string(), &ctx, Some("hi"));

        let state_msg = messages.iter().find(|m| m.content.contains("hp"));
        assert!(state_msg.is_some());
    }

    #[test]
    fn single_agent_messages_no_user_input_when_none() {
        let context = empty_context(vec![]);
        let messages = build_single_agent_messages("prompt".to_string(), &context, None);

        // Last message should NOT be a user message (no input provided)
        let last = messages.last().unwrap();
        assert_ne!(last.role, "user");
    }
}

/// Regenerate an assistant message: push current content to variants, call LLM, update content.
/// Returns (new_content, variants_json).
#[instrument(skip(pool))]
pub async fn regenerate_turn(
    pool: &SqlitePool,
    session_id: &str,
    message_id: &str,
) -> Result<(String, String, i32), AppError> {
    // Load the assistant message
    let msg = sqlx::query_as::<_, (String, i32, String, String)>(
        "SELECT id, turn_number, content, variants FROM messages WHERE id = ? AND session_id = ? AND role = 'assistant'"
    )
    .bind(message_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Message not found".to_string()))?;

    let (msg_id, turn_number, current_content, variants_str) = msg;

    // Find the user input for this turn
    let user_input: Option<String> = sqlx::query_scalar(
        "SELECT content FROM messages WHERE session_id = ? AND turn_number = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1"
    )
    .bind(session_id)
    .bind(turn_number)
    .fetch_optional(pool)
    .await?;

    let user_input = user_input
        .ok_or_else(|| AppError::NotFound("No user message found for this turn".to_string()))?;

    // Load session config
    let session_config: SessionConfig = sqlx::query_scalar::<_, String>(
        "SELECT config FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))
    .map(|c| serde_json::from_str(&c).unwrap_or_default())?;

    // Per-session chat model: prefer session_config.model, else global default.
    let model = if session_config.model.trim().is_empty() {
        load_provider_model(pool).await?
    } else {
        session_config.model.clone()
    };

    // Build context (exclude the current assistant message to avoid contamination)
    let context_bundle = context::build_context_for_regenerate(
        pool,
        session_id,
        turn_number,
        session_config.max_context_turns as usize,
        &msg_id,
    )
    .await?;

    let system_prompt = if session_config.system_prompt.is_empty() {
        default_system_prompt()
    } else {
        session_config.system_prompt.clone()
    };

    let messages = build_single_agent_messages(system_prompt, &context_bundle, None);

    let target = resolve_model_target(pool, &model, &model).await?;
    let model_for_trace = target.trace_model.clone();

    let request = ChatRequest {
        model: target.model.clone(),
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        tools: None,
        tool_choice: None,
        stream: false,
        ..Default::default()
    };

    tracing::info!(
        session = session_id,
        turn = turn_number,
        message_id = message_id,
        model = %target.model,
        msg_count = request.messages.len(),
        max_tokens = request.max_tokens,
        temperature = request.temperature,
        "LLM call starting for regenerate"
    );

    let start = std::time::Instant::now();
    let response = target
        .provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let duration_ms = start.elapsed().as_millis() as i32;

    let content_len = response
        .choices
        .first()
        .map(|c| c.message.content.len())
        .unwrap_or(0);
    let has_reasoning = response
        .choices
        .first()
        .and_then(|c| c.message.reasoning_content.as_ref())
        .is_some();
    let prompt_tokens = response
        .usage
        .as_ref()
        .map(|u| u.prompt_tokens)
        .unwrap_or(0);
    let completion_tokens = response
        .usage
        .as_ref()
        .map(|u| u.completion_tokens)
        .unwrap_or(0);

    tracing::info!(
        session = session_id,
        turn = turn_number,
        message_id = message_id,
        duration_ms = duration_ms,
        content_len = content_len,
        has_reasoning_content = has_reasoning,
        prompt_tokens = prompt_tokens,
        completion_tokens = completion_tokens,
        "LLM regenerate call completed"
    );

    let new_content = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    if new_content.trim().is_empty() {
        return Err(AppError::Provider(
            "模型返回了空内容，请重试或检查模型配置。".to_string(),
        ));
    }

    // Push current content to variants
    let mut variants: Vec<String> = serde_json::from_str(&variants_str).unwrap_or_default();
    variants.push(current_content);
    let variants_json = serde_json::to_string(&variants).unwrap_or_else(|_| "[]".to_string());

    // Build trace
    let trace = super::types::AgentTrace {
        agent_id: "single_agent".to_string(),
        agent_type: "single_agent".to_string(),
        prompt_tokens: response
            .usage
            .as_ref()
            .map(|u| u.prompt_tokens)
            .unwrap_or(0),
        completion_tokens: response
            .usage
            .as_ref()
            .map(|u| u.completion_tokens)
            .unwrap_or(0),
        cached_tokens: response
            .usage
            .as_ref()
            .map(|u| u.cached_tokens())
            .unwrap_or(0),
        duration_ms,
        input_summary: format!("Regenerate: {}", truncate_str(&user_input, 200)),
        output_summary: format!("Response: {}", truncate_str(&new_content, 200)),
        model: model_for_trace,
    };

    // Single transaction: update message + insert trace
    tracing::info!(
        session = session_id,
        turn = turn_number,
        message_id = message_id,
        "Persisting regeneration to database"
    );
    let mut tx = pool.begin().await?;
    turn_finalizer::finalize_regenerate(
        &mut tx,
        session_id,
        turn_number,
        &msg_id,
        &new_content,
        &variants_json,
        &trace,
    )
    .await?;
    tx.commit().await?;
    tracing::info!(
        session = session_id,
        turn = turn_number,
        message_id = message_id,
        "Regeneration persisted successfully"
    );

    info!(
        turn = turn_number,
        session = session_id,
        "Message regenerated"
    );

    Ok((new_content, variants_json, turn_number))
}
