mod config;
mod db;
mod error;
mod memory;
mod provider;
mod routes;
mod runtime;
mod trace;

use axum::routing::{delete, get, post, put};
use axum::Router;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing_subscriber::EnvFilter;

use crate::config::AppConfig;
use crate::routes::{health, messages, proposals, providers, sessions};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = AppConfig::from_env();
    let port = config.port;

    tracing::info!("Starting conclave-backend on port {}", port);

    let app = create_app(config).await;

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .expect("Failed to bind");

    axum::serve(listener, app).await.expect("Server failed");
}

async fn create_app(config: AppConfig) -> Router {
    let pool = db::create_pool(&config.database_url)
        .await
        .expect("Failed to create database pool");

    db::run_migrations(&pool)
        .await
        .expect("Failed to run migrations");

    let app_state = Arc::new(messages::AppState {
        pool: pool.clone(),
        config: config.clone(),
    });

    Router::new()
        .route("/api/health", get(health::health_check))
        .route("/api/sessions", post(sessions::create_session))
        .route("/api/sessions", get(sessions::list_sessions))
        .route("/api/sessions/{id}", get(sessions::get_session))
        .route("/api/sessions/{id}", axum::routing::patch(sessions::update_session))
        .route("/api/sessions/{id}", delete(sessions::delete_session))
        .route("/api/sessions/{id}/messages", post(messages::send_message))
        .route("/api/sessions/{id}/messages", get(messages::list_messages))
        .route("/api/sessions/{id}/state", get(messages::get_state))
        .route("/api/sessions/{id}/memory/events", get(messages::get_memory_events))
        .route("/api/sessions/{id}/memory/foreshadowing", get(messages::get_foreshadowing))
        .route("/api/sessions/{id}/trace/{turn}", get(messages::get_trace))
        .route("/api/sessions/{id}/messages/{msg_id}/regenerate", post(messages::regenerate))
        .route("/api/sessions/{id}/messages/{msg_id}/switch-variant", put(messages::switch_variant))
        .route("/api/sessions/{id}/messages/{msg_id}", put(messages::edit_message))
        .route("/api/sessions/{id}/messages/{msg_id}", delete(messages::delete_message))
        .route("/api/sessions/{id}/proposals", get(proposals::list_proposals))
        .route("/api/sessions/{id}/proposals/{pid}/approve", post(proposals::approve_proposal))
        .route("/api/sessions/{id}/proposals/{pid}/reject", post(proposals::reject_proposal))
        .route("/api/providers", get(providers::list_providers))
        .route("/api/providers", post(providers::create_provider))
        .route("/api/providers/fetch-models", post(providers::fetch_models))
        .route("/api/providers/{id}", get(providers::get_provider))
        .route("/api/providers/{id}", axum::routing::put(providers::update_provider))
        .route("/api/providers/{id}", delete(providers::delete_provider))
        .layer(CorsLayer::permissive())
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-cache"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CONNECTION,
            axum::http::HeaderValue::from_static("keep-alive"),
        ))
        .with_state(app_state)
}
