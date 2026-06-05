use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName};
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::runtime::executor;

type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

pub struct AppState {
    pub pool: SqlitePool,
    pub config: AppConfig,
}

#[derive(Deserialize)]
pub struct SendMessage {
    pub content: String,
    pub stream: Option<bool>,
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

    if body.stream.unwrap_or(false) {
        tracing::info!(session = %session_id, "streaming turn start, content_len={}", body.content.len());

        let stream_result = executor::execute_turn_stream(
            &state.pool,
            &state.config,
            &session_id,
            &body.content,
        )
        .await?;

        let turn_number = stream_result.turn_number;
        let session_id_clone = stream_result.session_id.clone();
        let title_source = stream_result.title_source.clone();
        let user_input = body.content.clone();
        let pool = state.pool.clone();

        // Use mpsc channel so the background task persists the message
        // even if the client disconnects and the SSE generator is dropped.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

        tokio::spawn(async move {
            tracing::debug!(session = %session_id_clone, turn = turn_number, "SSE background task started");

            let _ = tx.send(Ok(Event::default()
                .event("turn_start")
                .data(serde_json::json!({"turn_number": turn_number}).to_string())));

            let mut accumulated = String::new();
            let mut chunk_count: u64 = 0;
            let mut pinned = std::pin::pin!(stream_result.stream);
            while let Some(chunk) = pinned.next().await {
                match chunk {
                    Ok(c) => {
                        if let Some(delta) = c.choices.first().and_then(|ch| ch.delta.content.as_deref()) {
                            accumulated.push_str(delta);
                            chunk_count += 1;
                            let _ = tx.send(Ok(Event::default()
                                .event("message_delta")
                                .data(serde_json::json!({"content": delta}).to_string())));
                        }
                    }
                    Err(e) => {
                        tracing::error!(session = %session_id_clone, turn = turn_number, "LLM stream error: {}", e);
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

            // Persist assistant message — runs regardless of client connection
            let now = chrono::Utc::now().to_rfc3339();
            let msg_id = uuid::Uuid::new_v4().to_string();
            if let Err(e) = sqlx::query(
                "INSERT INTO messages (id, session_id, turn_number, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
            )
            .bind(&msg_id)
            .bind(&session_id_clone)
            .bind(turn_number)
            .bind(&accumulated)
            .bind(&now)
            .execute(&pool)
            .await {
                tracing::error!(session = %session_id_clone, turn = turn_number, msg_id = %msg_id, "Failed to persist assistant message: {}", e);
            } else {
                tracing::info!(session = %session_id_clone, turn = turn_number, msg_id = %msg_id, "Assistant message persisted");
            }

            let _ = tx.send(Ok(Event::default()
                .event("turn_end")
                .data(serde_json::json!({
                    "turn_number": turn_number,
                    "message_content": accumulated
                }).to_string())));

            // Fire-and-forget: auto-generate title after first turn
            let pool_bg = pool.clone();
            let sid_bg = session_id_clone.clone();
            let input_bg = user_input.clone();
            let ts_bg = title_source.clone();
            tokio::spawn(async move {
                executor::auto_title(&pool_bg, &sid_bg, &input_bg, &accumulated, turn_number, &ts_bg).await;
            });
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

        let turn_result = executor::execute_turn(
            &state.pool,
            &state.config,
            &session_id,
            &body.content,
        )
        .await?;

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
    let state_data: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1"
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
    let (new_content, variants_json, turn_number) = executor::regenerate_turn(
        &state.pool,
        &session_id,
        &message_id,
    )
    .await?;

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
        return Err(AppError::BadRequest("Variant index out of range".to_string()));
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
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT content, variants FROM messages WHERE id = ? AND session_id = ?"
    )
    .bind(&message_id)
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Message not found".to_string()))?;

    let (old_content, variants_str) = row;
    let mut variants: Vec<String> = serde_json::from_str(&variants_str).unwrap_or_default();
    variants.push(old_content);
    let variants_json = serde_json::to_string(&variants).unwrap_or_else(|_| "[]".to_string());

    sqlx::query("UPDATE messages SET content = ?, variants = ?, variant_index = -1 WHERE id = ?")
        .bind(&body.content)
        .bind(&variants_json)
        .bind(&message_id)
        .execute(&state.pool)
        .await?;

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
    let result = sqlx::query("DELETE FROM messages WHERE id = ? AND session_id = ?")
        .bind(&message_id)
        .bind(&session_id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Message not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
