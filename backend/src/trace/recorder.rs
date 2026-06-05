use crate::error::AppError;
use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TraceRecord {
    pub id: String,
    pub turn_number: i32,
    pub node_id: String,
    pub node_type: String,
    pub agent_id: Option<String>,
    pub input_summary: String,
    pub output_summary: String,
    pub output_type: Option<String>,
    pub model_config: String,
    pub token_usage: String,
    pub duration_ms: Option<i32>,
    pub created_at: String,
}

pub async fn get_turn_traces(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
) -> Result<Vec<TraceRecord>, AppError> {
    let traces = sqlx::query_as::<_, TraceRecord>(
        "SELECT id, turn_number, node_id, node_type, agent_id, input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at FROM traces WHERE session_id = ? AND turn_number = ? ORDER BY created_at"
    )
    .bind(session_id)
    .bind(turn_number)
    .fetch_all(pool)
    .await?;

    Ok(traces)
}

pub async fn get_trace_stats(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<serde_json::Value, AppError> {
    #[derive(sqlx::FromRow)]
    struct StatsRow {
        total_traces: i32,
        max_turn: Option<i32>,
        total_duration_ms: Option<i32>,
    }

    let stats = sqlx::query_as::<_, StatsRow>(
        "SELECT COUNT(*) as total_traces, MAX(turn_number) as max_turn, SUM(duration_ms) as total_duration_ms FROM traces WHERE session_id = ?"
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;

    Ok(serde_json::json!({
        "total_traces": stats.total_traces,
        "max_turn": stats.max_turn,
        "total_duration_ms": stats.total_duration_ms,
    }))
}
