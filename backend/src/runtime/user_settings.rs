use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub const USER_OVERRIDES_WORLDBOOK: &str = "user_overrides_worldbook";
pub const WORLDBOOK_OVERRIDES_USER: &str = "worldbook_overrides_user";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserPersonaSettings {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub style: String,
}

pub fn normalize_merge_strategy(strategy: &str) -> String {
    match strategy {
        USER_OVERRIDES_WORLDBOOK | WORLDBOOK_OVERRIDES_USER => strategy.to_string(),
        _ => USER_OVERRIDES_WORLDBOOK.to_string(),
    }
}

pub fn persona_context(persona: &UserPersonaSettings) -> (String, String) {
    let name = persona.name.trim();
    let address = persona.address.trim();
    let background = persona.background.trim();
    let style = persona.style.trim();
    let label = if name.is_empty() { "用户" } else { name }.to_string();

    let mut context_parts = Vec::new();
    if !name.is_empty() {
        context_parts.push(format!("名称: {}", name));
    }
    if !address.is_empty() {
        context_parts.push(format!("称呼: {}", address));
    }
    if !background.is_empty() {
        context_parts.push(format!("角色设定:\n{}", background));
    }
    if !style.is_empty() {
        context_parts.push(format!("扮演风格:\n{}", style));
    }

    (label, context_parts.join("\n\n"))
}

pub fn merge_context(persona_context: &str, worldbook_context: &str, strategy: &str) -> String {
    let persona_context = persona_context.trim();
    let worldbook_context = worldbook_context.trim();
    let strategy = normalize_merge_strategy(strategy);

    match (persona_context.is_empty(), worldbook_context.is_empty()) {
        (true, true) => String::new(),
        (false, true) => persona_context.to_string(),
        (true, false) => format!("世界书用户设定:\n{}", worldbook_context),
        (false, false) if strategy == WORLDBOOK_OVERRIDES_USER => format!(
            "冲突处理: 用户设定与世界书用户设定冲突时，以世界书用户设定为准。\n\n用户自定义设定:\n{}\n\n世界书用户设定（优先）:\n{}",
            persona_context, worldbook_context
        ),
        (false, false) => format!(
            "冲突处理: 用户设定与世界书用户设定冲突时，以用户自定义设定为准。\n\n世界书用户设定:\n{}\n\n用户自定义设定（优先）:\n{}",
            worldbook_context, persona_context
        ),
    }
}

pub fn looks_like_user_setting(keys: &[String], content: &str, comment: &str) -> bool {
    let text = format!("{} {} {}", keys.join(" "), content, comment).to_lowercase();
    [
        "user", "player", "主角", "玩家", "用户", "{{user}}", "<user>",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

pub async fn load_worldbook_user_context(
    pool: &SqlitePool,
    world_pack_id: Option<&str>,
) -> Result<String, AppError> {
    let Some(world_pack_id) = world_pack_id else {
        return Ok(String::new());
    };

    let parsed_json: Option<String> = {
        let single_agent_json: Option<String> = sqlx::query_scalar(
            "SELECT single_agent_parsed_entries FROM world_books WHERE id = ? AND single_agent_parse_status = 'done'",
        )
        .bind(world_pack_id)
        .fetch_optional(pool)
        .await?;

        match single_agent_json {
            Some(json) => Some(json),
            None => {
                sqlx::query_scalar(
                    "SELECT parsed_entries FROM world_books WHERE id = ? AND parse_status = 'done'",
                )
                .bind(world_pack_id)
                .fetch_optional(pool)
                .await?
            }
        }
    };

    let mut entries: Vec<(i32, String)> = if let Some(parsed_json) = parsed_json {
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&parsed_json).unwrap_or_default();
        parsed
            .into_iter()
            .filter_map(|v| {
                let enabled = v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true);
                let category = v.get("category").and_then(|c| c.as_str()).unwrap_or("");
                if !enabled || category != "user" {
                    return None;
                }
                let content = v.get("content")?.as_str()?.trim().to_string();
                if content.is_empty() {
                    return None;
                }
                let priority = v.get("priority").and_then(|p| p.as_i64()).unwrap_or(100) as i32;
                Some((priority, content))
            })
            .collect()
    } else {
        let raw_rows: Vec<(String, String, i32, String)> = sqlx::query_as(
            "SELECT keys, content, priority, comment FROM world_book_entries WHERE world_book_id = ? AND enabled = 1 ORDER BY priority DESC",
        )
        .bind(world_pack_id)
        .fetch_all(pool)
        .await?;

        raw_rows
            .into_iter()
            .filter_map(|(keys_json, content, priority, comment)| {
                let keys: Vec<String> = serde_json::from_str(&keys_json).unwrap_or_default();
                if !looks_like_user_setting(&keys, &content, &comment) {
                    return None;
                }
                let content = content.trim().to_string();
                if content.is_empty() {
                    return None;
                }
                Some((priority, content))
            })
            .collect()
    };

    entries.sort_by_key(|(priority, _)| -*priority);
    Ok(entries
        .into_iter()
        .map(|(_, content)| content)
        .collect::<Vec<_>>()
        .join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_with_user_priority_by_default() {
        let merged = merge_context("名称: A", "名称: B", "unknown");
        assert!(merged.contains("用户自定义设定（优先）"));
        assert!(merged.contains("世界书用户设定:"));
    }

    #[test]
    fn merges_with_worldbook_priority_when_requested() {
        let merged = merge_context("名称: A", "名称: B", WORLDBOOK_OVERRIDES_USER);
        assert!(merged.contains("世界书用户设定（优先）"));
    }

    #[test]
    fn detects_raw_user_setting_keywords() {
        assert!(looks_like_user_setting(&["玩家".to_string()], "设定", ""));
        assert!(!looks_like_user_setting(
            &["weather".to_string()],
            "雨季设定",
            ""
        ));
    }
}
