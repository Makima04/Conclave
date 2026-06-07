use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;
use crate::runtime::sub_agent;
use crate::runtime::types::{AgentType, SubAgent};

#[derive(Serialize)]
struct AgentResponse {
    id: String,
    session_id: String,
    agent_type: String,
    character_id: Option<String>,
    label: String,
    status: String,
    last_active_turn: i32,
    context: String,
    context_preview: String,
    config: serde_json::Value,
    fixed: bool,
}

fn to_response(agent: &SubAgent) -> AgentResponse {
    let preview = if agent.context.chars().count() > 100 {
        let truncated: String = agent.context.chars().take(100).collect();
        format!("{}...", truncated)
    } else {
        agent.context.clone()
    };
    AgentResponse {
        id: agent.id.clone(),
        session_id: agent.session_id.clone(),
        agent_type: agent.agent_type.to_string(),
        character_id: agent.character_id.clone(),
        label: agent.label.clone(),
        status: agent.status.clone(),
        last_active_turn: agent.last_active_turn,
        context: agent.context.clone(),
        context_preview: preview,
        config: agent.config.clone(),
        fixed: agent.agent_type == AgentType::User,
    }
}

pub async fn list_agents(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::debug!(session = %session_id, "Listing agents");
    let agents = sub_agent::get_all_agents(&state.pool, &session_id).await?;
    let items: Vec<AgentResponse> = agents.iter().map(to_response).collect();
    tracing::debug!(session = %session_id, count = items.len(), "Agents listed");
    Ok(Json(serde_json::json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct CreateAgentBody {
    pub agent_type: String,
    pub label: Option<String>,
    pub character_id: Option<String>,
    pub context: Option<String>,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
}

pub async fn create_agent_manual(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<CreateAgentBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    if body.agent_type == AgentType::User.as_str() {
        return Err(AppError::BadRequest(
            "User Agent is fixed and cannot be created manually".to_string(),
        ));
    }

    let agent_type: AgentType = body
        .agent_type
        .parse()
        .map_err(|_| AppError::BadRequest(format!("Invalid agent type: {}", body.agent_type)))?;

    tracing::info!(
        session = %session_id,
        agent_type = %agent_type,
        label = ?body.label,
        "Manual agent creation requested"
    );
    let action = crate::runtime::types::LifecycleAction {
        action: "create".to_string(),
        agent_type,
        character_id: body.character_id,
        label: body.label.unwrap_or_default(),
        reason: "manual".to_string(),
        context: body.context,
    };

    let agent = sub_agent::create_agent(&state.pool, &session_id, &action, 0).await?;

    // Override system_prompt if provided
    if let Some(prompt) = body.system_prompt {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE sub_agents SET system_prompt = ?, updated_at = ? WHERE id = ?")
            .bind(&prompt)
            .bind(&now)
            .bind(&agent.id)
            .execute(&state.pool)
            .await?;
    }

    // Set per-agent model override if provided
    if let Some(ref model) = body.model {
        if !model.is_empty() {
            let mut config = agent.config.clone();
            config["model"] = serde_json::json!(model);
            let now = chrono::Utc::now().to_rfc3339();
            sqlx::query("UPDATE sub_agents SET config = ?, updated_at = ? WHERE id = ?")
                .bind(config.to_string())
                .bind(&now)
                .bind(&agent.id)
                .execute(&state.pool)
                .await?;
        }
    }

    Ok(Json(serde_json::json!({
        "id": agent.id,
        "agent_type": agent.agent_type.to_string(),
        "label": agent.label,
        "status": agent.status,
    })))
}

pub async fn cooldown_agent_manual(
    State(state): State<Arc<AppState>>,
    Path((session_id, agent_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, agent_id = %agent_id, "Manual cooldown requested");
    ensure_mutable_lifecycle_agent(&state.pool, &session_id, &agent_id).await?;
    sub_agent::cooldown_agent(&state.pool, &agent_id, "manual", 0).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn restore_agent_manual(
    State(state): State<Arc<AppState>>,
    Path((session_id, agent_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, agent_id = %agent_id, "Manual restore requested");
    ensure_session_agent(&state.pool, &session_id, &agent_id).await?;
    sub_agent::restore_agent(&state.pool, &agent_id, 0).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn delete_agent_manual(
    State(state): State<Arc<AppState>>,
    Path((session_id, agent_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, agent_id = %agent_id, "Manual delete requested");
    ensure_mutable_lifecycle_agent(&state.pool, &session_id, &agent_id).await?;
    sub_agent::delete_agent(&state.pool, &agent_id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UpdateAgentBody {
    pub label: Option<String>,
    pub system_prompt: Option<String>,
    pub context: Option<String>,
    pub config: Option<serde_json::Value>,
}

pub async fn update_agent(
    State(state): State<Arc<AppState>>,
    Path((session_id, agent_id)): Path<(String, String)>,
    Json(body): Json<UpdateAgentBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, agent_id = %agent_id, "Agent update requested");
    ensure_session_agent(&state.pool, &session_id, &agent_id).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut updates = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(label) = body.label {
        updates.push("label = ?");
        params.push(label);
    }
    if let Some(prompt) = body.system_prompt {
        updates.push("system_prompt = ?");
        params.push(prompt);
    }
    if let Some(ctx) = body.context {
        updates.push("context = ?");
        params.push(ctx);
    }
    if let Some(config) = body.config {
        let config_str = serde_json::to_string(&config).unwrap_or_else(|_| "{}".to_string());
        updates.push("config = ?");
        params.push(config_str);
    }

    if updates.is_empty() {
        return Err(AppError::BadRequest("No fields to update".to_string()));
    }

    updates.push("updated_at = ?");
    params.push(now);

    let sql = format!("UPDATE sub_agents SET {} WHERE id = ?", updates.join(", "));

    let mut query = sqlx::query(&sql);
    for param in &params {
        query = query.bind(param);
    }
    query = query.bind(&agent_id);
    query.execute(&state.pool).await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn ensure_session_agent(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    agent_id: &str,
) -> Result<String, AppError> {
    sqlx::query_scalar::<_, String>(
        "SELECT agent_type FROM sub_agents WHERE id = ? AND session_id = ?",
    )
    .bind(agent_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Agent not found".to_string()))
}

async fn ensure_mutable_lifecycle_agent(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    agent_id: &str,
) -> Result<(), AppError> {
    let agent_type = ensure_session_agent(pool, session_id, agent_id).await?;
    if agent_type == AgentType::User.as_str() {
        return Err(AppError::BadRequest(
            "User Agent is fixed and cannot be deleted or cooled down".to_string(),
        ));
    }
    Ok(())
}
