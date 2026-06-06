use crate::error::AppError;
use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MemoryEvent {
    pub id: String,
    pub turn_number: i32,
    pub event_type: String,
    pub content: String,
    pub characters_involved: String,
    pub importance: String,
    pub created_at: String,
}

pub async fn record_event(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    event_type: &str,
    content: &str,
    characters: &[String],
    importance: &str,
) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let chars_json = serde_json::to_string(characters).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO memory_events (id, session_id, turn_number, event_type, content, characters_involved, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(turn_number)
    .bind(event_type)
    .bind(content)
    .bind(&chars_json)
    .bind(importance)
    .bind(&now)
    .execute(pool)
    .await?;

    tracing::debug!(
        session = session_id,
        turn = turn_number,
        event_type = event_type,
        importance = importance,
        "Memory event recorded"
    );

    Ok(id)
}

pub async fn get_events(
    pool: &SqlitePool,
    session_id: &str,
    limit: i32,
) -> Result<Vec<MemoryEvent>, AppError> {
    let events = sqlx::query_as::<_, MemoryEvent>(
        "SELECT id, turn_number, event_type, content, characters_involved, importance, created_at FROM memory_events WHERE session_id = ? ORDER BY turn_number DESC LIMIT ?"
    )
    .bind(session_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(events)
}
