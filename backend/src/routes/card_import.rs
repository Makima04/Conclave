use axum::Json;
use axum::extract::{Multipart, Path, State};
use chrono::Utc;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::AppError;
use crate::importer::llm_assist;
use crate::importer::types::*;
use crate::routes::messages::AppState;
use crate::runtime::executor;

/// POST /api/charactercards/import
/// Upload a PNG/JSON character card for import normalization.
pub async fn import_character_card(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    // 1. Extract file from multipart
    let mut filename = String::from("unknown");
    let mut bytes = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() == Some("file") {
            filename = field.file_name().unwrap_or("unknown").to_string();
            bytes = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))?
                .to_vec();
        }
    }

    if bytes.is_empty() {
        return Err(AppError::BadRequest("No file uploaded".to_string()));
    }

    // 2. Run import pipeline (orchestrator not yet implemented)
    let (package, report, original_card) =
        crate::importer::orchestrator::run_import(bytes.clone(), &filename)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

    // 3. Store draft in memory
    let import_id = Uuid::new_v4().to_string();
    let draft = ImportDraft {
        import_id: import_id.clone(),
        package_draft: package.clone(),
        import_report: report.clone(),
        original_card,
        created_at: Utc::now().to_rfc3339(),
    };

    state.import_drafts.insert(import_id.clone(), draft);

    Ok(Json(serde_json::json!({
        "import_id": import_id,
        "package_draft": package,
        "import_report": report,
    })))
}

/// POST /api/charactercards/{id}/run-import
/// Run the import normalization pipeline on an existing character card's source_data.
pub async fn run_import_for_card(
    State(state): State<Arc<AppState>>,
    Path(card_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // 1. Fetch the character card from DB
    let source_data: String =
        sqlx::query_scalar("SELECT source_data FROM character_cards WHERE id = ?")
            .bind(&card_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| AppError::NotFound("Character card not found".to_string()))?;

    if source_data.is_empty() || source_data == "{}" {
        return Err(AppError::BadRequest(
            "Character card has no source data to import".to_string(),
        ));
    }

    // 2. Convert source_data JSON to bytes
    let bytes = source_data.into_bytes();
    let filename = "card.json";

    // 3. Run import pipeline
    let (package, report, original_card) =
        crate::importer::orchestrator::run_import(bytes, filename)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

    // 4. Store draft in memory
    let import_id = Uuid::new_v4().to_string();
    let draft = ImportDraft {
        import_id: import_id.clone(),
        package_draft: package.clone(),
        import_report: report.clone(),
        original_card,
        created_at: Utc::now().to_rfc3339(),
    };

    state.import_drafts.insert(import_id.clone(), draft);

    Ok(Json(serde_json::json!({
        "import_id": import_id,
        "package_draft": package,
        "import_report": report,
    })))
}

/// POST /api/charactercards/import/:import_id/confirm
/// Confirm an import draft and persist the character card to the database.
pub async fn confirm_import(
    State(state): State<Arc<AppState>>,
    Path(import_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _degrade_to_schema = body
        .get("degrade_to_schema")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // 1. Look up draft from in-memory store
    let draft = state
        .import_drafts
        .get(&import_id)
        .ok_or_else(|| AppError::NotFound("Import draft not found".to_string()))?
        .clone();

    // 2. Check if a world_book_id was provided (update existing path)
    let world_book_id = body
        .get("world_book_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let (character_card_id, world_pack_id) = if let Some(wb_id) = &world_book_id {
        // Update existing world book's card instead of creating a new one
        crate::importer::storage::update_imported_card(
            &state.pool,
            wb_id,
            &draft.package_draft,
            &draft.original_card,
            &draft.import_report,
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    } else {
        // Save as new world book + character card
        crate::importer::storage::save_imported_card(
            &state.pool,
            &draft.package_draft,
            &draft.original_card,
            &draft.import_report,
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    };

    // 3. Remove draft from memory
    state.import_drafts.remove(&import_id);

    Ok(Json(serde_json::json!({
        "character_card_id": character_card_id,
        "world_pack_id": world_pack_id,
        "status": "confirmed",
    })))
}

/// POST /api/charactercards/import/:import_id/llm-assist
/// Request LLM assistance for interpreting import results.
pub async fn request_llm_assist(
    State(state): State<Arc<AppState>>,
    Path(import_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    // 1. Look up draft
    let draft = state
        .import_drafts
        .get(&import_id)
        .ok_or_else(|| AppError::NotFound("Import draft not found".to_string()))?
        .clone();

    // 2. Load provider for LLM calls
    let provider = executor::load_default_provider(&state.pool).await?;
    let model = executor::load_provider_model(&state.pool).await?;

    // 3. Determine assist type and build prompt
    let assist_type = body
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let prompt = match assist_type {
        "explain_actions" => {
            let html_context = body
                .get("html_context")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            llm_assist::build_explain_actions_prompt(&draft.package_draft.actions, html_context)
        }
        "label_variables" => {
            let code_context = body
                .get("code_context")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            llm_assist::build_label_variables_prompt(&draft.package_draft.variables, code_context)
        }
        "summarize_unsupported" => llm_assist::build_summarize_unsupported_prompt(
            &draft.package_draft.compatibility.unsupported_apis,
        ),
        "suggest_action_kind" => {
            let html_context = body
                .get("html_context")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            llm_assist::build_explain_actions_prompt(&draft.package_draft.actions, html_context)
        }
        _ => {
            return Err(AppError::BadRequest(format!(
                "Unknown assist type: {}",
                assist_type
            )));
        }
    };

    // 4. Call LLM and parse response
    let result = llm_assist::call_llm_json(&provider, &model, &prompt).await?;

    Ok(Json(serde_json::json!({
        "type": assist_type,
        "result": result,
    })))
}

/// GET /api/charactercards/import/:import_id/report
/// Get the import report for a draft.
pub async fn get_import_report(
    State(state): State<Arc<AppState>>,
    Path(import_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let draft = state
        .import_drafts
        .get(&import_id)
        .ok_or_else(|| AppError::NotFound("Import draft not found".to_string()))?;

    Ok(Json(serde_json::json!({
        "import_id": draft.import_id,
        "import_report": draft.import_report,
    })))
}

/// POST /api/charactercards/import/:import_id/raw-preview
/// Generate raw ST sandbox preview HTML for the imported card.
pub async fn get_raw_preview(
    State(state): State<Arc<AppState>>,
    Path(import_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let draft = state
        .import_drafts
        .get(&import_id)
        .ok_or_else(|| AppError::NotFound("Import draft not found".to_string()))?;

    // Generate preview from the package draft's UI definition
    let preview_html = match &draft.package_draft.ui.html {
        Some(html) => html.clone(),
        None => String::from("<p>No HTML preview available for this card.</p>"),
    };

    Ok(Json(serde_json::json!({
        "import_id": import_id,
        "html": preview_html,
        "ui_type": draft.package_draft.ui.ui_type,
    })))
}

/// POST /api/charactercards/import/:import_id/save-failure
/// Save a failure sample for debugging/training purposes.
pub async fn save_failure_sample(
    State(state): State<Arc<AppState>>,
    Path(import_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let draft = state
        .import_drafts
        .get(&import_id)
        .ok_or_else(|| AppError::NotFound("Import draft not found".to_string()))?;

    // Save failure sample via storage module (not yet implemented)
    let sample_id = crate::importer::storage::save_failure_sample(
        &state.pool,
        &import_id,
        &draft.original_card,
        &body,
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(serde_json::json!({
        "sample_id": sample_id,
        "status": "saved",
    })))
}
