use std::env;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub database_url: String,
    pub port: u16,
    pub openai_api_key: String,
    pub openai_base_url: String,
    pub openai_model: String,
    pub max_context_turns: usize,
}

impl AppConfig {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "sqlite:conclave.db".to_string()),
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3001),
            openai_api_key: env::var("OPENAI_API_KEY").unwrap_or_default(),
            openai_base_url: env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            openai_model: env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string()),
            max_context_turns: env::var("MAX_CONTEXT_TURNS")
                .ok()
                .and_then(|n| n.parse().ok())
                .unwrap_or(20),
        }
    }
}
