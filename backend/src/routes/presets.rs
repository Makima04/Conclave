use axum::Json;
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;

// ── Request / Response types ──

#[derive(Debug, Deserialize)]
pub struct ImportPresetRequest {
    pub data: serde_json::Value,
    /// Optional session ID to bind the preset to
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PresetSummary {
    pub id: String,
    pub session_id: Option<String>,
    pub name: String,
    pub source_format: String,
    pub module_count: i64,
    pub parse_status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct PresetDetailResponse {
    pub id: String,
    pub session_id: Option<String>,
    pub name: String,
    pub source_format: String,
    pub model_params: serde_json::Value,
    pub parse_status: String,
    pub modules: Vec<PresetModuleResponse>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct PresetModuleResponse {
    pub id: String,
    pub preset_id: String,
    pub identifier: String,
    pub name: String,
    pub role: String,
    pub content: String,
    pub target_agents: Vec<String>,
    pub enabled: bool,
    pub injection_order: i32,
    pub classification: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct ListPresetsQuery {
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePresetRequest {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateModuleRequest {
    pub target_agents: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

// ── Handlers ──

/// POST /api/presets — import a SillyTavern preset JSON
pub async fn import_preset(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportPresetRequest>,
) -> Result<Json<PresetDetailResponse>, AppError> {
    let data = &body.data;

    // Detect format: SillyTavern presets have a "prompts" array at top level
    let prompts = data
        .get("prompts")
        .and_then(|p| p.as_array())
        .ok_or_else(|| {
            AppError::BadRequest("Invalid preset format: missing 'prompts' array".to_string())
        })?;

    // Extract name — try several common fields, fallback to "未命名预设"
    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            data.get("preset_name")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "未命名预设".to_string());

    // Extract model params
    let model_param_keys = [
        "temperature",
        "frequency_penalty",
        "presence_penalty",
        "top_p",
        "top_k",
        "top_a",
        "min_p",
        "repetition_penalty",
        "openai_max_context",
        "openai_max_tokens",
        "max_tokens",
        "reasoning_effort",
    ];
    let mut model_params = serde_json::Map::new();
    for key in &model_param_keys {
        if let Some(val) = data.get(*key) {
            model_params.insert(key.to_string(), val.clone());
        }
    }
    let model_params_json = serde_json::Value::Object(model_params);

    // Build prompt_order lookup: identifier -> enabled
    let prompt_order_map = build_prompt_order_map(data);

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let source_json = serde_json::to_string(data)
        .map_err(|e| AppError::Internal(format!("Failed to serialize preset source: {}", e)))?;
    let model_params_str =
        serde_json::to_string(&model_params_json).unwrap_or_else(|_| "{}".to_string());

    let mut tx = state.pool.begin().await?;

    sqlx::query(
        "INSERT INTO presets (id, session_id, name, source_format, raw_json, model_params, parse_status, created_at, updated_at) VALUES (?, ?, ?, 'sillytavern', ?, ?, 'none', ?, ?)"
    )
    .bind(&id)
    .bind(&body.session_id)
    .bind(&name)
    .bind(&source_json)
    .bind(&model_params_str)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let mut modules = Vec::new();

    for prompt in prompts {
        let identifier = prompt
            .get("identifier")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let module_name = prompt
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("未命名模块")
            .to_string();
        let role = prompt
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("user")
            .to_string();
        let content = prompt
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let injection_order = prompt
            .get("injection_order")
            .and_then(|v| v.as_i64())
            .unwrap_or(100) as i32;

        // Determine enabled from prompt_order map
        let enabled = prompt_order_map.get(&identifier).copied().unwrap_or(true);

        // Skip marker prompts (they have no content and are placeholders)
        let is_marker = prompt
            .get("marker")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_marker && content.is_empty() {
            continue;
        }

        let module_id = uuid::Uuid::new_v4().to_string();

        sqlx::query(
            "INSERT INTO preset_modules (id, preset_id, identifier, name, role, content, target_agents, enabled, injection_order, classification, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, 'pending', '', ?, ?)"
        )
        .bind(&module_id)
        .bind(&id)
        .bind(&identifier)
        .bind(&module_name)
        .bind(&role)
        .bind(&content)
        .bind(if enabled { 1 } else { 0 })
        .bind(injection_order)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        modules.push(PresetModuleResponse {
            id: module_id,
            preset_id: id.clone(),
            identifier,
            name: module_name,
            role,
            content,
            target_agents: vec![],
            enabled,
            injection_order,
            classification: "pending".to_string(),
            reason: String::new(),
        });
    }

    tx.commit().await?;

    tracing::info!(preset_id = %id, name = %name, modules = modules.len(), "Preset imported");

    Ok(Json(PresetDetailResponse {
        id,
        session_id: body.session_id,
        name,
        source_format: "sillytavern".to_string(),
        model_params: model_params_json,
        parse_status: "none".to_string(),
        modules,
        created_at: now.clone(),
        updated_at: now,
    }))
}

/// GET /api/presets — list all presets
pub async fn list_presets(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListPresetsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows = if let Some(ref sid) = query.session_id {
        sqlx::query_as::<_, (String, Option<String>, String, String, String, String, String, String)>(
            "SELECT id, session_id, name, source_format, model_params, parse_status, created_at, updated_at FROM presets WHERE session_id IS NULL OR session_id = ? ORDER BY created_at DESC"
        )
        .bind(sid)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as::<_, (String, Option<String>, String, String, String, String, String, String)>(
            "SELECT id, session_id, name, source_format, model_params, parse_status, created_at, updated_at FROM presets ORDER BY created_at DESC"
        )
        .fetch_all(&state.pool)
        .await?
    };

    let mut items = Vec::new();
    for (
        id,
        session_id,
        name,
        source_format,
        _model_params,
        parse_status,
        created_at,
        updated_at,
    ) in rows
    {
        let module_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM preset_modules WHERE preset_id = ?")
                .bind(&id)
                .fetch_one(&state.pool)
                .await?;

        items.push(PresetSummary {
            id,
            session_id,
            name,
            source_format,
            module_count,
            parse_status,
            created_at,
            updated_at,
        });
    }

    Ok(Json(serde_json::json!({ "items": items })))
}

/// GET /api/presets/{id} — get preset detail with modules
pub async fn get_preset(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<PresetDetailResponse>, AppError> {
    let row = sqlx::query_as::<_, (String, Option<String>, String, String, String, String, String, String)>(
        "SELECT id, session_id, name, source_format, model_params, parse_status, created_at, updated_at FROM presets WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Preset not found".to_string()))?;

    let (
        pid,
        session_id,
        name,
        source_format,
        model_params_str,
        parse_status,
        created_at,
        updated_at,
    ) = row;
    let model_params: serde_json::Value =
        serde_json::from_str(&model_params_str).unwrap_or(serde_json::json!({}));

    let module_rows_raw = sqlx::query(
        "SELECT id, preset_id, identifier, name, role, content, target_agents, enabled, injection_order, classification, reason, created_at FROM preset_modules WHERE preset_id = ? ORDER BY injection_order ASC, created_at ASC"
    )
    .bind(&pid)
    .fetch_all(&state.pool)
    .await?;

    let modules = module_rows_raw
        .into_iter()
        .map(|row| {
            let mid: String = row.get("id");
            let mp_id: String = row.get("preset_id");
            let identifier: String = row.get("identifier");
            let mname: String = row.get("name");
            let role: String = row.get("role");
            let content: String = row.get("content");
            let target_agents_json: String = row.get("target_agents");
            let enabled: i32 = row.get("enabled");
            let injection_order: i32 = row.get("injection_order");
            let classification: String = row.get("classification");
            let reason: String = row.get("reason");
            let target_agents: Vec<String> =
                serde_json::from_str(&target_agents_json).unwrap_or_default();
            PresetModuleResponse {
                id: mid,
                preset_id: mp_id,
                identifier,
                name: mname,
                role,
                content,
                target_agents,
                enabled: enabled != 0,
                injection_order,
                classification,
                reason,
            }
        })
        .collect();

    Ok(Json(PresetDetailResponse {
        id: pid,
        session_id,
        name,
        source_format,
        model_params,
        parse_status,
        modules,
        created_at,
        updated_at,
    }))
}

/// PATCH /api/presets/{id} — update preset name
pub async fn update_preset(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdatePresetRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(ref name) = body.name {
        sqlx::query("UPDATE presets SET name = ?, updated_at = ? WHERE id = ?")
            .bind(name)
            .bind(&now)
            .bind(&id)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(serde_json::json!({ "id": id, "updated_at": now })))
}

/// DELETE /api/presets/{id}
pub async fn delete_preset(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query("DELETE FROM presets WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Preset not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}

/// POST /api/presets/{id}/parse — LLM classification of all modules
pub async fn parse_preset(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Load modules
    let module_rows = sqlx::query_as::<_, (String, String, String, String, String)>(
        "SELECT id, identifier, name, role, content FROM preset_modules WHERE preset_id = ? ORDER BY injection_order ASC, created_at ASC"
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    if module_rows.is_empty() {
        return Err(AppError::BadRequest("No modules to parse".to_string()));
    }

    // Prepare for LLM: (identifier, name, role, content)
    let entries_for_parse: Vec<(String, String, String, String)> = module_rows
        .iter()
        .map(|(_, identifier, name, role, content)| {
            (
                identifier.clone(),
                name.clone(),
                role.clone(),
                content.clone(),
            )
        })
        .collect();

    // Mark as parsing
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE presets SET parse_status = 'parsing', updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&id)
        .execute(&state.pool)
        .await?;

    // Load provider
    let provider = crate::runtime::executor::load_default_provider(&state.pool).await?;
    let model = crate::runtime::executor::load_provider_model(&state.pool).await?;

    // Classify
    match crate::runtime::preset_parser::classify_preset_modules(
        &provider,
        &model,
        &entries_for_parse,
    )
    .await
    {
        Ok(classified) => {
            let now2 = chrono::Utc::now().to_rfc3339();
            let mut tx = state.pool.begin().await?;

            for (i, classification) in classified.iter().enumerate() {
                let module_id = &module_rows[i].0;
                let target_agents_json = serde_json::to_string(&classification.target_agents)
                    .unwrap_or_else(|_| "[]".to_string());

                sqlx::query(
                    "UPDATE preset_modules SET target_agents = ?, classification = 'llm', reason = ?, updated_at = ? WHERE id = ?"
                )
                .bind(&target_agents_json)
                .bind(&classification.reason)
                .bind(&now2)
                .bind(module_id)
                .execute(&mut *tx)
                .await?;
            }

            tx.commit().await?;

            sqlx::query("UPDATE presets SET parse_status = 'done', updated_at = ? WHERE id = ?")
                .bind(&now2)
                .bind(&id)
                .execute(&state.pool)
                .await?;

            tracing::info!(preset_id = %id, modules = classified.len(), "Preset parsed for multi-agent");

            Ok(Json(serde_json::json!({
                "status": "done",
                "modules": classified.len(),
            })))
        }
        Err(e) => {
            let now2 = chrono::Utc::now().to_rfc3339();
            sqlx::query("UPDATE presets SET parse_status = 'error', updated_at = ? WHERE id = ?")
                .bind(&now2)
                .bind(&id)
                .execute(&state.pool)
                .await?;

            tracing::error!(preset_id = %id, error = %e, "Preset parse failed");
            Err(e)
        }
    }
}

/// PUT /api/presets/{id}/modules/{mid} — update a single module
pub async fn update_module(
    State(state): State<Arc<AppState>>,
    Path((preset_id, module_id)): Path<(String, String)>,
    Json(body): Json<UpdateModuleRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    if let Some(ref targets) = body.target_agents {
        let json = serde_json::to_string(targets).unwrap_or_else(|_| "[]".to_string());
        sqlx::query(
            "UPDATE preset_modules SET target_agents = ?, classification = 'manual', updated_at = ? WHERE id = ? AND preset_id = ?"
        )
        .bind(&json)
        .bind(&now)
        .bind(&module_id)
        .bind(&preset_id)
        .execute(&state.pool)
        .await?;
    }

    if let Some(enabled) = body.enabled {
        sqlx::query(
            "UPDATE preset_modules SET enabled = ?, updated_at = ? WHERE id = ? AND preset_id = ?",
        )
        .bind(if enabled { 1 } else { 0 })
        .bind(&now)
        .bind(&module_id)
        .bind(&preset_id)
        .execute(&state.pool)
        .await?;
    }

    Ok(Json(
        serde_json::json!({ "id": module_id, "updated_at": now }),
    ))
}

/// DELETE /api/presets/{id}/modules/{mid}
pub async fn delete_module(
    State(state): State<Arc<AppState>>,
    Path((preset_id, module_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query("DELETE FROM preset_modules WHERE id = ? AND preset_id = ?")
        .bind(&module_id)
        .bind(&preset_id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Module not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}

// ── Helpers ──

/// Build a map from prompt identifier to enabled status from the prompt_order arrays.
fn build_prompt_order_map(data: &serde_json::Value) -> HashMap<String, bool> {
    let mut map = HashMap::new();

    if let Some(order_arrays) = data.get("prompt_order").and_then(|v| v.as_array()) {
        for order_obj in order_arrays {
            if let Some(items) = order_obj.get("order").and_then(|v| v.as_array()) {
                for item in items {
                    let identifier = item
                        .get("identifier")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let enabled = item
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    if !identifier.is_empty() {
                        // If the same identifier appears in multiple order entries,
                        // it's enabled if ANY entry has it enabled
                        map.entry(identifier.to_string())
                            .and_modify(|e: &mut bool| *e = *e || enabled)
                            .or_insert(enabled);
                    }
                }
            }
        }
    }

    map
}
