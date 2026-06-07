use crate::importer::types::*;
use regex::Regex;

/// Split HTML content into html/css/js components.
pub fn split_html_app(html_content: &str) -> HtmlAppSplit {
    let is_full = is_full_document(html_content);
    let css = extract_styles(html_content);
    let (js, script_types) = extract_scripts(html_content);
    let entry = detect_entry_node(html_content);

    HtmlAppSplit {
        html: html_content.to_string(),
        css,
        js,
        script_types,
        entry_node: entry,
        is_full_document: is_full,
    }
}

/// Determine if content is a full HTML document.
/// Checks for <!doctype>, <html>, <head>, <body> tags.
fn is_full_document(html: &str) -> bool {
    let lower = html.to_lowercase();
    let has_doctype = lower.contains("<!doctype");
    let has_html_tag = lower.contains("<html");
    let has_head = lower.contains("<head");
    let has_body = lower.contains("<body");
    (has_doctype as u8 + has_html_tag as u8 + has_head as u8 + has_body as u8) >= 2
}

/// Extract `<style>` blocks from HTML.
/// Handles `<style>`, `<style type="text/css">`, `<style scoped>`, etc.
/// Returns list of CSS content strings.
fn extract_styles(html: &str) -> Vec<String> {
    let re = Regex::new(r"(?is)<style[^>]*>(.*?)</style>").unwrap();
    re.captures_iter(html)
        .map(|cap| cap[1].to_string())
        .collect()
}

/// Extract `<script>` blocks from HTML.
/// Returns (list of JS content strings, list of script type attributes).
///
/// Scripts with a `src=` attribute are skipped (external), but their type
/// is still recorded so the caller knows they exist.
fn extract_scripts(html: &str) -> (Vec<String>, Vec<String>) {
    // Match full <script ...>...</script> tags (inline scripts)
    let inline_re = Regex::new(r"(?is)<script([^>]*)>(.*?)</script>").unwrap();
    // Match <script ... src="..." ...> or <script ... src='...' ...> (external, self-closing or empty)
    let src_re = Regex::new(r#"(?is)src\s*=\s*["']([^"']+)["']"#).unwrap();

    let mut scripts = Vec::new();
    let mut types = Vec::new();

    for cap in inline_re.captures_iter(html) {
        let attrs = &cap[1];
        let body = &cap[2];

        // Extract type attribute
        let type_re = Regex::new(r#"(?is)type\s*=\s*["']([^"']+)["']"#).unwrap();
        let script_type = type_re
            .captures(attrs)
            .map(|t| t[1].to_string())
            .unwrap_or_else(|| "classic".to_string());

        // If it has src=, it's an external script — record the type but skip body
        if src_re.is_match(attrs) {
            // Skip external scripts; don't extract their (empty) body
            types.push(script_type);
            continue;
        }

        if !body.trim().is_empty() {
            scripts.push(body.to_string());
            types.push(script_type);
        }
    }

    (scripts, types)
}

/// Detect common entry nodes like `div#app`, `div#root`, etc.
fn detect_entry_node(html: &str) -> Option<String> {
    let re = Regex::new(r#"(?is)id\s*=\s*["'](app|root|mount|container|main-app|vue-app|react-root|svelte-app)["']"#).unwrap();
    re.captures(html).map(|cap| cap[1].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_full_document() {
        assert!(is_full_document(
            "<!DOCTYPE html><html><head></head><body></body></html>"
        ));
        assert!(is_full_document("<html><body>hello</body></html>"));
        // Only one indicator — not a full document
        assert!(!is_full_document("<div>hello</div>"));
        assert!(!is_full_document("<head><title>hi</title></head>"));
    }

    #[test]
    fn test_extract_styles() {
        let html = r#"
            <style>body { color: red; }</style>
            <style scoped>.foo { margin: 0; }</style>
            <div>no style here</div>
        "#;
        let styles = extract_styles(html);
        assert_eq!(styles.len(), 2);
        assert!(styles[0].contains("color: red"));
        assert!(styles[1].contains("margin: 0"));
    }

    #[test]
    fn test_extract_scripts_inline_and_external() {
        let html = r#"
            <script>console.log("inline");</script>
            <script type="module">import foo from 'bar';</script>
            <script src="external.js"></script>
            <script src="other.js" type="text/javascript"></script>
        "#;
        let (scripts, types) = extract_scripts(html);
        // Two inline scripts (the external ones are skipped)
        assert_eq!(scripts.len(), 2);
        assert_eq!(types.len(), 4); // all 4 types recorded
        assert!(scripts[0].contains("console.log"));
        assert!(scripts[1].contains("import foo"));
        assert_eq!(types[0], "classic");
        assert_eq!(types[1], "module");
        assert_eq!(types[2], "classic"); // external had no type attr
        assert_eq!(types[3], "text/javascript");
    }

    #[test]
    fn test_detect_entry_node() {
        assert_eq!(
            detect_entry_node(r#"<div id="app"></div>"#),
            Some("app".to_string())
        );
        assert_eq!(
            detect_entry_node(r#"<div id="root"></div>"#),
            Some("root".to_string())
        );
        assert_eq!(detect_entry_node("<div>no id</div>"), None);
    }

    #[test]
    fn test_split_html_app() {
        let html = r#"<!DOCTYPE html>
<html>
<head><style>body{}</style></head>
<body>
<div id="app"></div>
<script>var x = 1;</script>
</body>
</html>"#;
        let split = split_html_app(html);
        assert!(split.is_full_document);
        assert_eq!(split.css.len(), 1);
        assert_eq!(split.js.len(), 1);
        assert_eq!(split.entry_node, Some("app".to_string()));
    }
}
