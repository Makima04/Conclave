use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sqlx::QueryBuilder;
use std::collections::HashMap;
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
    #[serde(default)]
    pub variable_tool_model: String,
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
    #[serde(default, deserialize_with = "deserialize_optional_world_pack_id")]
    pub world_pack_id: Option<Option<String>>,
}

fn deserialize_optional_world_pack_id<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
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

#[derive(Serialize)]
pub struct SharedSaveResponse {
    #[serde(rename = "saveId")]
    pub save_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub meta: Value,
    pub payload: Value,
}

#[derive(Deserialize)]
pub struct SharedSavesParams {
    pub world_pack_id: String,
    pub limit: Option<i32>,
}

#[derive(sqlx::FromRow)]
struct SharedSaveMessageRow {
    session_id: String,
    role: String,
    content: String,
}

#[derive(sqlx::FromRow)]
struct SharedSaveStateRow {
    session_id: String,
    state_json: String,
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

fn clean_card_display_text(content: &str) -> String {
    let mut output = content.to_string();
    for pattern in [
        "<StatusPlaceHolderImpl/>",
        "</正文>",
        "<正文>",
        "{{char}}",
        "</user>",
        "<char>",
        "</char>",
    ] {
        output = output.replace(pattern, "");
    }
    output = output.replace("{{user}}", "你");
    output = output.replace("<user>", "你");
    for marker in ["<context", "<options", "<tucao", "<UpdateVariable", "<UpdateVariablevariable"] {
        output = strip_tag_block(&output, marker);
    }
    output = strip_initvar_tags(&output);
    collapse_blank_lines(output.trim())
}

fn strip_tag_block(source: &str, open_tag_prefix: &str) -> String {
    let lower = source.to_ascii_lowercase();
    let open = open_tag_prefix.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut output = String::new();
    loop {
        let Some(rel_start) = lower[cursor..].find(&open) else {
            output.push_str(&source[cursor..]);
            break;
        };
        let start = cursor + rel_start;
        output.push_str(&source[cursor..start]);
        let after_open = match source[start..].find('>') {
            Some(idx) => start + idx + 1,
            None => break,
        };
        let tag_name = open_tag_prefix
            .trim_start_matches('<')
            .trim_start_matches('/')
            .trim_end_matches('>')
            .trim_end_matches(|c: char| c.is_ascii_alphabetic() == false && c != '_');
        let close = format!("</{}>", tag_name.to_ascii_lowercase());
        if let Some(rel_end) = lower[after_open..].find(&close) {
            cursor = after_open + rel_end + close.len();
        } else {
            break;
        }
    }
    output
}

fn strip_initvar_tags(source: &str) -> String {
    source
        .replace("<initvar>", "")
        .replace("</initvar>", "")
        .replace("<InitVar>", "")
        .replace("</InitVar>", "")
}

fn collapse_blank_lines(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut blank_run = 0usize;
    for line in source.lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
            output.push('\n');
            continue;
        }
        blank_run = 0;
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(line.trim_end());
    }
    output.trim().to_string()
}

fn extract_assistant_save_text(content: &str) -> String {
    let visible_source = extract_tag_body(content, "content")
        .or_else(|| extract_tag_body(content, "正文"))
        .unwrap_or_else(|| content.to_string());
    clean_card_display_text(&visible_source)
}

fn extract_tag_body(source: &str, tag: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let open = format!("<{}", tag.to_ascii_lowercase());
    let close = format!("</{}>", tag.to_ascii_lowercase());
    let start = lower.find(&open)?;
    let body_start = source[start..].find('>')? + start + 1;
    let end = lower[body_start..].find(&close)? + body_start;
    Some(source[body_start..end].to_string())
}

fn short_text(value: &str, max: usize) -> String {
    let text = value.trim();
    let mut iter = text.chars();
    let shortened: String = iter.by_ref().take(max).collect();
    if iter.next().is_some() {
        format!("{}...", shortened)
    } else {
        shortened
    }
}

fn extract_save_preview(messages: &[SharedSaveMessageRow], fallback: &str) -> String {
    let candidate = messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant")
        .or_else(|| messages.first());
    let text = clean_card_display_text(candidate.map(|m| m.content.as_str()).unwrap_or(fallback))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    short_text(&text, 180)
}

fn build_shared_save(
    session: &SessionResponse,
    messages: &[SharedSaveMessageRow],
    state: &Value,
    character_name: Option<&str>,
) -> SharedSaveResponse {
    let persona = &session.config.user_persona;
    let persona_name = if persona.name.trim().is_empty() {
        "未命名主角".to_string()
    } else {
        persona.name.clone()
    };
    let chat_log: Vec<Value> = messages
        .iter()
        .filter(|message| message.role == "user" || message.role == "assistant")
        .map(|message| {
            if message.role == "assistant" {
                json!({
                    "role": message.role,
                    "speaker": "Assistant",
                    "text": extract_assistant_save_text(&message.content),
                    "rawText": message.content,
                })
            } else {
                json!({
                    "role": message.role,
                    "speaker": persona_name,
                    "text": message.content,
                })
            }
        })
        .collect();
    let projection_variables = state
        .get("variables")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}));
    let save_id = format!("xrp-session-{}", session.id);
    let run_id = session.id.clone();
    let message_count = chat_log.len();
    let character_name = character_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&session.title)
        .to_string();
    let meta = json!({
        "saveId": save_id,
        "runId": run_id,
        "sessionId": session.id,
        "kind": "autosave",
        "label": session.title,
        "createdAt": session.created_at,
        "updatedAt": session.updated_at,
        "messageIndex": message_count.saturating_sub(1),
        "messageCount": message_count,
        "playerProfile": { "name": persona_name },
        "characterName": character_name,
        "location": "",
        "gameTime": "",
        "preview": extract_save_preview(messages, &session.title),
        "version": 1,
    });
    let payload = json!({
        "saveId": save_id,
        "runId": run_id,
        "sessionId": session.id,
        "meta": meta.clone(),
        "gameState": {
            "runId": run_id,
            "statusData": projection_variables,
            "currentMessageIndex": message_count.saturating_sub(1),
            "runtimeFlags": {
                "saveKind": "autosave",
                "playerProfile": {
                    "name": persona_name,
                    "familyName": "",
                    "givenName": persona_name,
                    "gender": "男",
                    "personality": persona.background,
                    "appearance": persona.style,
                    "className": if persona.address.trim().is_empty() { "2年B班" } else { &persona.address },
                    "stats": {
                        "knowledge": 60,
                        "charm": 60,
                        "proficiency": 60,
                        "kindness": 60,
                        "courage": 60,
                    },
                    "difficulty": "normal",
                },
                "phoneMessages": Value::Null,
            }
        },
        "chatLog": chat_log,
        "summaryStore": {},
        "version": 2,
    });

    SharedSaveResponse {
        save_id,
        session_id: session.id.clone(),
        run_id,
        meta,
        payload,
    }
}

async fn load_shared_save_messages(
    pool: &sqlx::SqlitePool,
    session_ids: &[String],
) -> Result<Vec<SharedSaveMessageRow>, AppError> {
    if session_ids.is_empty() {
        return Ok(vec![]);
    }
    let mut qb = QueryBuilder::new(
        "SELECT session_id, role, content, created_at FROM messages WHERE session_id IN (",
    );
    {
        let mut separated = qb.separated(", ");
        for session_id in session_ids {
            separated.push_bind(session_id);
        }
    }
    qb.push(") ORDER BY turn_number ASC, created_at ASC");
    Ok(qb.build_query_as().fetch_all(pool).await?)
}

async fn load_latest_states(
    pool: &sqlx::SqlitePool,
    session_ids: &[String],
) -> Result<HashMap<String, Value>, AppError> {
    if session_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut qb = QueryBuilder::new(
        "SELECT session_id, state_json FROM state_snapshots WHERE session_id IN (",
    );
    {
        let mut separated = qb.separated(", ");
        for session_id in session_ids {
            separated.push_bind(session_id);
        }
    }
    qb.push(") ORDER BY session_id ASC, version DESC");
    let rows: Vec<SharedSaveStateRow> = qb.build_query_as().fetch_all(pool).await?;
    let mut states = HashMap::new();
    for row in rows {
        states.entry(row.session_id).or_insert_with(|| {
            serde_json::from_str(&row.state_json).unwrap_or_else(|_| json!({}))
        });
    }
    Ok(states)
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
    pub limit: Option<i32>,
    pub world_pack_id: Option<String>,
}

pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<serde_json::Value>, AppError> {
    let limit = params.limit.unwrap_or(20).min(100);

    let rows = if let Some(world_pack_id) = params.world_pack_id {
        sqlx::query_as::<_, SessionRow>(
            "SELECT id, title, mode, config, current_turn, title_source, status, world_pack_id, created_at, updated_at FROM sessions WHERE deleted_at IS NULL AND world_pack_id = ? ORDER BY updated_at DESC LIMIT ?"
        )
        .bind(world_pack_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as::<_, SessionRow>(
            "SELECT id, title, mode, config, current_turn, title_source, status, world_pack_id, created_at, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?"
        )
        .bind(limit)
        .fetch_all(&state.pool)
        .await?
    };

    let items: Vec<SessionResponse> = rows.into_iter().map(row_to_response).collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

pub async fn list_shared_saves(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SharedSavesParams>,
) -> Result<Json<serde_json::Value>, AppError> {
    let limit = params.limit.unwrap_or(50).clamp(1, 100);
    let session_rows = sqlx::query_as::<_, SessionRow>(
        "SELECT id, title, mode, config, current_turn, title_source, status, world_pack_id, created_at, updated_at
         FROM sessions
         WHERE deleted_at IS NULL AND world_pack_id = ?
         ORDER BY updated_at DESC
         LIMIT ?"
    )
    .bind(&params.world_pack_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let sessions: Vec<SessionResponse> = session_rows.into_iter().map(row_to_response).collect();
    let session_ids: Vec<String> = sessions.iter().map(|session| session.id.clone()).collect();
    let message_rows = load_shared_save_messages(&state.pool, &session_ids).await?;
    let state_rows = load_latest_states(&state.pool, &session_ids).await?;

    let mut messages_by_session: HashMap<String, Vec<SharedSaveMessageRow>> = HashMap::new();
    for row in message_rows {
        messages_by_session
            .entry(row.session_id.clone())
            .or_default()
            .push(row);
    }

    let character_name: Option<String> = sqlx::query_scalar(
        "SELECT name FROM character_cards WHERE world_book_id = ? ORDER BY created_at ASC LIMIT 1"
    )
    .bind(&params.world_pack_id)
    .fetch_optional(&state.pool)
    .await?;

    let items: Vec<SharedSaveResponse> = sessions
        .iter()
        .map(|session| {
            let session_messages = messages_by_session
                .get(&session.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let state = state_rows
                .get(&session.id)
                .cloned()
                .unwrap_or_else(|| json!({}));
            build_shared_save(session, session_messages, &state, character_name.as_deref())
        })
        .collect();

    Ok(Json(json!({ "items": items })))
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
    let world_pack_id_changed = body.world_pack_id.is_some();
    let world_pack_id = body.world_pack_id.unwrap_or(row.world_pack_id.clone());

    if let Some(ref world_pack_id) = world_pack_id {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM world_books WHERE id = ?")
            .bind(world_pack_id)
            .fetch_optional(&state.pool)
            .await?;
        if exists.is_none() {
            return Err(AppError::NotFound("World book not found".to_string()));
        }
    }

    sqlx::query(
        "UPDATE sessions SET title = ?, config = ?, title_source = ?, world_pack_id = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&title)
    .bind(&config_json)
    .bind(&title_source)
    .bind(&world_pack_id)
    .bind(&now)
    .bind(&id)
    .execute(&state.pool)
    .await?;

    if world_pack_id_changed {
        if let Err(e) =
            state_initializer::initialize_session_state_from_world_book(&state.pool, &id).await
        {
            tracing::warn!(session = %id, "Failed to initialize session state after world book change: {}", e);
        }
    }

    if row.mode == "multi_agent" || world_pack_id_changed {
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
        world_pack_id,
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
