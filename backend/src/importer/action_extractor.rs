use crate::importer::types::*;
use regex::Regex;
use std::sync::LazyLock;

// ── Compiled patterns ───────────────────────────────────────────────────

/// onclick containing setChatMessage or setChatMessages
static ONCLICK_SETMSG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"onclick\s*=\s*["'][^"']*setChat(?:Message|Messages)\s*\(\s*["']([^"']*)["']"#)
        .unwrap()
});

/// setChatMessage( or setChatMessages( in JS
static JS_SETMSG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"setChatMessages?\s*\(\s*["']([^"']*)["']"#).unwrap());

/// Main-message submission helpers in JS.
static JS_SUBMIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\b(?:Generate|generate|submitText)\s*\("#).unwrap());

/// <form[^>]+data-action=

// ── Public API ──────────────────────────────────────────────────────────

/// Extract action declarations from HTML and JS sources.
/// This intentionally records platform API touchpoints only. The original
/// HTML app remains responsible for its own buttons, views, and styling.
pub fn extract_actions(
    html: &str,
    js: &[String],
    _analysis: &JsAnalysisReport,
) -> Vec<ActionDeclaration> {
    let mut actions = Vec::new();
    actions.extend(scan_html_actions(html));
    actions.extend(scan_js_actions(js));
    // Deduplicate by label+selector
    actions.dedup_by(|a, b| a.label == b.label && a.selector == b.selector);
    actions
}

// ── HTML scanning ───────────────────────────────────────────────────────

/// Scan HTML for button[data-action], form[data-action], [aria-label], onclick handlers.
fn scan_html_actions(html: &str) -> Vec<ActionDeclaration> {
    let mut actions = Vec::new();

    // onclick with setChatMessage / setChatMessages
    for cap in ONCLICK_SETMSG_RE.captures_iter(html) {
        let msg_text = cap.get(1).unwrap().as_str();
        let label = if msg_text.is_empty() {
            "send_message".to_string()
        } else {
            msg_text.to_string()
        };
        actions.push(ActionDeclaration {
            id: format!("html:onclick:setmsg:{}", label),
            label: label.clone(),
            kind: ActionKind::SetMessage,
            selector: None,
            source: ActionSource::Html,
        });
    }

    actions
}

// ── JS scanning ─────────────────────────────────────────────────────────

/// Scan JS for setChatMessage/setChatMessages calls as action indicators.
fn scan_js_actions(js_sources: &[String]) -> Vec<ActionDeclaration> {
    let mut actions = Vec::new();

    for (i, js) in js_sources.iter().enumerate() {
        for cap in JS_SETMSG_RE.captures_iter(js) {
            let msg_text = cap.get(1).unwrap().as_str();
            let label = if msg_text.is_empty() {
                format!("send_message_{}", i)
            } else {
                msg_text.to_string()
            };
            actions.push(ActionDeclaration {
                id: format!("js:{}:setmsg:{}", i, label),
                label: label.clone(),
                kind: ActionKind::SetMessage,
                selector: None,
                source: ActionSource::Js,
            });
        }

        if JS_SUBMIT_RE.is_match(js) {
            actions.push(ActionDeclaration {
                id: format!("js:{}:submit_text", i),
                label: "submitText / Generate".to_string(),
                kind: ActionKind::SetMessage,
                selector: None,
                source: ActionSource::Js,
            });
        }
    }

    actions
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::importer::js_analyzer::analyze_js;

    fn empty_report() -> JsAnalysisReport {
        JsAnalysisReport {
            syntax_valid: true,
            syntax_errors: vec![],
            detected_apis: vec![],
            dynamic_imports: vec![],
        }
    }

    #[test]
    fn test_ignores_plain_ui_actions() {
        let html = r#"<button data-action="start-game">New Game</button><button aria-label="Open menu">Menu</button>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        assert!(actions.is_empty());
    }

    #[test]
    fn test_extract_onclick_set_chat_message() {
        let html = r#"<button onclick="setChatMessage('hello world')">Greet</button>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        let greet = actions.iter().find(|a| a.label == "hello world");
        assert!(greet.is_some());
        assert!(matches!(greet.unwrap().kind, ActionKind::SetMessage));
    }

    #[test]
    fn test_extract_js_set_chat_messages() {
        let js = vec![r#"setChatMessages('start the adventure')"#.to_string()];
        let report = analyze_js(&js);
        let actions = extract_actions("", &js, &report);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].label, "start the adventure");
        assert!(matches!(actions[0].source, ActionSource::Js));
    }

    #[test]
    fn test_deduplicate_api_actions_by_label_and_selector() {
        let html = r#"<button onclick="setChatMessage('Send')">Send</button><button onclick="setChatMessage('Send')">Send again</button>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        assert_eq!(
            actions.len(),
            1,
            "Should deduplicate identical platform API actions"
        );
    }

    #[test]
    fn test_chinese_ui_labels_are_not_platform_actions() {
        let html = r#"<button data-action="go">开始游戏</button>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        assert!(actions.is_empty());
    }

    #[test]
    fn test_empty_html_no_actions() {
        let report = empty_report();
        let actions = extract_actions("", &[], &report);
        assert!(actions.is_empty());
    }
}
