use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;

#[derive(Deserialize)]
pub struct CreateProvider {
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub is_default: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateProvider {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub is_default: Option<bool>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub is_default: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct FetchModelsRequest {
    pub base_url: String,
    pub api_key: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

pub async fn fetch_models(
    Json(body): Json<FetchModelsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let url = format!("{}/models", body.base_url.trim_end_matches('/'));
    let api_key = body.api_key.unwrap_or_default();

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let response = req
        .send()
        .await
        .map_err(|e| AppError::Provider(format!("请求失败: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::Provider(format!("HTTP {} - {}", status, text)));
    }

    let body_text = response
        .text()
        .await
        .map_err(|e| AppError::Provider(format!("读取响应失败: {}", e)))?;

    let models: ModelsResponse = serde_json::from_str(&body_text)
        .map_err(|e| AppError::Provider(format!("解析模型列表失败: {} - 原始响应: {}", e, &body_text[..body_text.len().min(200)])))?;

    let ids: Vec<String> = models.data.into_iter().map(|m| m.id).collect();

    Ok(Json(serde_json::json!({ "models": ids })))
}

pub async fn list_providers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, AppError> {
    let providers = sqlx::query_as::<_, ProviderConfig>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs ORDER BY is_default DESC, created_at DESC"
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "items": providers })))
}

pub async fn get_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ProviderConfig>, AppError> {
    let provider = sqlx::query_as::<_, ProviderConfig>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Provider not found".to_string()))?;

    Ok(Json(provider))
}

pub async fn create_provider(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateProvider>,
) -> Result<Json<ProviderConfig>, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let api_key = body.api_key.unwrap_or_default();
    let is_default = if body.is_default.unwrap_or(false) { 1 } else { 0 };

    // If setting as default, unset other defaults
    if is_default == 1 {
        sqlx::query("UPDATE provider_configs SET is_default = 0")
            .execute(&state.pool)
            .await?;
    }

    sqlx::query(
        "INSERT INTO provider_configs (id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at) VALUES (?, ?, 'openai_compatible', ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&body.name)
    .bind(&body.base_url)
    .bind(&api_key)
    .bind(&body.model)
    .bind(is_default)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await?;

    let provider = sqlx::query_as::<_, ProviderConfig>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(provider))
}

pub async fn update_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateProvider>,
) -> Result<Json<ProviderConfig>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    // Check exists
    let existing = sqlx::query_as::<_, ProviderConfig>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Provider not found".to_string()))?;

    let name = body.name.unwrap_or(existing.name);
    let base_url = body.base_url.unwrap_or(existing.base_url);
    let api_key = body.api_key.unwrap_or(existing.api_key);
    let model = body.model.unwrap_or(existing.model);
    let is_default = body.is_default.map(|d| if d { 1 } else { 0 }).unwrap_or(existing.is_default);

    if is_default == 1 {
        sqlx::query("UPDATE provider_configs SET is_default = 0 WHERE id != ?")
            .bind(&id)
            .execute(&state.pool)
            .await?;
    }

    sqlx::query(
        "UPDATE provider_configs SET name = ?, base_url = ?, api_key = ?, model = ?, is_default = ?, updated_at = ? WHERE id = ?"
    )
    .bind(&name)
    .bind(&base_url)
    .bind(&api_key)
    .bind(&model)
    .bind(is_default)
    .bind(&now)
    .bind(&id)
    .execute(&state.pool)
    .await?;

    let provider = sqlx::query_as::<_, ProviderConfig>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(provider))
}

pub async fn delete_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query("DELETE FROM provider_configs WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Provider not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}
