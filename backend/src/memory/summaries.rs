use crate::error::AppError;
use sqlx::SqlitePool;

pub async fn save_summary(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    summary_type: &str,
    content: &str,
) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO turn_summaries (id, session_id, turn_number, summary_type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(turn_number)
    .bind(summary_type)
    .bind(content)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(id)
}

pub async fn get_latest_summary(
    pool: &SqlitePool,
    session_id: &str,
    summary_type: &str,
) -> Result<Option<String>, AppError> {
    let summary: Option<String> = sqlx::query_scalar(
        "SELECT content FROM turn_summaries WHERE session_id = ? AND summary_type = ? ORDER BY turn_number DESC LIMIT 1"
    )
    .bind(session_id)
    .bind(summary_type)
    .fetch_optional(pool)
    .await?;

    Ok(summary)
}
