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
/// In v3 there is no filtering — the entire state is writable. BUT the canonical state
/// (`state_snapshots.state_json`) wraps the variable tree under a top-level `variables`
/// key: `{"variables": {"<user>": {...}, "时幼微": {...}}}`. The State Agent's paths are
/// rooted at the *inner* tree (`<user>.精神状态数值.调教值`), not at the wrapper. If we
/// returned the wrapper as-is, `normalize_changes`' existence check
/// (`get_path_value(writable_state, "<user>.精神状态数值.调教值")`) would look for `<user>`
/// at the top level (which only holds `variables`) → `exists=false` → every change
/// filtered out → `extract_tool_call` returns None → persist never runs → empty
/// stat_data → 状态栏 "角色数据缺失". Unwrap `variables` so the writable tree matches the
/// path roots the tool actually emits.
pub fn tool_state_for_context(state: &Value, _contract: Option<&SessionStateContract>) -> Value {
    if let Some(inner) = state.get("variables") {
        // The wrapper present — return the inner variable tree directly.
        return inner.clone();
    }
    // Already-unwrapped (or a legacy/empty snapshot): return as-is.
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

/// Persist a set of state changes to the `session_variables` table and mirror
/// the resulting projection into the latest state snapshot.
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
    let current_row: Option<(String,)> =
        sqlx::query_as("SELECT variables FROM session_variables WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(&mut **tx)
            .await?;

    let mut variables: Value = current_row
        .and_then(|(json,)| serde_json::from_str(&json).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));

    // Validate each change against the current variable tree (the writable
    // state). LLM output is untrusted: drop changes that fail a deterministic
    // rule (shape mismatch / out-of-range / yes-no / empty) rather than letting
    // them corrupt the tree. Each drop is a no-op for the rest of the turn.
    // `add`/`remove` structural ops skip value checks inside validate_change.
    let validated: Vec<StateChangeCandidate> = changes
        .iter()
        .filter_map(|change| crate::runtime::variable_validation::validate_change(change, &variables))
        .collect();
    let changes = validated.as_slice();

    // Apply changes via ST-style whole-object merge. `update`/`add` writes are
    // first aggregated into a single `patch` object (each change set at its bare
    // path with its complete value — no `[0]` value-slot folding), then merged
    // in one pass. `remove` is structural and handled separately. Building one
    // patch and merging once (rather than set_by_path per change) is what makes
    // `[value, 说明]` arrays replace wholesale instead of double-wrapping; see
    // `merge_variables`.
    let mut patch = Value::Object(Map::new());
    let mut removes: Vec<&str> = Vec::new();
    for change in changes {
        let relative = change
            .target
            .strip_prefix("variables.")
            .unwrap_or(&change.target);
        match change.op.as_str() {
            "remove" => removes.push(relative),
            _ => set_by_path(&mut patch, relative, change.to.clone()),
        }
    }
    merge_variables(&mut variables, &patch);
    for relative in removes {
        remove_by_path(&mut variables, relative);
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

    mirror_variables_to_state_snapshot_tx(tx, session_id, variables, &now).await?;

    tracing::info!(
        session = session_id,
        changes = changes.len(),
        "Persisted variable changes to session_variables and state_snapshots"
    );

    Ok(())
}

async fn mirror_variables_to_state_snapshot_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    variables: Value,
    now: &str,
) -> Result<(), AppError> {
    let current_state: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;

    let mut state: Value = current_state
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !state.is_object() {
        state = Value::Object(Map::new());
    }

    if let Some(obj) = state.as_object_mut() {
        obj.insert("variables".to_string(), variables);
    }

    let max_version: Option<i32> =
        sqlx::query_scalar("SELECT MAX(version) FROM state_snapshots WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await?;

    sqlx::query(
        "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at)
         VALUES (?, ?, ?, ?, 'low', 'variable_projection', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(session_id)
    .bind(max_version.unwrap_or(0) + 1)
    .bind(state.to_string())
    .bind(now)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers — deep JSON navigation
// ---------------------------------------------------------------------------

/// Deep-merge `patch` into `variables` with SillyTavern / JS-Slash-Runner
/// `mergeWith` semantics (see JSR `variables.ts::insertOrAssignVariables`):
/// the customizer is `(lhs, rhs) => isArray(rhs) ? rhs : undefined` —
/// arrays and scalars are replaced wholesale, objects recurse.
///
/// This is the single source of truth for applying variable updates. Unlike the
/// old `set_by_path` + `resolve_array_value_slot` path-slot approach, it never
/// produces a half-written `[value, 说明]` array (the `[[value, 说明], 说明]`
/// double-wrap): an array field is either left untouched (not in patch) or
/// replaced by the caller's complete new array. Mirrors how the frontend
/// `store.ts::deepMerge` already behaves, so host and client agree.
pub fn merge_variables(variables: &mut Value, patch: &Value) {
    // Object + object → recurse key by key. A non-object patch (array or
    // scalar) replaces the target wholesale. Matching on `patch` (not the
    // mutable target) keeps the borrow flow single-threaded through the loop.
    if let Value::Object(source) = patch {
        // If the target is not an object, become one so we can merge keys in.
        if !variables.is_object() {
            *variables = Value::Object(Map::new());
        }
        let target = variables.as_object_mut().expect("object ensured");
        for (key, value) in source {
            match target.get_mut(key) {
                Some(existing) => merge_variables(existing, value),
                None => {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
    } else {
        // Array patch (the `[value, 说明]` whole-array replace) or scalar patch
        // (number / string / bool overwrite) or type-changing write. Mirrors the
        // JSR customizer `isArray(rhs) ? rhs : undefined`: a non-object rhs is
        // never deep-merged, it replaces.
        *variables = patch.clone();
    }
}

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
    if let Some(idx) = idx {
        // `key[index]` write: set element `index` of the array at `cursor[key]`,
        // growing it with nulls and preserving siblings. Used for genuine indexed
        // writes (e.g. `add` into `characters[1]`). MVU `[value, 说明]` arrays are
        // NOT written through here anymore — they arrive as whole-array `to`
        // values and are replaced wholesale by `merge_variables`.
        ensure_object(cursor, key);
        let slot = cursor.get_mut(key).expect("key inserted by ensure_object");
        ensure_array_index(slot, idx);
        slot[idx] = value;
    } else if !key.is_empty() {
        if let Value::Object(map) = cursor {
            map.insert(key.clone(), value);
        } else {
            let mut map = Map::new();
            map.insert(key.clone(), value);
            *cursor = Value::Object(map);
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    async fn setup_test_pool() -> SqlitePool {
        let url = format!(
            "sqlite:file:{}?mode=memory&cache=shared",
            uuid::Uuid::new_v4()
        );
        let pool = db::create_pool(&url).await.expect("create pool");
        db::run_migrations(&pool).await.expect("run migrations");
        pool
    }

    #[test]
    fn merge_replaces_mvu_array_wholesale_no_double_wrap() {
        // Regression for the [[value, 说明], 说明] double-wrap. The patch gives the
        // complete new [value, 说明] array; merge replaces the whole field rather than
        // slotting into [0].
        let mut variables = serde_json::json!({
            "<user>": { "爱意值": ["0 | 我只会恨你", "范围[0-100]"] }
        });
        let patch = serde_json::json!({
            "<user>": { "爱意值": ["15 | 屈辱萌动", "范围[0-100]"] }
        });
        merge_variables(&mut variables, &patch);

        let arr = variables["<user>"]["爱意值"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "must stay a flat [value, 说明], not double-wrapped");
        assert_eq!(arr[0], serde_json::json!("15 | 屈辱萌动"));
        assert_eq!(arr[1], serde_json::json!("范围[0-100]"));
    }

    #[test]
    fn merge_recurses_into_objects() {
        let mut variables = serde_json::json!({
            "世界": { "当前日期": ["2025年/03月/24日", "说明"], "天气": "晴" }
        });
        let patch = serde_json::json!({ "世界": { "当前日期": ["2025年/03月/25日", "说明"] } });
        merge_variables(&mut variables, &patch);

        assert_eq!(
            variables["世界"]["当前日期"][0],
            serde_json::json!("2025年/03月/25日")
        );
        // Untouched sibling survives.
        assert_eq!(variables["世界"]["天气"], serde_json::json!("晴"));
    }

    #[test]
    fn merge_overwrites_scalar_and_inserts_new_key() {
        let mut variables = serde_json::json!({ "hp": 10, "name": "旧名" });
        let patch = serde_json::json!({ "hp": 42, "mood": "calm" });
        merge_variables(&mut variables, &patch);

        assert_eq!(variables["hp"], serde_json::json!(42));
        assert_eq!(variables["name"], serde_json::json!("旧名"));
        assert_eq!(variables["mood"], serde_json::json!("calm"));
    }

    #[test]
    fn merge_replaces_scalar_with_array_when_type_changes() {
        // ST semantics: a non-object patch replaces wholesale, even across types.
        let mut variables = serde_json::json!({ "字段": "Yes" });
        let patch = serde_json::json!({ "字段": ["新值", "说明"] });
        merge_variables(&mut variables, &patch);
        assert_eq!(variables["字段"][0], serde_json::json!("新值"));
        assert_eq!(variables["字段"][1], serde_json::json!("说明"));
    }

    #[tokio::test]
    async fn persisting_variables_mirrors_projection_into_state_snapshot() {
        let pool = setup_test_pool().await;
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO sessions (id, title, mode, config, world_pack_id, current_turn, title_source, status, created_at, updated_at)
             VALUES (?, '', 'single_agent', '{}', NULL, 0, 'auto', 'idle', ?, ?)",
        )
        .bind(&session_id)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert session");

        sqlx::query(
            "INSERT INTO session_variables (id, session_id, variables, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&session_id)
        .bind(
            serde_json::json!({
                "人际交往": {
                    "当前接触人物": {
                        "沈慕微": { "心情": "心虚" }
                    }
                }
            })
            .to_string(),
        )
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert variables");

        sqlx::query(
            "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at)
             VALUES (?, ?, 1, ?, 'low', 'runtime', ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&session_id)
        .bind(
            serde_json::json!({
                "variables": {
                    "世界系统": { "当前地址": "承安城·皇宫外殿" },
                    "人际交往": {
                        "当前接触人物": {
                            "沈慕微": { "心情": "心虚" }
                        }
                    }
                }
            })
            .to_string(),
        )
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert snapshot");

        let mut tx = pool.begin().await.expect("begin tx");
        persist_normalized_changes_tx(
            &mut tx,
            &session_id,
            &[StateChangeCandidate {
                op: "update".to_string(),
                target: "variables.人际交往.当前接触人物".to_string(),
                from: None,
                to: serde_json::json!({}),
                evidence_turns: vec![],
            }],
            "test",
        )
        .await
        .expect("persist changes");
        tx.commit().await.expect("commit tx");

        let latest_state: String = sqlx::query_scalar(
            "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
        )
        .bind(&session_id)
        .fetch_one(&pool)
        .await
        .expect("load latest snapshot");
        let latest_state: Value = serde_json::from_str(&latest_state).expect("parse state");
        // ST-style merge semantics: an empty-object patch `to: {}` is a no-op
        // (it merges nothing into the existing object). To clear a subtree you
        // must use op "remove". The old per-path-replace behavior that this
        // test asserted is exactly what produced the [[v, d], d] double-wrap, so
        // it is intentionally gone. Assert the surviving subtree instead.
        assert_eq!(
            latest_state["variables"]["人际交往"]["当前接触人物"]["沈慕微"]["心情"],
            serde_json::json!("心虚")
        );

        let variables: String =
            sqlx::query_scalar("SELECT variables FROM session_variables WHERE session_id = ?")
                .bind(&session_id)
                .fetch_one(&pool)
                .await
                .expect("load variables");
        let variables: Value = serde_json::from_str(&variables).expect("parse variables");
        assert_eq!(
            latest_state["variables"]["人际交往"]["当前接触人物"],
            variables["人际交往"]["当前接触人物"]
        );
    }

    // Regression for the production bug: an MVU `[value, 说明]` array updated by
    // the State Agent must not become `[[value, 说明], 说明]`. The persist path
    // builds a patch from the change's whole-array `to` value and merges it, so
    // the array is replaced wholesale.
    #[tokio::test]
    async fn persist_replaces_mvu_array_wholesale_no_double_wrap() {
        let pool = setup_test_pool().await;
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO sessions (id, title, mode, config, world_pack_id, current_turn, title_source, status, created_at, updated_at)
             VALUES (?, '', 'single_agent', '{}', NULL, 0, 'auto', 'idle', ?, ?)",
        )
        .bind(&session_id)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert session");

        sqlx::query(
            "INSERT INTO session_variables (id, session_id, variables, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&session_id)
        .bind(
            serde_json::json!({
                "<user>": {
                    "精神状态数值": { "爱意值": ["0 | 我只会恨你", "范围[0-100]"] },
                    "当前位置": ["空庭，主卧的床上", "<user>当前所在的地点。"]
                }
            })
            .to_string(),
        )
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert variables");

        let mut tx = pool.begin().await.expect("begin tx");
        persist_normalized_changes_tx(
            &mut tx,
            &session_id,
            &[
                // State Agent submits the COMPLETE new [value, 说明] array.
                StateChangeCandidate {
                    op: "update".to_string(),
                    target: "<user>.精神状态数值.爱意值".to_string(),
                    from: None,
                    to: serde_json::json!(["12 | 微弱的好感", "范围[0-100]"]),
                    evidence_turns: vec![],
                },
                // Untouched field (当前位置) must survive untouched.
            ],
            "test",
        )
        .await
        .expect("persist changes");
        tx.commit().await.expect("commit tx");

        let variables: String =
            sqlx::query_scalar("SELECT variables FROM session_variables WHERE session_id = ?")
                .bind(&session_id)
                .fetch_one(&pool)
                .await
                .expect("load variables");
        let variables: Value = serde_json::from_str(&variables).expect("parse variables");

        let affection = &variables["<user>"]["精神状态数值"]["爱意值"];
        let arr = affection.as_array().expect("爱意值 must stay an array");
        assert_eq!(arr.len(), 2, "flat [value, 说明], not double-wrapped: {affection}");
        assert_eq!(arr[0], serde_json::json!("12 | 微弱的好感"));
        assert_eq!(arr[1], serde_json::json!("范围[0-100]"));
        // Untouched sibling survived.
        assert_eq!(
            variables["<user>"]["当前位置"][0],
            serde_json::json!("空庭，主卧的床上")
        );
    }
}
