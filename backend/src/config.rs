use std::env;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub database_url: String,
    pub bind_host: String,
    pub port: u16,
    pub api_auth_token: String,
}

impl AppConfig {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "sqlite:conclave.db".to_string()),
            bind_host: env::var("BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3001),
            api_auth_token: env::var("API_AUTH_TOKEN").unwrap_or_default(),
        }
    }
}
