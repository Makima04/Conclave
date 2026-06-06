use super::types::{
    ContextBundle, ContextMessage, KnowledgeEvent, PresetModuleContext, RoleContext,
    WorldBookContextEntry,
};
use super::user_settings::{self, UserPersonaSettings};
use crate::error::AppError;
use sqlx::SqlitePool;

async fn build_context_inner(
    pool: &SqlitePool,
    session_id: &str,
    _current_turn: i32,
    max_turns: usize,
    exclude_message_id: Option<&str>,
) -> Result<ContextBundle, AppError> {
    let mut query =
        String::from("SELECT role, content, turn_number FROM messages WHERE session_id = ?");
    if exclude_message_id.is_some() {
        query.push_str(" AND id != ?");
    }
    query.push_str(" ORDER BY turn_number DESC, created_at DESC LIMIT ?");

    let mut q = sqlx::query_as::<_, (String, String, i32)>(&query).bind(session_id);
    if let Some(ex_id) = exclude_message_id {
        q = q.bind(ex_id);
    }
    let rows = q.bind(max_turns as i32).fetch_all(pool).await?;

    let recent_messages: Vec<ContextMessage> = rows
        .into_iter()
        .rev()
        .map(|(role, content, turn_number)| ContextMessage {
            role: if role.starts_with("npc:") {
                "assistant".to_string()
            } else {
                role
            },
            content,
            turn_number,
        })
        .collect();

    let mut role_contexts: Vec<RoleContext> = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        "SELECT agent_type, label, character_id, context FROM sub_agents WHERE session_id = ? AND status = 'active' AND agent_type IN ('npc', 'user') ORDER BY created_at"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .filter(|(_, label, _, context)| !label.trim().is_empty() || !context.trim().is_empty())
    .map(|(agent_type, label, character_id, context)| RoleContext {
        agent_type,
        label,
        character_id,
        context,
    })
    .collect();

    let knowledge_events = load_knowledge_events(pool, session_id, max_turns).await?;

    let state_snapshot: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    let structured_state = state_snapshot
        .map(|s: String| serde_json::from_str(&s).unwrap_or(serde_json::json!({})))
        .unwrap_or_else(|| serde_json::json!({}));

    let events_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT content, visibility FROM memory_events WHERE session_id = ? ORDER BY turn_number DESC LIMIT 20"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let events: Vec<String> = events_rows.iter().map(|(c, _)| c.clone()).collect();
    let event_visibilities: Vec<String> = events_rows.iter().map(|(_, v)| v.clone()).collect();

    let foreshadow_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT content, visibility FROM foreshadowing WHERE session_id = ? AND status IN ('open', 'hinted') ORDER BY importance DESC LIMIT 10"
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let foreshadowing: Vec<String> = foreshadow_rows.iter().map(|(c, _)| c.clone()).collect();
    let foreshadow_visibilities: Vec<String> =
        foreshadow_rows.iter().map(|(_, v)| v.clone()).collect();

    let scene_summary: Option<String> = sqlx::query_scalar(
        "SELECT content FROM turn_summaries WHERE session_id = ? AND summary_type = 'scene' ORDER BY turn_number DESC LIMIT 1"
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    // Fetch world book entries if the session has a world_pack_id
    let world_pack_id: Option<String> =
        sqlx::query_scalar("SELECT world_pack_id FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;

    let world_book_entries = if let Some(ref wb_id) = world_pack_id {
        load_world_book_entries(pool, wb_id)
            .await
            .unwrap_or_default()
    } else {
        vec![]
    };

    // Load preset modules if session has an active preset
    let session_config_json: Option<String> =
        sqlx::query_scalar("SELECT config FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;

    let session_config_value = session_config_json
        .as_deref()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let active_preset_id = session_config_value
        .get("active_preset_id")
        .and_then(|v| v.as_str())
        .map(String::from);

    let user_persona = session_config_value
        .get("user_persona")
        .cloned()
        .and_then(|v| serde_json::from_value::<UserPersonaSettings>(v).ok())
        .unwrap_or_default();
    let strategy = session_config_value
        .get("user_setting_merge_strategy")
        .and_then(|v| v.as_str())
        .unwrap_or(user_settings::USER_OVERRIDES_WORLDBOOK);
    let (user_label, user_persona_context) = user_settings::persona_context(&user_persona);
    let worldbook_user_context =
        user_settings::load_worldbook_user_context(pool, world_pack_id.as_deref())
            .await
            .unwrap_or_default();
    let merged_user_context =
        user_settings::merge_context(&user_persona_context, &worldbook_user_context, strategy);

    if !merged_user_context.trim().is_empty() {
        if let Some(user_role) = role_contexts.iter_mut().find(|r| r.agent_type == "user") {
            if user_role.label.trim().is_empty() || user_role.label == "用户" {
                user_role.label = user_label;
            }
            user_role.context = merged_user_context;
        } else {
            role_contexts.push(RoleContext {
                agent_type: "user".to_string(),
                label: user_label,
                character_id: Some("user".to_string()),
                context: merged_user_context,
            });
        }
    }

    let preset_modules = if let Some(ref pid) = active_preset_id {
        load_preset_modules(pool, pid).await.unwrap_or_default()
    } else {
        vec![]
    };

    Ok(ContextBundle {
        task: "Continue the roleplay narrative".to_string(),
        recent_context: recent_messages,
        role_contexts,
        knowledge_events,
        structured_state,
        events,
        event_visibilities,
        foreshadowing,
        foreshadow_visibilities,
        scene_summary,
        world_book_entries,
        preset_modules,
    })
}

async fn load_knowledge_events(
    pool: &SqlitePool,
    session_id: &str,
    max_turns: usize,
) -> Result<Vec<KnowledgeEvent>, AppError> {
    let rows = sqlx::query_as::<_, (String, String, String, String, String, String, String, f32, String, i32)>(
        "SELECT fact, source_type, actors, targets, observers, knowers, visibility, confidence, evidence, turn_number FROM agent_knowledge_events WHERE session_id = ? ORDER BY turn_number DESC, created_at DESC LIMIT ?"
    )
    .bind(session_id)
    .bind((max_turns * 6).max(20) as i32)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .rev()
        .map(
            |(
                fact,
                source_type,
                actors,
                targets,
                observers,
                knowers,
                visibility,
                confidence,
                evidence,
                turn_number,
            )| KnowledgeEvent {
                fact,
                source_type,
                actors: serde_json::from_str(&actors).unwrap_or_default(),
                targets: serde_json::from_str(&targets).unwrap_or_default(),
                observers: serde_json::from_str(&observers).unwrap_or_default(),
                knowers: serde_json::from_str(&knowers).unwrap_or_default(),
                visibility,
                confidence,
                evidence,
                turn_number,
            },
        )
        .collect())
}

/// Load world book entries for context injection. Prefers parsed entries (multi-agent),
/// falls back to raw entries (single-agent) if not parsed.
async fn load_world_book_entries(
    pool: &SqlitePool,
    wb_id: &str,
) -> Result<Vec<WorldBookContextEntry>, AppError> {
    // Try parsed entries first
    let parsed_json: Option<String> = sqlx::query_scalar(
        "SELECT parsed_entries FROM world_books WHERE id = ? AND parse_status = 'done'",
    )
    .bind(wb_id)
    .fetch_optional(pool)
    .await?;

    if let Some(json) = parsed_json {
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap_or_default();
        let entries: Vec<WorldBookContextEntry> = parsed
            .into_iter()
            .filter_map(|v| {
                let enabled = v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true);
                if !enabled {
                    return None;
                }
                Some(WorldBookContextEntry {
                    content: v.get("content")?.as_str()?.to_string(),
                    keys: v
                        .get("keys")
                        .and_then(|k| k.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|s| s.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                    constant: v.get("constant").and_then(|c| c.as_bool()).unwrap_or(false),
                    priority: v.get("priority").and_then(|p| p.as_i64()).unwrap_or(100) as i32,
                    visibility: v
                        .get("visibility")
                        .and_then(|v| v.as_str())
                        .unwrap_or("public")
                        .to_string(),
                    category: v
                        .get("category")
                        .and_then(|v| v.as_str())
                        .unwrap_or("global")
                        .to_string(),
                })
            })
            .collect();
        return Ok(entries);
    }

    // Fall back to raw entries
    let raw_rows: Vec<(String, String, i32, i32, String)> = sqlx::query_as(
        "SELECT keys, content, constant, priority, comment FROM world_book_entries WHERE world_book_id = ? AND enabled = 1 ORDER BY priority DESC"
    )
    .bind(wb_id)
    .fetch_all(pool)
    .await?;

    let entries: Vec<WorldBookContextEntry> = raw_rows
        .into_iter()
        .map(|(keys_json, content, constant, priority, comment)| {
            let keys: Vec<String> = serde_json::from_str(&keys_json).unwrap_or_default();
            let category = if user_settings::looks_like_user_setting(&keys, &content, &comment) {
                "user"
            } else {
                "global"
            };
            WorldBookContextEntry {
                content,
                keys,
                constant: constant != 0,
                priority,
                visibility: "public".to_string(),
                category: category.to_string(),
            }
        })
        .collect();

    Ok(entries)
}

/// Load preset modules for context injection.
async fn load_preset_modules(
    pool: &SqlitePool,
    preset_id: &str,
) -> Result<Vec<PresetModuleContext>, AppError> {
    let rows = sqlx::query_as::<_, (String, String, String, String, i32)>(
        "SELECT name, content, role, target_agents, injection_order FROM preset_modules WHERE preset_id = ? AND enabled = 1 ORDER BY injection_order ASC, created_at ASC"
    )
    .bind(preset_id)
    .fetch_all(pool)
    .await?;

    let modules = rows
        .into_iter()
        .filter_map(
            |(name, content, role, target_agents_json, injection_order)| {
                let target_agents: Vec<String> =
                    serde_json::from_str(&target_agents_json).unwrap_or_default();
                if target_agents.is_empty() {
                    return None; // Skip unclassified modules
                }
                Some(PresetModuleContext {
                    name,
                    content,
                    role,
                    target_agents,
                    injection_order,
                })
            },
        )
        .collect();

    Ok(modules)
}

pub async fn build_context(
    pool: &SqlitePool,
    session_id: &str,
    current_turn: i32,
    max_turns: usize,
) -> Result<ContextBundle, AppError> {
    tracing::debug!(
        session = session_id,
        turn = current_turn,
        max_turns = max_turns,
        "Building context bundle"
    );
    build_context_inner(pool, session_id, current_turn, max_turns, None).await
}

/// Build context for regeneration, excluding the message being regenerated.
pub async fn build_context_for_regenerate(
    pool: &SqlitePool,
    session_id: &str,
    current_turn: i32,
    max_turns: usize,
    exclude_message_id: &str,
) -> Result<ContextBundle, AppError> {
    build_context_inner(
        pool,
        session_id,
        current_turn,
        max_turns,
        Some(exclude_message_id),
    )
    .await
}
