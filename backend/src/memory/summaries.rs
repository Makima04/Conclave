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

    tracing::debug!(
        session = session_id,
        turn = turn_number,
        summary_type = summary_type,
        "Turn summary saved"
    );

    Ok(id)
}
