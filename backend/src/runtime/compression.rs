use crate::error::AppError;
use crate::memory::{state, summaries};
use crate::provider::adapter::ProviderAdapter;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use crate::runtime::structured_output;
use crate::runtime::types::{CompressionResult, ContextBundle, StateChangeProposal, SubAgent};
use sqlx::SqlitePool;
use tracing::instrument;

/// Generate compression result without persisting. Caller handles persistence.
pub async fn generate_compression(
    provider: &OpenAiProvider,
    model: &str,
    user_input: &str,
    narrative_text: &str,
    context: &ContextBundle,
    agent: Option<&SubAgent>,
) -> Result<CompressionResult, AppError> {
    let default_prompt = r#"你是状态管理Agent。分析本轮叙事中的关键信息，输出结构化的状态压缩。输出纯JSON，不要其他文字。

JSON格式：
{
  "scene_summary": "当前场景的完整状态摘要（包含地点、人物、氛围、关键状态）",
  "events": [
    {
      "event_type": "dialogue|action|discovery|conflict|change",
      "content": "事件描述",
      "characters_involved": ["角色名"],
      "importance": "low|normal|high|critical",
      "visibility": "public"
    }
  ],
  "structured_events": [
    {
      "characters": ["角色名"],
      "location": "地点名或null",
      "action": "发生了什么（动词短语）",
      "scene_type": "encounter|dialogue|combat|travel|info|other",
      "importance": 3,
      "raw_text": "完整事件描述"
    }
  ],
  "foreshadowing": [
    {
      "content": "伏笔描述",
      "importance": "low|normal|high",
      "trigger_conditions": ["触发条件"],
      "action": "new",
      "target_id": null,
      "new_status": null,
      "visibility": "public"
    }
  ],
  "state_changes": [
    {
      "op": "update|add|remove",
      "target": "path.to.field",
      "from": null,
      "to": "新值",
      "evidence_turns": []
    }
  ]
}

规则：
1. scene_summary应该是完整的场景状态描述，不是增量。包含所有当前有效的信息。
2. events只记录本轮新发生的有意义事件，不重复已有事件。
3. structured_events是结构化事件记录，用于后续检索。每个事件应有明确的行动主体和动作。importance 1=微不足道, 2=次要, 3=普通, 4=重要, 5=关键转折。scene_type根据事件主要内容判断。
4. foreshadowing记录伏笔线索（未解决的悬念、暗示等）。
5. state_changes记录具体的状态变更（角色关系、位置、物品等）。
6. visibility控制事件/伏笔对哪些Agent可见: "public"(所有人可见), "gm_only"(仅director/master可见), "character:角色id"(仅对应角色可见), "writer_only"(仅writer/director/master可见)。默认"public"。
7. 如果本轮对话没有产生有意义的变化，可以输出空数组。"#;

    // Use agent's DB prompt if available, otherwise fall back to hardcoded default
    let system_prompt = agent
        .filter(|a| !a.system_prompt.is_empty())
        .map(|a| a.system_prompt.clone())
        .unwrap_or_else(|| default_prompt.to_string());

    // Build current state context
    let state_str = if context
        .structured_state
        .as_object()
        .map_or(true, |o| o.is_empty())
    {
        "(无)".to_string()
    } else {
        serde_json::to_string_pretty(&context.structured_state).unwrap_or_default()
    };

    let events_str = if context.events.is_empty() {
        "(无)".to_string()
    } else {
        context.events.join("\n")
    };

    let previous_summary = context.scene_summary.as_deref().unwrap_or("(无)");

    let user_content = format!(
        "当前世界状态:\n{}\n\n已知事件:\n{}\n\n上一轮场景摘要:\n{}\n\n用户输入:\n{}\n\n本轮叙事输出:\n{}",
        state_str, events_str, previous_summary, user_input, narrative_text
    );

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                reasoning_content: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_content,
                reasoning_content: None,
            },
        ],
        temperature: Some(0.3),
        top_p: Some(1.0),
        max_tokens: Some(10000),
        frequency_penalty: None,
        presence_penalty: None,
        stream: false,
    };

    tracing::debug!("Compression Agent: sending LLM request");

    let response = provider
        .chat_completion_with_retry(request, 3)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let text = response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    tracing::info!(
        "Compression output: {} tokens, text preview: {}",
        response.usage.as_ref().map(|u| u.total_tokens).unwrap_or(0),
        truncate_str(&text, 200)
    );

    let schema_hint = r#"{"scene_summary":"...","events":[{"event_type":"...","content":"...","characters_involved":[...],"importance":"...","visibility":"public"}],"foreshadowing":[{"content":"...","importance":"...","trigger_conditions":[...],"action":"new","visibility":"public"}],"state_changes":[{"op":"update","target":"path","to":"value"}]}"#;
    let result = match structured_output::parse_with_repair(
        provider,
        model,
        &text,
        parse_compression,
        schema_hint,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Compression parse failed after repair: {}, skipping", e);
            return Ok(CompressionResult::default());
        }
    };

    Ok(result)
}

/// Generate + persist. Convenience wrapper for non-transactional callers.
#[instrument(skip(pool, provider, context, user_input, narrative_text), fields(session = session_id, turn = turn_number))]
pub async fn run_compression(
    pool: &SqlitePool,
    provider: &OpenAiProvider,
    model: &str,
    session_id: &str,
    turn_number: i32,
    user_input: &str,
    narrative_text: &str,
    context: &ContextBundle,
) -> Result<CompressionResult, AppError> {
    let result =
        generate_compression(provider, model, user_input, narrative_text, context, None).await?;
    persist_compression(pool, session_id, turn_number, &result).await?;
    Ok(result)
}

fn parse_compression(text: &str) -> Result<CompressionResult, String> {
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    serde_json::from_str::<CompressionResult>(json_str)
        .map_err(|e| format!("JSON parse error: {}", e))
}

pub async fn persist_compression(
    pool: &SqlitePool,
    session_id: &str,
    turn_number: i32,
    result: &CompressionResult,
) -> Result<(), AppError> {
    // 1. Save scene summary
    if !result.scene_summary.is_empty() {
        if let Err(e) = summaries::save_summary(
            pool,
            session_id,
            turn_number,
            "scene",
            &result.scene_summary,
        )
        .await
        {
            tracing::warn!("Failed to save scene summary: {}", e);
        }
    }

    // 2. Save events
    for event in &result.events {
        let chars_json =
            serde_json::to_string(&event.characters_involved).unwrap_or_else(|_| "[]".to_string());
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        if let Err(e) = sqlx::query(
            "INSERT INTO memory_events (id, session_id, turn_number, event_type, content, characters_involved, importance, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&id)
        .bind(session_id)
        .bind(turn_number)
        .bind(&event.event_type)
        .bind(&event.content)
        .bind(&chars_json)
        .bind(&event.importance)
        .bind(&event.visibility)
        .bind(&now)
        .execute(pool)
        .await
        {
            tracing::warn!("Failed to save event: {}", e);
        }
    }

    // 2b. Save structured events (with dedup)
    for se in &result.structured_events {
        let chars_json = serde_json::to_string(&se.characters).unwrap_or_else(|_| "[]".to_string());
        let hash = compute_content_hash(&se.raw_text);
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        // Layer 1: exact hash dedup
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM structured_events WHERE session_id = ? AND content_hash = ? LIMIT 1",
        )
        .bind(session_id)
        .bind(&hash)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        if existing.is_some() {
            tracing::debug!(hash = %hash, "Structured event deduped (exact hash match)");
            continue;
        }

        // Layer 2: semantic dedup — same scene_type + overlapping characters within 3 turns
        let recent_dup: Option<(String, i32, String)> = sqlx::query_as(
            "SELECT id, importance, characters FROM structured_events \
             WHERE session_id = ? AND scene_type = ? AND turn_number >= ? \
             ORDER BY turn_number DESC LIMIT 1",
        )
        .bind(session_id)
        .bind(&se.scene_type)
        .bind(turn_number - 3)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        if let Some((dup_id, dup_importance, dup_chars_str)) = recent_dup {
            let dup_chars: Vec<String> = serde_json::from_str(&dup_chars_str).unwrap_or_default();
            let overlap = se.characters.iter().any(|c| dup_chars.contains(c));
            if overlap {
                let new_importance = (dup_importance + 1).min(5);
                sqlx::query("UPDATE structured_events SET importance = ? WHERE id = ?")
                    .bind(new_importance)
                    .bind(&dup_id)
                    .execute(pool)
                    .await?;
                tracing::debug!(
                    dup_id = %dup_id,
                    new_importance,
                    "Structured event merged (semantic dedup)"
                );
                continue;
            }
        }

        // No dedup hit — insert
        if let Err(e) = sqlx::query(
            "INSERT INTO structured_events \
             (id, session_id, turn_number, characters, location, action, scene_type, importance, raw_text, content_hash, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(session_id)
        .bind(turn_number)
        .bind(&chars_json)
        .bind(&se.location)
        .bind(&se.action)
        .bind(&se.scene_type)
        .bind(se.importance)
        .bind(&se.raw_text)
        .bind(&hash)
        .bind(&now)
        .execute(pool)
        .await
        {
            tracing::warn!("Failed to save structured event: {}", e);
        }
    }

    // 3. Save foreshadowing
    for item in &result.foreshadowing {
        match item.action.as_str() {
            "new" => {
                let id = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now().to_rfc3339();
                let trigger_json = serde_json::to_string(&item.trigger_conditions)
                    .unwrap_or_else(|_| "[]".to_string());
                if let Err(e) = sqlx::query(
                    "INSERT INTO foreshadowing (id, session_id, content, status, importance, trigger_conditions, visibility, planted_at_turn, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)"
                )
                .bind(&id)
                .bind(session_id)
                .bind(&item.content)
                .bind(&item.importance)
                .bind(&trigger_json)
                .bind(&item.visibility)
                .bind(turn_number)
                .bind(&now)
                .bind(&now)
                .execute(pool)
                .await
                {
                    tracing::warn!("Failed to save foreshadowing: {}", e);
                }
            }
            "update" => {
                if let Some(ref target_id) = item.target_id {
                    let new_status = item.new_status.as_deref().unwrap_or("hinted");
                    let now = chrono::Utc::now().to_rfc3339();
                    if let Err(e) = sqlx::query(
                        "UPDATE foreshadowing SET status = ?, last_hint_turn = ?, updated_at = ? WHERE id = ? AND session_id = ?"
                    )
                    .bind(new_status)
                    .bind(turn_number)
                    .bind(&now)
                    .bind(target_id)
                    .bind(session_id)
                    .execute(pool)
                    .await
                    {
                        tracing::warn!("Failed to update foreshadowing: {}", e);
                    }
                }
            }
            _ => {
                tracing::warn!("Unknown foreshadowing action: {}", item.action);
            }
        }
    }

    // 4. Apply state changes
    if !result.state_changes.is_empty() {
        let proposal = StateChangeProposal {
            proposed_by: "compression_agent".to_string(),
            risk: "low".to_string(),
            changes: result.state_changes.clone(),
        };
        match state::apply_proposal(pool, session_id, &proposal, turn_number).await {
            Ok(r) => {
                tracing::info!(
                    "State proposal applied: status={}, version={}",
                    r.status,
                    r.version
                );
            }
            Err(e) => {
                tracing::warn!("State proposal failed: {}", e);
            }
        }
    }

    Ok(())
}

fn truncate_str(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn compute_content_hash(text: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let normalized = text
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
