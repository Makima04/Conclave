use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, code, message) = match &self {
            AppError::NotFound(msg) => {
                (axum::http::StatusCode::NOT_FOUND, "not_found", msg.clone())
            }
            AppError::BadRequest(msg) => (
                axum::http::StatusCode::BAD_REQUEST,
                "bad_request",
                msg.clone(),
            ),
            AppError::Conflict(msg) => (axum::http::StatusCode::CONFLICT, "conflict", msg.clone()),
            AppError::Database(e) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "database_error",
                e.to_string(),
            ),
            AppError::Provider(msg) => (
                axum::http::StatusCode::BAD_GATEWAY,
                "provider_error",
                msg.clone(),
            ),
            AppError::Internal(msg) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                msg.clone(),
            ),
        };

        let body = serde_json::json!({
            "error": {
                "code": code,
                "message": message
            }
        });

        (status, axum::Json(body)).into_response()
    }
}
