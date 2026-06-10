use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;
use crate::runtime::llm_limiter::{
    DEFAULT_LLM_CONCURRENCY_LIMIT, MIN_LLM_CONCURRENCY_LIMIT, normalize_limit,
};

#[derive(Debug, Serialize)]
pub struct RuntimeSettings {
    pub llm_concurrency_limit: usize,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRuntimeSettings {
    pub llm_concurrency_limit: Option<usize>,
}

pub async fn load_llm_concurrency_limit(pool: &sqlx::SqlitePool) -> Result<usize, AppError> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'llm_concurrency_limit'")
            .fetch_optional(pool)
            .await?;

    let parsed = stored
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_LLM_CONCURRENCY_LIMIT);

    Ok(normalize_limit(parsed))
}

pub async fn get_runtime_settings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RuntimeSettings>, AppError> {
    Ok(Json(RuntimeSettings {
        llm_concurrency_limit: state.llm_limiter.current_limit(),
    }))
}

pub async fn update_runtime_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateRuntimeSettings>,
) -> Result<Json<RuntimeSettings>, AppError> {
    let next_limit = body
        .llm_concurrency_limit
        .map(normalize_limit)
        .unwrap_or_else(|| state.llm_limiter.current_limit());

    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('llm_concurrency_limit', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(next_limit.to_string())
    .bind(now)
    .execute(&state.pool)
    .await?;

    let applied_limit = state.llm_limiter.set_limit(next_limit);

    Ok(Json(RuntimeSettings {
        llm_concurrency_limit: applied_limit,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::query(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT
            )",
        )
        .execute(&pool)
        .await
        .expect("create app_settings");
        pool
    }

    #[tokio::test]
    async fn load_llm_concurrency_limit_uses_default_when_setting_is_missing() {
        let pool = setup_pool().await;

        let limit = load_llm_concurrency_limit(&pool)
            .await
            .expect("load default runtime setting");

        assert_eq!(limit, DEFAULT_LLM_CONCURRENCY_LIMIT);
    }

    #[tokio::test]
    async fn load_llm_concurrency_limit_uses_default_when_setting_is_invalid() {
        let pool = setup_pool().await;
        sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
            .bind("llm_concurrency_limit")
            .bind("not-a-number")
            .bind("2026-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .expect("insert invalid setting");

        let limit = load_llm_concurrency_limit(&pool)
            .await
            .expect("load invalid runtime setting");

        assert_eq!(limit, DEFAULT_LLM_CONCURRENCY_LIMIT);
    }

    #[tokio::test]
    async fn load_llm_concurrency_limit_clamps_out_of_range_values() {
        let pool = setup_pool().await;

        sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
            .bind("llm_concurrency_limit")
            .bind("0")
            .bind("2026-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .expect("insert zero setting");

        let low_limit = load_llm_concurrency_limit(&pool)
            .await
            .expect("load low runtime setting");
        assert_eq!(low_limit, MIN_LLM_CONCURRENCY_LIMIT);

        sqlx::query("UPDATE app_settings SET value = ? WHERE key = ?")
            .bind("999")
            .bind("llm_concurrency_limit")
            .execute(&pool)
            .await
            .expect("update high setting");

        let high_limit = load_llm_concurrency_limit(&pool)
            .await
            .expect("load high runtime setting");
        assert_eq!(high_limit, crate::runtime::llm_limiter::MAX_LLM_CONCURRENCY_LIMIT);
    }
}
