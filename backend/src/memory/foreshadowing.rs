use crate::error::AppError;
use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ForeshadowItem {
    pub id: String,
    pub content: String,
    pub status: String,
    pub importance: String,
    pub planted_at_turn: i32,
    pub created_at: String,
}

pub async fn record_foreshadowing(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    content: &str,
    importance: &str,
    trigger_conditions: &[String],
) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let conditions_json = serde_json::to_string(trigger_conditions).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO foreshadowing (id, session_id, content, status, importance, trigger_conditions, planted_at_turn, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(content)
    .bind(importance)
    .bind(&conditions_json)
    .bind(turn_number)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(id)
}

pub async fn get_foreshadowing(
    pool: &SqlitePool,
    session_id: &str,
    status: &str,
) -> Result<Vec<ForeshadowItem>, AppError> {
    let items = sqlx::query_as::<_, ForeshadowItem>(
        "SELECT id, content, status, importance, planted_at_turn, created_at FROM foreshadowing WHERE session_id = ? AND status = ? ORDER BY importance DESC"
    )
    .bind(session_id)
    .bind(status)
    .fetch_all(pool)
    .await?;

    Ok(items)
}
