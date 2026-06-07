use crate::error::AppError;
use crate::runtime::types::StateChangeCandidate;
use sqlx::{Sqlite, Transaction};

#[derive(Debug, Clone, Default)]
pub struct VariableExtraction {
    pub display_text: String,
    pub changes: Vec<StateChangeCandidate>,
}

/// Extract SillyTavern/MVU-style variable update blocks from model output.
///
/// Supported forms inside `<UpdateVariable>...</UpdateVariable>`:
/// - JSON object: `{ "hp": 10, "profile.name": "Alice" }`
/// - JSON object with `variables`: `{ "variables": { "hp": 10 } }`
/// - JSON array of state changes: `[{"target":"variables.hp","to":10}]`
/// - Line pairs: `hp: 10`, `hp = 10`, `hp -> 10`
pub fn extract(text: &str) -> VariableExtraction {
    let (display_text, blocks) = strip_blocks(text);
    let mut changes = Vec::new();

    for block in blocks {
        changes.extend(parse_block(&block));
    }

    VariableExtraction {
        display_text: display_text.trim().to_string(),
        changes,
    }
}

pub async fn persist_extraction_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    turn_number: i32,
    extraction: &VariableExtraction,
) -> Result<(), AppError> {
    let changes: Vec<_> = extraction
        .changes
        .iter()
        .filter(|change| change.target.to_lowercase().starts_with("variables."))
        .cloned()
        .collect();

    if changes.is_empty() {
        return Ok(());
    }

    let current_state: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;

    let mut state_json = current_state
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    for change in &changes {
        set_nested_value(&mut state_json, &change.target, change.to.clone());
    }

    let max_version: Option<i32> =
        sqlx::query_scalar("SELECT MAX(version) FROM state_snapshots WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await?;

    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at) VALUES (?, ?, ?, ?, 'low', 'variable_parser', ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(max_version.unwrap_or(0) + 1)
    .bind(state_json.to_string())
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    tracing::info!(
        session = session_id,
        turn = turn_number,
        variables = changes.len(),
        "Variable updates persisted"
    );
    Ok(())
}

fn strip_blocks(text: &str) -> (String, Vec<String>) {
    let mut output = String::new();
    let mut blocks = Vec::new();
    let mut cursor = 0usize;

    while let Some((rel_start, open_len)) = find_update_open(&text[cursor..]) {
        let start = cursor + rel_start;
        output.push_str(&text[cursor..start]);
        let body_start = start + open_len;

        if let Some((rel_end, close_len)) = find_update_close(&text[body_start..]) {
            let end = body_start + rel_end;
            blocks.push(text[body_start..end].trim().to_string());
            cursor = end + close_len;
        } else {
            blocks.push(text[body_start..].trim().to_string());
            cursor = text.len();
            break;
        }
    }

    output.push_str(&text[cursor..]);
    (output, blocks)
}

fn find_update_open(text: &str) -> Option<(usize, usize)> {
    let start = text.find("<UpdateVariable")?;
    let close = text[start..].find('>')?;
    Some((start, close + 1))
}

fn find_update_close(text: &str) -> Option<(usize, usize)> {
    if let Some(idx) = text.find("</UpdateVariable>") {
        return Some((idx, "</UpdateVariable>".len()));
    }
    text.find("</UpdateVariablevariable>")
        .map(|idx| (idx, "</UpdateVariablevariable>".len()))
}

fn parse_block(block: &str) -> Vec<StateChangeCandidate> {
    let normalized = strip_initvar_tags(strip_code_fence(block.trim()));
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return parse_json_value(&value);
    }

    parse_lines(trimmed)
}

fn strip_initvar_tags(text: &str) -> String {
    text.replace("<initvar>", "")
        .replace("</initvar>", "")
        .replace("<InitVar>", "")
        .replace("</InitVar>", "")
}

fn strip_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }

    let without_open = match trimmed.find('\n') {
        Some(idx) => &trimmed[idx + 1..],
        None => return trimmed,
    };

    match without_open.rfind("```") {
        Some(idx) => without_open[..idx].trim(),
        None => without_open.trim(),
    }
}

fn parse_json_value(value: &serde_json::Value) -> Vec<StateChangeCandidate> {
    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(parse_change_object)
            .collect::<Vec<_>>(),
        serde_json::Value::Object(map) => {
            if let Some(vars) = map.get("variables").and_then(|v| v.as_object()) {
                return vars
                    .iter()
                    .map(|(key, value)| make_change(key, value.clone()))
                    .collect();
            }

            if let Some(change) = parse_change_object(value) {
                return vec![change];
            }

            map.iter()
                .filter(|(key, _)| is_safe_key(key))
                .map(|(key, value)| make_change(key, value.clone()))
                .collect()
        }
        _ => vec![],
    }
}

fn parse_change_object(value: &serde_json::Value) -> Option<StateChangeCandidate> {
    let obj = value.as_object()?;
    let target = obj
        .get("target")
        .or_else(|| obj.get("path"))
        .and_then(|v| v.as_str())?;
    if !is_safe_key(target) {
        return None;
    }
    let to = obj
        .get("to")
        .or_else(|| obj.get("value"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Some(StateChangeCandidate {
        op: obj
            .get("op")
            .and_then(|v| v.as_str())
            .unwrap_or("update")
            .to_string(),
        target: normalize_target(target),
        from: obj.get("from").cloned(),
        to,
        evidence_turns: vec![],
    })
}

fn parse_lines(text: &str) -> Vec<StateChangeCandidate> {
    let mut changes = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();

    for raw_line in text.lines() {
        let without_marker = raw_line
            .trim_start()
            .trim_start_matches('-')
            .trim_start_matches('*');
        let indent = raw_line.len().saturating_sub(raw_line.trim_start().len());
        let line = without_marker.trim();
        if line.is_empty() {
            continue;
        }

        while stack.last().map_or(false, |(level, _)| *level >= indent) {
            stack.pop();
        }

        let Some((key, raw_value)) = split_assignment(line) else {
            continue;
        };
        if !is_safe_key(key) {
            continue;
        }

        if raw_value.is_empty() {
            stack.push((indent, key.to_string()));
            continue;
        }

        let mut path_parts: Vec<String> = stack.iter().map(|(_, key)| key.clone()).collect();
        path_parts.push(key.to_string());
        let path = path_parts.join(".");
        if is_safe_key(&path) {
            changes.push(make_change(&path, parse_scalar(raw_value)));
        }
    }

    changes
}

fn split_assignment(line: &str) -> Option<(&str, &str)> {
    for sep in ["->", "=", "：", ":"] {
        if let Some(idx) = line.find(sep) {
            let key = line[..idx].trim();
            let value = line[idx + sep.len()..].trim();
            if !key.is_empty() {
                return Some((key, value));
            }
        }
    }
    None
}

fn make_change(key: &str, value: serde_json::Value) -> StateChangeCandidate {
    StateChangeCandidate {
        op: "update".to_string(),
        target: normalize_target(key),
        from: None,
        to: value,
        evidence_turns: vec![],
    }
}

fn set_nested_value(state: &mut serde_json::Value, path: &str, value: serde_json::Value) {
    if !state.is_object() {
        *state = serde_json::json!({});
    }
    let parts: Vec<&str> = path.split('.').collect();
    set_nested_recursive(state, &parts, value);
}

fn set_nested_recursive(current: &mut serde_json::Value, parts: &[&str], value: serde_json::Value) {
    if parts.is_empty() {
        return;
    }
    if parts.len() == 1 {
        if let Some(obj) = current.as_object_mut() {
            obj.insert(parts[0].to_string(), value);
        }
        return;
    }

    if !current.is_object() {
        *current = serde_json::json!({});
    }
    let next = current
        .as_object_mut()
        .expect("object initialized")
        .entry(parts[0].to_string())
        .or_insert_with(|| serde_json::json!({}));
    set_nested_recursive(next, &parts[1..], value);
}

fn normalize_target(key: &str) -> String {
    let trimmed = key.trim().trim_matches('"').trim_matches('\'');
    if trimmed.starts_with("variables.") {
        trimmed.to_string()
    } else {
        format!("variables.{}", trimmed)
    }
}

fn parse_scalar(raw: &str) -> serde_json::Value {
    let value = raw.trim().trim_end_matches(',');
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(value) {
        return json;
    }
    if value.eq_ignore_ascii_case("true") {
        return serde_json::Value::Bool(true);
    }
    if value.eq_ignore_ascii_case("false") {
        return serde_json::Value::Bool(false);
    }
    if let Ok(n) = value.parse::<i64>() {
        return serde_json::json!(n);
    }
    if let Ok(n) = value.parse::<f64>() {
        return serde_json::json!(n);
    }
    serde_json::Value::String(value.trim_matches('"').trim_matches('\'').to_string())
}

fn is_safe_key(key: &str) -> bool {
    let key = key.trim();
    if key.is_empty() || key.len() > 256 {
        return false;
    }
    let lower = key.to_lowercase();
    if lower.starts_with("hidden_")
        || lower.starts_with("secret_")
        || lower.starts_with("internal_")
        || lower.starts_with("world_rules")
        || lower.starts_with("meta")
        || lower.starts_with("gm_notes")
    {
        return false;
    }
    key.chars().all(|c| {
        c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' ' | '/' | ':' | '：' | '<' | '>')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_variables_and_removes_block_from_display_text() {
        let result = extract(
            "正文开始\n<UpdateVariable>{\"hp\": 9, \"profile.name\": \"浅野堇\"}</UpdateVariable>\n正文结束",
        );

        assert_eq!(result.display_text, "正文开始\n\n正文结束");
        assert_eq!(result.changes.len(), 2);
        assert!(
            result
                .changes
                .iter()
                .any(|c| c.target == "variables.hp" && c.to == serde_json::json!(9))
        );
        assert!(result.changes.iter().any(|c| {
            c.target == "variables.profile.name" && c.to == serde_json::json!("浅野堇")
        }));
    }

    #[test]
    fn parses_line_based_updates() {
        let result = extract(
            "<UpdateVariable>
            mood: calm
            trust = 3
            awake -> true
            </UpdateVariable>",
        );

        assert_eq!(result.changes.len(), 3);
        assert!(
            result
                .changes
                .iter()
                .any(|c| c.target == "variables.trust" && c.to == serde_json::json!(3))
        );
        assert!(
            result
                .changes
                .iter()
                .any(|c| c.target == "variables.awake" && c.to == serde_json::json!(true))
        );
    }

    #[test]
    fn filters_restricted_targets() {
        let result = extract(
            "<UpdateVariable>{\"variables\":{\"hp\":10},\"world_rules.owner\":\"bad\",\"secret_key\":\"bad\"}</UpdateVariable>",
        );

        assert_eq!(result.changes.len(), 1);
        assert_eq!(result.changes[0].target, "variables.hp");
    }

    #[test]
    fn allows_user_placeholder_paths() {
        let result = extract(
            "<UpdateVariable>{\"<user>.精神状态数值.调教值\":\"12 | 初始\"}</UpdateVariable>",
        );

        assert_eq!(result.changes.len(), 1);
        assert_eq!(
            result.changes[0].target,
            "variables.<user>.精神状态数值.调教值"
        );
    }

    #[test]
    fn test_is_safe_key_prefix_not_substring() {
        // Keys that CONTAIN but don't START WITH sensitive prefixes should be allowed
        assert!(is_safe_key("data_hidden_room"));
        assert!(is_safe_key("my_secret_garden"));
        assert!(is_safe_key("the_internal_logic"));

        // Keys that START WITH sensitive prefixes should still be blocked
        assert!(!is_safe_key("hidden_location"));
        assert!(!is_safe_key("secret_npc_name"));
        assert!(!is_safe_key("internal_state"));
    }
}
