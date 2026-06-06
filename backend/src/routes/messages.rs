use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName};
use axum::response::sse::{Event, Sse};
use futures::StreamExt;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::runtime::compression;
use crate::runtime::executor;
use crate::runtime::executor::ActiveTurns;
use crate::runtime::state_initializer;
use crate::runtime::turn_finalizer;
use crate::runtime::variable_update;

type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

pub struct AppState {
    pub pool: SqlitePool,
    pub config: AppConfig,
    pub active_turns: ActiveTurns,
    /// Per-session locks to serialize concurrent send_message requests.
    pub session_locks: Arc<dashmap::DashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Deserialize)]
pub struct SendMessage {
    pub content: String,
    pub stream: Option<bool>,
}

#[derive(Deserialize)]
pub struct ApplyOpeningMessage {
    pub content: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MessageResponse {
    pub id: String,
    pub session_id: String,
    pub turn_number: i32,
    pub role: String,
    pub content: String,
    pub variants: String,
    pub variant_index: i32,
    pub created_at: String,
}

pub async fn apply_opening(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<ApplyOpeningMessage>,
) -> Result<Json<MessageResponse>, AppError> {
    let content = body.content.trim();
    if content.is_empty() {
        return Err(AppError::BadRequest("开场白不能为空".to_string()));
    }

    let session_exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM sessions WHERE id = ? AND deleted_at IS NULL")
            .bind(&session_id)
            .fetch_optional(&state.pool)
            .await?;
    if session_exists.is_none() {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    if let Err(e) =
        state_initializer::initialize_session_state_from_world_book(&state.pool, &session_id).await
    {
        tracing::warn!(session = %session_id, "Failed to initialize session state before applying opening: {}", e);
    }

    let now = chrono::Utc::now().to_rfc3339();
    let extraction = variable_update::extract(content);
    let display_content = if extraction.display_text.is_empty() {
        content.to_string()
    } else {
        extraction.display_text.clone()
    };
    let existing_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM messages WHERE session_id = ? AND turn_number = 0 AND role = 'assistant' ORDER BY created_at ASC LIMIT 1"
    )
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?;

    let id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut tx = state.pool.begin().await?;
    if sqlx::query_scalar::<_, String>("SELECT id FROM messages WHERE id = ?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    {
        sqlx::query("UPDATE messages SET content = ?, created_at = ? WHERE id = ?")
            .bind(&display_content)
            .bind(&now)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query(
            "INSERT INTO messages (id, session_id, turn_number, role, content, created_at) VALUES (?, ?, 0, 'assistant', ?, ?)"
        )
        .bind(&id)
        .bind(&session_id)
        .bind(&display_content)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
    variable_update::persist_extraction_tx(&mut tx, &session_id, 0, &extraction).await?;
    tx.commit().await?;

    Ok(Json(MessageResponse {
        id,
        session_id,
        turn_number: 0,
        role: "assistant".to_string(),
        content: display_content,
        variants: "[]".to_string(),
        variant_index: -1,
        created_at: now,
    }))
}

#[derive(Deserialize)]
pub struct MessageListParams {
    pub cursor: Option<String>,
    pub limit: Option<i32>,
}

pub async fn send_message(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<SendMessage>,
) -> Result<(HeaderMap, Sse<SseStream>), AppError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        "no".parse().unwrap(),
    );

    // Per-session lock: serialize concurrent requests for the same session
    let session_lock = state
        .session_locks
        .entry(session_id.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let _guard = session_lock.lock().await;

    // Atomic status check-and-set: only proceed if session is in a recoverable state
    let status_result = sqlx::query(
        "UPDATE sessions SET status = 'processing' WHERE id = ? AND status IN ('idle', 'failed_generation', 'failed_compression', 'needs_repair')"
    )
    .bind(&session_id)
    .execute(&state.pool)
    .await?;

    if status_result.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "会话正在处理中，请稍后再试。".to_string(),
        ));
    }

    if body.stream.unwrap_or(false) {
        tracing::info!(session = %session_id, "streaming turn start, content_len={}", body.content.len());

        // Create broadcast channel for SSE reconnection (carries all lifecycle events)
        let (broadcast_tx, _) = broadcast::channel::<crate::runtime::sse_types::SseEvent>(256);
        state
            .active_turns
            .lock()
            .await
            .insert(session_id.clone(), broadcast_tx.clone());

        let stream_result = match executor::execute_turn_stream(
            &state.pool,
            &state.config,
            &session_id,
            &body.content,
            &state.active_turns,
            broadcast_tx.clone(),
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                // execute_turn_stream failed before spawning background task — reset status
                state.active_turns.lock().await.remove(&session_id);
                let _ =
                    sqlx::query("UPDATE sessions SET status = 'failed_generation' WHERE id = ?")
                        .bind(&session_id)
                        .execute(&state.pool)
                        .await;
                return Err(e);
            }
        };

        let turn_number = stream_result.turn_number;
        let session_id_clone = stream_result.session_id.clone();
        let title_source = stream_result.title_source.clone();
        let user_input = body.content.clone();
        let pool = state.pool.clone();
        let commit_data = stream_result.commit_data.clone();
        let active_turns_clone = state.active_turns.clone();
        let session_id_for_active = session_id.clone();

        // Use mpsc channel so the background task persists the message
        // even if the client disconnects and the SSE generator is dropped.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

        tokio::spawn(async move {
            tracing::debug!(session = %session_id_clone, turn = turn_number, "SSE background task started");

            let _ =
                broadcast_tx.send(crate::runtime::sse_types::SseEvent::TurnStart { turn_number });
            let _ = tx.send(Ok(Event::default()
                .event("turn_start")
                .data(serde_json::json!({"turn_number": turn_number}).to_string())));

            let mut accumulated = String::new();
            let mut chunk_count: u64 = 0;
            let mut pinned = std::pin::pin!(stream_result.stream);
            while let Some(chunk) = pinned.next().await {
                match chunk {
                    Ok(c) => {
                        if let Some(choice) = c.choices.first() {
                            // Forward agent status events
                            if let Some(ref status) = choice.delta.agent_status {
                                let _ = broadcast_tx.send(
                                    crate::runtime::sse_types::SseEvent::AgentStatus {
                                        agent_type: status.agent_type.clone(),
                                        label: status.label.clone(),
                                        status: status.status.clone(),
                                    },
                                );
                                let _ = tx.send(Ok(Event::default().event("agent_status").data(
                                    serde_json::json!({
                                        "agent_type": status.agent_type,
                                        "label": status.label,
                                        "status": status.status
                                    })
                                    .to_string(),
                                )));
                            }
                            // Accumulate and forward content deltas
                            if let Some(delta) = choice.delta.content.as_deref() {
                                accumulated.push_str(delta);
                                chunk_count += 1;
                                let _ = broadcast_tx.send(
                                    crate::runtime::sse_types::SseEvent::MessageDelta {
                                        content: delta.to_string(),
                                    },
                                );
                                let _ = tx.send(Ok(Event::default()
                                    .event("message_delta")
                                    .data(serde_json::json!({"content": delta}).to_string())));
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!(session = %session_id_clone, turn = turn_number, "LLM stream error: {}", e);
                        let _ = sqlx::query(
                            "UPDATE sessions SET status = 'failed_generation' WHERE id = ?",
                        )
                        .bind(&session_id_clone)
                        .execute(&pool)
                        .await;
                        let _ =
                            broadcast_tx.send(crate::runtime::sse_types::SseEvent::StreamError {
                                error: e.to_string(),
                            });
                        let _ = tx.send(Ok(Event::default()
                            .event("stream_error")
                            .data(serde_json::json!({"error": e.to_string()}).to_string())));
                        break;
                    }
                }
            }

            tracing::info!(
                session = %session_id_clone,
                turn = turn_number,
                chunks = chunk_count,
                content_len = accumulated.len(),
                "LLM stream finished, persisting assistant message"
            );

            let variable_extraction = variable_update::extract(&accumulated);
            let display_content = if variable_extraction.display_text.is_empty() {
                accumulated.clone()
            } else {
                variable_extraction.display_text.clone()
            };

            // Finalize: user msg + assistant msg + traces + current_turn in one transaction
            let (commit_traces, commit_compression, compression_job, state_proposals) = commit_data
                .as_ref()
                .and_then(|data| data.lock().ok().and_then(|guard| guard.clone()))
                .map(|(traces, compression, job, proposals)| {
                    (Some(traces), compression, job, proposals)
                })
                .unwrap_or((None, None, None, vec![]));
            let traces_ref = commit_traces.as_deref().unwrap_or(&[]);
            let finalize_result: Result<(), String> = async {
                let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
                turn_finalizer::finalize_turn(
                    &mut tx,
                    &session_id_clone,
                    turn_number,
                    &user_input,
                    &accumulated,
                    traces_ref,
                )
                .await
                .map_err(|e| e.to_string())?;
                tx.commit().await.map_err(|e| e.to_string())?;
                Ok(())
            }
            .await;

            if let Err(e) = &finalize_result {
                tracing::error!(session = %session_id_clone, turn = turn_number, "Turn finalize failed: {}", e);
                let _ = broadcast_tx.send(crate::runtime::sse_types::SseEvent::StreamError {
                    error: format!("Turn finalize failed: {}", e),
                });
                let _ = tx.send(Ok(Event::default().event("stream_error").data(
                    serde_json::json!({"error": format!("Turn finalize failed: {}", e)})
                        .to_string(),
                )));
                // Set failed status — next send_message will allow retry
                let _ =
                    sqlx::query("UPDATE sessions SET status = 'failed_generation' WHERE id = ?")
                        .bind(&session_id_clone)
                        .execute(&pool)
                        .await;
            } else {
                tracing::info!(session = %session_id_clone, turn = turn_number, "Turn finalized (assistant persisted, current_turn advanced)");
            }

            let _ = broadcast_tx.send(crate::runtime::sse_types::SseEvent::TurnEnd {
                turn_number,
                message_content: display_content.clone(),
            });
            let _ = tx.send(Ok(Event::default().event("turn_end").data(
                serde_json::json!({
                    "turn_number": turn_number,
                    "message_content": display_content
                })
                .to_string(),
            )));

            // Track compression success/failure
            if finalize_result.is_ok() {
                let _ = broadcast_tx
                    .send(crate::runtime::sse_types::SseEvent::MemoryStart { turn_number });
                let _ = tx.send(Ok(Event::default()
                    .event("memory_start")
                    .data(serde_json::json!({"turn_number": turn_number}).to_string())));

                // If multi-agent already produced compression results inline, persist them directly
                if let Some(ref cr) = commit_compression {
                    turn_finalizer::persist_turn_extras(
                        &pool,
                        &session_id_clone,
                        turn_number,
                        &Some(cr.clone()),
                        &state_proposals,
                    )
                    .await;
                    let _ = sqlx::query("UPDATE sessions SET status = 'idle' WHERE id = ?")
                        .bind(&session_id_clone)
                        .execute(&pool)
                        .await;
                } else {
                    if !state_proposals.is_empty() {
                        turn_finalizer::persist_turn_extras(
                            &pool,
                            &session_id_clone,
                            turn_number,
                            &None,
                            &state_proposals,
                        )
                        .await;
                    }
                    // Insert a background compression job
                    let model = match compression_job {
                        Some(ref j) => j.model.clone(),
                        None => String::new(),
                    };
                    turn_finalizer::persist_compression_job(
                        &pool,
                        &session_id_clone,
                        turn_number,
                        "compression",
                        &model,
                        &user_input,
                        &display_content,
                    )
                    .await;
                    // Session stays in 'compressing' — background worker will set to 'idle' when done
                }
            }

            // If finalize failed, set status (already done above). If finalize succeeded with inline compression, set idle.
            // For deferred compression, the worker handles status transitions.
            if finalize_result.is_err() {
                // Already set to failed_generation above
            } else if commit_compression.is_some() {
                // Inline compression already set to idle above
            }
            // else: deferred compression, worker handles it

            let _ =
                broadcast_tx.send(crate::runtime::sse_types::SseEvent::TurnReady { turn_number });
            // Remove from active turns — no longer reconnectable
            active_turns_clone
                .lock()
                .await
                .remove(&session_id_for_active);
            let _ = tx.send(Ok(Event::default()
                .event("turn_ready")
                .data(serde_json::json!({"turn_number": turn_number}).to_string())));

            // Fire-and-forget: auto-generate title after first turn (outside transaction)
            if finalize_result.is_ok() {
                let pool_bg = pool.clone();
                let sid_bg = session_id_clone.clone();
                let input_bg = user_input.clone();
                let ts_bg = title_source.clone();
                tokio::spawn(async move {
                    executor::auto_title(
                        &pool_bg,
                        &sid_bg,
                        &input_bg,
                        &display_content,
                        turn_number,
                        &ts_bg,
                    )
                    .await;
                });
            }
        });

        let stream = async_stream::stream! {
            while let Some(event) = rx.recv().await {
                yield event;
            }
        };

        let sse_stream: SseStream = Box::pin(stream);
        Ok((headers, Sse::new(sse_stream)))
    } else {
        tracing::info!(session = %session_id, "non-streaming turn start, content_len={}", body.content.len());

        let turn_result =
            match executor::execute_turn(&state.pool, &state.config, &session_id, &body.content)
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let _ = sqlx::query(
                        "UPDATE sessions SET status = 'failed_generation' WHERE id = ?",
                    )
                    .bind(&session_id)
                    .execute(&state.pool)
                    .await;
                    return Err(e);
                }
            };

        // Non-streaming succeeded — set idle
        let _ = sqlx::query("UPDATE sessions SET status = 'idle' WHERE id = ?")
            .bind(&session_id)
            .execute(&state.pool)
            .await;

        let stream = async_stream::stream! {
            yield Ok(Event::default()
                .event("turn_start")
                .data(serde_json::json!({"turn_number": turn_result.turn_number}).to_string()));

            yield Ok(Event::default()
                .event("message_delta")
                .data(serde_json::json!({"content": turn_result.message_content}).to_string()));

            yield Ok(Event::default()
                .event("turn_end")
                .data(serde_json::json!({
                    "turn_number": turn_result.turn_number,
                    "message_content": turn_result.message_content
                }).to_string()));
        };

        let sse_stream: SseStream = Box::pin(stream);
        Ok((headers, Sse::new(sse_stream)))
    }
}

pub async fn list_messages(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(params): Query<MessageListParams>,
) -> Result<Json<serde_json::Value>, AppError> {
    let limit = params.limit.unwrap_or(50).min(200);

    let messages = sqlx::query_as::<_, MessageResponse>(
        "SELECT id, session_id, turn_number, role, content, variants, variant_index, created_at FROM messages WHERE session_id = ? ORDER BY turn_number ASC, created_at ASC LIMIT ?"
    )
    .bind(&session_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "items": messages })))
}

pub async fn get_state(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    if let Err(e) =
        state_initializer::initialize_session_state_from_world_book(&state.pool, &session_id).await
    {
        tracing::warn!(session = %session_id, "Failed to lazily initialize session state: {}", e);
    }

    let state_data: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?;

    let value = state_data
        .map(|s| serde_json::from_str(&s).unwrap_or(serde_json::json!({})))
        .unwrap_or_else(|| serde_json::json!({}));

    Ok(Json(value))
}

pub async fn get_memory_events(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    #[derive(sqlx::FromRow, Serialize)]
    struct EventRow {
        id: String,
        turn_number: i32,
        event_type: String,
        content: String,
        importance: String,
        created_at: String,
    }

    let items = sqlx::query_as::<_, EventRow>(
        "SELECT id, turn_number, event_type, content, importance, created_at FROM memory_events WHERE session_id = ? ORDER BY turn_number DESC LIMIT 50"
    )
    .bind(&session_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "items": items })))
}

pub async fn get_foreshadowing(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    #[derive(sqlx::FromRow, Serialize)]
    struct ForeshadowRow {
        id: String,
        content: String,
        status: String,
        importance: String,
        planted_at_turn: i32,
        created_at: String,
    }

    let items = sqlx::query_as::<_, ForeshadowRow>(
        "SELECT id, content, status, importance, planted_at_turn, created_at FROM foreshadowing WHERE session_id = ? AND status = 'open' ORDER BY importance DESC"
    )
    .bind(&session_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "items": items })))
}

pub async fn get_trace(
    State(state): State<Arc<AppState>>,
    Path((session_id, turn)): Path<(String, i32)>,
) -> Result<Json<serde_json::Value>, AppError> {
    #[derive(sqlx::FromRow, Serialize)]
    struct TraceRow {
        id: String,
        turn_number: i32,
        node_id: String,
        node_type: String,
        agent_id: Option<String>,
        input_summary: String,
        output_summary: String,
        output_type: Option<String>,
        model_config: String,
        token_usage: String,
        duration_ms: Option<i32>,
        created_at: String,
    }

    let traces = sqlx::query_as::<_, TraceRow>(
        "SELECT id, turn_number, node_id, node_type, agent_id, input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at FROM traces WHERE session_id = ? AND turn_number = ? ORDER BY created_at"
    )
    .bind(&session_id)
    .bind(turn)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "items": traces })))
}

pub async fn regenerate(
    State(state): State<Arc<AppState>>,
    Path((session_id, message_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (new_content, variants_json, turn_number) =
        executor::regenerate_turn(&state.pool, &session_id, &message_id).await?;

    // Insert recompression job to rebuild memory for the regenerated turn
    turn_finalizer::persist_compression_job(
        &state.pool,
        &session_id,
        turn_number,
        "recompression",
        "",
        "",
        &new_content,
    )
    .await;

    Ok(Json(serde_json::json!({
        "id": message_id,
        "content": new_content,
        "variants": variants_json,
        "variant_index": -1,
        "turn_number": turn_number
    })))
}

#[derive(Deserialize)]
pub struct SwitchVariantBody {
    pub index: i32,
}

pub async fn switch_variant(
    State(state): State<Arc<AppState>>,
    Path((session_id, message_id)): Path<(String, String)>,
    Json(body): Json<SwitchVariantBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = sqlx::query_as::<_, (String, String, i32)>(
        "SELECT content, variants, variant_index FROM messages WHERE id = ? AND session_id = ? AND role = 'assistant'"
    )
    .bind(&message_id)
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Message not found".to_string()))?;

    let (current_content, variants_str, _current_index) = row;
    let variants: Vec<String> = serde_json::from_str(&variants_str).unwrap_or_default();

    // index == -1 means current content (live), 0..len means variants array
    if body.index < -1 || body.index >= variants.len() as i32 {
        return Err(AppError::BadRequest(
            "Variant index out of range".to_string(),
        ));
    }

    // If switching to a different variant, we need to make the current display content
    // the "live" content so context building uses it
    let (new_content, new_variants, new_index) = if body.index == -1 {
        // Switching back to live: no DB change needed, just update index
        (current_content, variants_str, -1i32)
    } else {
        // Switching to a historical variant: swap with current content
        let mut new_variants = variants;
        let selected = new_variants[body.index as usize].clone();
        new_variants[body.index as usize] = current_content;
        let json = serde_json::to_string(&new_variants).unwrap_or_else(|_| "[]".to_string());
        (selected, json, body.index)
    };

    sqlx::query("UPDATE messages SET content = ?, variants = ?, variant_index = ? WHERE id = ?")
        .bind(&new_content)
        .bind(&new_variants)
        .bind(new_index)
        .bind(&message_id)
        .execute(&state.pool)
        .await?;

    Ok(Json(serde_json::json!({
        "id": message_id,
        "content": new_content,
        "variants": new_variants,
        "variant_index": new_index
    })))
}

#[derive(Deserialize)]
pub struct EditMessageBody {
    pub content: String,
}

pub async fn edit_message(
    State(state): State<Arc<AppState>>,
    Path((session_id, message_id)): Path<(String, String)>,
    Json(body): Json<EditMessageBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = sqlx::query_as::<_, (String, String, i32)>(
        "SELECT content, variants, turn_number FROM messages WHERE id = ? AND session_id = ?",
    )
    .bind(&message_id)
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Message not found".to_string()))?;

    let (old_content, variants_str, turn_number) = row;
    let mut variants: Vec<String> = serde_json::from_str(&variants_str).unwrap_or_default();
    variants.push(old_content);
    let variants_json = serde_json::to_string(&variants).unwrap_or_else(|_| "[]".to_string());

    sqlx::query("UPDATE messages SET content = ?, variants = ?, variant_index = -1 WHERE id = ?")
        .bind(&body.content)
        .bind(&variants_json)
        .bind(&message_id)
        .execute(&state.pool)
        .await?;

    // Insert recompression job to rebuild memory for this turn
    turn_finalizer::persist_compression_job(
        &state.pool,
        &session_id,
        turn_number,
        "recompression",
        "",
        "",
        &body.content,
    )
    .await;

    Ok(Json(serde_json::json!({
        "id": message_id,
        "content": body.content,
        "variants": variants_json,
        "variant_index": -1
    })))
}

pub async fn delete_message(
    State(state): State<Arc<AppState>>,
    Path((session_id, message_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Get turn_number before deleting (for recompression job)
    let turn_number: Option<i32> =
        sqlx::query_scalar("SELECT turn_number FROM messages WHERE id = ? AND session_id = ?")
            .bind(&message_id)
            .bind(&session_id)
            .fetch_optional(&state.pool)
            .await?;

    let result = sqlx::query("DELETE FROM messages WHERE id = ? AND session_id = ?")
        .bind(&message_id)
        .bind(&session_id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Message not found".to_string()));
    }

    // Insert recompression job to rebuild memory after deletion
    if let Some(turn) = turn_number {
        turn_finalizer::persist_compression_job(
            &state.pool,
            &session_id,
            turn,
            "recompression",
            "",
            "",
            "",
        )
        .await;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// SSE reconnect endpoint: subscribe to an active turn's broadcast stream.
/// Returns 204 if no turn is active for this session.
pub async fn reconnect_stream(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<(HeaderMap, Sse<SseStream>), AppError> {
    let active = state.active_turns.lock().await;
    let broadcast_tx = match active.get(&session_id) {
        Some(tx) => tx.clone(),
        None => {
            // No active turn — return 204 No Content
            return Err(AppError::NotFound("no_active_turn".to_string()));
        }
    };
    drop(active);

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        "no".parse().unwrap(),
    );

    let mut rx = broadcast_tx.subscribe();

    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    use crate::runtime::sse_types::SseEvent;
                    match event {
                        SseEvent::TurnStart { turn_number } => {
                            yield Ok(Event::default()
                                .event("turn_start")
                                .data(serde_json::json!({"turn_number": turn_number}).to_string()));
                        }
                        SseEvent::AgentStatus { agent_type, label, status } => {
                            yield Ok(Event::default()
                                .event("agent_status")
                                .data(serde_json::json!({
                                    "agent_type": agent_type,
                                    "label": label,
                                    "status": status
                                }).to_string()));
                        }
                        SseEvent::MessageDelta { content } => {
                            yield Ok(Event::default()
                                .event("message_delta")
                                .data(serde_json::json!({"content": content}).to_string()));
                        }
                        SseEvent::StreamError { error } => {
                            yield Ok(Event::default()
                                .event("stream_error")
                                .data(serde_json::json!({"error": error}).to_string()));
                        }
                        SseEvent::TurnEnd { turn_number, message_content } => {
                            yield Ok(Event::default()
                                .event("turn_end")
                                .data(serde_json::json!({
                                    "turn_number": turn_number,
                                    "message_content": message_content
                                }).to_string()));
                        }
                        SseEvent::MemoryStart { turn_number } => {
                            yield Ok(Event::default()
                                .event("memory_start")
                                .data(serde_json::json!({"turn_number": turn_number}).to_string()));
                        }
                        SseEvent::MemoryError { error } => {
                            yield Ok(Event::default()
                                .event("memory_error")
                                .data(serde_json::json!({"error": error}).to_string()));
                        }
                        SseEvent::TurnReady { turn_number } => {
                            yield Ok(Event::default()
                                .event("turn_ready")
                                .data(serde_json::json!({"turn_number": turn_number}).to_string()));
                            break;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(session = %session_id, skipped = n, "Broadcast lagged during reconnect");
                    yield Ok(Event::default()
                        .event("stream_error")
                        .data(serde_json::json!({"error": format!("Reconnect lagged: {} events lost", n)}).to_string()));
                }
                Err(broadcast::error::RecvError::Closed) => {
                    // Channel closed without TurnReady — turn ended abnormally
                    yield Ok(Event::default()
                        .event("turn_end")
                        .data(serde_json::json!({}).to_string()));
                    break;
                }
            }
        }
    };

    let sse_stream: SseStream = Box::pin(stream);
    Ok((headers, Sse::new(sse_stream)))
}
