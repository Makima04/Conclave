//! Simple nested JSON variable storage for character card sessions.
//!
//! This module is intentionally minimal: no state adapter, no canonical-to-platform
//! mapping, no double-layer write gates. It reads/writes a flat variables blob in
//! the `session_variables` table, keyed by session_id.
//!
//! # API
//!
//! ```text
//! GET  /api/sessions/{session_id}/variables
//! PUT  /api/sessions/{session_id}/variables
//! ```
//!
//! # LLM Tool definitions (for later integration)
//!
//! - `read_variable(session_id: String, path: String) -> Option<Value>`
//!   Returns the value at the given path in the session's variables blob.
//!
//! - `write_variable(session_id: String, path: String, value: Value) -> Value`
//!   Deep-sets the value at the given path, upserting the row, and returns the
//!   full updated variables blob.

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Split a dotted/bracketed path into a flat list of `(key, optional_index)`
/// segments, supporting multiple bracket indices per component.
///
///   `"foo.bar"`         → `[("foo",None), ("bar",None)]`
///   `"targets[0].x"`    → `[("targets",Some(0)), ("x",None)]`
///   `"a[1][2].b"`       → `[("a",Some(1)), ("",Some(2)), ("b",None)]`
///
/// A `[n]` immediately following a key attaches to that key's segment; a `[n]`
/// following another index (consecutive brackets) becomes an empty-key index
/// segment. Empty/`.`-only paths return an empty list (no mutation).
fn parse_path(path: &str) -> Vec<(String, Option<usize>)> {
    let mut out: Vec<(String, Option<usize>)> = Vec::new();
    let mut chars = path.trim().chars().peekable();
    let mut key = String::new();

    while let Some(ch) = chars.next() {
        match ch {
            '.' => {
                if !key.is_empty() {
                    out.push((std::mem::take(&mut key), None));
                }
            }
            '[' => {
                // Read digits until the closing ']'.
                let mut num = String::new();
                while let Some(&c) = chars.peek() {
                    if c == ']' {
                        chars.next();
                        break;
                    }
                    num.push(c);
                    chars.next();
                }
                let idx = num.parse::<usize>().ok();
                if !key.is_empty() {
                    // `[n]` attaches to the pending key.
                    out.push((std::mem::take(&mut key), idx));
                } else {
                    // Consecutive brackets: empty-key index segment.
                    out.push((String::new(), idx));
                }
            }
            c => key.push(c),
        }
    }
    if !key.is_empty() {
        out.push((key, None));
    }
    out
}

/// Ensure `cursor` is a JSON Object, converting it from Null / non-Object
/// types when necessary.
fn ensure_object(cursor: &mut Value, key: &str) {
    match cursor {
        Value::Object(map) => {
            if !map.contains_key(key) {
                map.insert(key.to_string(), Value::Object(Map::new()));
            }
        }
        Value::Null | Value::Array(_) | Value::String(_) | Value::Number(_) | Value::Bool(_) => {
            let mut map = Map::new();
            map.insert(key.to_string(), Value::Object(Map::new()));
            *cursor = Value::Object(map);
        }
    }
}

/// Ensure the cursor is an Array with at least `idx + 1` elements.
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

/// Ensure `cursor[key]` is an Array with at least `idx + 1` elements, WITHOUT
/// converting an existing array into an object. Used by `set_by_path` for a
/// final `key[index]` segment so that writing the value slot of an MVU-style
/// `[value, "说明"]` array overwrites only `[index]` and preserves the siblings
/// (e.g. the 说明 at `[1]`).
fn ensure_array_key(cursor: &mut Value, key: &str, idx: usize) {
    ensure_object(cursor, key);
    let entry = cursor.get_mut(key).expect("key inserted by ensure_object");
    ensure_array_index(entry, idx);
}

/// Deep-set the `value` at the given path, creating intermediate objects and
/// arrays as needed.
fn set_by_path(root: &mut Value, path: &str, value: Value) {
    let segments = parse_path(path);
    if segments.is_empty() {
        return;
    }

    let last_idx = segments.len() - 1;

    // Walk to the second-to-last segment, creating containers on demand.
    let mut cursor = root;
    for i in 0..last_idx {
        let (key, index) = &segments[i];
        if !key.is_empty() {
            ensure_object(cursor, key);
            cursor = cursor.get_mut(key).unwrap();
        }
        if let Some(idx) = index {
            ensure_array_index(cursor, *idx);
            cursor = &mut cursor[*idx];
        }
    }

    // Write the final segment.
    let (last_key, last_index) = &segments[last_idx];
    if last_key.is_empty() {
        // Pure index segment on an existing array: write the slot, preserve siblings.
        if let Some(idx) = last_index {
            ensure_array_index(cursor, *idx);
            cursor[*idx] = value;
        }
    } else if let Some(idx) = last_index {
        // `key[index]` on the parent: ensure the key holds an array and write the
        // slot, preserving siblings (e.g. MVU [value, "说明"] — keep 说明).
        ensure_array_key(cursor, last_key, *idx);
        cursor.get_mut(last_key).unwrap()[*idx] = value;
    } else {
        ensure_object(cursor, last_key);
        cursor[last_key.clone()] = value;
    }
}

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PutVariablesBody {
    /// Single path-value pair: `{ "path": "targets[0].affinity", "value": 85 }`
    pub path: Option<String>,
    pub value: Option<Value>,
    /// Batch change set: `{ "changes": { "targets[0].affinity": 85 } }`
    pub changes: Option<Value>,
}

#[derive(Serialize)]
pub struct GetVariablesResponse {
    pub variables: Value,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Database row
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct SessionVariablesRow {
    variables: String,
    updated_at: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `GET /api/sessions/{session_id}/variables`
///
/// Returns the session's variables blob.  If no row exists yet, returns
/// `{ variables: {}, updatedAt: null }`.
pub async fn get_variables(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<GetVariablesResponse>, AppError> {
    let row = sqlx::query_as::<_, SessionVariablesRow>(
        "SELECT variables, updated_at FROM session_variables WHERE session_id = ?",
    )
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?;

    match row {
        Some(r) => {
            let variables = serde_json::from_str(&r.variables).unwrap_or_else(|_| json!({}));
            Ok(Json(GetVariablesResponse {
                variables,
                updated_at: Some(r.updated_at),
            }))
        }
        None => Ok(Json(GetVariablesResponse {
            variables: json!({}),
            updated_at: None,
        })),
    }
}

/// `PUT /api/sessions/{session_id}/variables`
///
/// Accepts either a single `{ path, value }` or a batch `{ changes }` map
/// and deep-sets each into the session's variables blob (dot-notation +
/// `[index]` paths supported). The row is upserted and the full updated blob
/// is returned.
pub async fn put_variables(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<PutVariablesBody>,
) -> Result<Json<GetVariablesResponse>, AppError> {
    // Validate at least one change is provided.
    let has_single = body.path.is_some() && body.value.is_some();
    let has_changes = body
        .changes
        .as_ref()
        .and_then(|c| c.as_object())
        .is_some_and(|m| !m.is_empty());

    if !has_single && !has_changes {
        return Err(AppError::BadRequest(
            "Either 'path' + 'value' or a non-empty 'changes' object is required".to_string(),
        ));
    }

    // Load existing variables (or start with empty object).
    let existing = sqlx::query_as::<_, SessionVariablesRow>(
        "SELECT variables, updated_at FROM session_variables WHERE session_id = ?",
    )
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?;

    let mut variables: Value = existing
        .as_ref()
        .and_then(|r| serde_json::from_str(&r.variables).ok())
        .unwrap_or_else(|| json!({}));
    if !variables.is_object() {
        variables = json!({});
    }

    // Apply single path-value.
    if let (Some(path), Some(value)) = (&body.path, body.value) {
        set_by_path(&mut variables, path, value.clone());
    }

    // Apply batch changes.
    if let Some(Value::Object(changes)) = &body.changes {
        for (path, value) in changes {
            set_by_path(&mut variables, path, value.clone());
        }
    }

    let variables_str = serde_json::to_string(&variables).unwrap_or_else(|_| "{}".to_string());
    let now = chrono::Utc::now().to_rfc3339();

    // Upsert.
    sqlx::query(
        "INSERT INTO session_variables (id, session_id, variables, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
             variables = excluded.variables,
             updated_at = excluded.updated_at",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&session_id)
    .bind(&variables_str)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await?;

    Ok(Json(GetVariablesResponse {
        variables,
        updated_at: Some(now),
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_path_simple_keys() {
        assert_eq!(
            parse_path("foo.bar"),
            vec![("foo".into(), None), ("bar".into(), None),]
        );
    }

    #[test]
    fn parse_path_with_bracket_index() {
        assert_eq!(
            parse_path("targets[0].affinity"),
            vec![("targets".into(), Some(0)), ("affinity".into(), None),]
        );
    }

    #[test]
    fn parse_path_multiple_indices() {
        assert_eq!(
            parse_path("a[1][2].b"),
            vec![
                ("a".into(), Some(1)),
                ("".into(), Some(2)),
                ("b".into(), None),
            ]
        );
    }

    #[test]
    fn parse_path_empty_returns_empty() {
        assert!(parse_path("").is_empty());
        assert!(parse_path(".").is_empty());
    }

    #[test]
    fn set_by_path_creates_nested_objects() {
        let mut root = json!({});
        set_by_path(&mut root, "a.b.c", json!(42));
        assert_eq!(root["a"]["b"]["c"], json!(42));
    }

    #[test]
    fn set_by_path_creates_arrays() {
        let mut root = json!({});
        set_by_path(&mut root, "items[2].name", json!("third"));
        let names: Vec<_> = root["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["name"].as_str().unwrap_or(""))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["", "", "third"]);
    }

    #[test]
    fn set_by_path_overwrites_existing() {
        let mut root = json!({ "score": 10 });
        set_by_path(&mut root, "score", json!(99));
        assert_eq!(root["score"], json!(99));
    }

    #[test]
    fn set_by_path_dot_only_skips() {
        let mut root = json!({ "x": 1 });
        set_by_path(&mut root, ".", json!(2));
        // The path ". " splits to [""], which has an empty key and no index →
        // no segments are returned, so no mutation happens.
        assert_eq!(root["x"], json!(1));
    }

    #[test]
    fn set_by_path_preserves_value_explanation_array_siblings() {
        // MVU variables are stored as [value, "说明"]. Writing the value slot
        // must overwrite only [0] and keep the 说明 at [1].
        let mut root = json!({ "时幼微": { "耐心值": [72, "对主人的忍耐"] } });
        set_by_path(&mut root, "时幼微.耐心值[0]", json!(90));
        let arr = root["时幼微"]["耐心值"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "说明 must be preserved, not dropped");
        assert_eq!(arr[0], json!(90));
        assert_eq!(arr[1], json!("对主人的忍耐"));
    }

    #[test]
    fn set_by_path_creates_value_slot_in_empty_mv_array() {
        // Writing a value slot where the array doesn't exist yet creates it.
        let mut root = json!({ "世界": {} });
        set_by_path(&mut root, "世界.当前时间[0]", json!("夜晚"));
        assert_eq!(root["世界"]["当前时间"][0], json!("夜晚"));
    }
}
