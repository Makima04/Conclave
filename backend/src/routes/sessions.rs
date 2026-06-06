use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;
use crate::runtime::{initializer, state_initializer, sub_agent, user_settings};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionConfig {
    #[serde(default = "default_max_context_turns")]
    pub max_context_turns: i32,
    #[serde(default = "default_true")]
    pub stream: bool,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_top_p")]
    pub top_p: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: i32,
    #[serde(default)]
    pub frequency_penalty: f32,
    #[serde(default)]
    pub presence_penalty: f32,
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,
    // Multi-agent config
    #[serde(default)]
    pub master_model: String,
    #[serde(default)]
    pub sub_agent_model: String,
    #[serde(default = "default_cooldown_turns")]
    pub cooldown_turns: i32,
    #[serde(default = "default_user_auto_mode")]
    pub user_auto_mode: String,
    #[serde(default = "default_max_active_agents")]
    pub max_active_agents: i32,
    #[serde(default = "default_true")]
    pub parser_enabled: bool,
    #[serde(default)]
    pub compression_model: String,
    #[serde(default = "default_render_mode")]
    pub render_mode: String,
    #[serde(default)]
    pub user_persona: UserPersona,
    #[serde(default = "default_user_setting_merge_strategy")]
    pub user_setting_merge_strategy: String,
    /// Active preset ID for prompt module injection
    #[serde(default)]
    pub active_preset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserPersona {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub style: String,
}

fn default_max_context_turns() -> i32 {
    20
}
fn default_true() -> bool {
    true
}
fn default_temperature() -> f32 {
    0.8
}
fn default_top_p() -> f32 {
    1.0
}
fn default_max_tokens() -> i32 {
    2048
}
fn default_cooldown_turns() -> i32 {
    10
}
fn default_user_auto_mode() -> String {
    "ask".to_string()
}
fn default_max_active_agents() -> i32 {
    8
}
fn default_system_prompt() -> String {
    r#"You are a creative roleplay and writing assistant. You narrate immersive stories, portray characters with depth and consistency, and respond to user actions with vivid detail.

Guidelines:
- Stay in character and maintain narrative consistency
- Describe environments, emotions, and actions with sensory detail
- Advance the story naturally based on user input
- Keep track of established facts, relationships, and ongoing plot threads
- Output only narrative text — no meta-commentary or out-of-character notes"#.to_string()
}

fn default_render_mode() -> String {
    "auto".to_string()
}

fn default_user_setting_merge_strategy() -> String {
    user_settings::USER_OVERRIDES_WORLDBOOK.to_string()
}

#[derive(Deserialize)]
pub struct CreateSession {
    pub title: Option<String>,
    pub mode: Option<String>,
    pub config: Option<SessionConfig>,
    pub world_pack_id: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateSession {
    pub title: Option<String>,
    pub config: Option<SessionConfig>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub config: String,
    pub current_turn: i32,
    pub title_source: String,
    pub status: String,
    pub world_pack_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub id: String,
    pub title: String,
    pub mode: String,
    pub config: SessionConfig,
    pub current_turn: i32,
    pub title_source: String,
    pub status: String,
    pub world_pack_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_response(row: SessionRow) -> SessionResponse {
    let config: SessionConfig =
        normalize_session_config(serde_json::from_str(&row.config).unwrap_or_default());
    SessionResponse {
        id: row.id,
        title: row.title,
        mode: row.mode,
        config,
        current_turn: row.current_turn,
        title_source: row.title_source,
        status: row.status,
        world_pack_id: row.world_pack_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn normalize_session_config(mut config: SessionConfig) -> SessionConfig {
    if !matches!(
        config.render_mode.as_str(),
        "auto" | "schema" | "sandbox" | "text"
    ) {
        config.render_mode = default_render_mode();
    }
    if !matches!(
        config.user_setting_merge_strategy.as_str(),
        user_settings::USER_OVERRIDES_WORLDBOOK | user_settings::WORLDBOOK_OVERRIDES_USER
    ) {
        config.user_setting_merge_strategy = default_user_setting_merge_strategy();
    }
    config
}

async fn sync_user_persona_agent(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    config: &SessionConfig,
) -> Result<(), AppError> {
    let persona = user_settings::UserPersonaSettings {
        name: config.user_persona.name.clone(),
        avatar: config.user_persona.avatar.clone(),
        address: config.user_persona.address.clone(),
        background: config.user_persona.background.clone(),
        style: config.user_persona.style.clone(),
    };
    let (label, persona_context) = user_settings::persona_context(&persona);
    let world_pack_id: Option<String> = sqlx::query_scalar(
        "SELECT world_pack_id FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    let worldbook_context =
        user_settings::load_worldbook_user_context(pool, world_pack_id.as_deref()).await?;
    let context = user_settings::merge_context(
        &persona_context,
        &worldbook_context,
        &config.user_setting_merge_strategy,
    );
    sub_agent::sync_user_agent_from_persona(pool, session_id, &label, &context).await
}

pub async fn create_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateSession>,
) -> Result<Json<SessionResponse>, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let title = body.title.unwrap_or_default();
    let mode = body.mode.unwrap_or_else(|| "single_agent".to_string());
    let config = normalize_session_config(
        body.config
            .unwrap_or_else(|| serde_json::from_str("{}").unwrap_or_default()),
    );
    let config_json = serde_json::to_string(&config).unwrap_or_else(|_| "{}".to_string());

    sqlx::query(
        "INSERT INTO sessions (id, title, mode, config, world_pack_id, current_turn, title_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'auto', ?, ?)"
    )
    .bind(&id)
    .bind(&title)
    .bind(&mode)
    .bind(&config_json)
    .bind(&body.world_pack_id)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await?;

    let state_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at) VALUES (?, ?, 1, '{}', 'low', 'runtime', ?)"
    )
    .bind(&state_id)
    .bind(&id)
    .bind(&now)
    .execute(&state.pool)
    .await?;

    if body.world_pack_id.is_some() {
        if let Err(e) =
            state_initializer::initialize_session_state_from_world_book(&state.pool, &id).await
        {
            tracing::warn!(session = %id, "Failed to initialize session state from world book: {}", e);
        }
    }

    // Initialize default agents for multi_agent sessions
    if mode == "multi_agent" {
        if let Err(e) = initializer::initialize_multi_agent_session(&state.pool, &id).await {
            tracing::warn!(session = %id, "Failed to initialize multi-agent session: {}", e);
        }
        if let Err(e) = sync_user_persona_agent(&state.pool, &id, &config).await {
            tracing::warn!(session = %id, "Failed to sync user persona agent: {}", e);
        }
    }

    Ok(Json(SessionResponse {
        id,
        title,
        mode,
        config,
        current_turn: 0,
        title_source: "auto".to_string(),
        status: "idle".to_string(),
        world_pack_id: body.world_pack_id,
        created_at: now.clone(),
        updated_at: now,
    }))
}

#[derive(Deserialize)]
pub struct ListParams {
    pub cursor: Option<String>,
    pub limit: Option<i32>,
}

pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<serde_json::Value>, AppError> {
    let limit = params.limit.unwrap_or(20).min(100);

    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT id, title, mode, config, current_turn, title_source, status, world_pack_id, created_at, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?"
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let items: Vec<SessionResponse> = rows.into_iter().map(row_to_response).collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

pub async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SessionResponse>, AppError> {
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT id, title, mode, config, current_turn, title_source, status, world_pack_id, created_at, updated_at FROM sessions WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    Ok(Json(row_to_response(row)))
}

pub async fn update_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateSession>,
) -> Result<Json<SessionResponse>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT id, title, mode, config, current_turn, title_source, status, world_pack_id, created_at, updated_at FROM sessions WHERE id = ? AND deleted_at IS NULL"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    // If user provides a title, mark as manual
    let is_rename = body.title.is_some();
    let title = body.title.unwrap_or(row.title.clone());
    let title_source = if is_rename {
        "manual".to_string()
    } else {
        row.title_source.clone()
    };
    let config = normalize_session_config(
        body.config
            .unwrap_or_else(|| serde_json::from_str(&row.config).unwrap_or_default()),
    );
    let config_json = serde_json::to_string(&config).unwrap_or_else(|_| "{}".to_string());

    sqlx::query(
        "UPDATE sessions SET title = ?, config = ?, title_source = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&title)
    .bind(&config_json)
    .bind(&title_source)
    .bind(&now)
    .bind(&id)
    .execute(&state.pool)
    .await?;

    if row.mode == "multi_agent" {
        sync_user_persona_agent(&state.pool, &id, &config).await?;
    }

    Ok(Json(SessionResponse {
        id: row.id,
        title,
        mode: row.mode,
        config,
        current_turn: row.current_turn,
        title_source,
        status: row.status,
        world_pack_id: row.world_pack_id,
        created_at: row.created_at,
        updated_at: now,
    }))
}

pub async fn delete_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    let result =
        sqlx::query("UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
            .bind(&now)
            .bind(&id)
            .execute(&state.pool)
            .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}
