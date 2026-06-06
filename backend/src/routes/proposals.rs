use axum::Json;
use axum::extract::{Path, State};
use serde::Serialize;
use std::sync::Arc;

use crate::error::AppError;
use crate::memory::state;
use crate::routes::messages::AppState;

#[derive(Serialize)]
struct ProposalItem {
    id: String,
    session_id: String,
    turn_number: i32,
    proposed_by: String,
    risk: String,
    status: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    proposal: Option<serde_json::Value>,
}

pub async fn list_proposals(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::debug!(session = %session_id, "Listing pending proposals");
    let pending = state::get_pending_proposals(&state.pool, &session_id).await?;

    let items: Vec<ProposalItem> = pending
        .into_iter()
        .map(|p| {
            let proposal: Option<serde_json::Value> = serde_json::from_str(&p.proposal_json).ok();
            ProposalItem {
                id: p.id,
                session_id: p.session_id,
                turn_number: p.turn_number,
                proposed_by: p.proposed_by,
                risk: p.risk,
                status: p.status,
                created_at: p.created_at,
                proposal,
            }
        })
        .collect();

    Ok(Json(serde_json::json!({ "items": items })))
}

pub async fn approve_proposal(
    State(state): State<Arc<AppState>>,
    Path((session_id, proposal_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, proposal_id = %proposal_id, "Proposal approved");
    let result = state::approve_proposal(&state.pool, &session_id, &proposal_id).await?;

    Ok(Json(serde_json::json!({
        "status": result.status,
        "version": result.version,
        "rejected_changes": result.rejected_changes,
    })))
}

pub async fn reject_proposal(
    State(state): State<Arc<AppState>>,
    Path((session_id, proposal_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!(session = %session_id, proposal_id = %proposal_id, "Proposal rejected");
    state::reject_proposal(&state.pool, &session_id, &proposal_id).await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
