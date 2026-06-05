use crate::error::AppError;
use crate::runtime::types::{ProposalResult, StateChangeCandidate, StateChangeProposal};
use sqlx::SqlitePool;

pub async fn get_current_state(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<serde_json::Value, AppError> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    match state {
        Some(s) => Ok(serde_json::from_str(&s).unwrap_or(serde_json::json!({}))),
        None => Ok(serde_json::json!({})),
    }
}

pub async fn commit_state(
    pool: &SqlitePool,
    session_id: &str,
    state: &serde_json::Value,
    risk_level: &str,
    committed_by: &str,
    proposal_id: Option<&str>,
) -> Result<i32, AppError> {
    let now = chrono::Utc::now().to_rfc3339();

    let max_version: Option<i32> =
        sqlx::query_scalar("SELECT MAX(version) FROM state_snapshots WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;

    let new_version = max_version.unwrap_or(0) + 1;
    let id = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(new_version)
    .bind(state.to_string())
    .bind(risk_level)
    .bind(committed_by)
    .bind(proposal_id)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(new_version)
}

pub async fn apply_proposal(
    pool: &SqlitePool,
    session_id: &str,
    proposal: &StateChangeProposal,
    turn_number: i32,
) -> Result<ProposalResult, AppError> {
    if proposal.changes.is_empty() {
        return Ok(ProposalResult {
            status: "committed".to_string(),
            version: 0,
            rejected_changes: vec![],
        });
    }

    // Medium/high risk: save as pending for review
    if proposal.risk == "medium" || proposal.risk == "high" {
        let proposal_id = save_pending_proposal(pool, session_id, proposal, turn_number).await?;
        tracing::info!(
            session = session_id,
            turn = turn_number,
            proposal_id = %proposal_id,
            risk = %proposal.risk,
            proposed_by = %proposal.proposed_by,
            changes = proposal.changes.len(),
            "Proposal saved as pending (risk={}, requires review)",
            proposal.risk
        );
        return Ok(ProposalResult {
            status: "pending".to_string(),
            version: 0,
            rejected_changes: vec![],
        });
    }

    // Low risk: auto-commit
    apply_changes(pool, session_id, proposal, None).await
}

async fn apply_changes(
    pool: &SqlitePool,
    session_id: &str,
    proposal: &StateChangeProposal,
    proposal_id: Option<&str>,
) -> Result<ProposalResult, AppError> {
    let mut state = get_current_state(pool, session_id).await?;
    let mut rejected = Vec::new();

    for (i, change) in proposal.changes.iter().enumerate() {
        match apply_single_change(&mut state, change) {
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    session = session_id,
                    change_index = i,
                    target = %change.target,
                    "Change rejected: {}", e
                );
                rejected.push(i);
            }
        }
    }

    let version = commit_state(
        pool,
        session_id,
        &state,
        &proposal.risk,
        &proposal.proposed_by,
        proposal_id,
    )
    .await?;

    tracing::info!(
        session = session_id,
        version = version,
        committed_by = %proposal.proposed_by,
        applied = proposal.changes.len() - rejected.len(),
        rejected = rejected.len(),
        "State committed"
    );

    Ok(ProposalResult {
        status: "committed".to_string(),
        version,
        rejected_changes: rejected,
    })
}

fn apply_single_change(
    state: &mut serde_json::Value,
    change: &StateChangeCandidate,
) -> Result<(), String> {
    match change.op.as_str() {
        "update" => {
            // Conflict detection: if `from` is specified, verify it matches current value
            if let Some(ref expected_from) = change.from {
                let current = get_nested_value(state, &change.target);
                if current.as_ref() != Some(expected_from) {
                    return Err(format!(
                        "conflict on '{}': expected {:?}, found {:?}",
                        change.target, expected_from, current
                    ));
                }
            }
            set_nested_value(state, &change.target, change.to.clone());
            Ok(())
        }
        "add" => {
            set_nested_value(state, &change.target, change.to.clone());
            Ok(())
        }
        "remove" => {
            remove_nested_value(state, &change.target);
            Ok(())
        }
        other => Err(format!("unknown op: '{}'", other)),
    }
}

fn get_nested_value(state: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = state;
    for part in &parts {
        match current.get(*part) {
            Some(v) => current = v,
            None => return None,
        }
    }
    Some(current.clone())
}

fn set_nested_value(state: &mut serde_json::Value, path: &str, value: serde_json::Value) {
    let parts: Vec<&str> = path.split('.').collect();
    set_nested_recursive(state, &parts, value);
}

fn set_nested_recursive(current: &mut serde_json::Value, parts: &[&str], value: serde_json::Value) {
    if parts.len() == 1 {
        if let Some(obj) = current.as_object_mut() {
            obj.insert(parts[0].to_string(), value);
        }
    } else {
        let entry = current
            .as_object_mut()
            .unwrap()
            .entry(parts[0].to_string())
            .or_insert(serde_json::json!({}));
        set_nested_recursive(entry, &parts[1..], value);
    }
}

fn remove_nested_value(state: &mut serde_json::Value, path: &str) {
    let parts: Vec<&str> = path.split('.').collect();
    remove_nested_recursive(state, &parts);
}

fn remove_nested_recursive(current: &mut serde_json::Value, parts: &[&str]) {
    if parts.len() == 1 {
        if let Some(obj) = current.as_object_mut() {
            obj.remove(parts[0]);
        }
    } else if let Some(next) = current.get_mut(parts[0]) {
        remove_nested_recursive(next, &parts[1..]);
    }
}

// --- Proposal persistence ---

pub async fn save_pending_proposal(
    pool: &SqlitePool,
    session_id: &str,
    proposal: &StateChangeProposal,
    turn_number: i32,
) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let proposal_json = serde_json::to_string(proposal).unwrap_or_else(|_| "{}".to_string());

    sqlx::query(
        "INSERT INTO pending_proposals (id, session_id, turn_number, proposed_by, risk, proposal_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(turn_number)
    .bind(&proposal.proposed_by)
    .bind(&proposal.risk)
    .bind(&proposal_json)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(id)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PendingProposal {
    pub id: String,
    pub session_id: String,
    pub turn_number: i32,
    pub proposed_by: String,
    pub risk: String,
    pub proposal_json: String,
    pub status: String,
    pub created_at: String,
}

pub async fn get_pending_proposals(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<PendingProposal>, AppError> {
    let proposals = sqlx::query_as::<_, PendingProposal>(
        "SELECT id, session_id, turn_number, proposed_by, risk, proposal_json, status, created_at FROM pending_proposals WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    Ok(proposals)
}

pub async fn approve_proposal(
    pool: &SqlitePool,
    session_id: &str,
    proposal_id: &str,
) -> Result<ProposalResult, AppError> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT proposal_json, status, risk FROM pending_proposals WHERE id = ? AND session_id = ?",
    )
    .bind(proposal_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Proposal not found".to_string()))?;

    let (proposal_json, status, _risk) = row;

    if status != "pending" {
        return Err(AppError::BadRequest(format!(
            "Proposal is already {}",
            status
        )));
    }

    let proposal: StateChangeProposal =
        serde_json::from_str(&proposal_json).map_err(|e| AppError::Internal(e.to_string()))?;

    let result = apply_changes(pool, session_id, &proposal, Some(proposal_id)).await?;

    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE pending_proposals SET status = 'committed', resolved_at = ? WHERE id = ?",
    )
    .bind(&now)
    .bind(proposal_id)
    .execute(pool)
    .await?;

    Ok(result)
}

pub async fn reject_proposal(
    pool: &SqlitePool,
    session_id: &str,
    proposal_id: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE pending_proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND session_id = ? AND status = 'pending'"
    )
    .bind(&now)
    .bind(proposal_id)
    .bind(session_id)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Pending proposal not found".to_string()));
    }

    Ok(())
}

// --- Backward-compatible wrapper ---

pub async fn apply_state_changes(
    pool: &SqlitePool,
    session_id: &str,
    changes: &[(String, serde_json::Value)],
) -> Result<i32, AppError> {
    if changes.is_empty() {
        return Ok(0);
    }

    let proposal = StateChangeProposal {
        proposed_by: "runtime".to_string(),
        risk: "low".to_string(),
        changes: changes
            .iter()
            .map(|(path, value)| StateChangeCandidate {
                op: "update".to_string(),
                target: path.clone(),
                from: None,
                to: value.clone(),
                evidence_turns: vec![],
            })
            .collect(),
    };
    let result = apply_proposal(pool, session_id, &proposal, 0).await?;
    Ok(result.version)
}

use serde::Serialize;
