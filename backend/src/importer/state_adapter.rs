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
    let warnings = build_adapter_warnings(variables, &fields, &read_rules, &write_rules);

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

fn build_adapter_warnings(
    variables: &[VariableDeclaration],
    fields: &[StateFieldDeclaration],
    read_rules: &[StateMappingRule],
    write_rules: &[StateMappingRule],
) -> Vec<String> {
    let mut warnings = Vec::new();
    let total = fields.len();
    let mapped = fields.iter().filter(|field| field.canonical_path.is_some()).count();
    let writable = fields.iter().filter(|field| field.writable).count();
    let manual_review = fields
        .iter()
        .filter(|field| field.canonical_path.is_none())
        .map(|field| field.path.as_str())
        .collect::<Vec<_>>();

    if total == 0 && !variables.is_empty() {
        warnings.push("检测到变量，但未生成任何 state_schema 字段。".to_string());
    }
    if total > 0 && mapped == 0 {
        warnings.push("state_schema 已生成，但没有任何字段映射到平台 canonical_path。".to_string());
    }
    if total > 0 && mapped < total {
        warnings.push(format!(
            "state_schema 仅部分完成映射: {}/{} 字段有 canonical_path。",
            mapped, total
        ));
    }
    if writable > 0 && write_rules.is_empty() {
        warnings.push("存在可写字段，但未生成 write_rules。".to_string());
    }
    if !read_rules.is_empty() && write_rules.is_empty() {
        warnings.push("已生成 read_rules，但没有对应 write_rules。".to_string());
    }
    if !manual_review.is_empty() {
        let preview = manual_review
            .iter()
            .take(6)
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if manual_review.len() > 6 {
            format!(" ... (+{} more)", manual_review.len() - 6)
        } else {
            String::new()
        };
        warnings.push(format!("仍需人工审查的字段: {}{}", preview, suffix));
    }

    warnings
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
    if segment_contains_any(
        lower,
        &["currenttime", "current_time", "time", "日期", "时间"],
    ) {
        return (
            StateFieldRole::Time,
            Some("world.current_time".to_string()),
            0.78,
        );
    }
    if segment_contains_any(
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
    if segment_contains_any(lower, &["affinity", "好感", "好感度", "trust", "信任"]) {
        return (
            StateFieldRole::RelationshipScore,
            Some(collection_platform_path(path, "relationships", "score")),
            0.7,
        );
    }
    if segment_contains_any(lower, &["stage", "阶段", "关系阶段"]) {
        return (
            StateFieldRole::RelationshipStage,
            Some(collection_platform_path(path, "relationships", "stage")),
            0.64,
        );
    }
    if segment_contains_any(lower, &["inventory", "item", "bag", "背包", "物品"]) {
        return (
            StateFieldRole::InventoryItem,
            Some(collection_platform_path(path, "inventory", "items")),
            0.64,
        );
    }
    if segment_contains_any(lower, &["summary", "summaries", "摘要", "总结"]) {
        return (
            StateFieldRole::SummaryEntry,
            Some(collection_platform_path(path, "summaries", "entries")),
            0.66,
        );
    }
    if segment_contains_any(lower, &["memory", "memories", "记忆", "事件"]) {
        return (
            StateFieldRole::MemoryEntry,
            Some(collection_platform_path(path, "memories", "entries")),
            0.62,
        );
    }
    if segment_contains_any(lower, &["name", "姓名", "名字"]) {
        return (
            StateFieldRole::CharacterName,
            Some(collection_platform_path(path, "characters", "name")),
            0.58,
        );
    }
    // UIFlag is a catch-all: checked last so more specific roles take precedence.
    // Only "runtime", "panel", "tab", "focused", "draft" are matched as segment
    // substrings; "ui" requires a standalone segment to avoid false positives.
    if segment_contains_any_strict_ui(
        lower,
        &["runtime", "panel", "tab", "focused", "draft"],
        &["ui"],
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

/// Segment-aware keyword matching: splits the path into segments by `.` and `[]`
/// delimiters, then checks if any keyword appears within an individual segment.
/// This prevents false positives where a keyword spans segment boundaries
/// (e.g., "time" matching inside "timeout" within a "ui.timeout" path).
fn segment_contains_any(lower_path: &str, keywords: &[&str]) -> bool {
    let segments: Vec<&str> = lower_path
        .split(|c: char| c == '.' || c == '[' || c == ']')
        .filter(|s| !s.is_empty())
        .collect();
    segments
        .iter()
        .any(|seg| keywords.iter().any(|kw| seg.contains(kw)))
}

/// Like segment_contains_any but with stricter matching for certain keywords.
/// `substring_keywords` are matched as substrings within segments (normal behavior).
/// `exact_keywords` require an exact segment match (e.g., "ui" must be the entire
/// segment, not a substring of "build" or "quiet").
fn segment_contains_any_strict_ui(
    lower_path: &str,
    substring_keywords: &[&str],
    exact_keywords: &[&str],
) -> bool {
    let segments: Vec<&str> = lower_path
        .split(|c: char| c == '.' || c == '[' || c == ']')
        .filter(|s| !s.is_empty())
        .collect();
    segments.iter().any(|seg| {
        substring_keywords.iter().any(|kw| seg.contains(kw))
            || exact_keywords.iter().any(|kw| *seg == *kw)
    })
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
        assert!(
            adapter
                .warnings
                .iter()
                .any(|warning| warning.contains("人工审查") || warning.contains("manual") || warning.contains("审查")),
            "expected manual review warning, got {:?}",
            adapter.warnings
        );
    }
}
