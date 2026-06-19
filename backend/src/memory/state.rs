use crate::error::AppError;
use crate::runtime::card_state_adapter;
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

    // Runtime-classified risk: don't trust LLM self-reporting
    let classified_risk = classify_risk(&proposal.proposed_by, &proposal.changes);

    // Reject changes that hit restricted paths for the proposer
    let allowed_changes: Vec<(usize, &StateChangeCandidate)> = proposal
        .changes
        .iter()
        .enumerate()
        .filter(|(_, c)| is_path_allowed(&proposal.proposed_by, &c.target))
        .collect();

    let rejected_by_policy: Vec<usize> = proposal
        .changes
        .iter()
        .enumerate()
        .filter(|(_, c)| !is_path_allowed(&proposal.proposed_by, &c.target))
        .map(|(i, _)| i)
        .collect();

    if !rejected_by_policy.is_empty() {
        tracing::warn!(
            session = session_id,
            proposed_by = %proposal.proposed_by,
            rejected_paths = ?rejected_by_policy.iter().map(|i| &proposal.changes[*i].target).collect::<Vec<_>>(),
            "State changes rejected by path policy"
        );
    }

    if allowed_changes.is_empty() {
        return Ok(ProposalResult {
            status: "rejected".to_string(),
            version: 0,
            rejected_changes: rejected_by_policy,
        });
    }

    // Medium/high risk: save as pending for review
    if classified_risk == "medium" || classified_risk == "high" {
        let proposal_id = save_pending_proposal(pool, session_id, proposal, turn_number).await?;
        tracing::info!(
            session = session_id,
            turn = turn_number,
            proposal_id = %proposal_id,
            risk = %classified_risk,
            proposed_by = %proposal.proposed_by,
            changes = allowed_changes.len(),
            "Proposal saved as pending (risk={}, requires review)",
            classified_risk
        );
        return Ok(ProposalResult {
            status: "pending".to_string(),
            version: 0,
            rejected_changes: rejected_by_policy,
        });
    }

    // Low risk: auto-commit (with policy-filtered changes)
    let filtered_proposal = StateChangeProposal {
        proposed_by: proposal.proposed_by.clone(),
        risk: classified_risk,
        changes: allowed_changes.iter().map(|(_, c)| (*c).clone()).collect(),
    };
    let mut result = apply_changes(pool, session_id, &filtered_proposal, None).await?;
    result.rejected_changes.extend(rejected_by_policy);
    Ok(result)
}

/// Classify risk level based on who proposes and what paths are targeted.
/// Runtime decides risk, not the LLM.
fn classify_risk(proposed_by: &str, changes: &[StateChangeCandidate]) -> String {
    // Runtime and master can auto-commit anything
    if matches!(proposed_by, "runtime" | "master" | "director") {
        return "low".to_string();
    }

    // Any change to world_rules or meta is always high risk
    let targets_world_rules = changes.iter().any(|c| {
        let lower = c.target.to_lowercase();
        lower.starts_with("world_rules")
            || lower.starts_with("meta.")
            || lower.starts_with("gm_notes")
    });
    if targets_world_rules {
        return "high".to_string();
    }

    // "remove" operations are medium risk regardless of proposer
    let has_remove = changes.iter().any(|c| c.op == "remove");
    if has_remove {
        return "medium".to_string();
    }

    // compression_agent / variable_parser / state_agent: low risk for standard writes
    if matches!(
        proposed_by,
        "compression_agent" | "variable_parser" | "state_agent"
    ) {
        return "low".to_string();
    }

    // Unknown proposer → medium
    "medium".to_string()
}

/// Check if a proposer is allowed to write to a given path.
fn is_path_allowed(proposed_by: &str, target: &str) -> bool {
    let lower = target.to_lowercase();

    // Nobody can write hidden/secret/internal fields through proposals
    // (those are only set by initialization or admin)
    if lower.contains("hidden_") || lower.contains("secret_") || lower.contains("internal_") {
        return matches!(proposed_by, "runtime" | "master");
    }

    // world_rules and meta: only runtime/master
    if lower.starts_with("world_rules")
        || lower.starts_with("meta.")
        || lower.starts_with("gm_notes")
    {
        return matches!(proposed_by, "runtime" | "master" | "director");
    }

    // compression_agent: can write characters, relationships, scene, inventory, flags
    if proposed_by == "compression_agent" {
        return lower.starts_with("characters")
            || lower.starts_with("relationships")
            || lower.starts_with("scene")
            || lower.starts_with("inventory")
            || lower.starts_with("flags")
            || lower.starts_with("atmosphere")
            || lower.starts_with("location");
    }

    // variable_parser/state_agent only write SillyTavern/MVU-style runtime variables.
    if matches!(proposed_by, "variable_parser" | "state_agent") {
        return lower.starts_with("variables.");
    }

    // variable_tool_agent: writes canonical platform_state paths (the
    // structured state the LLM updates via the update_variables tool). Allows
    // mutable game state — characters, relationships, scene, inventory, flags,
    // location, atmosphere — incl. structural ops (add/remove on arrays such as
    // characters[]). Blocked: world rules, meta, gm notes, hidden/secret/internal.
    if proposed_by == "variable_tool_agent" {
        if lower.contains("hidden_") || lower.contains("secret_") || lower.contains("internal_") {
            return false;
        }
        return lower.starts_with("variables.")
            || lower.starts_with("platform_state.")
            || lower.starts_with("characters")
            || lower.starts_with("relationships")
            || lower.starts_with("scene")
            || lower.starts_with("inventory")
            || lower.starts_with("flags")
            || lower.starts_with("atmosphere")
            || lower.starts_with("location")
            || lower.starts_with("world.");
    }

    // single_agent, unknown: allow common paths
    if proposed_by == "single_agent" {
        return !lower.starts_with("world_rules")
            && !lower.starts_with("meta.")
            && !lower.starts_with("gm_notes");
    }

    // Default: allow (other proposers get benefit of the doubt for now)
    true
}

async fn apply_changes(
    pool: &SqlitePool,
    session_id: &str,
    proposal: &StateChangeProposal,
    proposal_id: Option<&str>,
) -> Result<ProposalResult, AppError> {
    let mut state = get_current_state(pool, session_id).await?;
    let mut rejected = Vec::new();

    // Pre-check: reject "update" changes whose `from` doesn't match the current value.
    // apply_agent_changes does not perform this conflict detection.
    for (i, change) in proposal.changes.iter().enumerate() {
        if change.op == "update" {
            if let Some(ref expected_from) = change.from {
                let current = get_nested_value(&state, &change.target);
                if current.as_ref() != Some(expected_from) {
                    tracing::warn!(
                        session = session_id,
                        change_index = i,
                        target = %change.target,
                        "Change rejected: conflict on '{}': expected {:?}, found {:?}",
                        change.target, expected_from, current
                    );
                    rejected.push(i);
                }
            }
        }
    }

    let allowed_changes: Vec<StateChangeCandidate> = proposal
        .changes
        .iter()
        .enumerate()
        .filter(|(i, _)| !rejected.contains(i))
        .map(|(_, c)| c.clone())
        .collect();

    // Load the session contract to route through the adapter when available.
    let fallback_variables = state.get("variables").cloned();
    let contract =
        card_state_adapter::load_session_contract(pool, session_id, fallback_variables.as_ref())
            .await?;

    if let Some(ref contract) = contract {
        // Adapter path: write_rule validation + card_variables re-projection
        tracing::info!(
            session = session_id,
            source = %contract.source,
            changes = allowed_changes.len(),
            "Approving proposal via state_adapter (write_rules enforced)"
        );
        card_state_adapter::apply_agent_changes(&mut state, &allowed_changes, Some(contract));
    } else {
        // Fallback: raw writes (no adapter registered for this session)
        for (i, change) in proposal.changes.iter().enumerate() {
            if rejected.contains(&i) {
                continue;
            }
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
    let mut current = state;
    for part in path.split('.') {
        let (key, index) = parse_path_part(part);
        current = current.get(key)?;
        if let Some(index) = index {
            current = current.get(index)?;
        }
    }
    Some(current.clone())
}

fn set_nested_value(state: &mut serde_json::Value, path: &str, value: serde_json::Value) {
    let parts: Vec<PathPart<'_>> = path.split('.').map(parse_path_part).collect();
    set_nested_recursive(state, &parts, value);
}

fn set_nested_recursive(
    current: &mut serde_json::Value,
    parts: &[PathPart<'_>],
    value: serde_json::Value,
) {
    let (key, index) = parts[0];
    if parts.len() == 1 {
        if let Some(index) = index {
            let slot = current
                .as_object_mut()
                .expect("state object")
                .entry(key.to_string())
                .or_insert_with(|| serde_json::json!([]));
            ensure_array_len(slot, index + 1);
            if let Some(arr) = slot.as_array_mut() {
                arr[index] = value;
            }
        } else if let Some(obj) = current.as_object_mut() {
            obj.insert(key.to_string(), value);
        }
    } else {
        let mut entry = current
            .as_object_mut()
            .expect("state object")
            .entry(key.to_string())
            .or_insert(serde_json::json!({}));
        if let Some(index) = index {
            ensure_array_len(entry, index + 1);
            entry = &mut entry.as_array_mut().expect("array initialized")[index];
            if !entry.is_object() {
                *entry = serde_json::json!({});
            }
        }
        set_nested_recursive(entry, &parts[1..], value);
    }
}

fn remove_nested_value(state: &mut serde_json::Value, path: &str) {
    let parts: Vec<PathPart<'_>> = path.split('.').map(parse_path_part).collect();
    remove_nested_recursive(state, &parts);
}

fn remove_nested_recursive(current: &mut serde_json::Value, parts: &[PathPart<'_>]) {
    let (key, index) = parts[0];
    if parts.len() == 1 {
        if let Some(index) = index {
            if let Some(arr) = current.get_mut(key).and_then(|v| v.as_array_mut()) {
                if index < arr.len() {
                    arr.remove(index);
                }
            }
        } else if let Some(obj) = current.as_object_mut() {
            obj.remove(key);
        }
    } else if let Some(mut next) = current.get_mut(key) {
        if let Some(index) = index {
            next = match next.as_array_mut().and_then(|arr| arr.get_mut(index)) {
                Some(value) => value,
                None => return,
            };
        }
        remove_nested_recursive(next, &parts[1..]);
    }
}

type PathPart<'a> = (&'a str, Option<usize>);

fn parse_path_part(part: &str) -> PathPart<'_> {
    if let Some(open) = part.rfind('[') {
        if part.ends_with(']') {
            let key = &part[..open];
            let index = part[open + 1..part.len() - 1].parse::<usize>().ok();
            if !key.is_empty() && index.is_some() {
                return (key, index);
            }
        }
    }
    (part, None)
}

fn ensure_array_len(value: &mut serde_json::Value, len: usize) {
    if !value.is_array() {
        *value = serde_json::json!([]);
    }
    let arr = value.as_array_mut().expect("array initialized");
    while arr.len() < len {
        arr.push(serde_json::Value::Null);
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
    sqlx::query("UPDATE pending_proposals SET status = 'committed', resolved_at = ? WHERE id = ?")
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

use serde::Serialize;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gets_and_sets_paths_with_angle_bracket_keys_and_array_indices() {
        let mut state = serde_json::json!({
            "variables": {
                "<user>": {
                    "成长之路": [
                        {
                            "身体开发": [
                                { "status": "待解锁" }
                            ]
                        }
                    ]
                }
            }
        });

        assert_eq!(
            get_nested_value(&state, "variables.<user>.成长之路[0].身体开发[0].status"),
            Some(serde_json::json!("待解锁"))
        );

        set_nested_value(
            &mut state,
            "variables.<user>.成长之路[0].身体开发[0].status",
            serde_json::json!("已掌握"),
        );

        assert_eq!(
            state["variables"]["<user>"]["成长之路"][0]["身体开发"][0]["status"],
            serde_json::json!("已掌握")
        );
    }

    #[test]
    fn detects_conflict_with_indexed_path() {
        let mut state = serde_json::json!({
            "variables": {
                "<user>": {
                    "精神状态数值": {
                        "调教值": ["0 | 最初的苏醒", "说明"]
                    }
                }
            }
        });
        let change = StateChangeCandidate {
            op: "update".to_string(),
            target: "variables.<user>.精神状态数值.调教值[0]".to_string(),
            from: Some(serde_json::json!("1 | 已变化")),
            to: serde_json::json!("2 | 新值"),
            evidence_turns: vec![],
        };

        assert!(apply_single_change(&mut state, &change).is_err());
    }
}
