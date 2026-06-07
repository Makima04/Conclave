use crate::importer::types::*;
use regex::Regex;
use std::sync::LazyLock;

// ── Compiled patterns ───────────────────────────────────────────────────

/// data-action="xxx" or data-action='xxx'
static DATA_ACTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<[^>]+data-action\s*=\s*["']([^"']+)["'][^>]*>(.*?)</[^>]+>"#).unwrap()
});

/// aria-label="xxx" on interactive elements (button, a, input, div, span)
static ARIA_LABEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<(?:button|a|input|div|span)[^>]+aria-label\s*=\s*["']([^"']+)["']"#).unwrap()
});

/// onclick containing setChatMessage or setChatMessages
static ONCLICK_SETMSG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"onclick\s*=\s*["'][^"']*setChat(?:Message|Messages)\s*\(\s*["']([^"']*)["']"#)
        .unwrap()
});

/// setChatMessage( or setChatMessages( in JS
static JS_SETMSG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"setChatMessages?\s*\(\s*["']([^"']*)["']"#).unwrap());

/// <form[^>]+data-action=

// ── Public API ──────────────────────────────────────────────────────────

/// Extract action declarations from HTML and JS sources.
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

    // 1. data-action="xxx" on any element (buttons, divs, forms, etc.)
    for cap in DATA_ACTION_RE.captures_iter(html) {
        let action_value = cap.get(1).unwrap().as_str();
        let selector = format!("[data-action=\"{}\"]", action_value);
        let text_label = strip_html_tags(cap.get(2).map(|m| m.as_str()).unwrap_or(""));
        let text_label = text_label.trim();
        let label = action_value.to_string();
        let inference_label = format!("{} {}", action_value, text_label);
        let kind = infer_action_kind(&inference_label, Some(&selector));
        actions.push(ActionDeclaration {
            id: format!("html:{}", action_value),
            label,
            kind,
            selector: Some(selector),
            source: ActionSource::Html,
        });
    }

    // 2. aria-label on interactive elements
    for cap in ARIA_LABEL_RE.captures_iter(html) {
        let label = cap.get(1).unwrap().as_str().to_string();
        let kind = infer_action_kind(&label, None);
        actions.push(ActionDeclaration {
            id: format!("html:aria:{}", label),
            label: label.clone(),
            kind,
            selector: None,
            source: ActionSource::Html,
        });
    }

    // 3. onclick with setChatMessage / setChatMessages
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

fn strip_html_tags(source: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .unwrap()
        .replace_all(source, "")
        .into_owned()
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
    }

    actions
}

// ── Kind inference ──────────────────────────────────────────────────────

/// Infer action kind from label, selector, and context.
fn infer_action_kind(label: &str, selector: Option<&str>) -> ActionKind {
    let lower = label.to_lowercase();

    if lower.contains("start")
        || lower.contains("\u{5f00}\u{59cb}")
        || lower.contains("new game")
        || lower.contains("\u{65b0}\u{6e38}\u{620f}")
    {
        ActionKind::Start
    } else if lower.contains("load")
        || lower.contains("\u{8bfb}\u{6863}")
        || lower.contains("save")
        || lower.contains("\u{5b58}\u{6863}")
    {
        ActionKind::LoadSave
    } else if lower.contains("send") || lower.contains("\u{53d1}\u{9001}") {
        ActionKind::SetMessage
    } else if lower.contains("variable") || lower.contains("\u{53d8}\u{91cf}") {
        ActionKind::SetVariable
    } else if lower.contains("panel")
        || lower.contains("\u{83dc}\u{5355}")
        || lower.contains("menu")
    {
        ActionKind::OpenPanel
    } else if selector.is_some_and(|s| s.contains("data-action")) {
        // data-action elements without a clear label heuristic are still form-ish
        ActionKind::FormSubmit
    } else {
        ActionKind::Unknown
    }
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
    fn test_extract_data_action_buttons() {
        let html = r#"<button data-action="start-game">New Game</button><button data-action="load-save">Load</button>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].label, "start-game");
        assert!(matches!(actions[0].kind, ActionKind::Start));
        assert_eq!(actions[1].label, "load-save");
        assert!(matches!(actions[1].kind, ActionKind::LoadSave));
    }

    #[test]
    fn test_extract_aria_label_action() {
        let html = r#"<button aria-label="Open menu">Menu</button>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        let menu_action = actions.iter().find(|a| a.label == "Open menu");
        assert!(menu_action.is_some());
        assert!(matches!(menu_action.unwrap().kind, ActionKind::OpenPanel));
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
    fn test_deduplicate_by_label_and_selector() {
        let html = r#"<button data-action="send">Send</button><div data-action="send">Send</div>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        // Both have same label="send" and same selector="[data-action=\"send\"]"
        assert_eq!(
            actions.len(),
            1,
            "Should deduplicate identical label+selector pairs"
        );
    }

    #[test]
    fn test_chinese_labels_inferred() {
        let html = r#"<button data-action="go">开始游戏</button>"#;
        let report = empty_report();
        let actions = extract_actions(html, &[], &report);
        assert!(matches!(actions[0].kind, ActionKind::Start));
    }

    #[test]
    fn test_empty_html_no_actions() {
        let report = empty_report();
        let actions = extract_actions("", &[], &report);
        assert!(actions.is_empty());
    }
}
