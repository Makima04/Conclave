use super::context;
use super::types::{MemoryProposal, StateChangeProposal, TurnResult, WriterDraft};
use crate::config::AppConfig;
use crate::error::AppError;
use crate::memory::state;
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest, StreamChunk};
use crate::routes::sessions::SessionConfig;
use futures::Stream;
use sqlx::SqlitePool;
use std::pin::Pin;
use tracing::{info, instrument};

pub struct StreamTurnResult {
    pub stream: Pin<Box<dyn Stream<Item = Result<StreamChunk, AppError>> + Send>>,
    pub turn_number: i32,
    pub session_id: String,
    pub model_config_json: String,
    pub title_source: String,
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

async fn load_provider(pool: &SqlitePool) -> Result<OpenAiProvider, AppError> {
    let row = sqlx::query_as::<_, ProviderRow>(
        "SELECT id, base_url, api_key, model FROM provider_configs WHERE is_default = 1 LIMIT 1"
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

async fn load_provider_model(pool: &SqlitePool) -> Result<String, AppError> {
    let model: Option<String> = sqlx::query_scalar(
        "SELECT model FROM provider_configs WHERE is_default = 1 LIMIT 1"
    )
    .fetch_optional(pool)
    .await?;

    model.ok_or_else(|| AppError::BadRequest("未配置默认模型。".to_string()))
}

#[instrument(skip(pool, _app_config))]
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
    let now = chrono::Utc::now().to_rfc3339();
    let user_msg_id = uuid::Uuid::new_v4().to_string();

    tracing::info!(
        session = session_id,
        turn = turn_number,
        model = %model,
        "execute_turn: non-streaming turn start"
    );

    // Save user message
    sqlx::query(
        "INSERT INTO messages (id, session_id, turn_number, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)"
    )
    .bind(&user_msg_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(user_input)
    .bind(&now)
    .execute(pool)
    .await?;

    tracing::debug!(session = session_id, turn = turn_number, msg_id = %user_msg_id, "User message saved");

    // Multi-agent graph execution: dispatch based on session mode
    if session.mode != "single_agent" {
        let graph = super::templates::get_template(&session.mode);
        let narrative_text = super::graph::execute_graph(
            pool, &provider, &model, session_id, turn_number, &graph, user_input, &session_config,
        ).await?;

        let now = chrono::Utc::now().to_rfc3339();

        // Save assistant message
        let assistant_msg_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, session_id, turn_number, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
        )
        .bind(&assistant_msg_id)
        .bind(session_id)
        .bind(turn_number)
        .bind(&narrative_text)
        .bind(&now)
        .execute(pool)
        .await?;

        // Update session turn counter
        sqlx::query("UPDATE sessions SET current_turn = ?, updated_at = ? WHERE id = ?")
            .bind(turn_number)
            .bind(&now)
            .bind(session_id)
            .execute(pool)
            .await?;

        auto_title(pool, session_id, user_input, &narrative_text, turn_number, &session.title_source).await;

        return Ok(TurnResult {
            message_content: narrative_text.clone(),
            writer_draft: WriterDraft {
                narrative_text,
                memory_candidates: MemoryProposal::default(),
            },
            turn_number,
        });
    }

    // Single-agent execution (existing path)
    let context_bundle = context::build_context(
        pool, session_id, turn_number, session_config.max_context_turns as usize
    ).await?;

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

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_prompt,
    }];

    for msg in &context_bundle.recent_context {
        messages.push(ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
    }

    if !context_bundle.events.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Known events:\n{}", context_bundle.events.join("\n")),
        });
    }

    if !context_bundle.foreshadowing.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Open foreshadowing items:\n{}", context_bundle.foreshadowing.join("\n")),
        });
    }

    if let Some(ref summary) = context_bundle.scene_summary {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Scene summary:\n{}", summary),
        });
    }

    let model_for_trace = model.clone();

    let request = ChatRequest {
        model,
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        stream: false,
    };

    let start = std::time::Instant::now();
    let response = provider
        .chat_completion(request)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let duration_ms = start.elapsed().as_millis() as i32;

    tracing::info!(
        session = session_id,
        turn = turn_number,
        duration_ms = duration_ms,
        "LLM non-streaming call completed"
    );

    let narrative_text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    let token_usage = response.usage.as_ref().map(|u| {
        serde_json::json!({
            "prompt_tokens": u.prompt_tokens,
            "completion_tokens": u.completion_tokens,
            "total_tokens": u.total_tokens
        })
    }).unwrap_or_else(|| serde_json::json!({}));

    // Save assistant message
    let assistant_msg_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO messages (id, session_id, turn_number, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
    )
    .bind(&assistant_msg_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(&narrative_text)
    .bind(&now)
    .execute(pool)
    .await?;

    // Update session turn counter
    sqlx::query("UPDATE sessions SET current_turn = ?, updated_at = ? WHERE id = ?")
        .bind(turn_number)
        .bind(&now)
        .bind(session_id)
        .execute(pool)
        .await?;

    // Auto-generate title after first turn if not manually set
    auto_title(pool, session_id, user_input, &narrative_text, turn_number, &session.title_source).await;

    // Proposal pipeline: apply state changes from MemoryProposal
    // Currently memory_candidates is always default() (empty); when LLM structured
    // output extraction is added, state_changes will flow through here automatically.
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
        match state::apply_proposal(pool, session_id, &proposal, turn_number).await {
            Ok(result) => {
                info!(
                    turn = turn_number,
                    session = session_id,
                    status = %result.status,
                    version = result.version,
                    "State proposal applied"
                );
            }
            Err(e) => {
                tracing::warn!(
                    turn = turn_number,
                    session = session_id,
                    "State proposal failed: {}", e
                );
            }
        }
    }

    // Record trace
    let trace_id = uuid::Uuid::new_v4().to_string();
    let input_summary = format!("User: {}", truncate_str(user_input, 200));
    let output_summary = format!("Response: {}", truncate_str(&narrative_text, 200));
    let model_config = serde_json::json!({
        "model": model_for_trace,
        "temperature": session_config.temperature,
        "top_p": session_config.top_p,
        "max_tokens": session_config.max_tokens,
        "max_context_turns": session_config.max_context_turns,
    }).to_string();

    sqlx::query(
        r#"INSERT INTO traces (id, session_id, turn_number, node_id, node_type, agent_id,
           input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at)
           VALUES (?, ?, ?, 'npc_writer_1', 'npc', 'single_agent', ?, ?, 'writer_draft', ?, ?, ?, ?)"#
    )
    .bind(&trace_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(&input_summary)
    .bind(&output_summary)
    .bind(&model_config)
    .bind(token_usage.to_string())
    .bind(duration_ms)
    .bind(&now)
    .execute(pool)
    .await?;

    info!(turn = turn_number, session = session_id, duration_ms, "Turn executed");

    Ok(TurnResult {
        message_content: narrative_text.clone(),
        writer_draft: WriterDraft {
            narrative_text,
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
        }],
        temperature: Some(0.3),
        top_p: None,
        max_tokens: Some(50),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
    };

    let response = provider
        .chat_completion(request)
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
pub async fn auto_title(pool: &SqlitePool, session_id: &str, user_input: &str, assistant_reply: &str, turn_number: i32, title_source: &str) {
    if turn_number != 1 || title_source != "auto" {
        return;
    }
    let provider = match load_provider(pool).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(session = session_id, "auto_title: failed to load provider: {}", e);
            return;
        }
    };
    let model = match load_provider_model(pool).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(session = session_id, "auto_title: failed to load model: {}", e);
            return;
        }
    };
    match generate_title(&provider, &model, user_input, assistant_reply).await {
        Ok(title) => {
            if let Err(e) = sqlx::query("UPDATE sessions SET title = ? WHERE id = ? AND title_source = 'auto'")
                .bind(&title)
                .bind(session_id)
                .execute(pool)
                .await {
                tracing::warn!(session = session_id, "auto_title: failed to persist title: {}", e);
            }
        }
        Err(e) => {
            tracing::warn!(session = session_id, "auto_title: generation failed: {}", e);
        }
    }
}

#[instrument(skip(pool, _app_config))]
pub async fn execute_turn_stream(
    pool: &SqlitePool,
    _app_config: &AppConfig,
    session_id: &str,
    user_input: &str,
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
    let now = chrono::Utc::now().to_rfc3339();
    let user_msg_id = uuid::Uuid::new_v4().to_string();

    tracing::info!(
        session = session_id,
        turn = turn_number,
        model = %model,
        "execute_turn_stream: streaming turn start"
    );

    // Save user message
    sqlx::query(
        "INSERT INTO messages (id, session_id, turn_number, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)"
    )
    .bind(&user_msg_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(user_input)
    .bind(&now)
    .execute(pool)
    .await?;

    tracing::debug!(session = session_id, turn = turn_number, msg_id = %user_msg_id, "User message saved");

    // Multi-agent graph execution: run non-streaming, wrap result as single-chunk stream
    if session.mode != "single_agent" {
        let graph = super::templates::get_template(&session.mode);
        let narrative_text = super::graph::execute_graph(
            pool, &provider, &model, session_id, turn_number, &graph, user_input, &session_config,
        ).await?;

        let model_config_json = serde_json::json!({"model": model, "mode": &session.mode}).to_string();
        let title_source = session.title_source.clone();
        let session_id_clone = session_id.to_string();
        let narrative_for_stream = narrative_text.clone();
        let narrative_for_save = narrative_text.clone();
        let user_input_clone = user_input.to_string();
        let pool_clone = pool.clone();

        let stream = async_stream::stream! {
            yield Ok::<_, crate::error::AppError>(StreamChunk {
                choices: vec![crate::provider::types::StreamChoice {
                    delta: crate::provider::types::StreamDelta {
                        role: Some("assistant".to_string()),
                        content: Some(narrative_for_stream),
                    },
                    finish_reason: Some("stop".to_string()),
                }],
            });
        };

        // Save assistant message and update turn in background
        let pool_bg = pool_clone.clone();
        tokio::spawn(async move {
            let now = chrono::Utc::now().to_rfc3339();
            let msg_id = uuid::Uuid::new_v4().to_string();
            let _ = sqlx::query(
                "INSERT INTO messages (id, session_id, turn_number, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
            )
            .bind(&msg_id)
            .bind(&session_id_clone)
            .bind(turn_number)
            .bind(&narrative_for_save)
            .bind(&now)
            .execute(&pool_bg)
            .await;

            let _ = sqlx::query("UPDATE sessions SET current_turn = ?, updated_at = ? WHERE id = ?")
                .bind(turn_number)
                .bind(&now)
                .bind(&session_id_clone)
                .execute(&pool_bg)
                .await;

            auto_title(&pool_bg, &session_id_clone, &user_input_clone, &narrative_for_save, turn_number, &title_source).await;
        });

        let pinned = Box::pin(stream);
        return Ok(StreamTurnResult {
            stream: pinned,
            turn_number,
            session_id: session_id.to_string(),
            model_config_json,
            title_source: session.title_source.clone(),
        });
    }

    // Single-agent streaming path (existing)
    // Build context
    let context_bundle = context::build_context(
        pool, session_id, turn_number, session_config.max_context_turns as usize
    ).await?;

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

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_prompt,
    }];

    for msg in &context_bundle.recent_context {
        messages.push(ChatMessage {
            role: msg.role.clone(),
            content: msg.content.clone(),
        });
    }

    if !context_bundle.events.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Known events:\n{}", context_bundle.events.join("\n")),
        });
    }

    if !context_bundle.foreshadowing.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Open foreshadowing items:\n{}", context_bundle.foreshadowing.join("\n")),
        });
    }

    if let Some(ref summary) = context_bundle.scene_summary {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Scene summary:\n{}", summary),
        });
    }

    let request = ChatRequest {
        model: model.clone(),
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        stream: true,
    };

    let model_config_json = serde_json::json!({
        "model": model,
        "temperature": session_config.temperature,
        "top_p": session_config.top_p,
        "max_tokens": session_config.max_tokens,
        "max_context_turns": session_config.max_context_turns,
    }).to_string();

    let provider_stream = provider
        .chat_completion_stream(request)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    tracing::debug!(session = session_id, turn = turn_number, "LLM stream connected, forwarding chunks");

    let mapped_stream = async_stream::stream! {
        use futures::StreamExt;
        let mut pinned = std::pin::pin!(provider_stream);
        while let Some(chunk) = pinned.next().await {
            yield chunk.map_err(|e| AppError::Provider(e.to_string()));
        }
    };

    // Update session turn counter
    sqlx::query("UPDATE sessions SET current_turn = ?, updated_at = ? WHERE id = ?")
        .bind(turn_number)
        .bind(&now)
        .bind(session_id)
        .execute(pool)
        .await?;

    Ok(StreamTurnResult {
        stream: Box::pin(mapped_stream),
        turn_number,
        session_id: session_id.to_string(),
        model_config_json,
        title_source: session.title_source,
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
    let provider = load_provider(pool).await?;
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

    let user_input = user_input.ok_or_else(|| AppError::NotFound("No user message found for this turn".to_string()))?;

    // Load session config
    let session_config: SessionConfig = sqlx::query_scalar::<_, String>(
        "SELECT config FROM sessions WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))
    .map(|c| serde_json::from_str(&c).unwrap_or_default())?;

    // Build context (exclude the current assistant message to avoid contamination)
    let context_bundle = context::build_context_for_regenerate(
        pool, session_id, turn_number, session_config.max_context_turns as usize, &msg_id
    ).await?;

    let system_prompt = if session_config.system_prompt.is_empty() {
        default_system_prompt()
    } else {
        session_config.system_prompt.clone()
    };

    let mut messages = vec![ChatMessage {
        role: "system".to_string(),
        content: system_prompt,
    }];

    for ctx_msg in &context_bundle.recent_context {
        messages.push(ChatMessage {
            role: ctx_msg.role.clone(),
            content: ctx_msg.content.clone(),
        });
    }

    if !context_bundle.events.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Known events:\n{}", context_bundle.events.join("\n")),
        });
    }

    if !context_bundle.foreshadowing.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Open foreshadowing items:\n{}", context_bundle.foreshadowing.join("\n")),
        });
    }

    if let Some(ref summary) = context_bundle.scene_summary {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Scene summary:\n{}", summary),
        });
    }

    let model_for_trace = model.clone();

    let request = ChatRequest {
        model,
        messages,
        temperature: Some(session_config.temperature),
        top_p: Some(session_config.top_p),
        max_tokens: Some(session_config.max_tokens as u32),
        frequency_penalty: Some(session_config.frequency_penalty),
        presence_penalty: Some(session_config.presence_penalty),
        stream: false,
    };

    let start = std::time::Instant::now();
    let response = provider
        .chat_completion(request)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;
    let duration_ms = start.elapsed().as_millis() as i32;

    let new_content = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    let token_usage = response.usage.as_ref().map(|u| {
        serde_json::json!({
            "prompt_tokens": u.prompt_tokens,
            "completion_tokens": u.completion_tokens,
            "total_tokens": u.total_tokens
        })
    }).unwrap_or_else(|| serde_json::json!({}));

    // Push current content to variants
    let mut variants: Vec<String> = serde_json::from_str(&variants_str).unwrap_or_default();
    variants.push(current_content);
    let variants_json = serde_json::to_string(&variants).unwrap_or_else(|_| "[]".to_string());

    // Update the assistant message
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE messages SET content = ?, variants = ? WHERE id = ?")
        .bind(&new_content)
        .bind(&variants_json)
        .bind(&msg_id)
        .execute(pool)
        .await?;

    // Record trace
    let trace_id = uuid::Uuid::new_v4().to_string();
    let input_summary = format!("Regenerate: {}", truncate_str(&user_input, 200));
    let output_summary = format!("Response: {}", truncate_str(&new_content, 200));
    let model_config = serde_json::json!({
        "model": model_for_trace,
        "temperature": session_config.temperature,
        "top_p": session_config.top_p,
        "max_tokens": session_config.max_tokens,
        "max_context_turns": session_config.max_context_turns,
    }).to_string();

    sqlx::query(
        r#"INSERT INTO traces (id, session_id, turn_number, node_id, node_type, agent_id,
           input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at)
           VALUES (?, ?, ?, 'npc_writer_1', 'npc', 'single_agent', ?, ?, 'writer_draft', ?, ?, ?, ?)"#
    )
    .bind(&trace_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(&input_summary)
    .bind(&output_summary)
    .bind(&model_config)
    .bind(token_usage.to_string())
    .bind(duration_ms)
    .bind(&now)
    .execute(pool)
    .await?;

    info!(turn = turn_number, session = session_id, "Message regenerated");

    Ok((new_content, variants_json, turn_number))
}
