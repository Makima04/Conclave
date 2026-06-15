// EJS preprocessing for character_book entries with @@preprocessing decorator
//
// In SillyTavern + ST-Prompt-Template, character_book entries marked with
// `@@preprocessing` are executed as EJS templates before the LLM prompt is assembled.
// This module provides a lightweight JS-based evaluator using boa_engine.
//
// Reference: ST-Prompt-Template/src/modules/handler.ts (handleWorldInfoLoaded)
//            ST-Prompt-Template/src/utils/evaluate.ts (evalTemplateWI)

use boa_engine::{Context, Source, JsResult};
use serde_json::Value;
use tracing::{debug, warn};

/// Decorator markers that indicate a world book entry is a preprocessing entry.
const PREPROCESSING_DECORATORS: &[&str] = &["@@preprocessing"];
const PREPROCESSING_COMMENT_MARKERS: &[&str] = &["[Preprocessing]", "EJS_"];

/// Check if a world book entry should be preprocessed.
pub fn is_preprocessing_entry(comment: &str, content: &str) -> bool {
    // Check comment markers
    for marker in PREPROCESSING_COMMENT_MARKERS {
        if comment.contains(marker) {
            return true;
        }
    }
    // Check content decorators (lines at the start of content beginning with @@)
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("@@") {
            for decorator in PREPROCESSING_DECORATORS {
                if trimmed.contains(decorator) {
                    return true;
                }
            }
        } else {
            // Stop checking after first non-decorator, non-empty line
            break;
        }
    }
    false
}

/// Strip decorator lines from the beginning of content.
fn strip_decorators(content: &str) -> String {
    let mut result = Vec::new();
    let mut in_header = true;
    for line in content.lines() {
        if in_header {
            let trimmed = line.trim();
            if trimmed.starts_with("@@") || trimmed.is_empty() {
                continue;
            }
            in_header = false;
        }
        result.push(line);
    }
    result.join("\n")
}

/// Convert EJS template to plain JavaScript that can be evaluated by boa.
///
/// EJS syntax:
///   `<% code %>` → inline JS code
///   `<%= expr %>` → output expression (appended to result string)
///   `<%- expr %>` → output expression (HTML-escaped)
///   Regular text → appended to result string as string literal
///
/// The converted code builds a `__ejs_output` string variable.
fn ejs_to_js(ejs_source: &str) -> String {
    let mut js = String::from("var __ejs_output = '';\n");
    let mut remaining = ejs_source;

    while !remaining.is_empty() {
        // Find the next EJS tag
        if let Some(start) = remaining.find("<%") {
            // Text before the tag — emit as string append
            let before = &remaining[..start];
            if !before.is_empty() {
                js.push_str(&format!("__ejs_output += {};\n", escape_js_string(before)));
            }

            // Find the closing %>
            if let Some(end) = remaining[start..].find("%>") {
                let tag_content = &remaining[start + 2..start + end];
                let tag_inner = tag_content.trim();

                if tag_inner.starts_with('=') {
                    // Output tag: <%= expr %>
                    let expr = tag_inner[1..].trim();
                    js.push_str(&format!("__ejs_output += String({});\n", expr));
                } else if tag_inner.starts_with("-") {
                    // Escaped output tag: <%- expr %>
                    let expr = tag_inner[1..].trim();
                    js.push_str(&format!("__ejs_output += String({});\n", expr));
                } else {
                    // Code tag: <% code %>
                    js.push_str(tag_inner);
                    js.push('\n');
                }

                remaining = &remaining[start + end + 2..];
            } else {
                // No closing %> — treat rest as text
                js.push_str(&format!("__ejs_output += {};\n", escape_js_string(remaining)));
                break;
            }
        } else {
            // No more tags — emit remaining as text
            js.push_str(&format!("__ejs_output += {};\n", escape_js_string(remaining)));
            break;
        }
    }

    js.push_str("__ejs_output;\n");
    js
}

/// Escape a string for use in JavaScript source.
fn escape_js_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("'{}'", escaped)
}

/// Build the JS preamble that provides ST-compatible helper functions.
fn build_js_preamble(
    user_name: &str,
    char_name: &str,
    variables: &Value,
) -> String {
    let vars_json = variables.to_string();
    format!(
        r#"
var userName = {};
var charName = {};
var _variables = {};

// getvar — read a chat variable
function getvar(name) {{
    var keys = name.split('.');
    var obj = _variables;
    for (var i = 0; i < keys.length; i++) {{
        if (obj == null) return '';
        obj = obj[keys[i]];
    }}
    return obj != null ? String(obj) : '';
}}

// setvar — set a chat variable (in-memory only for this evaluation)
function setvar(name, value) {{
    var keys = name.split('.');
    var obj = _variables;
    for (var i = 0; i < keys.length - 1; i++) {{
        if (obj[keys[i]] == null) obj[keys[i]] = {{}};
        obj = obj[keys[i]];
    }}
    obj[keys[keys.length - 1]] = value;
}}

// getGlobalVar — alias for getvar (simplified)
function getGlobalVar(name) {{ return getvar(name); }}
function getglobalvar(name) {{ return getvar(name); }}

// incvar / decvar
function incvar(name) {{
    var val = parseFloat(getvar(name)) || 0;
    setvar(name, String(val + 1));
    return String(val + 1);
}}
function decvar(name) {{
    var val = parseFloat(getvar(name)) || 0;
    setvar(name, String(val - 1));
    return String(val - 1);
}}

// substituteParams — replace {{user}} and {{char}}
function substituteParams(text) {{
    if (typeof text !== 'string') return String(text || '');
    return text.replace(/\{{\{{user\}}\}}/gi, userName).replace(/\{{\{{char\}}\}}/gi, charName);
}}

// print — EJS output function
function print() {{
    for (var i = 0; i < arguments.length; i++) {{
        __ejs_output += String(arguments[i]);
    }}
}}

// Stub functions for features not yet supported
function activewi() {{ return []; }}
function getwi() {{ return []; }}
function getchr() {{ return {{}}; }}
function getchar() {{ return {{}}; }}
function getChara() {{ return {{}}; }}
function getChatMessage() {{ return {{}}; }}
function getChatMessages() {{ return []; }}
function execute() {{}}
function activateRegex() {{}}
function injectPrompt() {{}}
function faker() {{ return {{ person: function() {{ return {{ firstName: 'NPC' }}; }} }}; }}
"#,
        escape_js_string(user_name),
        escape_js_string(char_name),
        vars_json,
    )
}

/// Preprocess a single EJS template entry.
///
/// Returns the evaluated output string, or `None` if evaluation fails.
pub fn preprocess_ejs_entry(
    content: &str,
    user_name: &str,
    char_name: &str,
    variables: &Value,
) -> Option<String> {
    // Strip @@decorator lines
    let stripped = strip_decorators(content);
    if stripped.trim().is_empty() {
        return None;
    }

    // Check if content actually contains EJS tags
    if !stripped.contains("<%") {
        // Not an EJS template — just do basic macro substitution
        let mut result = stripped;
        result = result.replace("{{user}}", user_name);
        result = result.replace("{{char}}", char_name);
        return Some(result);
    }

    // Convert EJS to JS
    let js_code = ejs_to_js(&stripped);

    // Build full script with preamble
    let preamble = build_js_preamble(user_name, char_name, variables);
    let full_script = format!("{}\n{}", preamble, js_code);

    // Evaluate with boa
    match eval_js(&full_script) {
        Ok(result) => {
            debug!("[ejs_preprocess] evaluated entry, output length: {}", result.len());
            Some(result)
        }
        Err(e) => {
            warn!("[ejs_preprocess] evaluation failed: {}", e);
            // Fall back to basic macro substitution
            let mut result = stripped;
            result = result.replace("{{user}}", user_name);
            result = result.replace("{{char}}", char_name);
            Some(result)
        }
    }
}

/// Evaluate JavaScript code and return the result as a string.
fn eval_js(code: &str) -> JsResult<String> {
    let mut context = Context::default();
    let result = context.eval(Source::from_bytes(code))?;
    // boa_engine JsValue to string
    Ok(result
        .to_string(&mut context)?
        .to_std_string_escaped())
}

/// A world book entry for preprocessing.
#[derive(Debug, Clone)]
pub struct PreprocessableEntry {
    pub index: usize,
    pub comment: String,
    pub content: String,
    pub keys: Vec<String>,
}

/// Preprocess all @@preprocessing entries in a world book.
///
/// Returns the entries with their content replaced by the EJS evaluation output.
pub fn preprocess_world_book_entries(
    entries: &mut [PreprocessableEntry],
    user_name: &str,
    char_name: &str,
    variables: &Value,
) {
    for entry in entries.iter_mut() {
        if !is_preprocessing_entry(&entry.comment, &entry.content) {
            continue;
        }

        debug!(
            "[ejs_preprocess] processing entry {}: {}",
            entry.index,
            entry.comment.chars().take(50).collect::<String>()
        );

        if let Some(processed) = preprocess_ejs_entry(&entry.content, user_name, char_name, variables) {
            entry.content = processed;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_is_preprocessing_entry_by_comment() {
        assert!(is_preprocessing_entry("EJS_SJG控制器", "some content"));
        assert!(is_preprocessing_entry("[Preprocessing] entry", "some content"));
        assert!(!is_preprocessing_entry("Normal entry", "some content"));
    }

    #[test]
    fn test_is_preprocessing_entry_by_decorator() {
        let content = "@@preprocessing\n<% if (true) { %>\nHello\n<% } %>";
        assert!(is_preprocessing_entry("some entry", content));
    }

    #[test]
    fn test_strip_decorators() {
        let content = "@@preprocessing\n@@dont_preload\nHello world";
        assert_eq!(strip_decorators(content), "Hello world");
    }

    #[test]
    fn test_ejs_to_js_simple() {
        let ejs = "Hello <%= name %>!";
        let js = ejs_to_js(ejs);
        assert!(js.contains("__ejs_output"));
        assert!(js.contains("String(name)"));
    }

    #[test]
    fn test_ejs_to_js_code_block() {
        let ejs = "<% if (show) { %>\nVisible\n<% } %>";
        let js = ejs_to_js(ejs);
        assert!(js.contains("if (show)"));
        assert!(js.contains("Visible"));
    }

    #[test]
    fn test_preprocess_ejs_basic_macro() {
        let content = "Hello {{user}}, welcome to {{char}}'s world.";
        let result = preprocess_ejs_entry(content, "Player", "NPC", &json!({})).unwrap();
        assert_eq!(result, "Hello Player, welcome to NPC's world.");
    }

    #[test]
    fn test_preprocess_ejs_template() {
        let content = "@@preprocessing\n<% var x = 42; %>\nThe answer is <%= x %>.";
        let result = preprocess_ejs_entry(content, "User", "Char", &json!({})).unwrap();
        assert!(result.contains("The answer is 42."));
    }

    #[test]
    fn test_preprocess_ejs_with_variables() {
        let content = "@@preprocessing\n<% var v = getvar('修为'); %>\n修为: <%= v %>";
        let vars = json!({"修为": "筑基五层"});
        let result = preprocess_ejs_entry(content, "User", "Char", &vars).unwrap();
        assert!(result.contains("修为: 筑基五层"));
    }
}
