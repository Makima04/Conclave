use super::types::{
    AgentType, ContextBundle, ContextMessage, KnowledgeEvent, PresetModuleContext, RoleContext,
    WorldBookContextEntry,
};
use super::user_settings::{self, UserPersonaSettings};
use crate::error::AppError;
use crate::runtime::card_state_adapter;
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
    let rows = q
        .bind((max_turns * 2).max(1) as i32)
        .fetch_all(pool)
        .await?;

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
        agent_type: AgentType::from_db(&agent_type).unwrap_or(AgentType::Writer),
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

    let mut structured_state = state_snapshot
        .map(|s: String| serde_json::from_str(&s).unwrap_or(serde_json::json!({})))
        .unwrap_or_else(|| serde_json::json!({}));

    // v3 has no state contract table — `load_session_contract` is a stub returning None,
    // so the previous `if let Some(contract) = load_session_contract(...)` block never
    // executed and `_state_agent_writable` was never inserted into structured_state.
    // That made `propose_variable_changes` (single-agent State Agent) early-return on
    // empty writable_state, so stat_data was never written and status bars stayed empty.
    // Expose the whole structured state as the writable subset unconditionally
    // (`tool_state_for_context` ignores the contract arg in v3 and returns the full state).
    let writable_state = card_state_adapter::tool_state_for_context(&structured_state, None);
    if let Some(obj) = structured_state.as_object_mut() {
        obj.insert("_state_agent_writable".to_string(), writable_state);
    }

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

    let session_mode: String = sqlx::query_scalar("SELECT mode FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or_else(|| "single_agent".to_string());

    // World book activation text: ST world-info entries activate (constant aside) when their
    // keys appear in the recent conversation context. We match against recent turns + the
    // current scene summary — this mirrors SillyTavern's key-scan over the chat context.
    let activation_text = {
        let mut buf = recent_messages
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(scene) = scene_summary.as_deref() {
            buf.push('\n');
            buf.push_str(scene);
        }
        buf
    };

    let world_book_entries = if let Some(ref wb_id) = world_pack_id {
        load_world_book_entries(pool, wb_id, &session_mode, &activation_text)
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
        if let Some(user_role) = role_contexts
            .iter_mut()
            .find(|r| r.agent_type == AgentType::User)
        {
            if user_role.label.trim().is_empty() || user_role.label == "用户" {
                user_role.label = user_label;
            }
            user_role.context = merged_user_context;
        } else {
            role_contexts.push(RoleContext {
                agent_type: AgentType::User,
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

/// Trim + drop-empty a key list, borrowing into the originals.
fn trimmed_nonempty_keys(keys: &[String]) -> Vec<&str> {
    keys.iter()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .collect()
}

/// True iff `hay` contains any of the keys (as substrings). SillyTavern's keyword-scan
/// match — a key "hits" when it appears anywhere in the activation context.
fn any_key_hits(hay: &str, keys: &[&str]) -> bool {
    keys.iter().any(|k| hay.contains(k))
}

/// ST world-book entry activation. Mirrors SillyTavern's key-scan + selective logic:
/// - `constant=true` → always inject
/// - `constant=false` with no keys → conservatively inject (avoids dropping setting
///   entries that forgot to mark `constant`; matches prior all-inject behavior)
/// - `constant=false` + `selective=false` → inject iff any primary key hits `hay`
/// - `constant=false` + `selective=true` → primary hit AND secondary keys combine per ST
///   `selective_logic`: `0`=AND ANY (any secondary), `1`=NOT ALL (≥1 secondary missing),
///   `2`=NOT ANY (no secondary), `3`=AND ALL (all secondary). Default `0`.
pub(crate) fn is_entry_activated(e: &WorldBookContextEntry, hay: &str) -> bool {
    if e.constant {
        return true;
    }
    let primary = trimmed_nonempty_keys(&e.keys);
    if primary.is_empty() {
        return true; // keyless trigger → treat as always-on (conservative)
    }
    let primary_hit = any_key_hits(hay, &primary);
    if !e.selective {
        return primary_hit;
    }
    // Secondary combination (ST selectiveLogic); primary is always AND-ANY.
    let sec = trimmed_nonempty_keys(&e.secondary_keys);
    if sec.is_empty() {
        return primary_hit; // selective but no secondary keys → degrade to primary-only
    }
    let any_sec = any_key_hits(hay, &sec);
    let all_sec = sec.iter().all(|k| hay.contains(k));
    match e.selective_logic {
        0 => primary_hit && any_sec,   // AND ANY (ST default)
        1 => primary_hit && !all_sec,  // NOT ALL
        2 => primary_hit && !any_sec,  // NOT ANY
        3 => primary_hit && all_sec,   // AND ALL
        _ => primary_hit && any_sec,
    }
}

/// Load world book entries for context injection. Parsed world books use the parsed
/// contract exclusively; raw entries are only used before a parse result exists.
/// `activation_text` is the recent-context + scene summary used to activate keyed entries.
async fn load_world_book_entries(
    pool: &SqlitePool,
    wb_id: &str,
    session_mode: &str,
    activation_text: &str,
) -> Result<Vec<WorldBookContextEntry>, AppError> {
    // Try parsed entries first. Single-agent sessions use their own routing parse;
    // multi-agent keeps the legacy parsed_entries column.
    let parsed_json: Option<String> = if session_mode == "single_agent" {
        let single_agent_json: Option<String> = sqlx::query_scalar(
            "SELECT single_agent_parsed_entries FROM world_books WHERE id = ? AND single_agent_parse_status = 'done'",
        )
        .bind(wb_id)
        .fetch_optional(pool)
        .await?;

        match single_agent_json {
            Some(json) => Some(json),
            None => {
                sqlx::query_scalar(
                    "SELECT parsed_entries FROM world_books WHERE id = ? AND parse_status = 'done'",
                )
                .bind(wb_id)
                .fetch_optional(pool)
                .await?
            }
        }
    } else {
        sqlx::query_scalar(
            "SELECT parsed_entries FROM world_books WHERE id = ? AND parse_status = 'done'",
        )
        .bind(wb_id)
        .fetch_optional(pool)
        .await?
    };

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
                    selective: v.get("selective").and_then(|s| s.as_bool()).unwrap_or(false),
                    secondary_keys: v
                        .get("secondary_keys")
                        .and_then(|k| k.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|s| s.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                    selective_logic: v
                        .get("selective_logic")
                        .and_then(|s| s.as_i64())
                        .unwrap_or(0) as i32,
                })
            })
            .collect();
        // Apply ST key-activation: drop entries that are neither constant nor keyed-hit.
        return Ok(entries
            .into_iter()
            .filter(|e| is_entry_activated(e, activation_text))
            .collect());
    }

    // Fall back to raw entries
    let raw_rows: Vec<(String, String, i32, i32, String, i32, String, i32)> = sqlx::query_as(
        "SELECT keys, content, constant, priority, comment, selective, secondary_keys, selective_logic FROM world_book_entries WHERE world_book_id = ? AND enabled = 1 ORDER BY priority DESC"
    )
    .bind(wb_id)
    .fetch_all(pool)
    .await?;

    let entries: Vec<WorldBookContextEntry> = raw_rows
        .into_iter()
        .map(
            |(keys_json, content, constant, priority, comment, selective, secondary_keys_json, selective_logic)| {
                let keys: Vec<String> = serde_json::from_str(&keys_json).unwrap_or_default();
                let category = if user_settings::looks_like_user_setting(&keys, &content, &comment) {
                    "user"
                } else {
                    "global"
                };
                let secondary_keys: Vec<String> =
                    serde_json::from_str(&secondary_keys_json).unwrap_or_default();
                WorldBookContextEntry {
                    content,
                    keys,
                    constant: constant != 0,
                    priority,
                    visibility: "public".to_string(),
                    category: category.to_string(),
                    selective: selective != 0,
                    secondary_keys,
                    selective_logic,
                }
            },
        )
        .collect();

    Ok(entries
        .into_iter()
        .filter(|e| is_entry_activated(e, activation_text))
        .collect())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(constant: bool, keys: &[&str], selective: bool, sec: &[&str], logic: i32) -> WorldBookContextEntry {
        WorldBookContextEntry {
            content: "x".into(),
            keys: keys.iter().map(|s| s.to_string()).collect(),
            constant,
            priority: 100,
            visibility: "public".into(),
            category: "global".into(),
            selective,
            secondary_keys: sec.iter().map(|s| s.to_string()).collect(),
            selective_logic: logic,
        }
    }

    #[test]
    fn constant_entries_always_activate() {
        let e = entry(true, &["unmatched"], false, &[], 0);
        assert!(is_entry_activated(&e, "nothing relevant here"));
    }

    #[test]
    fn keyless_non_constant_activates_conservatively() {
        // keyless + non-constant → treat as always-on (don't drop setting entries that
        // forgot to mark constant)
        let e = entry(false, &[], false, &[], 0);
        assert!(is_entry_activated(&e, "anything"));
    }

    #[test]
    fn keyed_entry_activates_on_primary_hit() {
        let e = entry(false, &["教室", "课间"], false, &[], 0);
        assert!(is_entry_activated(&e, "他们走进教室坐下"));
        assert!(!is_entry_activated(&e, "外面下着雨"));
    }

    #[test]
    fn selective_and_any_requires_primary_and_any_secondary() {
        // logic 0 = AND ANY (ST default): primary hit AND any secondary hit
        let e = entry(false, &["教室"], true, &["夜晚"], 0);
        assert!(is_entry_activated(&e, "夜晚的教室很安静")); // both hit
        assert!(!is_entry_activated(&e, "白天的教室很吵")); // only primary
        assert!(!is_entry_activated(&e, "夜晚的操场")); // only secondary, primary miss
    }

    #[test]
    fn selective_not_all_blocks_when_all_secondary_hit() {
        // logic 1 = NOT ALL: primary hit AND NOT(all secondary hit)
        let e = entry(false, &["教室"], true, &["a", "b"], 1);
        assert!(is_entry_activated(&e, "教室里只有 a")); // primary + 1 of 2 sec → not all → true
        assert!(!is_entry_activated(&e, "教室里 a 和 b")); // primary + all sec → blocked
    }

    #[test]
    fn selective_not_any_requires_no_secondary() {
        // logic 2 = NOT ANY: primary hit AND no secondary hits
        let e = entry(false, &["教室"], true, &["安静"], 2);
        assert!(is_entry_activated(&e, "教室里喧闹")); // primary hit, no sec → true
        assert!(!is_entry_activated(&e, "教室很安静")); // primary + sec → blocked
    }

    #[test]
    fn selective_and_all_requires_every_secondary() {
        // logic 3 = AND ALL: primary hit AND all secondary hit
        let e = entry(false, &["教室"], true, &["a", "b"], 3);
        assert!(is_entry_activated(&e, "教室里 a 和 b 都在")); // primary + all sec
        assert!(!is_entry_activated(&e, "教室里只有 a")); // primary + 1 of 2 → false
    }
}
