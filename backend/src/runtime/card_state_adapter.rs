use crate::error::AppError;
use crate::importer::state_adapter;
use crate::importer::types::{
    CardStateAdapter, CardStateSchema, ConclaveCardPackage, ExternalCard, MappingTransform,
    SourceFormat, StateFieldRole, VariableDeclaration, VariableType,
};
use crate::runtime::types::StateChangeCandidate;
use serde_json::{Map, Value};
use sqlx::{Sqlite, SqlitePool, Transaction};

const PLATFORM_ROOT: &str = "platform_state";
const CARD_VARIABLES_ROOT: &str = "variables";
const ADAPTER_META_ROOT: &str = "_card_state_adapter";

#[derive(Debug, Clone)]
pub struct SessionStateContract {
    pub schema: CardStateSchema,
    pub adapter: CardStateAdapter,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct StateView {
    pub writable_platform_state: Value,
}

pub async fn load_session_contract(
    pool: &SqlitePool,
    session_id: &str,
    fallback_variables: Option<&Value>,
) -> Result<Option<SessionStateContract>, AppError> {
    let world_pack_id: Option<String> = sqlx::query_scalar(
        "SELECT world_pack_id FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    let Some(world_pack_id) = world_pack_id else {
        return Ok(fallback_variables.and_then(build_contract_from_variables));
    };

    if let Some(package) = load_latest_package_for_world_pack(pool, &world_pack_id).await? {
        let has_state_contract =
            !package.state_schema.fields.is_empty() || !package.state_adapter.read_rules.is_empty();
        if has_state_contract {
            return Ok(Some(SessionStateContract {
                schema: package.state_schema,
                adapter: package.state_adapter,
                source: "import_package".to_string(),
            }));
        }
    }

    if let Some(variables) = fallback_variables {
        return Ok(build_contract_from_variables(variables));
    }

    Ok(None)
}

pub fn build_normalized_state(
    current_state: &Value,
    contract: &SessionStateContract,
    initial_card_variables: Option<Value>,
) -> Value {
    let mut state = current_state.clone();
    ensure_object(&mut state);

    let base_card_variables = initial_card_variables
        .or_else(|| state.get(CARD_VARIABLES_ROOT).cloned())
        .unwrap_or_else(|| default_card_variables(&contract.schema));

    let mut platform_state = state
        .get(PLATFORM_ROOT)
        .cloned()
        .unwrap_or_else(|| default_platform_state(&contract.schema));
    ensure_object(&mut platform_state);

    for rule in &contract.adapter.read_rules {
        if let Some(value) = get_path_value(&base_card_variables, &rule.card_path).or_else(|| {
            get_path_value(&base_card_variables, strip_known_card_root(&rule.card_path))
        }) {
            set_path_value(
                &mut platform_state,
                &rule.platform_path,
                value_for_transform(value, &rule.transform),
            );
        }
    }

    let card_variables = project_card_variables(&base_card_variables, &platform_state, contract);
    set_top_level(&mut state, PLATFORM_ROOT, platform_state.clone());
    set_top_level(&mut state, CARD_VARIABLES_ROOT, card_variables);
    set_top_level(
        &mut state,
        ADAPTER_META_ROOT,
        adapter_metadata(contract, &platform_state),
    );
    state
}

pub fn state_view(state: &Value, contract: Option<&SessionStateContract>) -> StateView {
    let platform_state = state.get(PLATFORM_ROOT).cloned().unwrap_or_else(|| {
        state
            .get(CARD_VARIABLES_ROOT)
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()))
    });
    let writable_platform_state = contract
        .map(|contract| writable_state_from_contract(&platform_state, contract))
        .unwrap_or_else(|| {
            state
                .get(CARD_VARIABLES_ROOT)
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()))
        });

    StateView {
        writable_platform_state,
    }
}

pub fn apply_agent_changes(
    state: &mut Value,
    changes: &[StateChangeCandidate],
    contract: Option<&SessionStateContract>,
) {
    ensure_object(state);
    if contract.is_none() {
        for change in changes {
            set_path_value(state, &change.target, change.to.clone());
        }
        return;
    }

    let contract = contract.expect("checked above");
    let mut platform_state = state
        .get(PLATFORM_ROOT)
        .cloned()
        .unwrap_or_else(|| default_platform_state(&contract.schema));
    ensure_object(&mut platform_state);

    for change in changes {
        if let Some(target) = resolve_writable_platform_path(&change.target, contract) {
            set_path_value(&mut platform_state, &target, change.to.clone());
        }
    }

    let base_card_variables = state
        .get(CARD_VARIABLES_ROOT)
        .cloned()
        .unwrap_or_else(|| default_card_variables(&contract.schema));
    let card_variables = project_card_variables(&base_card_variables, &platform_state, contract);
    set_top_level(state, PLATFORM_ROOT, platform_state.clone());
    set_top_level(state, CARD_VARIABLES_ROOT, card_variables);
    set_top_level(
        state,
        ADAPTER_META_ROOT,
        adapter_metadata(contract, &platform_state),
    );
}

pub async fn persist_normalized_changes_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    changes: &[StateChangeCandidate],
    committed_by: &str,
) -> Result<(), AppError> {
    if changes.is_empty() {
        return Ok(());
    }

    let current_state = latest_state_tx(tx, session_id).await?;
    let fallback_variables = current_state.get(CARD_VARIABLES_ROOT).cloned();
    let contract = load_session_contract_tx(tx, session_id, fallback_variables.as_ref()).await?;
    let mut next_state = current_state;
    apply_agent_changes(&mut next_state, changes, contract.as_ref());
    commit_state_tx(tx, session_id, &next_state, committed_by).await
}

pub fn tool_state_for_context(state: &Value, contract: Option<&SessionStateContract>) -> Value {
    let view = state_view(state, contract);
    view.writable_platform_state
}

pub fn projection_path_writable(contract: &SessionStateContract, path: &str) -> bool {
    let trimmed = path.trim().trim_start_matches("variables.");
    contract.adapter.write_rules.iter().any(|rule| {
        trimmed == rule.card_path
            || trimmed.starts_with(&format!("{}.", rule.card_path))
            || trimmed.starts_with(&format!("{}[", rule.card_path))
    })
}

pub fn apply_projection_change_set(
    current_projection: &Value,
    changes: &[(String, Value)],
    contract: &SessionStateContract,
) -> (Value, Vec<String>) {
    let mut next = current_projection.clone();
    ensure_object(&mut next);
    let mut rejected = Vec::new();

    for (path, value) in changes {
        let trimmed = path.trim().trim_start_matches("variables.").to_string();
        if !projection_path_writable(contract, &trimmed) {
            rejected.push(trimmed);
            continue;
        }
        set_path_value(&mut next, &trimmed, value.clone());
    }

    (next, rejected)
}

async fn load_latest_package_for_world_pack(
    pool: &SqlitePool,
    world_pack_id: &str,
) -> Result<Option<ConclaveCardPackage>, AppError> {
    let package_json: Option<String> = sqlx::query_scalar(
        "SELECT ir.package_json
         FROM import_reports ir
         JOIN character_cards cc ON cc.id = ir.character_card_id
         WHERE cc.world_book_id = ?
         ORDER BY ir.created_at DESC
         LIMIT 1",
    )
    .bind(world_pack_id)
    .fetch_optional(pool)
    .await?;

    Ok(package_json.and_then(|json| serde_json::from_str(&json).ok()))
}

async fn load_session_contract_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    fallback_variables: Option<&Value>,
) -> Result<Option<SessionStateContract>, AppError> {
    let world_pack_id: Option<String> = sqlx::query_scalar(
        "SELECT world_pack_id FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(world_pack_id) = world_pack_id {
        let package_json: Option<String> = sqlx::query_scalar(
            "SELECT ir.package_json
             FROM import_reports ir
             JOIN character_cards cc ON cc.id = ir.character_card_id
             WHERE cc.world_book_id = ?
             ORDER BY ir.created_at DESC
             LIMIT 1",
        )
        .bind(world_pack_id)
        .fetch_optional(&mut **tx)
        .await?;

        if let Some(package) =
            package_json.and_then(|json| serde_json::from_str::<ConclaveCardPackage>(&json).ok())
        {
            if !package.state_schema.fields.is_empty()
                || !package.state_adapter.read_rules.is_empty()
            {
                return Ok(Some(SessionStateContract {
                    schema: package.state_schema,
                    adapter: package.state_adapter,
                    source: "import_package".to_string(),
                }));
            }
        }
    }

    Ok(fallback_variables.and_then(build_contract_from_variables))
}

pub async fn load_session_contract_tx_for_routes(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    fallback_variables: Option<&Value>,
) -> Result<Option<SessionStateContract>, AppError> {
    load_session_contract_tx(tx, session_id, fallback_variables).await
}

fn build_contract_from_variables(variables: &Value) -> Option<SessionStateContract> {
    let declarations = variable_declarations_from_value(variables);
    if declarations.is_empty() {
        return None;
    }
    let card = ExternalCard {
        name: "runtime_state".to_string(),
        description: String::new(),
        personality: String::new(),
        scenario: String::new(),
        first_mes: String::new(),
        alternate_greetings: vec![],
        system_prompt: String::new(),
        post_history_instructions: String::new(),
        creator_notes: String::new(),
        mes_example: String::new(),
        creator: String::new(),
        character_version: String::new(),
        tags: vec![],
        spec: "runtime".to_string(),
        extensions: Value::Object(Map::new()),
        avatar: "none".to_string(),
        source_format: SourceFormat::JsonV2,
        source_hash: "runtime:initvar".to_string(),
    };
    let (schema, adapter) = state_adapter::build_state_conversion(&card, &declarations);
    Some(SessionStateContract {
        schema,
        adapter,
        source: "runtime_initvar".to_string(),
    })
}

fn variable_declarations_from_value(value: &Value) -> Vec<VariableDeclaration> {
    let mut out = Vec::new();
    collect_variable_declarations(value, "", &mut out);
    out
}

fn collect_variable_declarations(value: &Value, path: &str, out: &mut Vec<VariableDeclaration>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let next = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{}.{}", path, key)
                };
                collect_variable_declarations(child, &next, out);
            }
        }
        _ if !path.is_empty() => out.push(VariableDeclaration {
            path: path.to_string(),
            var_type: infer_variable_type(value),
            default_value: Some(value.clone()),
            label: None,
            source: "runtime_initvar".to_string(),
        }),
        _ => {}
    }
}

fn default_platform_state(schema: &CardStateSchema) -> Value {
    let mut root = Value::Object(Map::new());
    for field in &schema.fields {
        if let Some(path) = &field.canonical_path {
            let value = field.default_value.clone().unwrap_or(Value::Null);
            set_path_value(&mut root, path, primary_value(value));
        }
    }
    root
}

fn default_card_variables(schema: &CardStateSchema) -> Value {
    let mut root = Value::Object(Map::new());
    for field in &schema.fields {
        let value = field.default_value.clone().unwrap_or(Value::Null);
        set_path_value(&mut root, &field.path, value);
    }
    root
}

fn project_card_variables(
    base_card_variables: &Value,
    platform_state: &Value,
    contract: &SessionStateContract,
) -> Value {
    let mut variables = base_card_variables.clone();
    ensure_object(&mut variables);
    for rule in &contract.adapter.write_rules {
        if let Some(value) = get_path_value(platform_state, &rule.platform_path) {
            let existing = get_path_value(&variables, &rule.card_path).cloned();
            set_path_value(
                &mut variables,
                &rule.card_path,
                restore_card_value(existing.as_ref(), value.clone(), &rule.transform),
            );
        }
    }
    variables
}

fn writable_state_from_contract(platform_state: &Value, contract: &SessionStateContract) -> Value {
    let mut state = Value::Object(Map::new());
    for rule in &contract.adapter.write_rules {
        if let Some(value) = get_path_value(platform_state, &rule.platform_path) {
            set_path_value(&mut state, &rule.platform_path, value.clone());
        }
    }
    state
}

fn adapter_metadata(contract: &SessionStateContract, platform_state: &Value) -> Value {
    let writable_paths: Vec<Value> = contract
        .adapter
        .write_rules
        .iter()
        .map(|rule| Value::String(rule.platform_path.clone()))
        .collect();
    let manual_review_paths: Vec<Value> = contract
        .schema
        .fields
        .iter()
        .filter(|field| field.canonical_path.is_none() || !field.writable)
        .map(|field| Value::String(field.path.clone()))
        .collect();

    serde_json::json!({
        "source": contract.source,
        "adapter_version": contract.adapter.adapter_version,
        "source_format": contract.adapter.source_format,
        "writable_platform_paths": writable_paths,
        "manual_review_card_paths": manual_review_paths,
        "mapped_field_count": contract.adapter.read_rules.len(),
        "platform_state_empty": platform_state.as_object().map_or(true, |obj| obj.is_empty()),
        "warnings": contract.adapter.warnings,
    })
}

fn resolve_writable_platform_path(target: &str, contract: &SessionStateContract) -> Option<String> {
    let trimmed = target.trim();
    let relative = trimmed
        .strip_prefix("platform_state.")
        .or_else(|| trimmed.strip_prefix("variables."))
        .unwrap_or(trimmed);

    contract
        .adapter
        .write_rules
        .iter()
        .find(|rule| {
            rule.platform_path == relative
                || rule.card_path == relative
                || format!("variables.{}", rule.card_path) == trimmed
        })
        .map(|rule| rule.platform_path.clone())
}

fn value_for_transform(value: &Value, transform: &MappingTransform) -> Value {
    match transform {
        MappingTransform::FirstArrayItem => primary_value(value.clone()),
        _ => primary_value(value.clone()),
    }
}

fn restore_card_value(
    existing: Option<&Value>,
    value: Value,
    transform: &MappingTransform,
) -> Value {
    match transform {
        MappingTransform::FirstArrayItem => {
            if let Some(Value::Array(existing_arr)) = existing {
                let mut arr = existing_arr.clone();
                if arr.is_empty() {
                    arr.push(value);
                } else {
                    arr[0] = value;
                }
                Value::Array(arr)
            } else {
                value
            }
        }
        _ => {
            if let Some(Value::Array(existing_arr)) = existing {
                if existing_arr.len() >= 2 {
                    let mut arr = existing_arr.clone();
                    arr[0] = value;
                    return Value::Array(arr);
                }
            }
            value
        }
    }
}

fn primary_value(value: Value) -> Value {
    if let Value::Array(arr) = &value {
        if arr.len() >= 2 {
            return arr.first().cloned().unwrap_or(Value::Null);
        }
    }
    value
}

fn infer_variable_type(value: &Value) -> VariableType {
    match value {
        Value::String(_) => VariableType::String,
        Value::Number(_) => VariableType::Number,
        Value::Bool(_) => VariableType::Boolean,
        Value::Object(_) => VariableType::Object,
        Value::Array(_) => VariableType::Array,
        Value::Null => VariableType::String,
    }
}

fn strip_known_card_root(path: &str) -> &str {
    path.strip_prefix("variables.")
        .or_else(|| path.strip_prefix("stat_data."))
        .unwrap_or(path)
}

async fn latest_state_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
) -> Result<Value, AppError> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(state
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Map::new())))
}

async fn commit_state_tx(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    state: &Value,
    committed_by: &str,
) -> Result<(), AppError> {
    let max_version: Option<i32> =
        sqlx::query_scalar("SELECT MAX(version) FROM state_snapshots WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(&mut **tx)
            .await?;

    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at) VALUES (?, ?, ?, ?, 'low', ?, ?)"
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(session_id)
    .bind(max_version.unwrap_or(0) + 1)
    .bind(state.to_string())
    .bind(committed_by)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn set_top_level(state: &mut Value, key: &str, value: Value) {
    ensure_object(state);
    if let Some(obj) = state.as_object_mut() {
        obj.insert(key.to_string(), value);
    }
}

fn ensure_object(value: &mut Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
}

pub fn get_path_value<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = root;
    for raw_part in path.split('.') {
        let (key, index) = parse_path_part(raw_part);
        current = current.get(key)?;
        if let Some(index) = index {
            current = current.get(index)?;
        }
    }
    Some(current)
}

fn set_path_value(root: &mut Value, path: &str, value: Value) {
    if !root.is_object() {
        *root = Value::Object(Map::new());
    }
    let parts: Vec<PathPart> = path.split('.').map(PathPart::parse).collect();
    set_path_recursive(root, &parts, value);
}

fn set_path_recursive(current: &mut Value, parts: &[PathPart], value: Value) {
    if parts.is_empty() {
        *current = value;
        return;
    }

    if !current.is_object() {
        *current = Value::Object(Map::new());
    }

    let part = &parts[0];
    if parts.len() == 1 {
        if let Some(obj) = current.as_object_mut() {
            if let Some(index) = part.index {
                let entry = obj
                    .entry(part.key.clone())
                    .or_insert_with(|| Value::Array(Vec::new()));
                set_array_index(entry, index, value);
            } else {
                obj.insert(part.key.clone(), value);
            }
        }
        return;
    }

    let next = current
        .as_object_mut()
        .expect("object initialized")
        .entry(part.key.clone())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(index) = part.index {
        ensure_array(next);
        let arr = next.as_array_mut().expect("array initialized");
        while arr.len() <= index {
            arr.push(Value::Object(Map::new()));
        }
        set_path_recursive(&mut arr[index], &parts[1..], value);
    } else {
        set_path_recursive(next, &parts[1..], value);
    }
}

fn set_array_index(value: &mut Value, index: usize, next: Value) {
    ensure_array(value);
    let arr = value.as_array_mut().expect("array initialized");
    while arr.len() <= index {
        arr.push(Value::Null);
    }
    arr[index] = next;
}

fn ensure_array(value: &mut Value) {
    if !value.is_array() {
        *value = Value::Array(Vec::new());
    }
}

#[derive(Debug)]
struct PathPart {
    key: String,
    index: Option<usize>,
}

impl PathPart {
    fn parse(part: &str) -> Self {
        let (key, index) = parse_path_part(part);
        Self {
            key: key.to_string(),
            index,
        }
    }
}

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

#[allow(dead_code)]
fn field_role_name(role: &StateFieldRole) -> &'static str {
    match role {
        StateFieldRole::Time => "time",
        StateFieldRole::Location => "location",
        StateFieldRole::CharacterName => "character_name",
        StateFieldRole::RelationshipScore => "relationship_score",
        StateFieldRole::RelationshipStage => "relationship_stage",
        StateFieldRole::InventoryItem => "inventory_item",
        StateFieldRole::MemoryEntry => "memory_entry",
        StateFieldRole::SummaryEntry => "summary_entry",
        StateFieldRole::UiFlag => "ui_flag",
        StateFieldRole::Custom => "custom",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::importer::types::{
        MappingDirection, StateFieldDeclaration, StateFieldRole, StateMappingRule, VariableRule,
        VariableUpdatePolicy,
    };

    fn contract() -> SessionStateContract {
        SessionStateContract {
            source: "test".to_string(),
            schema: CardStateSchema {
                roots: vec![],
                fields: vec![StateFieldDeclaration {
                    path: "世界.当前地点".to_string(),
                    canonical_path: Some("world.current_location".to_string()),
                    field_type: VariableType::Array,
                    default_value: Some(serde_json::json!(["侦探坡", "说明"])),
                    role: StateFieldRole::Location,
                    writable: true,
                    source: "test".to_string(),
                    confidence: 0.9,
                }],
            },
            adapter: CardStateAdapter {
                adapter_version: "test".to_string(),
                source_format: "test".to_string(),
                read_rules: vec![StateMappingRule {
                    card_path: "世界.当前地点".to_string(),
                    platform_path: "world.current_location".to_string(),
                    direction: MappingDirection::Read,
                    transform: MappingTransform::Identity,
                    confidence: 0.9,
                }],
                write_rules: vec![StateMappingRule {
                    card_path: "世界.当前地点".to_string(),
                    platform_path: "world.current_location".to_string(),
                    direction: MappingDirection::Write,
                    transform: MappingTransform::Identity,
                    confidence: 0.9,
                }],
                variable_rules: vec![VariableRule {
                    path_pattern: "世界.当前地点".to_string(),
                    role: StateFieldRole::Location,
                    writable: true,
                    update_policy: VariableUpdatePolicy::AgentTool,
                    confidence: 0.9,
                }],
                warnings: vec![],
            },
        }
    }

    #[test]
    fn normalizes_initvar_into_platform_state_and_projection() {
        let vars = serde_json::json!({"世界": {"当前地点": ["侦探坡", "说明"]}});
        let state = build_normalized_state(&serde_json::json!({}), &contract(), Some(vars));

        assert_eq!(
            state["platform_state"]["world"]["current_location"],
            serde_json::json!("侦探坡")
        );
        assert_eq!(
            state["variables"]["世界"]["当前地点"],
            serde_json::json!(["侦探坡", "说明"])
        );
    }

    #[test]
    fn agent_write_updates_platform_and_card_projection() {
        let vars = serde_json::json!({"世界": {"当前地点": ["侦探坡", "说明"]}});
        let mut state = build_normalized_state(&serde_json::json!({}), &contract(), Some(vars));
        apply_agent_changes(
            &mut state,
            &[StateChangeCandidate {
                op: "update".to_string(),
                target: "platform_state.world.current_location".to_string(),
                from: None,
                to: serde_json::json!("学校"),
                evidence_turns: vec![],
            }],
            Some(&contract()),
        );

        assert_eq!(
            state["platform_state"]["world"]["current_location"],
            serde_json::json!("学校")
        );
        assert_eq!(
            state["variables"]["世界"]["当前地点"],
            serde_json::json!(["学校", "说明"])
        );
    }

    #[test]
    fn manual_review_fields_are_not_writable() {
        let vars = serde_json::json!({"私有": {"flag": true}});
        let contract = build_contract_from_variables(&vars).expect("contract");
        let mut state = build_normalized_state(&serde_json::json!({}), &contract, Some(vars));
        assert!(contract.adapter.write_rules.is_empty());
        apply_agent_changes(
            &mut state,
            &[StateChangeCandidate {
                op: "update".to_string(),
                target: "variables.私有.flag".to_string(),
                from: None,
                to: serde_json::json!(false),
                evidence_turns: vec![],
            }],
            Some(&contract),
        );
        assert_eq!(state["variables"]["私有"]["flag"], serde_json::json!(true));
    }
}
