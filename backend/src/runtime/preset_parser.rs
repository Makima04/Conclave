use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::{ChatMessage, ChatRequest};
use futures::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MODULE_CONTENT_LIMIT: usize = 200;
const LLM_MAX_TOKENS: u32 = 4096;
const CLASSIFY_BATCH_SIZE: usize = 8;
const CLASSIFY_CONCURRENCY: usize = 4;

/// A preset module after LLM classification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifiedModule {
    pub identifier: String,
    pub target_agents: Vec<String>,
    pub reason: String,
}

/// Module data prepared for LLM classification.
#[derive(Serialize)]
struct ModuleForParsing {
    index: usize,
    identifier: String,
    name: String,
    role: String,
    content_preview: String,
}

/// Intermediate struct matching what the LLM actually returns (index-based).
#[derive(Deserialize)]
struct LlmClassificationResult {
    index: usize,
    target_agents: Vec<String>,
    reason: String,
}

const CLASSIFY_SYSTEM_PROMPT: &str = r#"You are a preset module classifier for a multi-agent roleplay platform. The platform has multiple specialized agents that handle different aspects of creative roleplay.

Given a list of prompt modules from a SillyTavern system preset, classify each module to the appropriate agent(s).

Agent types and their responsibilities:
- **writer** (写手/Narrator): Prose writing style, description techniques, formatting rules, banned words, NSFW writing rules, POV/persona control, dialogue techniques, anti-cliché rules, anti-repetition rules
- **director** (导演/GM): Pacing control, plot construction, world-building decisions, information asymmetry, emotional tone, character focus, NSFW pacing/phases, scene transitions, character analysis
- **master** (总控/Orchestrator): High-level narrative mode selection (conservative/adventurous/explosive), orchestration decisions
- **compression** (摘要/Summarizer): Summary generation, scene recap
- **state** (状态/Variables): Variable management, status blocks
- **parser** (解析/Intent): Input parsing, intent extraction

Special classification:
- **discard**: Jailbreak/prefill hacks specific to a particular LLM (DeepSeek, Claude, etc.), Clewd proxy regex, cache-busting tricks, platform-specific workarounds that won't work in this system
- **inject_all**: Universal rules that should be seen by ALL agents (e.g., core anti-judgment principles, fundamental creative philosophy)

Rules:
1. A module can target MULTIPLE agents (content duplication is fine and expected)
2. Classify based on the SEMANTIC MEANING of the module's name and content, not just keywords
3. Modules with Chinese names should be understood by their meaning
4. When in doubt between writer and director: if it's about HOW to write prose → writer; if it's about WHAT happens in the story → director
5. The "enabled" field in the source indicates whether the user had this module active; preserve it

IMPORTANT: Output ONLY a valid JSON array. No markdown fences, no explanation text outside the JSON.
Output an array of objects, one per input entry (same order), each with fields: index, target_agents (string array), reason (brief Chinese explanation)."#;

/// Classify all preset modules via batched concurrent LLM calls with recursive splitting.
pub async fn classify_preset_modules(
    provider: &OpenAiProvider,
    model: &str,
    modules: &[(String, String, String, String)], // (identifier, name, role, content)
) -> Result<Vec<ClassifiedModule>, AppError> {
    let all_modules = Arc::new(modules.to_vec());

    let batches: Vec<(usize, Vec<(String, String, String, String)>)> = all_modules
        .chunks(CLASSIFY_BATCH_SIZE)
        .enumerate()
        .map(|(batch_idx, chunk)| (batch_idx * CLASSIFY_BATCH_SIZE, chunk.to_vec()))
        .collect();

    let batch_futures = batches.into_iter().map(|(offset, batch)| {
        let provider = provider.clone();
        let model = model.to_string();
        let all_modules = Arc::clone(&all_modules);

        async move {
            classify_batch_with_split(&provider, &model, all_modules.as_slice(), offset, &batch)
                .await
                .map(|classified| (offset, classified))
        }
    });

    let mut batch_results: Vec<(usize, Vec<ClassifiedModule>)> = Vec::new();
    let mut pending = stream::iter(batch_futures).buffer_unordered(CLASSIFY_CONCURRENCY);
    while let Some(batch_result) = pending.next().await {
        batch_results.push(batch_result?);
    }

    batch_results.sort_by_key(|(offset, _)| *offset);

    Ok(batch_results
        .into_iter()
        .flat_map(|(_, classified)| classified)
        .collect())
}

/// Recursively split a batch on failure. If a single module still fails, use heuristic fallback.
fn classify_batch_with_split<'a>(
    provider: &'a OpenAiProvider,
    model: &'a str,
    all_modules: &'a [(String, String, String, String)],
    offset: usize,
    batch: &'a [(String, String, String, String)],
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<ClassifiedModule>, AppError>> + Send + 'a>,
> {
    Box::pin(async move {
        match classify_batch(provider, model, all_modules, offset, batch).await {
            Ok(classified) => Ok(classified),
            Err(e) if batch.len() > 1 => {
                tracing::warn!(
                    offset,
                    len = batch.len(),
                    error = %e,
                    "Preset classify batch failed; retrying with smaller batches"
                );
                let mid = batch.len() / 2;
                let mut left =
                    classify_batch_with_split(provider, model, all_modules, offset, &batch[..mid])
                        .await?;
                let mut right = classify_batch_with_split(
                    provider,
                    model,
                    all_modules,
                    offset + mid,
                    &batch[mid..],
                )
                .await?;
                left.append(&mut right);
                Ok(left)
            }
            Err(e) => {
                tracing::warn!(
                    offset,
                    error = %e,
                    "Preset single-module LLM classify failed; using heuristic fallback"
                );
                Ok(vec![heuristic_classify(all_modules, offset)])
            }
        }
    })
}

/// Send a single batch to the LLM for classification.
async fn classify_batch(
    provider: &OpenAiProvider,
    model: &str,
    all_modules: &[(String, String, String, String)],
    offset: usize,
    batch: &[(String, String, String, String)],
) -> Result<Vec<ClassifiedModule>, AppError> {
    let modules_for_llm: Vec<ModuleForParsing> = batch
        .iter()
        .enumerate()
        .map(|(i, (identifier, name, role, content))| ModuleForParsing {
            index: offset + i,
            identifier: identifier.clone(),
            name: name.clone(),
            role: role.clone(),
            content_preview: truncate_chars(content, MODULE_CONTENT_LIMIT),
        })
        .collect();

    let user_content = serde_json::to_string_pretty(&modules_for_llm)
        .map_err(|e| AppError::Internal(format!("Failed to serialize modules: {}", e)))?;

    let request = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: CLASSIFY_SYSTEM_PROMPT.to_string(),
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
        max_tokens: Some(LLM_MAX_TOKENS),
        frequency_penalty: Some(0.0),
        presence_penalty: Some(0.0),
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

    // Detect truncation — triggers recursive split
    if matches!(choice.finish_reason.as_deref(), Some("length")) {
        return Err(AppError::Provider(
            "LLM response was truncated by max_tokens".to_string(),
        ));
    }

    let content = choice.message.content.trim();

    let json_str = extract_json_array(content);

    let mut parsed: Vec<LlmClassificationResult> = serde_json::from_str(json_str).map_err(|e| {
        tracing::warn!(
            error = %e,
            response = %truncate_chars(content, 500),
            "Failed to parse LLM classification response"
        );
        AppError::Internal(format!("LLM classification parse error: {}", e))
    })?;

    parsed.sort_by_key(|p| p.index);

    // Map LLM results back to original modules with full data from all_modules
    let result: Vec<ClassifiedModule> = parsed
        .into_iter()
        .filter_map(|p| {
            let idx = p.index;
            if idx < offset || idx >= offset + batch.len() || idx >= all_modules.len() {
                return None;
            }
            let (identifier, _, _, _) = &all_modules[idx];
            Some(ClassifiedModule {
                identifier: identifier.clone(),
                target_agents: p.target_agents,
                reason: p.reason,
            })
        })
        .collect();

    if result.len() != batch.len() {
        return Err(AppError::Internal(format!(
            "LLM returned {} classifications for a batch of {} modules",
            result.len(),
            batch.len()
        )));
    }

    Ok(result)
}

/// Heuristic fallback when LLM classification fails for a single module.
fn heuristic_classify(
    all_modules: &[(String, String, String, String)],
    index: usize,
) -> ClassifiedModule {
    let (identifier, name, role, content) = &all_modules[index];
    let combined = format!("{} {} {} {}", identifier, name, role, content).to_lowercase();

    let target_agents = classify_heuristically(&combined);
    let reason = format!("LLM分类失败，启发式关键词回退: {:?}", target_agents);

    ClassifiedModule {
        identifier: identifier.clone(),
        target_agents,
        reason,
    }
}

/// Keyword-based heuristic classification for a single module's combined text.
fn classify_heuristically(combined: &str) -> Vec<String> {
    // Discard: jailbreak, prefill, cache hacks, clewd
    if combined.contains("穿甲")
        || combined.contains("破限")
        || combined.contains("预填充")
        || combined.contains("clewd")
        || combined.contains("缓存")
        || combined.contains("prefill")
        || combined.contains("jailbreak")
        || combined.contains("cache")
    {
        return vec!["discard".to_string()];
    }

    let mut targets = Vec::new();

    // Writer indicators
    if combined.contains("文风")
        || combined.contains("风格")
        || combined.contains("描写")
        || combined.contains("写")
        || combined.contains("对白")
        || combined.contains("nsfw")
        || combined.contains("人称")
        || combined.contains("排版")
        || combined.contains("禁词")
        || combined.contains("抗八股")
        || combined.contains("抗重复")
        || combined.contains("抗滥用")
        || combined.contains("格式姬")
        || combined.contains("不抢话")
        || combined.contains("抢话")
        || combined.contains("字数")
        || combined.contains("段落")
        || combined.contains("叙事")
        || combined.contains("prose")
        || combined.contains("narration")
        || combined.contains("style")
        || combined.contains("writing")
        || combined.contains("format")
        || combined.contains("banned")
        || combined.contains("pov")
        || combined.contains("dialogue")
    {
        targets.push("writer".to_string());
    }

    // Director indicators
    if combined.contains("节奏")
        || combined.contains("剧情")
        || combined.contains("情节")
        || combined.contains("世界观")
        || combined.contains("角色分析")
        || combined.contains("信息控制")
        || combined.contains("反全知")
        || combined.contains("情感基调")
        || combined.contains("限速器")
        || combined.contains("冒险")
        || combined.contains("保守")
        || combined.contains("爆炸")
        || combined.contains("director")
        || combined.contains("pacing")
        || combined.contains("plot")
        || combined.contains("world")
    {
        targets.push("director".to_string());
    }

    // State / Variable indicators
    if combined.contains("变量") || combined.contains("variable") || combined.contains("state") {
        targets.push("state".to_string());
    }

    // Lore master indicators
    if combined.contains("lore")
        || combined.contains("设定")
        || combined.contains("背景")
        || combined.contains("lore_master")
    {
        targets.push("lore_master".to_string());
    }

    // Compression indicators
    if combined.contains("总结") || combined.contains("摘要") || combined.contains("summary") {
        targets.push("compression".to_string());
    }

    // Default: writer
    if targets.is_empty() {
        targets.push("writer".to_string());
    }

    targets
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).collect::<String>() + "..."
}

fn extract_json_array(text: &str) -> &str {
    let trimmed = text.trim();
    if trimmed.starts_with('[') {
        if let Some(end) = trimmed.rfind(']') {
            return &trimmed[..=end];
        }
    }

    // Try to extract from markdown code fences
    if let Some(start) = trimmed.find("```json") {
        let after_fence = &trimmed[start + 7..];
        if let Some(end_fence) = after_fence.find("```") {
            let inner = after_fence[..end_fence].trim();
            if inner.starts_with('[') {
                return inner;
            }
        }
    }
    if let Some(start) = trimmed.find("```") {
        let after_fence = &trimmed[start + 3..];
        let after_newline = if let Some(nl) = after_fence.find('\n') {
            &after_fence[nl + 1..]
        } else {
            after_fence
        };
        if let Some(end_fence) = after_newline.find("```") {
            let inner = after_newline[..end_fence].trim();
            if inner.starts_with('[') {
                return inner;
            }
        }
    }

    // Last resort: find first [ and last ]
    if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            if end > start {
                return &trimmed[start..=end];
            }
        }
    }

    trimmed
}
