use crate::config::AppConfig;
use crate::error::AppError;
use crate::runtime::compression;
use crate::runtime::executor;
use crate::runtime::turn_finalizer;
use sqlx::SqlitePool;
use std::sync::Arc;

/// Background worker that processes turn_jobs (compression, recompression).
/// Polls every 5 seconds, retries up to 3 attempts.
pub async fn run(pool: SqlitePool, _config: Arc<AppConfig>) {
    tracing::info!("Background job worker started");

    loop {
        // Also reset stale terminal states on each cycle (lightweight, indexed)
        let _ = sqlx::query(
            "UPDATE sessions SET status = 'idle' WHERE status IN ('processing', 'compressing', 'failed_generation', 'failed_compression') AND id NOT IN (SELECT DISTINCT session_id FROM turn_jobs WHERE status IN ('pending', 'running'))"
        )
        .execute(&pool)
        .await;

        match process_next_job(&pool).await {
            Ok(true) => {
                // Job processed, immediately check for more
                continue;
            }
            Ok(false) => {
                // No pending jobs, sleep
            }
            Err(e) => {
                tracing::warn!("Background job error: {}", e);
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Process the next pending job. Returns Ok(true) if a job was processed.
async fn process_next_job(pool: &SqlitePool) -> Result<bool, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let job = sqlx::query_as::<_, JobRow>(
        "UPDATE turn_jobs
         SET status = 'running', updated_at = ?
         WHERE id = (
             SELECT id FROM turn_jobs
             WHERE status = 'pending' AND attempts < 3
             ORDER BY created_at
             LIMIT 1
         )
         AND status = 'pending'
         RETURNING id, session_id, turn_number, job_type, status, payload, error, attempts",
    )
    .bind(&now)
    .fetch_optional(pool)
    .await?;

    let job = match job {
        Some(j) => j,
        None => return Ok(false),
    };

    let _ = sqlx::query("UPDATE sessions SET status = 'compressing' WHERE id = ?")
        .bind(&job.session_id)
        .execute(pool)
        .await?;

    tracing::info!(job_id = %job.id, session = %job.session_id, turn = job.turn_number, job_type = %job.job_type, "Processing background job");

    let result = match job.job_type.as_str() {
        "compression" => run_compression_job(pool, &job).await,
        "recompression" => run_recompression_job(pool, &job).await,
        other => {
            tracing::warn!(job_type = other, "Unknown job type, marking as failed");
            Err(AppError::Internal(format!("Unknown job type: {}", other)))
        }
    };

    match result {
        Ok(()) => {
            sqlx::query("UPDATE turn_jobs SET status = 'completed', updated_at = ? WHERE id = ?")
                .bind(chrono::Utc::now().to_rfc3339())
                .bind(&job.id)
                .execute(pool)
                .await?;

            // Set session to idle
            let _ = sqlx::query("UPDATE sessions SET status = 'idle' WHERE id = ?")
                .bind(&job.session_id)
                .execute(pool)
                .await;

            tracing::info!(job_id = %job.id, "Background job completed");
            tracing::info!(job_id = %job.id, session = %job.session_id, turn = job.turn_number, job_type = %job.job_type, "Job completed successfully");
            Ok(true)
        }
        Err(e) => {
            let now = chrono::Utc::now().to_rfc3339();
            sqlx::query("UPDATE turn_jobs SET status = 'pending', attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?")
                .bind(e.to_string())
                .bind(&now)
                .bind(&job.id)
                .execute(pool)
                .await?;

            // If max retries exhausted, mark as failed
            if job.attempts + 1 >= 3 {
                sqlx::query("UPDATE turn_jobs SET status = 'failed' WHERE id = ?")
                    .bind(&job.id)
                    .execute(pool)
                    .await?;

                let _ =
                    sqlx::query("UPDATE sessions SET status = 'failed_compression' WHERE id = ?")
                        .bind(&job.session_id)
                        .execute(pool)
                        .await;

                tracing::error!(job_id = %job.id, session = %job.session_id, error = %e, "Job failed permanently after max retries");
            } else {
                tracing::warn!(job_id = %job.id, session = %job.session_id, error = %e, attempts = job.attempts + 1, "Job failed, will retry");
                // Set back to pending for retry
                let _ = sqlx::query("UPDATE sessions SET status = 'compressing' WHERE id = ?")
                    .bind(&job.session_id)
                    .execute(pool)
                    .await;
            }

            Ok(true) // We processed (even if failed), so caller can check for more
        }
    }
}

async fn run_compression_job(pool: &SqlitePool, job: &JobRow) -> Result<(), AppError> {
    let payload: CompressionPayload = serde_json::from_str(&job.payload).unwrap_or_default();

    let fallback_model = crate::runtime::executor::load_provider_model(pool).await?;
    let model_ref = if payload.model.is_empty() {
        fallback_model.as_str()
    } else {
        payload.model.as_str()
    };

    tracing::info!(session = %job.session_id, turn = job.turn_number, model_ref = model_ref, "Starting compression job");
    let target = executor::resolve_model_target(pool, &fallback_model, model_ref).await?;

    // Build a minimal context from DB for compression
    let context =
        crate::runtime::context::build_context(pool, &job.session_id, job.turn_number, 10).await?;

    let result = compression::generate_compression(
        &target.provider,
        &target.model,
        &payload.user_input,
        &payload.narrative,
        &context,
        None,
    )
    .await?;

    compression::persist_compression(pool, &job.session_id, job.turn_number, &result).await?;
    turn_finalizer::persist_turn_knowledge(
        pool,
        &target.provider,
        &target.model,
        &job.session_id,
        job.turn_number,
        &payload.user_input,
        &payload.narrative,
    )
    .await;

    Ok(())
}

async fn run_recompression_job(pool: &SqlitePool, job: &JobRow) -> Result<(), AppError> {
    tracing::info!(session = %job.session_id, turn = job.turn_number, "Starting recompression job");

    // Clean up existing compression data for this turn
    cleanup_turn_memory(pool, &job.session_id, job.turn_number).await?;

    // Then run compression fresh
    run_compression_job(pool, job).await
}

/// Delete existing memory/compression data for a specific turn (used before recompression).
async fn cleanup_turn_memory(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM memory_events WHERE session_id = ? AND turn_number = ?")
        .bind(session_id)
        .bind(turn_number)
        .execute(pool)
        .await?;

    sqlx::query("DELETE FROM structured_events WHERE session_id = ? AND turn_number = ?")
        .bind(session_id)
        .bind(turn_number)
        .execute(pool)
        .await?;

    sqlx::query("DELETE FROM agent_knowledge_events WHERE session_id = ? AND turn_number = ?")
        .bind(session_id)
        .bind(turn_number)
        .execute(pool)
        .await?;

    sqlx::query("DELETE FROM turn_summaries WHERE session_id = ? AND turn_number = ? AND summary_type = 'scene'")
        .bind(session_id)
        .bind(turn_number)
        .execute(pool)
        .await?;

    tracing::info!(
        session = session_id,
        turn = turn_number,
        "Cleaned up memory data for recompression"
    );
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
struct JobRow {
    id: String,
    session_id: String,
    turn_number: i32,
    job_type: String,
    status: String,
    payload: String,
    error: Option<String>,
    attempts: i32,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Default)]
pub struct CompressionPayload {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub user_input: String,
    #[serde(default)]
    pub narrative: String,
}
