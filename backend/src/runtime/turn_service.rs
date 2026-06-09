use sqlx::SqlitePool;

use crate::error::AppError;

pub async fn acquire_processing_status(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<(), AppError> {
    let status_result = sqlx::query(
        "UPDATE sessions SET status = 'processing' WHERE id = ? AND status IN ('idle', 'compressing', 'failed_generation', 'failed_compression', 'needs_repair')"
    )
    .bind(session_id)
    .execute(pool)
    .await?;

    if status_result.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "会话正在处理中，请稍后再试。".to_string(),
        ));
    }

    Ok(())
}

pub async fn mark_failed_generation(pool: &SqlitePool, session_id: &str) {
    let _ = sqlx::query("UPDATE sessions SET status = 'failed_generation' WHERE id = ?")
        .bind(session_id)
        .execute(pool)
        .await;
}

pub async fn mark_idle(pool: &SqlitePool, session_id: &str) {
    let _ = sqlx::query("UPDATE sessions SET status = 'idle' WHERE id = ?")
        .bind(session_id)
        .execute(pool)
        .await;
}
