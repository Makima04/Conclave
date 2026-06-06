use crate::error::AppError;
use crate::provider::types::{ChatMessage, ChatRequest};
use sqlx::SqlitePool;

/// Shared LLM request builder
pub fn build_chat_request(
    model: &str,
    system_prompt: &str,
    user_content: &str,
    temperature: f32,
    max_tokens: i32,
) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                reasoning_content: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_content.to_string(),
                reasoning_content: None,
            },
        ],
        temperature: Some(temperature),
        top_p: None,
        max_tokens: Some(max_tokens as u32),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
    }
}

/// Record a generic trace entry
pub async fn record_trace(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    node_id: &str,
    node_type: &str,
    agent_id: &str,
    input_summary: &str,
    output_summary: &str,
    output_type: &str,
    model: &str,
    token_usage: &serde_json::Value,
    duration_ms: i32,
) -> Result<(), AppError> {
    let trace_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let model_config = serde_json::json!({"model": model});

    tracing::debug!(
        session = session_id,
        turn = turn_number,
        node_id = node_id,
        node_type = node_type,
        agent_id = agent_id,
        duration_ms = duration_ms,
        "Recording trace"
    );

    sqlx::query(
        r#"INSERT INTO traces (id, session_id, turn_number, node_id, node_type, agent_id,
           input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&trace_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(node_id)
    .bind(node_type)
    .bind(agent_id)
    .bind(input_summary)
    .bind(output_summary)
    .bind(output_type)
    .bind(model_config.to_string())
    .bind(token_usage.to_string())
    .bind(duration_ms)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}
