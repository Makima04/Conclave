mod config;
mod db;
mod error;
mod importer;
mod memory;
mod provider;
mod routes;
mod runtime;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::extract::Request;
use axum::http;
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use std::net::IpAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::routes::{
    agents, card_import, charactercards, health, messages, presets, proposals, providers, sessions,
    settings, worldbooks,
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
    let bind_host = config.bind_host.clone();
    if config.api_auth_token.is_empty() && !is_loopback_bind_host(&bind_host) {
        panic!("API_AUTH_TOKEN is required when BIND_HOST is not a loopback address");
    }

    tracing::info!("Starting conclave-backend on {}:{}", bind_host, port);

    let app = create_app(config).await;

    let listener = tokio::net::TcpListener::bind(format!("{}:{}", bind_host, port))
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

    let llm_concurrency_limit = settings::load_llm_concurrency_limit(&pool)
        .await
        .expect("Failed to load runtime settings");

    let app_state = Arc::new(messages::AppState {
        pool: pool.clone(),
        config: config.clone(),
        active_turns: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        session_locks: Arc::new(dashmap::DashMap::new()),
        import_drafts: Arc::new(dashmap::DashMap::new()),
        llm_limiter: runtime::llm_limiter::LlmConcurrencyLimiter::new(llm_concurrency_limit),
    });

    // Spawn background job worker (compression, recompression)
    tokio::spawn(runtime::background_jobs::run(
        pool.clone(),
        Arc::new(config.clone()),
    ));

    let auth_token = Arc::new(config.api_auth_token.clone());

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
        .route(
            "/api/sessions/{id}/quiet-generate",
            post(messages::quiet_generate),
        )
        .route("/api/sessions/{id}/state", get(messages::get_state))
        .route(
            "/api/sessions/{id}/variables",
            put(messages::update_variables),
        )
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
            "/api/sessions/{id}/debug",
            get(messages::get_debug_overview),
        )
        .route(
            "/api/sessions/{id}/debug/{turn}",
            get(messages::get_debug_turn),
        )
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
            "/api/sessions/{id}/messages/{msg_id}/metadata",
            put(messages::update_message_metadata),
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
        .route("/api/settings/runtime", get(settings::get_runtime_settings))
        .route(
            "/api/settings/runtime",
            axum::routing::put(settings::update_runtime_settings),
        )
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
            "/api/worldbooks/{id}/parse-single-agent",
            post(worldbooks::parse_worldbook_single_agent),
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
        .route(
            "/api/charactercards/{id}/run-import",
            post(card_import::run_import_for_card),
        )
        .route(
            "/api/charactercards/import",
            post(card_import::import_character_card),
        )
        .route(
            "/api/charactercards/import/{import_id}/confirm",
            post(card_import::confirm_import),
        )
        .route(
            "/api/charactercards/import/{import_id}/llm-assist",
            post(card_import::request_llm_assist),
        )
        .route(
            "/api/charactercards/import/{import_id}/report",
            get(card_import::get_import_report),
        )
        .route(
            "/api/charactercards/import/{import_id}/raw-preview",
            post(card_import::get_raw_preview),
        )
        .route(
            "/api/charactercards/import/{import_id}/save-failure",
            post(card_import::save_failure_sample),
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
        .layer(axum::middleware::from_fn_with_state(
            auth_token,
            require_api_auth,
        ))
        .with_state(app_state)
}

async fn require_api_auth(
    axum::extract::State(token): axum::extract::State<Arc<String>>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    if token.is_empty()
        || req.uri().path() == "/api/health"
        || req.method() == http::Method::OPTIONS
    {
        return Ok(next.run(req).await);
    }

    let authorized = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == format!("Bearer {}", token))
        || req
            .headers()
            .get("x-api-key")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == token.as_str());

    if !authorized {
        return Err(AppError::Unauthorized(
            "Missing or invalid API token".to_string(),
        ));
    }

    Ok(next.run(req).await)
}

fn is_loopback_bind_host(host: &str) -> bool {
    matches!(host, "localhost" | "localhost.localdomain")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}
