use axum::Json;
use axum::extract::{Path, State};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

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

#[derive(sqlx::FromRow)]
struct ProviderConfigRow {
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

#[derive(Serialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key_set: bool,
    pub model: String,
    pub is_default: i32,
    pub created_at: String,
    pub updated_at: String,
}

impl From<ProviderConfigRow> for ProviderConfig {
    fn from(value: ProviderConfigRow) -> Self {
        Self {
            id: value.id,
            name: value.name,
            provider_type: value.provider_type,
            base_url: value.base_url,
            api_key_set: !value.api_key.is_empty(),
            model: value.model,
            is_default: value.is_default,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Deserialize)]
pub struct FetchModelsRequest {
    pub provider_id: Option<String>,
    pub base_url: Option<String>,
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
    State(state): State<Arc<AppState>>,
    Json(body): Json<FetchModelsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (base_url, api_key) = if let Some(provider_id) = body.provider_id {
        let provider = sqlx::query_as::<_, ProviderConfigRow>(
            "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
        )
        .bind(&provider_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Provider not found".to_string()))?;
        (provider.base_url, provider.api_key)
    } else {
        (
            body.base_url.ok_or_else(|| {
                AppError::BadRequest("base_url or provider_id is required".to_string())
            })?,
            body.api_key.unwrap_or_default(),
        )
    };
    let url = model_list_url(&base_url).await?;
    let url_for_log = url.to_string();

    tracing::info!(url = %url_for_log, "Fetching available models");

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Provider(format!("创建 HTTP 客户端失败: {}", e)))?;
    let mut req = client.get(url);
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

    let models: ModelsResponse = serde_json::from_str(&body_text).map_err(|e| {
        let preview: String = body_text.chars().take(200).collect();
        AppError::Provider(format!("解析模型列表失败: {} - 原始响应: {}", e, preview))
    })?;

    let ids: Vec<String> = models.data.into_iter().map(|m| m.id).collect();

    tracing::info!(url = %url_for_log, model_count = ids.len(), "Models fetched successfully");

    Ok(Json(serde_json::json!({ "models": ids })))
}

async fn model_list_url(base_url: &str) -> Result<Url, AppError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let url = Url::parse(&format!("{}/models", trimmed))
        .map_err(|_| AppError::BadRequest("Base URL 必须是完整的 http(s) URL".to_string()))?;

    match url.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(AppError::BadRequest(
                "Base URL 只允许 http 或 https".to_string(),
            ));
        }
    }

    let host = url
        .host_str()
        .ok_or_else(|| AppError::BadRequest("Base URL 缺少 host".to_string()))?;
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    if matches!(
        normalized_host.as_str(),
        "localhost" | "localhost.localdomain" | "metadata.google.internal"
    ) || normalized_host.ends_with(".localhost")
    {
        return Err(AppError::BadRequest(
            "Base URL 不允许指向 localhost 或 metadata host".to_string(),
        ));
    }

    if let Ok(ip) = normalized_host.parse::<IpAddr>() {
        reject_private_ip(ip)?;
    } else {
        let port = url
            .port_or_known_default()
            .ok_or_else(|| AppError::BadRequest("Base URL 缺少端口且 scheme 未知".to_string()))?;
        let addrs = tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| AppError::BadRequest(format!("Base URL host 解析失败: {}", e)))?;
        for addr in addrs {
            reject_private_ip(addr.ip())?;
        }
    }

    Ok(url)
}

fn reject_private_ip(ip: IpAddr) -> Result<(), AppError> {
    let blocked = match ip {
        IpAddr::V4(ip) => is_blocked_ipv4(ip),
        IpAddr::V6(ip) => is_blocked_ipv6(ip),
    };

    if blocked {
        return Err(AppError::BadRequest(
            "Base URL 不允许指向 localhost、私网、link-local 或 metadata 地址".to_string(),
        ));
    }

    Ok(())
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
}

pub async fn list_providers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, AppError> {
    let providers = sqlx::query_as::<_, ProviderConfigRow>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs ORDER BY is_default DESC, created_at DESC"
    )
    .fetch_all(&state.pool)
    .await?;

    let providers: Vec<ProviderConfig> = providers.into_iter().map(ProviderConfig::from).collect();

    Ok(Json(serde_json::json!({ "items": providers })))
}

pub async fn get_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ProviderConfig>, AppError> {
    let provider = sqlx::query_as::<_, ProviderConfigRow>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Provider not found".to_string()))?;

    Ok(Json(provider.into()))
}

pub async fn create_provider(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateProvider>,
) -> Result<Json<ProviderConfig>, AppError> {
    tracing::info!(name = %body.name, base_url = %body.base_url, model = %body.model, "Creating provider");
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let api_key = body.api_key.unwrap_or_default();
    let is_default = if body.is_default.unwrap_or(false) {
        1
    } else {
        0
    };

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

    let provider = sqlx::query_as::<_, ProviderConfigRow>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(provider.into()))
}

pub async fn update_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateProvider>,
) -> Result<Json<ProviderConfig>, AppError> {
    tracing::info!(provider_id = %id, "Updating provider");
    let now = chrono::Utc::now().to_rfc3339();

    // Check exists
    let existing = sqlx::query_as::<_, ProviderConfigRow>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Provider not found".to_string()))?;

    let name = body.name.unwrap_or(existing.name);
    let base_url = body.base_url.unwrap_or(existing.base_url);
    let api_key = body
        .api_key
        .filter(|value| !value.is_empty())
        .unwrap_or(existing.api_key);
    let model = body.model.unwrap_or(existing.model);
    let is_default = body
        .is_default
        .map(|d| if d { 1 } else { 0 })
        .unwrap_or(existing.is_default);

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

    let provider = sqlx::query_as::<_, ProviderConfigRow>(
        "SELECT id, name, provider_type, base_url, api_key, model, is_default, created_at, updated_at FROM provider_configs WHERE id = ?"
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(provider.into()))
}

pub async fn delete_provider(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(provider_id = %id, "Deleting provider");
    let result = sqlx::query("DELETE FROM provider_configs WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Provider not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}
