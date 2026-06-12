use crate::error::AppError;
use crate::runtime::card_state_adapter;
use serde_json::{Map, Value};
use sqlx::SqlitePool;

/// Initialize a session's runtime state from a linked character card/world book.
///
/// SillyTavern + MVU cards commonly store the initial state in a disabled world
/// book entry whose comment is "[InitVar]". The platform treats that as raw card
/// state, converts it into canonical `platform_state`, then projects it back into
/// `variables` for card HTML/JS runtimes.
pub async fn initialize_session_state_from_world_book(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<bool, AppError> {
    initialize_session_state_from_world_book_inner(pool, session_id, false).await
}

pub async fn reinitialize_session_state_from_world_book(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<bool, AppError> {
    initialize_session_state_from_world_book_inner(pool, session_id, true).await
}

pub async fn initialize_session_state_from_content(
    pool: &SqlitePool,
    session_id: &str,
    content: &str,
    force_reset: bool,
) -> Result<bool, AppError> {
    let Some(initial_variables) = parse_init_variables(content).filter(has_object_content) else {
        return Ok(false);
    };

    initialize_session_state_with_variables(pool, session_id, initial_variables, force_reset).await
}

async fn initialize_session_state_from_world_book_inner(
    pool: &SqlitePool,
    session_id: &str,
    force_reset: bool,
) -> Result<bool, AppError> {
    let Some(world_pack_id): Option<String> = sqlx::query_scalar(
        "SELECT world_pack_id FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(false);
    };

    let Some(initial_variables) = load_initial_variables(pool, &world_pack_id).await? else {
        tracing::warn!(
            session = session_id,
            world_pack_id = %world_pack_id,
            "No parseable InitVar source found for linked world book"
        );
        return Ok(false);
    };

    initialize_session_state_with_variables(pool, session_id, initial_variables, force_reset).await
}

async fn initialize_session_state_with_variables(
    pool: &SqlitePool,
    session_id: &str,
    initial_variables: Value,
    force_reset: bool,
) -> Result<bool, AppError> {
    let mut current_state = if force_reset {
        serde_json::json!({})
    } else {
        latest_state(pool, session_id).await?
    };
    if !force_reset && has_initialized_state(&current_state) {
        return Ok(false);
    }
    let current_variables = current_state.get("variables").cloned();
    let merged_variables =
        merge_with_existing_variables(initial_variables, current_variables.as_ref());
    if current_variables.as_ref() == Some(&merged_variables)
        && has_initialized_state(&current_state)
        && !force_reset
    {
        return Ok(false);
    }

    let Some(contract) =
        card_state_adapter::load_session_contract(pool, session_id, Some(&merged_variables))
            .await?
    else {
        ensure_object(&mut current_state);
        if let Some(obj) = current_state.as_object_mut() {
            obj.insert("variables".to_string(), merged_variables);
        }
        commit_initialized_state(pool, session_id, &current_state).await?;
        return Ok(true);
    };

    let next_state = card_state_adapter::build_normalized_state(
        &current_state,
        &contract,
        Some(merged_variables),
    );

    if next_state == current_state {
        return Ok(false);
    }

    commit_initialized_state(pool, session_id, &next_state).await?;
    tracing::info!(
        session = session_id,
        source = %contract.source,
        "Initialized session state through card state adapter"
    );

    Ok(true)
}

pub fn parse_init_variables(content: &str) -> Option<serde_json::Value> {
    let normalized = normalize_initvar_source(content);
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(value) = parse_json_variables(trimmed) {
        return Some(value);
    }

    parse_indented_variables(trimmed)
}

async fn load_initial_variables(
    pool: &SqlitePool,
    world_pack_id: &str,
) -> Result<Option<Value>, AppError> {
    let init_entries: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM world_book_entries
         WHERE world_book_id = ?
           AND (LOWER(TRIM(comment)) LIKE '%initvar%' OR LOWER(content) LIKE '%<initvar%')
         ORDER BY created_at ASC",
    )
    .bind(world_pack_id)
    .fetch_all(pool)
    .await?;

    for content in init_entries {
        if let Some(value) = parse_init_variables(&content).filter(has_object_content) {
            return Ok(Some(value));
        }
    }

    let card_sources: Option<(String, String, String)> = sqlx::query_as(
        "SELECT first_mes, alternate_greetings, source_data
         FROM character_cards
         WHERE world_book_id = ?
         ORDER BY created_at ASC
         LIMIT 1",
    )
    .bind(world_pack_id)
    .fetch_optional(pool)
    .await?;

    let Some((first_mes, alternate_greetings, source_data)) = card_sources else {
        return Ok(None);
    };

    for source in character_card_init_sources(&first_mes, &alternate_greetings, &source_data) {
        if let Some(value) = parse_init_variables(&source).filter(has_object_content) {
            return Ok(Some(value));
        }
    }

    Ok(None)
}

fn character_card_init_sources(
    first_mes: &str,
    alternate_greetings: &str,
    source_data: &str,
) -> Vec<String> {
    let mut sources = Vec::new();
    sources.push(first_mes.to_string());

    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(alternate_greetings) {
        sources.extend(
            items
                .into_iter()
                .filter_map(|item| item.as_str().map(str::to_string)),
        );
    }

    if let Ok(value) = serde_json::from_str::<Value>(source_data) {
        collect_string_fields(
            &value,
            &[
                "first_mes",
                "firstMes",
                "alternate_greetings",
                "alternateGreetings",
            ],
            &mut sources,
        );
    }

    sources
}

fn collect_string_fields(value: &Value, keys: &[&str], out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if keys.contains(&key.as_str()) {
                    match child {
                        Value::String(text) => out.push(text.clone()),
                        Value::Array(items) => out.extend(
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(str::to_string)),
                        ),
                        _ => {}
                    }
                }
                collect_string_fields(child, keys, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_string_fields(item, keys, out);
            }
        }
        _ => {}
    }
}

fn parse_json_variables(text: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    match value {
        Value::Object(mut map) => {
            if let Some(variables) = map.remove("variables") {
                Some(variables)
            } else {
                Some(Value::Object(map))
            }
        }
        _ => None,
    }
}

fn normalize_initvar_source(content: &str) -> String {
    let without_fence = strip_code_fence(content.trim()).trim().to_string();
    let update_body = find_tag_body(&without_fence, "UpdateVariable")
        .or_else(|| find_tag_body(&without_fence, "UpdateVariablevariable"))
        .unwrap_or(without_fence);
    find_tag_body(&update_body, "initvar").unwrap_or(update_body)
}

fn find_tag_body(text: &str, tag: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let open_pattern = format!("<{}", tag.to_ascii_lowercase());
    let close_pattern = format!("</{}>", tag.to_ascii_lowercase());
    let start = lower.find(&open_pattern)?;
    let body_start = text[start..].find('>')? + start + 1;
    let end = lower[body_start..].find(&close_pattern)? + body_start;
    Some(text[body_start..end].trim().to_string())
}

fn strip_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let Some(first_break) = trimmed.find('\n') else {
        return trimmed;
    };
    let without_open = &trimmed[first_break + 1..];
    match without_open.rfind("```") {
        Some(idx) => without_open[..idx].trim(),
        None => without_open.trim(),
    }
}

fn parse_indented_variables(text: &str) -> Option<Value> {
    let mut root = Value::Object(Map::new());
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut wrote_value = false;

    for raw_line in text.lines() {
        let line_without_comment = raw_line.split('#').next().unwrap_or(raw_line);
        let indent = line_without_comment
            .len()
            .saturating_sub(line_without_comment.trim_start().len());
        let line = line_without_comment.trim();
        if line.is_empty() {
            continue;
        }

        while stack.last().map_or(false, |(level, _)| *level >= indent) {
            stack.pop();
        }

        if let Some(item) = line.strip_prefix("- ") {
            let path: Vec<String> = stack.iter().map(|(_, key)| key.clone()).collect();
            if !path.is_empty() {
                push_array_value(&mut root, &path, parse_scalar(item));
                wrote_value = true;
            }
            continue;
        }

        let Some((key, raw_value)) = split_assignment(line) else {
            continue;
        };
        if key.is_empty() {
            continue;
        }

        let mut path: Vec<String> = stack.iter().map(|(_, key)| key.clone()).collect();
        path.push(key.to_string());
        if raw_value.is_empty() {
            ensure_path_object(&mut root, &path);
            stack.push((indent, key.to_string()));
            continue;
        }

        set_path_value(&mut root, &path, parse_scalar(raw_value));
        wrote_value = true;
    }

    wrote_value.then_some(root)
}

fn split_assignment(line: &str) -> Option<(&str, &str)> {
    for sep in ["：", ":"] {
        if let Some(idx) = line.find(sep) {
            let key = line[..idx].trim();
            let value = line[idx + sep.len()..].trim();
            return Some((key, value));
        }
    }
    None
}

fn parse_scalar(raw: &str) -> Value {
    let value = raw.trim().trim_end_matches(',');
    if value.is_empty() {
        return Value::String(String::new());
    }
    if let Ok(json) = serde_json::from_str::<Value>(value) {
        return json;
    }
    if value.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if value.eq_ignore_ascii_case("false") {
        return Value::Bool(false);
    }
    if let Ok(number) = value.parse::<i64>() {
        return serde_json::json!(number);
    }
    if let Ok(number) = value.parse::<f64>() {
        return serde_json::json!(number);
    }
    Value::String(value.trim_matches('"').trim_matches('\'').to_string())
}

fn ensure_path_object(root: &mut Value, path: &[String]) {
    let mut cursor = root;
    for key in path {
        ensure_object(cursor);
        let map = cursor.as_object_mut().expect("object ensured");
        cursor = map
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    ensure_object(cursor);
}

fn set_path_value(root: &mut Value, path: &[String], value: Value) {
    if path.is_empty() {
        return;
    }
    let mut cursor = root;
    for key in &path[..path.len() - 1] {
        ensure_object(cursor);
        let map = cursor.as_object_mut().expect("object ensured");
        cursor = map
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    ensure_object(cursor);
    if let Some(map) = cursor.as_object_mut() {
        map.insert(path[path.len() - 1].clone(), value);
    }
}

fn push_array_value(root: &mut Value, path: &[String], value: Value) {
    if path.is_empty() {
        return;
    }
    let mut cursor = root;
    for key in &path[..path.len() - 1] {
        ensure_object(cursor);
        let map = cursor.as_object_mut().expect("object ensured");
        cursor = map
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    ensure_object(cursor);
    if let Some(map) = cursor.as_object_mut() {
        let entry = map
            .entry(path[path.len() - 1].clone())
            .or_insert_with(|| Value::Array(vec![]));
        if !entry.is_array() {
            *entry = Value::Array(vec![]);
        }
        if let Some(items) = entry.as_array_mut() {
            items.push(value);
        }
    }
}

fn merge_with_existing_variables(initial: Value, existing: Option<&Value>) -> Value {
    let mut merged = initial;
    if let Some(existing) = existing {
        merge_json_objects(&mut merged, existing);
    }
    merged
}

fn merge_json_objects(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target_map), Value::Object(source_map)) => {
            for (key, source_value) in source_map {
                match target_map.get_mut(key) {
                    Some(target_value) => merge_json_objects(target_value, source_value),
                    None => {
                        target_map.insert(key.clone(), source_value.clone());
                    }
                }
            }
        }
        (target_value, source_value) => {
            *target_value = source_value.clone();
        }
    }
}

fn has_object_content(value: &Value) -> bool {
    value.as_object().map_or(false, |map| !map.is_empty())
}

fn has_initialized_state(state: &serde_json::Value) -> bool {
    state
        .get("platform_state")
        .and_then(|v| v.as_object())
        .map(|obj| !obj.is_empty())
        .unwrap_or(false)
        || state
            .get("variables")
            .and_then(|v| v.as_object())
            .map(|obj| !obj.is_empty())
            .unwrap_or(false)
}

fn ensure_object(value: &mut serde_json::Value) {
    if !value.is_object() {
        *value = serde_json::json!({});
    }
}

async fn latest_state(pool: &SqlitePool, session_id: &str) -> Result<serde_json::Value, AppError> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    Ok(state
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({})))
}

async fn commit_initialized_state(
    pool: &SqlitePool,
    session_id: &str,
    state: &serde_json::Value,
) -> Result<(), AppError> {
    let max_version: Option<i32> =
        sqlx::query_scalar("SELECT MAX(version) FROM state_snapshots WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;

    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at) VALUES (?, ?, ?, ?, 'low', 'runtime', ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(max_version.unwrap_or(0) + 1)
    .bind(state.to_string())
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use sqlx::SqlitePool;

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
    fn parses_plain_initvar_json_as_variables() {
        let parsed = parse_init_variables(r#"{"世界":{"当前日期":["2025年/03月/24日","说明"]}}"#)
            .expect("init vars");

        assert_eq!(
            parsed["世界"]["当前日期"][0],
            serde_json::json!("2025年/03月/24日")
        );
    }

    #[test]
    fn unwraps_variables_container_when_present() {
        let parsed = parse_init_variables(r#"{"variables":{"hp":10}}"#).expect("init vars");

        assert_eq!(parsed["hp"], serde_json::json!(10));
    }

    #[test]
    fn parses_updatevariable_yaml_initvar() {
        let parsed = parse_init_variables(
            r#"<UpdateVariable>
<initvar>
主角状态:
  修为:
    当前境界: 筑基五层
    进度百分比: 0
世界系统:
  当前地址: 天剑后山·祖师祠堂
  在场角色: ""
  今日运势:
    宜: 睡大觉、打坐练功、和师妹唠嗑
    忌: 出门、帮别人处理烂摊子
人际交往:
  当前接触人物:
    沈慕微:
      心情: 心虚
</initvar>
</UpdateVariable>"#,
        )
        .expect("yaml init vars");

        assert_eq!(
            parsed["主角状态"]["修为"]["当前境界"],
            serde_json::json!("筑基五层")
        );
        assert_eq!(
            parsed["主角状态"]["修为"]["进度百分比"],
            serde_json::json!(0)
        );
        assert_eq!(
            parsed["世界系统"]["当前地址"],
            serde_json::json!("天剑后山·祖师祠堂")
        );
        assert_eq!(
            parsed["世界系统"]["今日运势"]["宜"],
            serde_json::json!("睡大觉、打坐练功、和师妹唠嗑")
        );
        assert_eq!(
            parsed["人际交往"]["当前接触人物"]["沈慕微"]["心情"],
            serde_json::json!("心虚")
        );
    }

    #[test]
    fn merges_existing_variables_without_resetting_runtime_values() {
        let initial = serde_json::json!({
            "主角状态": { "修为": { "当前境界": "筑基五层" } },
            "世界系统": { "当前地址": "祖师祠堂" }
        });
        let existing = serde_json::json!({
            "主角状态": { "修为": { "当前境界": "筑基六层" } },
            "cx_auto_regex_enabled_names": ["开场白"]
        });

        let merged = merge_with_existing_variables(initial, Some(&existing));

        assert_eq!(
            merged["主角状态"]["修为"]["当前境界"],
            serde_json::json!("筑基六层")
        );
        assert_eq!(
            merged["世界系统"]["当前地址"],
            serde_json::json!("祖师祠堂")
        );
        assert_eq!(
            merged["cx_auto_regex_enabled_names"],
            serde_json::json!(["开场白"])
        );
    }

    #[tokio::test]
    async fn lazy_world_book_initialization_does_not_merge_over_existing_state() {
        let pool = setup_test_pool().await;
        let session_id = uuid::Uuid::new_v4().to_string();
        let world_pack_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO world_books (id, name, description, original_format, source_data, created_at, updated_at)
             VALUES (?, 'world', '', 'test', '{}', ?, ?)",
        )
        .bind(&world_pack_id)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert world book");

        sqlx::query(
            "INSERT INTO sessions (id, title, mode, config, world_pack_id, current_turn, title_source, status, created_at, updated_at)
             VALUES (?, '', 'single_agent', '{}', ?, 0, 'auto', 'idle', ?, ?)",
        )
        .bind(&session_id)
        .bind(&world_pack_id)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert session");

        sqlx::query(
            "INSERT INTO world_book_entries (id, world_book_id, keys, secondary_keys, comment, content, enabled, priority, created_at, updated_at)
             VALUES (?, ?, '[]', '[]', '[InitVar]', ?, 1, 0, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&world_pack_id)
        .bind(
            r#"<UpdateVariable>
<initvar>
人际交往:
  当前接触人物:
    沈慕微:
      心情: 心虚
</initvar>
</UpdateVariable>"#,
        )
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert init var entry");

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
                            "姜澄鸢": { "心情": "平静" }
                        }
                    }
                }
            })
            .to_string(),
        )
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert existing snapshot");

        let changed = initialize_session_state_from_world_book(&pool, &session_id)
            .await
            .expect("lazy initialize");

        assert!(!changed);
        let latest = latest_state(&pool, &session_id)
            .await
            .expect("latest state");
        assert!(latest["variables"]["人际交往"]["当前接触人物"]["沈慕微"].is_null());
        assert_eq!(
            latest["variables"]["人际交往"]["当前接触人物"]["姜澄鸢"]["心情"],
            serde_json::json!("平静")
        );
    }

    #[tokio::test]
    async fn initializes_session_state_from_opening_content() {
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
            "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at)
             VALUES (?, ?, 1, '{}', 'low', 'runtime', ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&session_id)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("insert initial snapshot");

        let changed = initialize_session_state_from_content(
            &pool,
            &session_id,
            r#"[attachment]
<UpdateVariable>
<initvar>
<user>:
  精神状态数值:
    调教值:
      - "12 | 初始"
世界:
  当前日期:
    - "2026年6月9日"
</initvar>
</UpdateVariable>
"#,
            true,
        )
        .await
        .expect("initialize from content");

        assert!(changed);

        let latest = latest_state(&pool, &session_id)
            .await
            .expect("latest state");
        assert_eq!(
            latest["variables"]["<user>"]["精神状态数值"]["调教值"][0],
            serde_json::json!("12 | 初始")
        );
        assert_eq!(
            latest["variables"]["世界"]["当前日期"][0],
            serde_json::json!("2026年6月9日")
        );
    }
}
