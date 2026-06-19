use super::str_utils::{contains_any, truncate_with_suffix};
use crate::error::AppError;
use crate::provider::openai::OpenAiProvider;
use crate::provider::types::ChatRequest;
use serde::{Deserialize, Serialize};

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
6. EVERY module MUST get at least one concrete target — `target_agents` must NEVER be empty. If a module is not clearly for one of writer/director/master/compression/state/parser/inject_all and is not a platform-specific hack, classify it as `inject_all` rather than leaving it empty.

IMPORTANT: Output ONLY a valid JSON array. No markdown fences, no explanation text outside the JSON.
Output an array of objects, one per input entry (same order), each with fields: index, target_agents (string array), reason (brief Chinese explanation)."#;

/// Classify all preset modules via batched concurrent LLM calls with recursive splitting.
pub async fn classify_preset_modules(
    provider: &OpenAiProvider,
    model: &str,
    modules: &[(String, String, String, String)], // (identifier, name, role, content)
) -> Result<Vec<ClassifiedModule>, AppError> {
    // Concurrency/batching driven by the shared llm_batch pipeline; the closure defines how
    // to classify one batch, the fallback defines how to recover a single failed module.
    let provider = provider.clone();
    let model = model.to_string();
    super::llm_batch::run_batched(
        modules,
        CLASSIFY_BATCH_SIZE,
        CLASSIFY_CONCURRENCY,
        move |offset, all_modules, batch| {
            let provider = provider.clone();
            let model = model.clone();
            async move {
                classify_batch(&provider, &model, &all_modules, offset, &batch).await
            }
        },
        move |offset, all_modules| heuristic_classify(all_modules, offset),
        "Preset",
    )
    .await
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
            content_preview: truncate_with_suffix(content, MODULE_CONTENT_LIMIT, "..."),
        })
        .collect();

    let user_content = serde_json::to_string_pretty(&modules_for_llm)
        .map_err(|e| AppError::Internal(format!("Failed to serialize modules: {}", e)))?;

    let request = ChatRequest::classification_request(
        model,
        CLASSIFY_SYSTEM_PROMPT,
        user_content,
        LLM_MAX_TOKENS,
    );

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
            response = %truncate_with_suffix(content, 500, "..."),
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

    let (target_agents, low_confidence) = classify_heuristically(&combined);
    let reason = if low_confidence {
        format!(
            "{}：LLM分类失败，未命中明确类别，保守回退 writer",
            LOW_CONFIDENCE_REASON_PREFIX
        )
    } else {
        format!("LLM分类失败，启发式关键词回退: {:?}", target_agents)
    };

    ClassifiedModule {
        identifier: identifier.clone(),
        target_agents,
        reason,
    }
}

/// Keyword-based heuristic classification for a single module's combined text.
/// Returns `(target_agents, low_confidence)` — the flag marks cases where no concrete
/// category matched and we conservatively defaulted to writer (so callers/UI can surface it
/// for review instead of silently soaking every ambiguous module into the writer prompt).
/// Heuristic fallback returns a `reason` prefix so callers can tell apart genuine
/// classifications from low-confidence defaults. Used by `heuristic_classify`.
const LOW_CONFIDENCE_REASON_PREFIX: &str = "低置信度启发式默认";

fn classify_heuristically(combined: &str) -> (Vec<String>, bool) {
    // Discard: model-specific jailbreaks, prefill hacks, cache-busting tricks, and proxy
    // (Clewd) regex — these target a particular LLM/proxy and have no effect here.
    // Match by structural intent, not card-specific Chinese slang.
    const DISCARD_NEEDLES: &[&str] = &[
        // proxy / prefill / cache machinery
        "clewd",
        "prefill",
        "prefix回复",
        "prefix response",
        "jailbreak",
        "cache",
        "缓存",
        "穿透",
        "预填充",
        "穿甲",
        "破限",
        "nsfw切换",
        "sk-",
        "anthropic-version",
        // model-specific workarounds (kept broad on purpose)
        "deepseek",
        "glm",
        "gpt-4",
        "claude",
        "gemini",
        "groq",
        "openrouter",
        "openai",
    ];
    if DISCARD_NEEDLES.iter().any(|n| combined.contains(n)) {
        // Only discard when the module looks like a hack (mentions one of the above AND a
        // hack/switch/injection verb), to avoid killing legit model-selection presets.
        let looks_like_hack = [
            "破限",
            "穿甲",
            "预填充",
            "prefill",
            "jailbreak",
            "clewd",
            "穿透",
            "切换",
            "越狱",
            "绕过",
            "绕过审核",
            "bypass",
        ]
        .iter()
        .any(|n| combined.contains(n));
        if looks_like_hack {
            return (vec!["discard".to_string()], false);
        }
    }

    let mut targets = Vec::new();

    // Writer indicators
    if contains_any(
        combined,
        &[
            "文风", "风格", "描写", "写", "对白", "nsfw", "人称", "排版", "禁词", "抗八股",
            "抗重复", "抗滥用", "格式姬", "不抢话", "抢话", "字数", "段落", "叙事", "prose",
            "narration", "style", "writing", "format", "banned", "pov", "dialogue",
        ],
    ) {
        targets.push("writer".to_string());
    }

    // Director indicators
    if contains_any(
        combined,
        &[
            "节奏", "剧情", "情节", "世界观", "角色分析", "信息控制", "反全知", "情感基调",
            "限速器", "冒险", "保守", "爆炸", "director", "pacing", "plot", "world",
        ],
    ) {
        targets.push("director".to_string());
    }

    // State / Variable indicators
    if contains_any(combined, &["变量", "variable", "state"]) {
        targets.push("state".to_string());
    }

    // Lore master indicators
    if contains_any(combined, &["lore", "设定", "背景", "lore_master"]) {
        targets.push("lore_master".to_string());
    }

    // Compression indicators
    if contains_any(combined, &["总结", "摘要", "summary"]) {
        targets.push("compression".to_string());
    }

    // Default: when no class matched, keep writer as a conservative default but flag it as
    // low-confidence so the reason surfaces for review instead of silently soaking every
    // ambiguous module into the writer prompt.
    let low_confidence = targets.is_empty();
    if low_confidence {
        targets.push("writer".to_string());
    }

    (targets, low_confidence)
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
