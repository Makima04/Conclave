use super::context;
use super::types::{
    ContextBundle, MemoryProposal, RoleContext, StateChangeProposal, TurnResult,
    WorldBookContextEntry, WriterDraft,
};
use crate::config::AppConfig;
use crate::error::AppError;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest, StreamChunk};
use crate::routes::sessions::SessionConfig;
use crate::runtime::turn_finalizer;
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
            Option<crate::runtime::types::CompressionResult>,
            Option<turn_finalizer::CompressionJob>,
            Vec<StateChangeProposal>,
        )>,
    >,
>;

pub struct StreamTurnResult {
    pub stream: Pin<Box<dyn Stream<Item = Result<StreamChunk, AppError>> + Send>>,
    pub turn_number: i32,
    pub session_id: String,
    pub model_config_json: String,
    pub title_source: String,
    /// Data from multi-agent turn for the route layer to persist after the stream completes.
    /// None for single-agent streaming.
    pub commit_data: Option<StreamCommitData>,
    /// Broadcast sender for SSE reconnect. Created and registered by the caller.
    pub broadcast_tx: Option<broadcast::Sender<SseEvent>>,
}

fn format_world_book_reference(entries: &[WorldBookContextEntry]) -> Option<String> {
    let mut visible_entries: Vec<_> = entries
        .iter()
        .filter(|entry| entry.category != "user")
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
) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_prompt,
        reasoning_content: None,
    }];

    if let Some(role_content) = format_role_reference(&context_bundle.role_contexts) {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: role_content,
            reasoning_content: None,
        });
    }

    for msg in &context_bundle.recent_context {
        messages.push(ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
            reasoning_content: None,
        });
    }

    if !context_bundle.events.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Known events:\n{}", context_bundle.events.join("\n")),
            reasoning_content: None,
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
        });
    }

    if let Some(ref summary) = context_bundle.scene_summary {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Scene summary:\n{}", summary),
            reasoning_content: None,
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
        });
    }

    // User-character world-book entries are merged into Role Reference above.
    if let Some(wb_content) = format_world_book_reference(&context_bundle.world_book_entries) {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: wb_content,
            reasoning_content: None,
        });
    }

    messages
}

#[derive(Debug, sqlx::FromRow)]
struct SessionRow {
    id: String,
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
    model: String,
}

#[derive(Clone)]
pub struct ModelTarget {
    pub provider: OpenAiProvider,
    pub model: String,
    pub trace_model: String,
}

async fn load_provider(pool: &SqlitePool) -> Result<OpenAiProvider, AppError> {
    let row = sqlx::query_as::<_, ProviderRow>(
        "SELECT id, base_url, api_key, model FROM provider_configs WHERE is_default = 1 LIMIT 1",
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
            "SELECT id, base_url, api_key, model FROM provider_configs WHERE id = ?",
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

#[instrument(skip(pool, _app_config, user_input), fields(session = session_id))]
pub async fn execute_turn(
    pool: &SqlitePool,
    _app_config: &AppConfig,
    session_id: &str,
    user_input: &str,
) -> Result<TurnResult, AppError> {
    let provider = load_provider(pool).await?;
    let model = load_provider_model(pool).await?;

    let session = sqlx::query_as::<_, SessionRow>(
        "SELECT id, mode, current_turn, config, title_source FROM sessions WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    let session_config: SessionConfig = serde_json::from_str(&session.config).unwrap_or_default();
    let turn_number = session.current_turn + 1;

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

        // Post-commit extras (non-fatal)
        turn_finalizer::persist_turn_extras(
            pool,
            session_id,
            turn_number,
            &commit.compression,
            &commit.state_proposals,
        )
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

    let messages = build_single_agent_messages(system_prompt, &context_bundle);

    let model_for_trace = target.trace_model.clone();

    let request = ChatRequest {
        model: target.model.clone(),
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        stream: false,
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
        duration_ms,
        input_summary: format!("User: {}", truncate_str(user_input, 200)),
        output_summary: format!("Response: {}", truncate_str(&narrative_text, 200)),
        model: model_for_trace,
    };

    // Single transaction: user msg + assistant msg + traces + current_turn
    tracing::info!(
        session = session_id,
        turn = turn_number,
        "Persisting turn to database"
    );
    let mut tx = pool.begin().await?;
    turn_finalizer::finalize_turn(
        &mut tx,
        session_id,
        turn_number,
        user_input,
        &narrative_text,
        &[trace],
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

    // State proposals (currently always empty — placeholder for future LLM structured output)
    let writer_draft = WriterDraft {
        narrative_text: narrative_text.clone(),
        memory_candidates: MemoryProposal::default(),
    };
    if !writer_draft.memory_candidates.state_changes.is_empty() {
        let proposal = StateChangeProposal {
            proposed_by: "single_agent".to_string(),
            risk: "low".to_string(),
            changes: writer_draft.memory_candidates.state_changes.clone(),
        };
        turn_finalizer::persist_turn_extras(pool, session_id, turn_number, &None, &[proposal])
            .await;
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

pub fn default_system_prompt() -> String {
    r#"You are a creative roleplay and writing assistant. You narrate immersive stories, portray characters with depth and consistency, and respond to user actions with vivid detail.

Guidelines:
- Stay in character and maintain narrative consistency
- Describe environments, emotions, and actions with sensory detail
- Advance the story naturally based on user input
- Keep track of established facts, relationships, and ongoing plot threads
- Output only narrative text — no meta-commentary or out-of-character notes"#.to_string()
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
        }],
        temperature: Some(0.3),
        top_p: None,
        max_tokens: Some(10000),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
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
    let model = load_provider_model(pool).await?;

    let session = sqlx::query_as::<_, SessionRow>(
        "SELECT id, mode, current_turn, config, title_source FROM sessions WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    let session_config: SessionConfig = serde_json::from_str(&session.config).unwrap_or_default();
    let turn_number = session.current_turn + 1;

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

        let model_config_json =
            serde_json::json!({"model": model, "mode": "multi_agent"}).to_string();

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
                        Some((commit.traces, commit.compression, commit.compression_job, commit.state_proposals));
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
            model_config_json,
            title_source: session.title_source.clone(),
            commit_data: Some(commit_data),
            broadcast_tx: Some(broadcast_tx),
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

    let messages = build_single_agent_messages(system_prompt, &context_bundle);

    let request = ChatRequest {
        model: target.model.clone(),
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        stream: true,
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

    let model_config_json = serde_json::json!({
        "model": target.trace_model,
        "temperature": session_config.temperature,
        "top_p": session_config.top_p,
        "max_tokens": session_config.max_tokens,
        "max_context_turns": session_config.max_context_turns,
    })
    .to_string();

    let provider_stream = target
        .provider
        .chat_completion_stream(request)
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
        model_config_json,
        title_source: session.title_source,
        commit_data: None,
        broadcast_tx: Some(broadcast_tx),
    })
}

fn truncate_str(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
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
    let model = load_provider_model(pool).await?;

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

    let messages = build_single_agent_messages(system_prompt, &context_bundle);

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
        stream: false,
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
