use crate::importer::types::*;

const ADAPTER_VERSION: &str = "0.1.0";

/// Build the platform-facing state conversion contract for an imported card.
///
/// This layer is intentionally schema-driven and conservative: it classifies
/// variable paths into reusable state roles, but uncertain card-private fields
/// remain custom/manual-review instead of becoming runtime shims.
pub fn build_state_conversion(
    card: &ExternalCard,
    variables: &[VariableDeclaration],
) -> (CardStateSchema, CardStateAdapter) {
    let fields = variables
        .iter()
        .map(classify_variable)
        .collect::<Vec<StateFieldDeclaration>>();
    let roots = infer_roots(&fields);
    let read_rules = fields
        .iter()
        .filter_map(|field| mapping_rule(field, MappingDirection::Read))
        .collect::<Vec<_>>();
    let write_rules = fields
        .iter()
        .filter(|field| field.writable)
        .filter_map(|field| mapping_rule(field, MappingDirection::Write))
        .collect::<Vec<_>>();
    let variable_rules = fields
        .iter()
        .map(variable_rule)
        .collect::<Vec<VariableRule>>();
    let warnings = fields
        .iter()
        .filter(|field| field.canonical_path.is_none())
        .take(20)
        .map(|field| {
            format!(
                "State field '{}' is card-private and requires adapter review before Agent writes.",
                field.path
            )
        })
        .collect();

    (
        CardStateSchema { roots, fields },
        CardStateAdapter {
            adapter_version: ADAPTER_VERSION.to_string(),
            source_format: card.source_format.to_string(),
            read_rules,
            write_rules,
            variable_rules,
            warnings,
        },
    )
}

fn classify_variable(var: &VariableDeclaration) -> StateFieldDeclaration {
    let normalized = normalize_path(&var.path);
    let lower = normalized.to_ascii_lowercase();
    let (role, canonical_path, confidence) = classify_field_role(&normalized, &lower);

    StateFieldDeclaration {
        path: var.path.clone(),
        canonical_path,
        field_type: var.var_type.clone(),
        default_value: var.default_value.clone(),
        writable: is_agent_writable(&role),
        role,
        source: var.source.clone(),
        confidence,
    }
}

fn classify_field_role(path: &str, lower: &str) -> (StateFieldRole, Option<String>, f64) {
    if contains_any(
        lower,
        &["currenttime", "current_time", "time", "日期", "时间"],
    ) {
        return (
            StateFieldRole::Time,
            Some("world.current_time".to_string()),
            0.78,
        );
    }
    if contains_any(
        lower,
        &[
            "currentlocation",
            "current_location",
            "location",
            "地点",
            "位置",
        ],
    ) {
        return (
            StateFieldRole::Location,
            Some("world.current_location".to_string()),
            0.78,
        );
    }
    if contains_any(lower, &["affinity", "好感", "好感度", "trust", "信任"]) {
        return (
            StateFieldRole::RelationshipScore,
            Some(collection_platform_path(path, "relationships", "score")),
            0.7,
        );
    }
    if contains_any(lower, &["stage", "阶段", "关系阶段"]) {
        return (
            StateFieldRole::RelationshipStage,
            Some(collection_platform_path(path, "relationships", "stage")),
            0.64,
        );
    }
    if contains_any(lower, &["inventory", "item", "bag", "背包", "物品"]) {
        return (
            StateFieldRole::InventoryItem,
            Some(collection_platform_path(path, "inventory", "items")),
            0.64,
        );
    }
    if contains_any(lower, &["summary", "summaries", "摘要", "总结"]) {
        return (
            StateFieldRole::SummaryEntry,
            Some(collection_platform_path(path, "summaries", "entries")),
            0.66,
        );
    }
    if contains_any(lower, &["memory", "memories", "记忆", "事件"]) {
        return (
            StateFieldRole::MemoryEntry,
            Some(collection_platform_path(path, "memories", "entries")),
            0.62,
        );
    }
    if contains_any(lower, &["name", "姓名", "名字"]) {
        return (
            StateFieldRole::CharacterName,
            Some(collection_platform_path(path, "characters", "name")),
            0.58,
        );
    }
    if contains_any(
        lower,
        &["runtime", "ui", "panel", "tab", "focused", "draft"],
    ) {
        return (StateFieldRole::UiFlag, None, 0.62);
    }
    (StateFieldRole::Custom, None, 0.35)
}

fn infer_roots(fields: &[StateFieldDeclaration]) -> Vec<StateRootDeclaration> {
    let mut roots = Vec::<StateRootDeclaration>::new();
    for field in fields {
        let root = field.path.split(['.', '[']).next().unwrap_or(&field.path);
        if root.is_empty() || roots.iter().any(|entry| entry.path == root) {
            continue;
        }
        roots.push(StateRootDeclaration {
            path: root.to_string(),
            role: classify_root_role(root),
            source: field.source.clone(),
            confidence: field.confidence,
        });
    }
    roots
}

fn classify_root_role(root: &str) -> StateRootRole {
    let lower = root.to_ascii_lowercase();
    if contains_any(&lower, &["world", "scene", "statusdata"]) {
        StateRootRole::World
    } else if contains_any(&lower, &["target", "character", "角色"]) {
        StateRootRole::CharacterCollection
    } else if contains_any(&lower, &["relationship", "relation"]) {
        StateRootRole::Relationship
    } else if contains_any(&lower, &["inventory", "bag"]) {
        StateRootRole::Inventory
    } else if contains_any(&lower, &["memory", "memorydb"]) {
        StateRootRole::Memory
    } else if contains_any(&lower, &["summary", "summarystore"]) {
        StateRootRole::Summary
    } else if contains_any(&lower, &["runtime", "ui"]) {
        StateRootRole::UiRuntime
    } else {
        StateRootRole::Custom
    }
}

fn mapping_rule(
    field: &StateFieldDeclaration,
    direction: MappingDirection,
) -> Option<StateMappingRule> {
    let platform_path = field.canonical_path.clone()?;
    Some(StateMappingRule {
        card_path: field.path.clone(),
        platform_path,
        direction,
        transform: transform_for_path(&field.path),
        confidence: field.confidence,
    })
}

fn variable_rule(field: &StateFieldDeclaration) -> VariableRule {
    VariableRule {
        path_pattern: field.path.clone(),
        role: field.role.clone(),
        writable: field.writable,
        update_policy: match field.role {
            StateFieldRole::UiFlag => VariableUpdatePolicy::UiOnly,
            StateFieldRole::Custom => VariableUpdatePolicy::ManualReview,
            StateFieldRole::SummaryEntry | StateFieldRole::MemoryEntry => {
                VariableUpdatePolicy::DerivedFromMessages
            }
            _ => VariableUpdatePolicy::AgentTool,
        },
        confidence: field.confidence,
    }
}

fn is_agent_writable(role: &StateFieldRole) -> bool {
    !matches!(
        role,
        StateFieldRole::UiFlag | StateFieldRole::Custom | StateFieldRole::SummaryEntry
    )
}

fn transform_for_path(path: &str) -> MappingTransform {
    if path.contains("[0]") {
        MappingTransform::FirstArrayItem
    } else if contains_any(
        &path.to_ascii_lowercase(),
        &["targets", "characters", "items"],
    ) {
        MappingTransform::CollectionById
    } else {
        MappingTransform::Identity
    }
}

fn collection_platform_path(path: &str, root: &str, leaf: &str) -> String {
    let segment = path
        .split('.')
        .rev()
        .find(|part| !part.is_empty())
        .unwrap_or(leaf);
    format!("{}.{}.{}", root, sanitize_segment(segment), leaf)
}

fn normalize_path(path: &str) -> String {
    path.trim()
        .trim_start_matches("variables.")
        .trim_start_matches("stat_data.")
        .replace("?.", ".")
}

fn sanitize_segment(segment: &str) -> String {
    let cleaned = segment
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .replace(['[', ']'], "");
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> ExternalCard {
        ExternalCard {
            name: "Test".to_string(),
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
            spec: "chara_card_v2".to_string(),
            extensions: serde_json::json!({}),
            avatar: "none".to_string(),
            source_format: SourceFormat::PngCcv3,
            source_hash: "sha256:test".to_string(),
        }
    }

    fn var(path: &str, var_type: VariableType) -> VariableDeclaration {
        VariableDeclaration {
            path: path.to_string(),
            var_type,
            default_value: None,
            label: None,
            source: "script_0".to_string(),
        }
    }

    #[test]
    fn maps_common_world_and_relationship_fields() {
        let variables = vec![
            var("statusData.world.currentTime", VariableType::String),
            var("targets[0].affinity", VariableType::Number),
        ];
        let (schema, adapter) = build_state_conversion(&card(), &variables);

        assert_eq!(schema.fields.len(), 2);
        assert!(
            schema
                .fields
                .iter()
                .any(|field| matches!(field.role, StateFieldRole::Time))
        );
        assert!(
            adapter
                .write_rules
                .iter()
                .any(|rule| rule.platform_path == "world.current_time")
        );
        assert!(
            adapter
                .variable_rules
                .iter()
                .any(|rule| matches!(rule.update_policy, VariableUpdatePolicy::AgentTool))
        );
    }

    #[test]
    fn keeps_unknown_fields_manual_review() {
        let variables = vec![var("privateBundle.weirdThing", VariableType::Object)];
        let (schema, adapter) = build_state_conversion(&card(), &variables);

        assert!(schema.fields[0].canonical_path.is_none());
        assert!(matches!(schema.fields[0].role, StateFieldRole::Custom));
        assert!(matches!(
            adapter.variable_rules[0].update_policy,
            VariableUpdatePolicy::ManualReview
        ));
        assert!(!adapter.warnings.is_empty());
    }
}
