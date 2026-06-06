use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;
use crate::runtime::sub_agent;
use crate::runtime::types::SubAgent;

#[derive(Serialize)]
struct AgentResponse {
    id: String,
    session_id: String,
    agent_type: String,
    character_id: Option<String>,
    label: String,
    status: String,
    last_active_turn: i32,
    context_preview: String,
    config: serde_json::Value,
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
        agent_type: agent.agent_type.clone(),
        character_id: agent.character_id.clone(),
        label: agent.label.clone(),
        status: agent.status.clone(),
        last_active_turn: agent.last_active_turn,
        context_preview: preview,
        config: agent.config.clone(),
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
    tracing::info!(
        session = %session_id,
        agent_type = %body.agent_type,
        label = ?body.label,
        "Manual agent creation requested"
    );
    let action = crate::runtime::types::LifecycleAction {
        action: "create".to_string(),
        agent_type: body.agent_type,
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
        "agent_type": agent.agent_type,
        "label": agent.label,
        "status": agent.status,
    })))
}

pub async fn cooldown_agent_manual(
    State(state): State<Arc<AppState>>,
    Path((session_id, agent_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, agent_id = %agent_id, "Manual cooldown requested");
    sub_agent::cooldown_agent(&state.pool, &agent_id, "manual", 0).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn restore_agent_manual(
    State(state): State<Arc<AppState>>,
    Path((session_id, agent_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, agent_id = %agent_id, "Manual restore requested");
    sub_agent::restore_agent(&state.pool, &agent_id, 0).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn delete_agent_manual(
    State(state): State<Arc<AppState>>,
    Path((session_id, agent_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, agent_id = %agent_id, "Manual delete requested");
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
