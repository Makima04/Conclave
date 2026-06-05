use super::types::{ContextBundle, ContextMessage};
use crate::error::AppError;
use sqlx::SqlitePool;

async fn build_context_inner(
    pool: &SqlitePool,
    session_id: &str,
    _current_turn: i32,
    max_turns: usize,
    exclude_message_id: Option<&str>,
) -> Result<ContextBundle, AppError> {
    let mut query = String::from(
        "SELECT role, content, turn_number FROM messages WHERE session_id = ?"
    );
    if exclude_message_id.is_some() {
        query.push_str(" AND id != ?");
    }
    query.push_str(" ORDER BY turn_number DESC, created_at DESC LIMIT ?");

    let mut q = sqlx::query_as::<_, (String, String, i32)>(&query)
        .bind(session_id);
    if let Some(ex_id) = exclude_message_id {
        q = q.bind(ex_id);
    }
    let rows = q.bind(max_turns as i32).fetch_all(pool).await?;

    let recent_messages: Vec<ContextMessage> = rows
        .into_iter()
        .rev()
        .map(|(role, content, turn_number)| ContextMessage {
            role: if role.starts_with("npc:") { "assistant".to_string() } else { role },
            content,
            turn_number,
        })
        .collect();

    let state_snapshot: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    let structured_state = state_snapshot
        .map(|s: String| serde_json::from_str(&s).unwrap_or(serde_json::json!({})))
        .unwrap_or_else(|| serde_json::json!({}));

    let events: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM memory_events WHERE session_id = ? ORDER BY turn_number DESC LIMIT 20"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let foreshadow_items: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM foreshadowing WHERE session_id = ? AND status IN ('open', 'hinted') ORDER BY importance DESC LIMIT 10"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let scene_summary: Option<String> = sqlx::query_scalar(
        "SELECT content FROM turn_summaries WHERE session_id = ? AND summary_type = 'scene' ORDER BY turn_number DESC LIMIT 1"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    Ok(ContextBundle {
        task: "Continue the roleplay narrative".to_string(),
        recent_context: recent_messages,
        structured_state,
        events,
        foreshadowing: foreshadow_items,
        scene_summary,
    })
}

pub async fn build_context(
    pool: &SqlitePool,
    session_id: &str,
    current_turn: i32,
    max_turns: usize,
) -> Result<ContextBundle, AppError> {
    build_context_inner(pool, session_id, current_turn, max_turns, None).await
}

/// Build context for regeneration, excluding the message being regenerated.
pub async fn build_context_for_regenerate(
    pool: &SqlitePool,
    session_id: &str,
    current_turn: i32,
    max_turns: usize,
    exclude_message_id: &str,
) -> Result<ContextBundle, AppError> {
    build_context_inner(pool, session_id, current_turn, max_turns, Some(exclude_message_id)).await
}
