use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

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
            AppError::Unauthorized(msg) => (
                axum::http::StatusCode::UNAUTHORIZED,
                "unauthorized",
                msg.clone(),
            ),
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;

    async fn assert_error_response(
        error: AppError,
        expected_status: axum::http::StatusCode,
        expected_code: &str,
        expected_message: &str,
    ) {
        let response = error.into_response();
        assert_eq!(response.status(), expected_status);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let payload: serde_json::Value =
            serde_json::from_slice(&body).expect("valid JSON error body");

        assert_eq!(payload["error"]["code"], expected_code);
        assert_eq!(payload["error"]["message"], expected_message);
    }

    #[tokio::test]
    async fn client_errors_map_to_expected_status_and_codes() {
        assert_error_response(
            AppError::NotFound("missing".into()),
            axum::http::StatusCode::NOT_FOUND,
            "not_found",
            "missing",
        )
        .await;

        assert_error_response(
            AppError::BadRequest("bad input".into()),
            axum::http::StatusCode::BAD_REQUEST,
            "bad_request",
            "bad input",
        )
        .await;

        assert_error_response(
            AppError::Conflict("duplicate".into()),
            axum::http::StatusCode::CONFLICT,
            "conflict",
            "duplicate",
        )
        .await;

        assert_error_response(
            AppError::Unauthorized("denied".into()),
            axum::http::StatusCode::UNAUTHORIZED,
            "unauthorized",
            "denied",
        )
        .await;
    }

    #[tokio::test]
    async fn server_errors_map_to_expected_status_and_codes() {
        assert_error_response(
            AppError::Provider("upstream failed".into()),
            axum::http::StatusCode::BAD_GATEWAY,
            "provider_error",
            "upstream failed",
        )
        .await;

        assert_error_response(
            AppError::Internal("panic avoided".into()),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "panic avoided",
        )
        .await;

        assert_error_response(
            AppError::Database(sqlx::Error::RowNotFound),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "database_error",
            "no rows returned by a query that expected to return at least one row",
        )
        .await;
    }
}
