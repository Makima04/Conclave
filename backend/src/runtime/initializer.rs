use crate::error::AppError;
use sqlx::SqlitePool;

/// Initialize default permanent agents for a new multi_agent session
pub async fn initialize_multi_agent_session(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    // master/parser/state: leave system_prompt empty so runtime code defaults
    // (with full JSON format, rules, etc.) are used. Users can customize via UI later.
    let defaults = vec![
        ("master", "总控", ""),
        ("parser", "解析器", ""),
        (
            "writer",
            "写手",
            "你是写手Agent。根据所有角色的互动和导演的安排，创作最终的叙事文本。\n\n保持文风一致，描写生动，输出纯叙事文本。",
        ),
        (
            "director",
            "导演",
            "你是导演Agent。分析当前场景中各角色的输出，安排叙事节奏、场景切换和重点突出。",
        ),
        ("state", "状态管理", ""),
    ];

    for (agent_type, label, system_prompt) in defaults {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO sub_agents (id, session_id, agent_type, label, system_prompt, context, status, last_active_turn, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, '{}', ?, ?)"
        )
        .bind(&id)
        .bind(session_id)
        .bind(agent_type)
        .bind(label)
        .bind(system_prompt)
        .bind("")
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    tracing::info!(
        session = session_id,
        "Initialized 5 default agents for multi_agent session"
    );

    Ok(())
}
