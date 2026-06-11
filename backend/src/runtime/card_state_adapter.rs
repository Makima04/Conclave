//! Minimal state adapter — v3 architecture replaces contract-based state normalization
//! with simple JSON path read/write on session_variables.
//!
//! This module exists to maintain source compatibility with the 6 callers that
//! still reference `crate::runtime::card_state_adapter`. All functions now
//! operate as pass-throughs with no path mapping, no write-rule gates, and no
//! canonical-to-platform projection.

use crate::error::AppError;
use crate::runtime::types::StateChangeCandidate;
use serde_json::{Map, Value};
use sqlx::{Sqlite, SqlitePool, Transaction};

// ---------------------------------------------------------------------------
// Contract types (minimal stubs)
// ---------------------------------------------------------------------------

/// Minimal session state contract for v3. In the previous architecture this
/// carried canonical↔platform path mappings, read/write rules, and adapter
/// metadata. In v3 all of that machinery is removed: variables are stored as
/// raw JSON with no double-layer projection.
#[derive(Debug, Clone)]
pub struct SessionStateContract {
    /// Identifies the adapter source (e.g. "card_v3", "mvu"). Kept for logging.
    pub source: String,
    /// Minimal rule holder — always empty in v3.
    pub adapter: ContractAdapter,
}

/// Minimal adapter config — rules are always empty in v3.
#[derive(Debug, Clone)]
pub struct ContractAdapter {
    pub read_rules: Vec<String>,
    pub write_rules: Vec<String>,
}

// ---------------------------------------------------------------------------
// 1. Path access
// ---------------------------------------------------------------------------

/// Parse a dot-path segment with optional `[index]` suffix.
///
/// `"targets[0]"` → `("targets", Some(0))`
/// `"affinity"`   → `("affinity", None)`
fn parse_path_part(part: &str) -> (&str, Option<usize>) {
    if let Some(open) = part.rfind('[') {
        if part.ends_with(']') {
            let key = &part[..open];
            let index = part[open + 1..part.len() - 1].parse::<usize>().ok();
            return (key, index);
        }
    }
    (part, None)
}

/// Read the value at the given dot-path from a JSON tree.
///
/// Returns `None` if any segment does not exist.
pub fn get_path_value<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cursor = root;
    for part in path.split('.') {
        let (key, index) = parse_path_part(part);
        if !key.is_empty() {
            cursor = cursor.get(key)?;
        }
        if let Some(idx) = index {
            cursor = cursor.get(idx)?;
        }
    }
    Some(cursor)
}

// ---------------------------------------------------------------------------
// 2-3. Session contract loading
// ---------------------------------------------------------------------------

/// Load a session state contract from the database.
///
/// In v3 there is no contract table — always returns `Ok(None)`.
pub async fn load_session_contract(
    _pool: &SqlitePool,
    _session_id: &str,
    _fallback_variables: Option<&Value>,
) -> Result<Option<SessionStateContract>, AppError> {
    Ok(None)
}

/// Transaction-scoped variant of [`load_session_contract`].
///
/// In v3 there is no contract table — always returns `Ok(None)`.
pub async fn load_session_contract_tx_for_routes(
    _tx: &mut Transaction<'_, Sqlite>,
    _session_id: &str,
    _fallback_variables: Option<&Value>,
) -> Result<Option<SessionStateContract>, AppError> {
    Ok(None)
}

// ---------------------------------------------------------------------------
// 4-5. State normalization / projection
// ---------------------------------------------------------------------------

/// Build a normalized state from raw state and an optional projection.
///
/// In v3 this simply sets the `variables` key when a projection is provided;
/// otherwise it returns the state unchanged.
pub fn build_normalized_state(
    state: &Value,
    _contract: &SessionStateContract,
    projection: Option<Value>,
) -> Value {
    let mut out = state.clone();
    if let Some(vars) = projection {
        if let Some(obj) = out.as_object_mut() {
            obj.insert("variables".to_string(), vars);
        }
    }
    out
}

/// Return the writable subset of state for the LLM tool context.
///
/// In v3 there is no filtering — the entire state is writable.
pub fn tool_state_for_context(
    state: &Value,
    _contract: Option<&SessionStateContract>,
) -> Value {
    state.clone()
}

// ---------------------------------------------------------------------------
// 6-7. Change application
// ---------------------------------------------------------------------------

/// Apply agent-proposed state changes directly with no write-rule gating.
///
/// Returns the set of accepted target paths (all of them in v3).
pub fn apply_agent_changes(
    state: &mut Value,
    changes: &[StateChangeCandidate],
    _contract: Option<&SessionStateContract>,
) -> Vec<String> {
    let mut accepted = Vec::with_capacity(changes.len());
    for change in changes {
        apply_single_change(state, change);
        accepted.push(change.target.clone());
    }
    accepted
}

/// Apply a set of `(path, value)` pairs to a projection value.
///
/// Returns `(new_projection, rejected_paths)` — in v3 nothing is rejected.
pub fn apply_projection_change_set(
    current: &Value,
    changes: &[(String, Value)],
    _contract: &SessionStateContract,
) -> (Value, Vec<String>) {
    let mut proj = current.clone();
    for (path, value) in changes {
        set_by_path(&mut proj, path, value.clone());
    }
    (proj, Vec::new())
}

/// Apply a single `StateChangeCandidate` to a mutable JSON root.
fn apply_single_change(state: &mut Value, change: &StateChangeCandidate) {
    match change.op.as_str() {
        "update" | "add" => {
            set_by_path(state, &change.target, change.to.clone());
        }
        "remove" => {
            remove_by_path(state, &change.target);
        }
        _ => {
            // Unknown op — fall back to set
            set_by_path(state, &change.target, change.to.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// 8. Persistence
// ---------------------------------------------------------------------------

/// Persist a set of state changes to the `session_variables` table.
///
/// Reads the current variables blob, applies the changes via deep-set, and
/// upserts back. This is the v3 replacement for the old contract-aware
/// persistence path.
pub async fn persist_normalized_changes_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    changes: &[StateChangeCandidate],
    _source: &str,
) -> Result<(), AppError> {
    if changes.is_empty() {
        return Ok(());
    }

    // Read current variables (or start with empty object)
    let current_row: Option<(String,)> = sqlx::query_as(
        "SELECT variables FROM session_variables WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;

    let mut variables: Value = current_row
        .and_then(|(json,)| serde_json::from_str(&json).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));

    // Apply changes
    for change in changes {
        let relative = change
            .target
            .strip_prefix("variables.")
            .unwrap_or(&change.target);
        match change.op.as_str() {
            "update" | "add" => {
                set_by_path(&mut variables, relative, change.to.clone());
            }
            "remove" => {
                remove_by_path(&mut variables, relative);
            }
            _ => {
                set_by_path(&mut variables, relative, change.to.clone());
            }
        }
    }

    // Upsert
    let variables_str = serde_json::to_string(&variables).unwrap_or_else(|_| "{}".to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO session_variables (id, session_id, variables, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
             variables = excluded.variables,
             updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(session_id)
    .bind(&variables_str)
    .bind(&now)
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    tracing::info!(
        session = session_id,
        changes = changes.len(),
        "Persisted variable changes to session_variables"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers — deep JSON navigation
// ---------------------------------------------------------------------------

fn ensure_object(cursor: &mut Value, key: &str) {
    match cursor {
        Value::Object(map) => {
            if !map.contains_key(key) {
                map.insert(key.to_string(), Value::Object(Map::new()));
            }
        }
        _ => {
            let mut map = Map::new();
            map.insert(key.to_string(), Value::Object(Map::new()));
            *cursor = Value::Object(map);
        }
    }
}

fn ensure_array_index(cursor: &mut Value, idx: usize) {
    match cursor {
        Value::Array(arr) => {
            if arr.len() <= idx {
                arr.resize(idx + 1, Value::Null);
            }
        }
        _ => {
            let mut arr = Vec::with_capacity(idx + 1);
            arr.resize(idx + 1, Value::Null);
            *cursor = Value::Array(arr);
        }
    }
}

fn set_by_path(root: &mut Value, path: &str, value: Value) {
    let segments: Vec<_> = path
        .split('.')
        .map(|part| {
            let (key, idx) = parse_path_part(part);
            (key.to_string(), idx)
        })
        .collect();

    if segments.is_empty() {
        return;
    }

    let last = segments.len() - 1;

    let mut cursor = root;
    for i in 0..last {
        let (ref key, idx) = segments[i];
        if !key.is_empty() {
            ensure_object(cursor, key);
            cursor = cursor.get_mut(key).unwrap();
        }
        if let Some(idx) = idx {
            ensure_array_index(cursor, idx);
            cursor = cursor.get_mut(idx).unwrap();
        }
    }

    let (ref key, idx) = segments[last];
    if !key.is_empty() {
        if let Value::Object(map) = cursor {
            map.insert(key.clone(), value.clone());
        } else {
            let mut map = Map::new();
            map.insert(key.clone(), value.clone());
            *cursor = Value::Object(map);
        }
    }
    if let Some(idx) = idx {
        ensure_array_index(cursor, idx);
        cursor[idx] = value;
    }
}

fn remove_by_path(root: &mut Value, path: &str) {
    let segments: Vec<_> = path
        .split('.')
        .map(|part| {
            let (key, idx) = parse_path_part(part);
            (key.to_string(), idx)
        })
        .collect();

    if segments.is_empty() {
        return;
    }

    let last = segments.len() - 1;

    let mut cursor = root;
    for i in 0..last {
        let (ref key, idx) = segments[i];
        if !key.is_empty() {
            match cursor.get_mut(key) {
                Some(next) => cursor = next,
                None => return, // path doesn't exist
            }
        }
        if let Some(idx) = idx {
            match cursor.get_mut(idx) {
                Some(next) => cursor = next,
                None => return,
            }
        }
    }

    let (ref key, idx) = segments[last];
    if let Some(idx) = idx {
        if let Value::Array(arr) = cursor {
            if idx < arr.len() {
                arr.remove(idx);
            }
        }
    } else if !key.is_empty() {
        if let Value::Object(map) = cursor {
            map.remove(key);
        }
    }
}
