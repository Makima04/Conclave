mod config;
mod db;
mod error;
mod memory;
mod provider;
mod routes;
mod runtime;
mod trace;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post, put};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::AppConfig;
use crate::routes::{
    agents, charactercards, health, messages, presets, proposals, providers, sessions, worldbooks,
};

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
        active_turns: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        session_locks: Arc::new(dashmap::DashMap::new()),
    });

    // Spawn background job worker (compression, recompression)
    tokio::spawn(runtime::background_jobs::run(
        pool.clone(),
        Arc::new(config.clone()),
    ));

    Router::new()
        .route("/api/health", get(health::health_check))
        .route("/api/sessions", post(sessions::create_session))
        .route("/api/sessions", get(sessions::list_sessions))
        .route("/api/sessions/{id}", get(sessions::get_session))
        .route(
            "/api/sessions/{id}",
            axum::routing::patch(sessions::update_session),
        )
        .route("/api/sessions/{id}", delete(sessions::delete_session))
        .route("/api/sessions/{id}/messages", post(messages::send_message))
        .route("/api/sessions/{id}/messages", get(messages::list_messages))
        .route("/api/sessions/{id}/state", get(messages::get_state))
        .route(
            "/api/sessions/{id}/memory/events",
            get(messages::get_memory_events),
        )
        .route(
            "/api/sessions/{id}/memory/foreshadowing",
            get(messages::get_foreshadowing),
        )
        .route("/api/sessions/{id}/trace/{turn}", get(messages::get_trace))
        .route(
            "/api/sessions/{id}/messages/{msg_id}/regenerate",
            post(messages::regenerate),
        )
        .route(
            "/api/sessions/{id}/messages/{msg_id}/switch-variant",
            put(messages::switch_variant),
        )
        .route(
            "/api/sessions/{id}/messages/{msg_id}",
            put(messages::edit_message),
        )
        .route(
            "/api/sessions/{id}/messages/{msg_id}",
            delete(messages::delete_message),
        )
        .route("/api/sessions/{id}/opening", post(messages::apply_opening))
        .route(
            "/api/sessions/{id}/reconnect",
            get(messages::reconnect_stream),
        )
        .route(
            "/api/sessions/{id}/proposals",
            get(proposals::list_proposals),
        )
        .route(
            "/api/sessions/{id}/proposals/{pid}/approve",
            post(proposals::approve_proposal),
        )
        .route(
            "/api/sessions/{id}/proposals/{pid}/reject",
            post(proposals::reject_proposal),
        )
        .route("/api/sessions/{id}/agents", get(agents::list_agents))
        .route(
            "/api/sessions/{id}/agents",
            post(agents::create_agent_manual),
        )
        .route(
            "/api/sessions/{id}/agents/{aid}",
            axum::routing::put(agents::update_agent),
        )
        .route(
            "/api/sessions/{id}/agents/{aid}",
            delete(agents::delete_agent_manual),
        )
        .route(
            "/api/sessions/{id}/agents/{aid}/cooldown",
            post(agents::cooldown_agent_manual),
        )
        .route(
            "/api/sessions/{id}/agents/{aid}/restore",
            post(agents::restore_agent_manual),
        )
        .route("/api/providers", get(providers::list_providers))
        .route("/api/providers", post(providers::create_provider))
        .route("/api/providers/fetch-models", post(providers::fetch_models))
        .route("/api/providers/{id}", get(providers::get_provider))
        .route(
            "/api/providers/{id}",
            axum::routing::put(providers::update_provider),
        )
        .route("/api/providers/{id}", delete(providers::delete_provider))
        .route("/api/worldbooks", post(worldbooks::import_worldbook))
        .route("/api/worldbooks", get(worldbooks::list_worldbooks))
        .route("/api/worldbooks/{id}", get(worldbooks::get_worldbook))
        .route(
            "/api/worldbooks/{id}",
            axum::routing::patch(worldbooks::update_worldbook),
        )
        .route("/api/worldbooks/{id}", delete(worldbooks::delete_worldbook))
        .route(
            "/api/worldbooks/{id}/export",
            get(worldbooks::export_worldbook),
        )
        .route(
            "/api/worldbooks/{id}/parse",
            post(worldbooks::parse_worldbook),
        )
        .route(
            "/api/worldbooks/{id}/character-card",
            get(charactercards::get_card_for_worldbook),
        )
        .route(
            "/api/worldbooks/{id}/entries/{entry_id}",
            put(worldbooks::update_entry),
        )
        .route(
            "/api/worldbooks/{id}/entries/{entry_id}",
            delete(worldbooks::delete_entry),
        )
        .route("/api/presets", post(presets::import_preset))
        .route("/api/presets", get(presets::list_presets))
        .route("/api/presets/{id}", get(presets::get_preset))
        .route(
            "/api/presets/{id}",
            axum::routing::patch(presets::update_preset),
        )
        .route("/api/presets/{id}", delete(presets::delete_preset))
        .route("/api/presets/{id}/parse", post(presets::parse_preset))
        .route(
            "/api/presets/{id}/modules/{mid}",
            put(presets::update_module),
        )
        .route(
            "/api/presets/{id}/modules/{mid}",
            delete(presets::delete_module),
        )
        .route(
            "/api/charactercards",
            get(charactercards::list_character_cards),
        )
        .route(
            "/api/charactercards/{id}",
            get(charactercards::get_character_card),
        )
        .route(
            "/api/charactercards/{id}",
            axum::routing::patch(charactercards::update_character_card),
        )
        .layer(TraceLayer::new_for_http())
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
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
