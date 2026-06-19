use axum::Json;
use axum::extract::{Path, State};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;
use crate::routes::runtime_assets::{self, SessionRuntimeAssets};

const STATUS_PLACEHOLDER: &str = "<StatusPlaceHolderImpl/>";

#[derive(Debug, Deserialize, Clone, Default)]
struct RegexScript {
    #[serde(default, rename = "scriptName")]
    script_name: String,
    #[serde(default)]
    disabled: bool,
    #[serde(default, rename = "runOnEdit")]
    run_on_edit: bool,
    #[serde(default, rename = "findRegex")]
    find_regex: String,
    #[serde(default, rename = "replaceString")]
    replace_string: String,
    #[serde(default)]
    placement: Vec<i64>,
    #[serde(default, rename = "substituteRegex")]
    substitute_regex: i64,
    #[serde(default, rename = "minDepth")]
    min_depth: Option<i64>,
    #[serde(default, rename = "maxDepth")]
    max_depth: Option<i64>,
    #[serde(default, rename = "markdownOnly")]
    markdown_only: bool,
    #[serde(default, rename = "promptOnly")]
    prompt_only: bool,
}

#[derive(sqlx::FromRow)]
struct CharacterCardRenderRow {
    id: String,
    world_book_id: String,
    name: String,
    first_mes: String,
    alternate_greetings: String,
}

#[derive(sqlx::FromRow)]
struct MessageRenderRow {
    id: String,
    role: String,
    content: String,
}

#[derive(Serialize)]
pub struct RenderedMessageResponse {
    pub id: String,
    pub rendered_html: String,
}

#[derive(Serialize)]
pub struct StHostRenderResponse {
    pub world_pack_id: String,
    pub character_card_id: String,
    pub character_name: String,
    pub first_message: String,
    pub rendered_html: String,
    pub greetings: Vec<String>,
    pub rendered_greetings: Vec<String>,
    pub messages: Vec<RenderedMessageResponse>,
}

enum RegexStage {
    DisplaySource,
    MarkdownDisplay,
}

fn parse_json_array(source: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(source).unwrap_or_default()
}

fn scripts_from_assets(assets: &SessionRuntimeAssets) -> Vec<RegexScript> {
    assets
        .regex_scripts
        .iter()
        .filter_map(|script| serde_json::from_value::<RegexScript>(script.script.clone()).ok())
        .filter(|script| !script.find_regex.trim().is_empty())
        .collect()
}

fn message_has_status_variable_payload(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("<initvar") || lower.contains("<updatevariable")
}

fn append_status_placeholder_if_needed(
    message: &str,
    scripts: &[RegexScript],
    has_tavern_helper_scripts: bool,
) -> String {
    if message.contains(STATUS_PLACEHOLDER) {
        return message.to_string();
    }

    let has_statusbar_regex = scripts.iter().any(|script| {
        !script.disabled
            && script.markdown_only
            && script.find_regex.trim() == STATUS_PLACEHOLDER
            && !script.replace_string.trim().is_empty()
    });

    if !has_statusbar_regex {
        return message.to_string();
    }

    // MVU cards: in native ST, MVU's tavern_helper_script injects the placeholder
    // into each assistant message at runtime (on generation_ended). Our runtime event
    // bridge doesn't fire MVU's injection, so the marker never lands and the
    // statusbar regex has nothing to replace → no status bar renders. Inject it at
    // render time instead. If MVU's runtime injection later fires, its
    // `message.includes(STATUS_PLACEHOLDER)` guard makes it a no-op, so no conflict.
    if has_tavern_helper_scripts {
        return format!("{message}\n{STATUS_PLACEHOLDER}");
    }

    // Non-MVU cards: only inject when the message already carries a status payload.
    if message_has_status_variable_payload(message) {
        format!("{message}\n{STATUS_PLACEHOLDER}")
    } else {
        message.to_string()
    }
}

/// Heuristic: does this `replaceString` render a full/complex HTML surface (a
/// card body, not a tiny sub-component box)? Used to distinguish the card's
/// main narrative template from short sub-component wrappers like `<inner>`.
fn is_complex_html(s: &str) -> bool {
    if s.len() > 2000 {
        return true;
    }
    let lower = s.to_ascii_lowercase();
    lower.contains("<style") || lower.contains("<script") || lower.contains("<html")
}

/// Pull the wrapper tag NAME out of a findRegex shaped like `<TAG…>…</TAG>`
/// (with the closing slash possibly escaped as `<\/TAG>`, since it lives inside
/// a regex string). Returns None for self-closing singletons like
/// `<StatusPlaceHolderImpl/>` (no matching close tag) and for non-tag patterns.
fn extract_wrapper_tag_name(find_regex: &str) -> Option<String> {
    let opener = Regex::new(r"<(\p{L}[\p{L}\p{N}_]*)").ok()?;
    for cap in opener.captures_iter(find_regex) {
        let name = cap.get(1)?.as_str();
        let close_unescaped = format!("</{}", name);
        let close_escaped = format!("<\\/{}", name);
        if find_regex.contains(&close_unescaped) || find_regex.contains(&close_escaped) {
            return Some(name.to_string());
        }
    }
    None
}

/// Discover the card's "narrative wrapper" tag generically — the markdownOnly
/// regex whose findRegex is `<TAG>…</TAG>` AND whose replaceString is the
/// dominant, complex body template (the galaxy starfield / full-page renderer).
/// No tag name is hardcoded: it is read from the card's own scripts.
/// If a card declares several such wrappers, the longest replaceString wins
/// (it is almost always the main body).
fn discover_narrative_wrap_tag(scripts: &[RegexScript]) -> Option<String> {
    let mut best: Option<(String, usize)> = None;
    for s in scripts {
        if s.disabled || !s.markdown_only || s.replace_string.trim().is_empty() {
            continue;
        }
        if !is_complex_html(&s.replace_string) {
            continue;
        }
        if let Some(tag) = extract_wrapper_tag_name(&s.find_regex) {
            let len = s.replace_string.len();
            match &best {
                None => best = Some((tag, len)),
                Some((_, prev_len)) if len > *prev_len => best = Some((tag, len)),
                _ => {}
            }
        }
    }
    best.map(|(tag, _)| tag)
}

/// If the card has a narrative-wrapper tag but the message omits its open tag
/// (the model "forgot" to wrap), wrap the whole body so the card's display
/// regex fires. Already-wrapped messages are left untouched (the card's own
/// regex tolerates an unclosed tag via its `(?:</tag>|$)` fallback, so we never
/// double-wrap). Render-time only: persisted content is not modified.
fn wrap_narrative_if_needed(message: &str, scripts: &[RegexScript]) -> String {
    let Some(tag) = discover_narrative_wrap_tag(scripts) else {
        return message.to_string();
    };
    let open_marker = format!("<{}", tag);
    if message.contains(&open_marker) {
        return message.to_string();
    }
    format!("<{}>\n{}\n</{}>", tag, message.trim_end(), tag)
}

fn should_run_script(script: &RegexScript, stage: &RegexStage) -> bool {
    if script.disabled {
        return false;
    }

    match stage {
        RegexStage::DisplaySource => !script.markdown_only && !script.prompt_only,
        RegexStage::MarkdownDisplay => script.markdown_only,
    }
}

fn expand_replacement(template: &str, captures: &Captures<'_>) -> String {
    let mut output = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    let capture_count = captures.len().saturating_sub(1);

    while let Some(ch) = chars.next() {
        if ch != '$' {
            output.push(ch);
            continue;
        }

        match chars.peek().copied() {
            Some('$') => {
                chars.next();
                output.push('$');
            }
            Some('&') => {
                chars.next();
                output.push_str(captures.get(0).map_or("", |matched| matched.as_str()));
            }
            Some('1'..='9') => {
                let first_digit = chars.next().unwrap();
                let first_index = first_digit.to_digit(10).unwrap() as usize;
                let second_digit = chars.peek().copied().filter(|next| next.is_ascii_digit());

                if let Some(second_digit) = second_digit {
                    let second_index = second_digit.to_digit(10).unwrap() as usize;
                    let two_digit_index = first_index * 10 + second_index;
                    if two_digit_index <= capture_count {
                        chars.next();
                        output.push_str(
                            captures
                                .get(two_digit_index)
                                .map_or("", |matched| matched.as_str()),
                        );
                        continue;
                    }
                }

                if first_index <= capture_count {
                    output.push_str(
                        captures
                            .get(first_index)
                            .map_or("", |matched| matched.as_str()),
                    );
                } else {
                    output.push('$');
                    output.push(first_digit);
                }
            }
            Some('{') => {
                chars.next();
                let mut name = String::new();
                let mut closed = false;
                for next in chars.by_ref() {
                    if next == '}' {
                        closed = true;
                        break;
                    }
                    name.push(next);
                }

                if closed {
                    if let Some(value) = captures.name(&name) {
                        output.push_str(value.as_str());
                    } else {
                        output.push_str("${");
                        output.push_str(&name);
                        output.push('}');
                    }
                } else {
                    output.push_str("${");
                    output.push_str(&name);
                }
            }
            _ => output.push('$'),
        }
    }

    output
}

fn apply_scripts_for_stage(text: &str, scripts: &[RegexScript], stage: RegexStage) -> String {
    let mut result = text.to_string();

    for script in scripts {
        if !should_run_script(script, &stage) {
            continue;
        }

        let raw = script.find_regex.trim();
        let (clean_regex, flags) = if raw.starts_with('/') {
            let without_leading = &raw[1..];
            if let Some(last_slash) = without_leading.rfind('/') {
                (
                    &without_leading[..last_slash],
                    &without_leading[last_slash + 1..],
                )
            } else {
                (without_leading, "")
            }
        } else {
            (raw, "")
        };

        let mut regex_prefix = String::new();
        if flags.contains('m') {
            regex_prefix.push_str("(?m)");
        }
        if flags.contains('s') {
            regex_prefix.push_str("(?s)");
        }

        if let Ok(re) = Regex::new(&format!("{}{}", regex_prefix, clean_regex)) {
            result = re
                .replace_all(&result, |captures: &Captures| {
                    expand_replacement(&script.replace_string, captures)
                })
                .to_string();
        }
    }

    result
}

fn strip_markdown_fences(text: &str) -> String {
    if let Some(content) = strip_outer_html_fence(text) {
        return content;
    }

    let re = Regex::new(r"(?is)```\s*(?:html\b)?\s*([\s\S]*?)\s*```").unwrap();
    re.replace_all(text, |captures: &Captures| {
        let content = captures.get(1).map_or("", |matched| matched.as_str());
        if looks_like_html(content) {
            content.trim().to_string()
        } else {
            captures
                .get(0)
                .map_or(String::new(), |matched| matched.as_str().to_string())
        }
    })
    .to_string()
}

fn strip_outer_html_fence(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return None;
    }

    let mut inner = trimmed.trim_start_matches("```").trim_start();
    let has_html_label = inner
        .get(..4)
        .map(|prefix| prefix.eq_ignore_ascii_case("html"))
        .unwrap_or(false);
    let html_label_is_separate = inner
        .get(4..)
        .and_then(|rest| rest.chars().next())
        .map(char::is_whitespace)
        .unwrap_or(true);
    if has_html_label && html_label_is_separate {
        inner = inner[4..].trim_start();
    }

    let trimmed_inner = inner.trim_end();
    let inner_without_closing = if trimmed_inner.ends_with("```") {
        &trimmed_inner[..trimmed_inner.len() - 3]
    } else {
        inner
    };

    let content = inner_without_closing.trim();
    if looks_like_html(content) {
        Some(content.to_string())
    } else {
        None
    }
}

fn looks_like_html(text: &str) -> bool {
    let trimmed = text.trim_start().to_ascii_lowercase();
    [
        "<!doctype",
        "<html",
        "<head",
        "<body",
        "<style",
        "<script",
        "<div",
        "<section",
        "<article",
        "<main",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix))
}

fn render_card_message(
    message: &str,
    scripts: &[RegexScript],
    has_tavern_helper_scripts: bool,
) -> String {
    // Auto-wrap a bare narrative in the card's wrapper tag BEFORE the regex
    // stages run, so a model that omitted `<正文>` still gets the card's body
    // template. Generic: the tag is discovered from the scripts, never hardcoded.
    let mut result = wrap_narrative_if_needed(message, scripts);
    result = append_status_placeholder_if_needed(&result, scripts, has_tavern_helper_scripts);
    result = apply_scripts_for_stage(&result, scripts, RegexStage::DisplaySource);
    result = apply_scripts_for_stage(&result, scripts, RegexStage::MarkdownDisplay);
    strip_markdown_fences(&result)
}

pub async fn get_session_st_host_render(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<StHostRenderResponse>, AppError> {
    let card = sqlx::query_as::<_, CharacterCardRenderRow>(
        "SELECT cc.id, cc.world_book_id, cc.name, cc.first_mes, cc.alternate_greetings
         FROM sessions s
         INNER JOIN character_cards cc ON cc.world_book_id = s.world_pack_id
         WHERE s.id = ? AND s.deleted_at IS NULL",
    )
    .bind(&session_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("No character card for this session".to_string()))?;

    let assets = runtime_assets::load_session_runtime_assets(&state, &session_id).await?;
    let scripts = scripts_from_assets(&assets);
    let has_tavern_helper_scripts = !assets.tavern_helper_scripts.is_empty();
    let greetings = parse_json_array(&card.alternate_greetings);
    let rendered_html = render_card_message(&card.first_mes, &scripts, has_tavern_helper_scripts);
    let rendered_greetings = greetings
        .iter()
        .map(|greeting| render_card_message(greeting, &scripts, has_tavern_helper_scripts))
        .collect::<Vec<_>>();

    let message_rows = sqlx::query_as::<_, MessageRenderRow>(
        "SELECT id, role, content
         FROM messages
         WHERE session_id = ?
         ORDER BY turn_number ASC, created_at ASC
         LIMIT 200",
    )
    .bind(&session_id)
    .fetch_all(&state.pool)
    .await?;

    let messages = message_rows
        .into_iter()
        .filter(|message| message.role == "assistant")
        .map(|message| RenderedMessageResponse {
            id: message.id,
            rendered_html: render_card_message(
                &message.content,
                &scripts,
                has_tavern_helper_scripts,
            ),
        })
        .collect();

    Ok(Json(StHostRenderResponse {
        world_pack_id: card.world_book_id,
        character_card_id: card.id,
        character_name: card.name,
        first_message: card.first_mes,
        rendered_html,
        greetings,
        rendered_greetings,
        messages,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(find_regex: &str, replace_string: &str, markdown_only: bool) -> RegexScript {
        RegexScript {
            script_name: "test".to_string(),
            disabled: false,
            run_on_edit: false,
            find_regex: find_regex.to_string(),
            replace_string: replace_string.to_string(),
            placement: Vec::new(),
            substitute_regex: 0,
            min_depth: None,
            max_depth: None,
            markdown_only,
            prompt_only: false,
        }
    }

    #[test]
    fn replacement_preserves_javascript_template_expressions() {
        let output = render_card_message(
            "{{GameStart}}",
            &[script(
                "/\\{\\{GameStart\\}\\}/g",
                "const $grid = $('#grid'); return `${fb.id}:${m}:${s}`;",
                false,
            )],
            false,
        );

        assert!(output.contains("const $grid = $('#grid');"));
        assert!(output.contains("`${fb.id}:${m}:${s}`"));
    }

    #[test]
    fn replacement_expands_named_capture_groups() {
        let output = render_card_message(
            "name=Makima",
            &[script(
                "/name=(?<name>\\w+)/g",
                "<span>${name}</span>",
                false,
            )],
            false,
        );

        assert_eq!(output, "<span>Makima</span>");
    }

    #[test]
    fn markdown_fence_stripping_handles_inline_html_fences() {
        let output = render_card_message(
            "x",
            &[script(
                "x",
                "intro ```html <div class=\"panel\">ok</div>``` outro",
                true,
            )],
            false,
        );

        assert_eq!(output, "intro <div class=\"panel\">ok</div> outro");
    }

    #[test]
    fn mvu_card_appends_status_placeholder_at_render_time() {
        // MVU card (tavern_helper_scripts present) with a statusbar regex: the message
        // has no <UpdateVariable>/<initvar> payload, but the placeholder must still be
        // injected at render time so the statusbar regex renders the status card.
        // (Native ST lets MVU inject it at runtime on generation_ended; our event
        // bridge doesn't fire that, so render-time injection is required.)
        let scripts = vec![script(
            "<StatusPlaceHolderImpl/>",
            "<div class=\"status-card\">stats</div>",
            true, // markdownOnly
        )];
        let output = render_card_message("开场正文", &scripts, /*has_tavern_helper_scripts=*/ true);

        assert!(output.contains("status-card"));
        assert!(!output.contains("<StatusPlaceHolderImpl/>")); // marker replaced, not left raw
    }

    #[test]
    fn mvu_card_without_statusbar_regex_does_not_inject_marker() {
        // tavern_helper_scripts present but NO statusbar regex: don't inject the marker
        // (nothing would consume it → raw text would leak into the message).
        let scripts = vec![script("x", "y", true)];
        let output = render_card_message("开场正文", &scripts, /*has_tavern_helper_scripts=*/ true);

        assert_eq!(output, "开场正文");
    }

    // --- generic narrative-wrap-tag discovery (no hardcoded <正文>) ---

    #[test]
    fn extract_wrapper_tag_name_cjk_with_escaped_close() {
        let fr = r"/<正文>([\s\S]*?)(?:<\/正文>|$)/s";
        assert_eq!(extract_wrapper_tag_name(fr).as_deref(), Some("正文"));
    }

    #[test]
    fn extract_wrapper_tag_name_ascii_tag_with_attrs() {
        let fr = r"<content\b[^>]*>((?:(?!<\/?content\b)[\s\S])*?)<\/content\s*>";
        assert_eq!(extract_wrapper_tag_name(fr).as_deref(), Some("content"));
    }

    #[test]
    fn extract_wrapper_tag_name_rejects_self_closing_singleton() {
        // <StatusPlaceHolderImpl/> has no matching close tag → None.
        assert_eq!(extract_wrapper_tag_name("<StatusPlaceHolderImpl/>"), None);
    }

    #[test]
    fn discover_wrap_tag_ignores_subcomponents_and_statusbar() {
        // <inner> is a short sub-component wrapper (its replaceString is a tiny
        // box, not complex HTML) → must NOT be picked.
        // <正文> has a complex replaceString → the narrative wrapper.
        // <StatusPlaceHolderImpl/> is the statusbar singleton.
        let scripts = vec![
            script(r"/<inner>([\s\S]*?)<\/inner>/", "<div class=\"box\">x</div>", true),
            script(
                r"/<正文>([\s\S]*?)(?:<\/正文>|$)/s",
                "<style>galaxy{}</style><div class=\"galaxy-container\"></div>",
                true,
            ),
            script("<StatusPlaceHolderImpl/>", "<style>big status</style><script>init()</script>", true),
        ];
        assert_eq!(discover_narrative_wrap_tag(&scripts).as_deref(), Some("正文"));
    }

    #[test]
    fn discover_wrap_tag_none_when_only_statusbar_and_updatevar() {
        let scripts = vec![
            script("<StatusPlaceHolderImpl/>", "<style>s</style><script>x</script>", true),
            script(r"/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/", "", true),
        ];
        assert_eq!(discover_narrative_wrap_tag(&scripts), None);
    }

    #[test]
    fn wrap_narrative_if_needed_wraps_bare_message() {
        let scripts = vec![script(
            r"/<正文>([\s\S]*?)(?:<\/正文>|$)/s",
            "<style>g{}</style><div class=\"galaxy\">$1</div>",
            true,
        )];
        assert_eq!(
            wrap_narrative_if_needed("走廊很长。", &scripts),
            "<正文>\n走廊很长。\n</正文>"
        );
    }

    #[test]
    fn wrap_narrative_if_needed_leaves_wrapped_message_untouched() {
        let scripts = vec![script(
            r"/<正文>([\s\S]*?)(?:<\/正文>|$)/s",
            "<style>g{}</style><div class=\"galaxy\">$1</div>",
            true,
        )];
        let msg = "<正文>\n走廊很长。\n</正文>";
        assert_eq!(wrap_narrative_if_needed(msg, &scripts), msg);
    }

    #[test]
    fn wrap_narrative_if_needed_noop_when_no_wrapper_regex() {
        // A card with only a statusbar regex: bare text must pass through unwrapped.
        let scripts = vec![script("<StatusPlaceHolderImpl/>", "<style>s</style><script>x</script>", true)];
        assert_eq!(wrap_narrative_if_needed("走廊很长。", &scripts), "走廊很长。");
    }

    #[test]
    fn render_card_message_wraps_bare_narrative_before_display_regex() {
        // End-to-end: a bare (unwrapped) assistant message + a <正文> wrapper
        // regex whose replace echoes the captured body. Without auto-wrap the
        // regex never matches; with it, the body template renders.
        let scripts = vec![script(
            r"/<正文>([\s\S]*?)(?:<\/正文>|$)/s",
            "<style>g{}</style><galaxy>$1</galaxy>",
            true,
        )];
        let output = render_card_message("走廊很长。", &scripts, false);
        assert!(output.contains("<galaxy>"), "body template should render: {output}");
        assert!(output.contains("走廊很长"), "narrative should survive: {output}");
    }
}
