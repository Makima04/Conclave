use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use futures::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const INITIAL_BATCH_SIZE: usize = 12;
const ENTRY_CONTENT_LIMIT: usize = 500;
const LLM_MAX_TOKENS: u32 = 4096;
const PARSE_CONCURRENCY: usize = 4;

/// A world book entry after LLM categorization for runtime context routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedWorldBookEntry {
    pub keys: Vec<String>,
    pub content: String,
    pub comment: String,
    pub constant: bool,
    pub priority: i32,
    pub enabled: bool,
    pub category: String,
    pub visibility: String,
    pub reason: String,
}

/// Raw entry data sent to the LLM for categorization.
#[derive(Serialize)]
struct EntryForParsing {
    index: usize,
    comment: String,
    keys: Vec<String>,
    content: String,
    constant: bool,
}

const MULTI_AGENT_PARSE_SYSTEM_PROMPT: &str = r#"You are a world book analysis engine for a multi-agent roleplay platform. Given a list of world book entries from a single-agent character card, categorize each entry for use in a multi-agent system.

For each entry, assign:
- category: one of "global", "writer_only", "gm_only", "npc:{character_name}", or "user"
- visibility: one of "public", "writer_only", "gm_only", or "character:{character_name}"
- reason: a brief Chinese explanation of why you chose this category

Guidelines:
- "global" / "public": World rules, setting descriptions, geography, factions, magic systems — everyone should know this
- "writer_only": Narrative style guides, tone instructions, prose formatting rules, output format requirements
- "gm_only": Hidden plot points, secret information, GM notes, antagonist plans, things players shouldn't know
- "npc:{name}" / "character:{name}": Character-specific backstories, dialogue patterns, relationships, personality traits for a specific NPC
- "user": Information specifically for the player/user character

IMPORTANT: Output ONLY a valid JSON array. No markdown, no explanation text outside the JSON.
Output an array of objects, one per input entry (same order), each with fields: index, category, visibility, reason, enabled (bool)."#;

const SINGLE_AGENT_PARSE_SYSTEM_PROMPT: &str = r#"You are a world book analysis engine for a single-agent roleplay runtime. Given a list of world book entries from a character card, categorize each entry for prompt routing.

For each entry, assign:
- category: one of "global", "writer_only", "state_agent", "gm_only", or "user"
- visibility: one of "public", "writer_only", "state_agent", or "gm_only"
- reason: a brief Chinese explanation of why you chose this category

Guidelines:
- "global" / "public": World rules, setting descriptions, geography, factions, magic systems, schedules, scene/event modules that the narrative writer needs.
- "writer_only": Narrative style guides, tone instructions, prose formatting rules, and output format requirements for the narrative writer.
- "state_agent": Variable update protocols, UpdateVariable rules, stat_data/current variable instructions, getvar/setvar snippets, state mutation rules, MVU/status update instructions. These must NOT be sent to the narrative writer; they are only for the variable update tool LLM.
- "gm_only": Hidden plot points, secret information, GM notes, antagonist plans, things players shouldn't know.
- "user": Information specifically for the player/user character.

IMPORTANT: Output ONLY a valid JSON array. No markdown, no explanation text outside the JSON.
Output an array of objects, one per input entry (same order), each with fields: index, category, visibility, reason, enabled (bool)."#;

/// Parse world book entries for multi-agent use via LLM categorization.
pub async fn parse_world_book_for_multi_agent(
    provider: &OpenAiProvider,
    model: &str,
    entries: &[(String, Vec<String>, String, String, bool)], // (id, keys, content, comment, constant)
) -> Result<Vec<ParsedWorldBookEntry>, AppError> {
    parse_world_book_with_prompt(
        provider,
        model,
        entries,
        MULTI_AGENT_PARSE_SYSTEM_PROMPT,
        ParseMode::MultiAgent,
    )
    .await
}

/// Parse world book entries for single-agent prompt routing.
pub async fn parse_world_book_for_single_agent(
    provider: &OpenAiProvider,
    model: &str,
    entries: &[(String, Vec<String>, String, String, bool)], // (id, keys, content, comment, constant)
) -> Result<Vec<ParsedWorldBookEntry>, AppError> {
    parse_world_book_with_prompt(
        provider,
        model,
        entries,
        SINGLE_AGENT_PARSE_SYSTEM_PROMPT,
        ParseMode::SingleAgent,
    )
    .await
}

#[derive(Debug, Clone, Copy)]
enum ParseMode {
    MultiAgent,
    SingleAgent,
}

async fn parse_world_book_with_prompt(
    provider: &OpenAiProvider,
    model: &str,
    entries: &[(String, Vec<String>, String, String, bool)], // (id, keys, content, comment, constant)
    system_prompt: &'static str,
    mode: ParseMode,
) -> Result<Vec<ParsedWorldBookEntry>, AppError> {
    let all_entries = Arc::new(entries.to_vec());
    let batches: Vec<(usize, Vec<(String, Vec<String>, String, String, bool)>)> = all_entries
        .chunks(INITIAL_BATCH_SIZE)
        .enumerate()
        .map(|(batch_start, batch)| (batch_start * INITIAL_BATCH_SIZE, batch.to_vec()))
        .collect();

    let batch_futures = batches.into_iter().map(|(offset, batch)| {
        let provider = provider.clone();
        let model = model.to_string();
        let all_entries = Arc::clone(&all_entries);

        async move {
            parse_batch_with_split(
                &provider,
                &model,
                all_entries.as_slice(),
                offset,
                &batch,
                system_prompt,
                mode,
            )
            .await
            .map(|parsed| (offset, parsed))
        }
    });

    let mut batch_results = Vec::new();
    let mut pending = stream::iter(batch_futures).buffer_unordered(PARSE_CONCURRENCY);
    while let Some(batch_result) = pending.next().await {
        batch_results.push(batch_result?);
    }

    batch_results.sort_by_key(|(offset, _)| *offset);

    Ok(batch_results
        .into_iter()
        .flat_map(|(_, parsed)| parsed)
        .collect())
}

fn parse_batch_with_split<'a>(
    provider: &'a OpenAiProvider,
    model: &'a str,
    all_entries: &'a [(String, Vec<String>, String, String, bool)],
    offset: usize,
    batch: &'a [(String, Vec<String>, String, String, bool)],
    system_prompt: &'static str,
    mode: ParseMode,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<ParsedWorldBookEntry>, AppError>> + Send + 'a>,
> {
    Box::pin(async move {
        match parse_batch(provider, model, all_entries, offset, batch, system_prompt).await {
            Ok(parsed) => Ok(parsed),
            Err(e) if batch.len() > 1 => {
                tracing::warn!(
                    offset,
                    len = batch.len(),
                    error = %e,
                    "World book parse batch failed; retrying with smaller batches"
                );
                let mid = batch.len() / 2;
                let mut left = parse_batch_with_split(
                    provider,
                    model,
                    all_entries,
                    offset,
                    &batch[..mid],
                    system_prompt,
                    mode,
                )
                .await?;
                let mut right = parse_batch_with_split(
                    provider,
                    model,
                    all_entries,
                    offset + mid,
                    &batch[mid..],
                    system_prompt,
                    mode,
                )
                .await?;
                left.append(&mut right);
                Ok(left)
            }
            Err(e) => {
                tracing::warn!(
                    offset,
                    error = %e,
                    "World book single-entry LLM parse failed; using heuristic fallback"
                );
                Ok(vec![heuristic_entry(all_entries, offset, mode)])
            }
        }
    })
}

async fn parse_batch(
    provider: &OpenAiProvider,
    model: &str,
    all_entries: &[(String, Vec<String>, String, String, bool)],
    offset: usize,
    entries: &[(String, Vec<String>, String, String, bool)],
    system_prompt: &'static str,
) -> Result<Vec<ParsedWorldBookEntry>, AppError> {
    let entries_for_llm: Vec<EntryForParsing> = entries
        .iter()
        .enumerate()
        .map(
            |(i, (_, keys, content, comment, constant))| EntryForParsing {
                index: offset + i,
                comment: comment.clone(),
                keys: keys.clone(),
                content: truncate_chars(content, ENTRY_CONTENT_LIMIT),
                constant: *constant,
            },
        )
        .collect();

    let user_content = serde_json::to_string_pretty(&entries_for_llm)
        .map_err(|e| AppError::Internal(format!("Failed to serialize entries: {}", e)))?;

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                reasoning_content: None,
                tool_calls: None,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_content,
                reasoning_content: None,
                tool_calls: None,
            },
        ],
        temperature: Some(0.3),
        top_p: Some(1.0),
        max_tokens: Some(LLM_MAX_TOKENS),
        frequency_penalty: Some(0.0),
        presence_penalty: Some(0.0),
        tools: None,
        tool_choice: None,
        stream: false,
    };

    let response = provider
        .chat_completion_with_retry(request, 2)
        .await
        .map_err(|e| AppError::Provider(e.to_string()))?;

    let choice = response
        .choices
        .first()
        .ok_or_else(|| AppError::Provider("LLM response contained no choices".to_string()))?;
    if matches!(choice.finish_reason.as_deref(), Some("length")) {
        return Err(AppError::Provider(
            "LLM response was truncated by max_tokens".to_string(),
        ));
    }

    let content = choice.message.content.trim();

    // Try to parse the JSON array from the response
    // Handle cases where LLM wraps in markdown code blocks
    let json_str = if let Some(start) = content.find('[') {
        if let Some(end) = content.rfind(']') {
            &content[start..=end]
        } else {
            content
        }
    } else {
        content
    };

    let mut parsed: Vec<ParsedLLMEntry> = serde_json::from_str(json_str).map_err(|e| {
        AppError::Internal(format!(
            "Failed to parse LLM response as JSON: {}. Response was: {}",
            e,
            truncate_chars(content, 500)
        ))
    })?;

    parsed.sort_by_key(|p| p.index);

    // Map LLM results back to original entries with full content
    let result: Vec<ParsedWorldBookEntry> = parsed
        .into_iter()
        .filter_map(|p| {
            let idx = p.index;
            if idx < offset || idx >= offset + entries.len() || idx >= all_entries.len() {
                return None;
            }
            let (_, keys, content, comment, constant) = &all_entries[idx];
            Some(ParsedWorldBookEntry {
                keys: keys.clone(),
                content: content.clone(),
                comment: comment.clone(),
                constant: *constant,
                priority: 100,
                enabled: p.enabled,
                category: p.category,
                visibility: p.visibility,
                reason: p.reason,
            })
        })
        .collect();

    if result.len() != entries.len() {
        return Err(AppError::Internal(format!(
            "LLM returned {} parsed entries for a batch of {} entries",
            result.len(),
            entries.len()
        )));
    }

    Ok(result)
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}...[truncated]", truncated)
    } else {
        text.to_string()
    }
}

fn heuristic_entry(
    entries: &[(String, Vec<String>, String, String, bool)],
    index: usize,
    mode: ParseMode,
) -> ParsedWorldBookEntry {
    let (_, keys, content, comment, constant) = &entries[index];
    let (category, visibility, reason) = classify_heuristically(keys, content, comment, mode);

    ParsedWorldBookEntry {
        keys: keys.clone(),
        content: content.clone(),
        comment: comment.clone(),
        constant: *constant,
        priority: 100,
        enabled: true,
        category,
        visibility,
        reason,
    }
}

fn classify_heuristically(
    keys: &[String],
    content: &str,
    comment: &str,
    mode: ParseMode,
) -> (String, String, String) {
    let text = format!(
        "{}\n{}\n{}",
        keys.join(" "),
        comment,
        truncate_chars(content, 400)
    )
    .to_lowercase();

    if matches!(mode, ParseMode::SingleAgent)
        && contains_any(
            &text,
            &[
                "updatevariable",
                "stat_data",
                "current_variables",
                "get_message_variable",
                "getvar",
                "setvar",
                "变量更新",
                "状态更新",
                "动态变量",
                "变量输出",
                "变量规范",
                "mvu",
            ],
        )
    {
        return (
            "state_agent".to_string(),
            "state_agent".to_string(),
            "LLM解析失败，按关键词回退为变量状态工具指令".to_string(),
        );
    }

    if contains_any(
        &text,
        &[
            "secret",
            "hidden",
            "gm",
            "dm",
            "master",
            "spoiler",
            "秘密",
            "隐藏",
            "幕后",
            "真相",
            "伏笔",
            "不可告知",
            "不要告诉",
            "仅gm",
        ],
    ) {
        return (
            "gm_only".to_string(),
            "gm_only".to_string(),
            "LLM解析失败，按关键词回退为GM隐藏信息".to_string(),
        );
    }

    if contains_any(
        &text,
        &[
            "style",
            "tone",
            "format",
            "prose",
            "narration",
            "output",
            "writer",
            "写作",
            "文风",
            "语气",
            "格式",
            "输出",
            "叙事",
            "描写",
            "旁白",
            "变量",
        ],
    ) {
        return (
            "writer_only".to_string(),
            "writer_only".to_string(),
            "LLM解析失败，按关键词回退为写作引擎指令".to_string(),
        );
    }

    if contains_any(
        &text,
        &[
            "user", "player", "主角", "玩家", "用户", "{{user}}", "<user>",
        ],
    ) {
        return (
            "user".to_string(),
            "public".to_string(),
            "LLM解析失败，按关键词回退为用户角色相关信息".to_string(),
        );
    }

    (
        "global".to_string(),
        "public".to_string(),
        "LLM解析失败，默认回退为公开世界设定".to_string(),
    )
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

#[derive(Deserialize)]
struct ParsedLLMEntry {
    index: usize,
    category: String,
    visibility: String,
    reason: String,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heuristic_classifies_writer_rules() {
        let (category, visibility, _) = classify_heuristically(
            &["变量".to_string()],
            "变量输出格式是写作引擎指令，规定更新命令的结构和规则",
            "",
            ParseMode::MultiAgent,
        );

        assert_eq!(category, "writer_only");
        assert_eq!(visibility, "writer_only");
    }

    #[test]
    fn single_agent_heuristic_routes_variable_rules_to_state_agent() {
        let (category, visibility, _) = classify_heuristically(
            &["变量更新规范".to_string()],
            "<status_current_variables>{{get_message_variable::stat_data}}</status_current_variables>\nYou must output <UpdateVariable>...</UpdateVariable>",
            "",
            ParseMode::SingleAgent,
        );

        assert_eq!(category, "state_agent");
        assert_eq!(visibility, "state_agent");
    }

    #[test]
    fn heuristic_classifies_hidden_gm_notes() {
        let (category, visibility, _) = classify_heuristically(
            &["plot".to_string()],
            "隐藏真相：反派计划在第三幕揭露身份",
            "",
            ParseMode::MultiAgent,
        );

        assert_eq!(category, "gm_only");
        assert_eq!(visibility, "gm_only");
    }

    #[test]
    fn truncates_by_chars_not_bytes() {
        assert_eq!(truncate_chars("好感度规则", 3), "好感度...[truncated]");
    }
}
