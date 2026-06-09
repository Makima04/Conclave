use crate::error::AppError;
use crate::runtime::types::{AgentDebugSnapshot, AgentTrace, CompressionResult};
use crate::runtime::variable_update;
use crate::runtime::{compression, knowledge};
use sqlx::Sqlite;
use sqlx::SqlitePool;
use sqlx::Transaction;

/// Data produced by a turn — no persistence.
/// Different paths (multi-agent, single-agent, streaming) build this differently,
/// but all paths finalize through the same transaction.
#[derive(Debug, Clone)]
pub struct TurnCommit {
    pub narrative: String,
    pub traces: Vec<AgentTrace>,
    pub debug_snapshots: Vec<AgentDebugSnapshot>,
    pub compression: Option<CompressionResult>,
    pub compression_job: Option<CompressionJob>,
}

/// Inputs needed to run post-turn compression after the user-visible narrative is ready.
#[derive(Debug, Clone)]
pub struct CompressionJob {
    pub model: String,
}

/// Core transaction: user msg + assistant msg + traces + current_turn.
/// All four writes succeed or none do.
pub async fn finalize_turn(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    turn_number: i32,
    user_input: &str,
    narrative: &str,
    traces: &[AgentTrace],
) -> Result<(), AppError> {
    finalize_turn_with_options(
        tx,
        session_id,
        turn_number,
        user_input,
        narrative,
        traces,
        &[],
        true,
        &serde_json::json!({}),
    )
    .await
}

pub async fn finalize_turn_with_options(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    turn_number: i32,
    user_input: &str,
    narrative: &str,
    traces: &[AgentTrace],
    debug_snapshots: &[AgentDebugSnapshot],
    persist_inline_variable_updates: bool,
    message_metadata: &serde_json::Value,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let message_metadata_json =
        serde_json::to_string(message_metadata).unwrap_or_else(|_| "{}".to_string());
    let variable_extraction = variable_update::extract(narrative);
    let assistant_content = if variable_extraction.display_text.is_empty() {
        narrative
    } else {
        variable_extraction.display_text.as_str()
    };

    // 1. User message (dedup-safe)
    let existing_user: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE session_id = ? AND turn_number = ? AND role = 'user'",
    )
    .bind(session_id)
    .bind(turn_number)
    .fetch_one(&mut **tx)
    .await
    .unwrap_or(0);

    if existing_user == 0 {
        let user_msg_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, session_id, turn_number, role, content, metadata, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)"
        )
        .bind(&user_msg_id)
        .bind(session_id)
        .bind(turn_number)
        .bind(user_input)
        .bind(&message_metadata_json)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
    }

    // 2. Assistant message (dedup-safe)
    let existing_assistant: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE session_id = ? AND turn_number = ? AND role = 'assistant'"
    )
    .bind(session_id)
    .bind(turn_number)
    .fetch_one(&mut **tx)
    .await
    .unwrap_or(0);

    if existing_assistant == 0 {
        let assistant_msg_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, session_id, turn_number, role, content, metadata, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)"
        )
        .bind(&assistant_msg_id)
        .bind(session_id)
        .bind(turn_number)
        .bind(assistant_content)
        .bind(&message_metadata_json)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
    }

    // 3. Traces
    for trace in traces {
        let trace_id = uuid::Uuid::new_v4().to_string();
        let token_usage = serde_json::json!({
            "prompt_tokens": trace.prompt_tokens,
            "completion_tokens": trace.completion_tokens,
        });
        let model_config = serde_json::json!({"model": trace.model}).to_string();

        sqlx::query(
            r#"INSERT INTO traces (id, session_id, turn_number, node_id, node_type, agent_id,
               input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)"#
        )
        .bind(&trace_id)
        .bind(session_id)
        .bind(turn_number)
        .bind(&trace.agent_id)
        .bind(&trace.agent_type)
        .bind(&trace.agent_id)
        .bind(&trace.input_summary)
        .bind(&trace.output_summary)
        .bind(&model_config)
        .bind(token_usage.to_string())
        .bind(trace.duration_ms)
        .bind(&now)
        .execute(&mut **tx)
            .await?;
    }

    // 4. Debug snapshots
    if !debug_snapshots.is_empty() {
        sqlx::query(
            "DELETE FROM agent_call_debug_snapshots WHERE session_id = ? AND turn_number = ?",
        )
        .bind(session_id)
        .bind(turn_number)
        .execute(&mut **tx)
        .await?;
    }

    for snapshot in debug_snapshots {
        sqlx::query(
            r#"INSERT INTO agent_call_debug_snapshots (
               id, session_id, turn_number, phase, level_index, agent_id, agent_type, agent_label,
               model, task, system_prompt, user_prompt, injected_from_json, injected_outputs_json,
               preset_modules_json, worldbook_entries_json, recent_messages_json, recalled_events_json,
               state_slice_json, raw_output, tool_calls_json, duration_ms, prompt_tokens,
               completion_tokens, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#
        )
        .bind(&snapshot.id)
        .bind(session_id)
        .bind(turn_number)
        .bind(&snapshot.phase)
        .bind(snapshot.level_index)
        .bind(&snapshot.agent_id)
        .bind(&snapshot.agent_type)
        .bind(&snapshot.agent_label)
        .bind(&snapshot.model)
        .bind(&snapshot.task)
        .bind(&snapshot.system_prompt)
        .bind(&snapshot.user_prompt)
        .bind(serde_json::to_string(&snapshot.injected_from).unwrap_or_else(|_| "[]".to_string()))
        .bind(serde_json::to_string(&snapshot.injected_outputs).unwrap_or_else(|_| "[]".to_string()))
        .bind(serde_json::to_string(&snapshot.preset_modules).unwrap_or_else(|_| "[]".to_string()))
        .bind(serde_json::to_string(&snapshot.worldbook_entries).unwrap_or_else(|_| "[]".to_string()))
        .bind(serde_json::to_string(&snapshot.recent_messages).unwrap_or_else(|_| "[]".to_string()))
        .bind(serde_json::to_string(&snapshot.recalled_events).unwrap_or_else(|_| "[]".to_string()))
        .bind(serde_json::to_string(&snapshot.state_slice).unwrap_or_else(|_| "{}".to_string()))
        .bind(&snapshot.raw_output)
        .bind(serde_json::to_string(&snapshot.tool_calls).unwrap_or_else(|_| "[]".to_string()))
        .bind(snapshot.duration_ms)
        .bind(snapshot.prompt_tokens as i32)
        .bind(snapshot.completion_tokens as i32)
        .bind(&snapshot.created_at)
        .execute(&mut **tx)
        .await?;
    }

    // 5. Advance current_turn
    sqlx::query("UPDATE sessions SET current_turn = ?, updated_at = ? WHERE id = ?")
        .bind(turn_number)
        .bind(&now)
        .bind(session_id)
        .execute(&mut **tx)
        .await?;

    if persist_inline_variable_updates {
        variable_update::persist_extraction_tx(tx, session_id, turn_number, &variable_extraction)
            .await?;
    }

    Ok(())
}

/// Post-commit work: compression. Non-fatal — errors are logged, not propagated.
pub async fn persist_turn_extras(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    compression_result: &Option<CompressionResult>,
) {
    // Compression
    if let Some(cr) = compression_result {
        if let Err(e) = compression::persist_compression(pool, session_id, turn_number, cr).await {
            tracing::warn!("Failed to persist compression: {}", e);
        }
    }
}

pub async fn persist_turn_knowledge(
    pool: &SqlitePool,
    provider: &crate::provider::openai::OpenAiProvider,
    model: &str,
    session_id: &str,
    turn_number: i32,
    user_input: &str,
    narrative: &str,
) {
    let context =
        match crate::runtime::context::build_context(pool, session_id, turn_number, 10).await {
            Ok(ctx) => ctx,
            Err(e) => {
                tracing::warn!(
                    session = session_id,
                    turn = turn_number,
                    "Knowledge context build failed: {}",
                    e
                );
                return;
            }
        };

    match knowledge::generate_knowledge_events(provider, model, user_input, narrative, &context)
        .await
    {
        Ok(extraction) => {
            if let Err(e) =
                knowledge::persist_knowledge_events(pool, session_id, turn_number, &extraction)
                    .await
            {
                tracing::warn!(
                    session = session_id,
                    turn = turn_number,
                    "Knowledge persist failed: {}",
                    e
                );
            }
        }
        Err(e) => {
            tracing::warn!(
                session = session_id,
                turn = turn_number,
                "Knowledge extraction failed, storing writer-only fallback: {}",
                e
            );
            if let Err(e) =
                knowledge::persist_fallback_writer_only(pool, session_id, turn_number, narrative)
                    .await
            {
                tracing::warn!(
                    session = session_id,
                    turn = turn_number,
                    "Knowledge fallback persist failed: {}",
                    e
                );
            }
        }
    }
}

/// Persist a compression job to the background worker queue.
pub async fn persist_compression_job(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    job_type: &str,
    model: &str,
    user_input: &str,
    narrative: &str,
) {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let payload = serde_json::json!({
        "model": model,
        "user_input": user_input,
        "narrative": narrative,
    });

    if let Err(e) = sqlx::query(
        "INSERT INTO turn_jobs (id, session_id, turn_number, job_type, status, payload, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(turn_number)
    .bind(job_type)
    .bind(payload.to_string())
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    {
        tracing::warn!("Failed to persist compression job: {}", e);
        return;
    }

    if let Err(e) = sqlx::query("UPDATE sessions SET status = 'compressing' WHERE id = ?")
        .bind(session_id)
        .execute(pool)
        .await
    {
        tracing::warn!("Failed to set session compressing after job insert: {}", e);
    }
}

/// Finalize a regenerate: update assistant message (with variants) + insert trace in one transaction.
pub async fn finalize_regenerate(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    turn_number: i32,
    message_id: &str,
    new_content: &str,
    variants_json: &str,
    trace: &AgentTrace,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    // 1. Update assistant message content + variants
    sqlx::query("UPDATE messages SET content = ?, variants = ? WHERE id = ?")
        .bind(new_content)
        .bind(variants_json)
        .bind(message_id)
        .execute(&mut **tx)
        .await?;

    // 2. Insert trace
    let trace_id = uuid::Uuid::new_v4().to_string();
    let token_usage = serde_json::json!({
        "prompt_tokens": trace.prompt_tokens,
        "completion_tokens": trace.completion_tokens,
    });
    let model_config = serde_json::json!({"model": &trace.model}).to_string();

    sqlx::query(
        r#"INSERT INTO traces (id, session_id, turn_number, node_id, node_type, agent_id,
           input_summary, output_summary, output_type, model_config, token_usage, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)"#
    )
    .bind(&trace_id)
    .bind(session_id)
    .bind(turn_number)
    .bind(&trace.agent_id)
    .bind(&trace.agent_type)
    .bind(&trace.agent_id)
    .bind(&trace.input_summary)
    .bind(&trace.output_summary)
    .bind(&model_config)
    .bind(token_usage.to_string())
    .bind(trace.duration_ms)
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
