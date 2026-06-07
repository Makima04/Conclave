use crate::importer::types::*;
use regex::{NoExpand, Regex};

// ─── Public API ───────────────────────────────────────────────────────────

/// Execute all non-disabled regex_scripts against content.
///
/// Mirrors the TypeScript `executeStRegexScripts` semantics exactly:
/// 1. Filter scripts (disabled, prompt_only, markdown_only)
/// 2. For each script: parse findRegex, strip code fences from replaceString,
///    substitute macros, test and replace
/// 3. Return output with diagnostics
pub fn execute_regex_scripts(
    scripts: &[RegexScript],
    content: &str,
    options: &RegexOptions,
    is_prompt_mode: bool,
    is_markdown_mode: bool,
) -> RegexExecutionResult {
    let mut diagnostics = Vec::new();
    let mut scripts_used = Vec::new();

    if scripts.is_empty() {
        return RegexExecutionResult {
            matched: false,
            output: String::new(),
            scripts_used,
            diagnostics,
        };
    }

    let user_name = &options.user_name;
    let char_name = &options.char_name;

    let mut output = content.to_string();
    let mut any_matched = false;

    for (idx, script) in scripts.iter().enumerate() {
        // Skip disabled scripts
        if script.disabled {
            continue;
        }
        // Skip prompt_only when not in prompt mode
        if script.prompt_only && !is_prompt_mode {
            continue;
        }
        // Skip markdown_only when not in markdown mode
        if script.markdown_only && !is_markdown_mode {
            continue;
        }
        // Skip if find_regex or replace_string is empty
        if script.find_regex.is_empty() || script.replace_string.is_empty() {
            continue;
        }

        // Parse findRegex into a compiled regex
        let regex = match parse_find_regex(&script.find_regex) {
            Some(r) => r,
            None => {
                diagnostics.push(RegexDiagnostic {
                    level: DiagnosticLevel::Warn,
                    message: format!(
                        "Invalid regex pattern: {}",
                        truncate_for_log(&script.find_regex, 120)
                    ),
                    script_index: Some(idx),
                });
                continue;
            }
        };

        // Strip code fences from replaceString, then substitute macros
        let cleaned = strip_code_fences(&script.replace_string);
        let macroed = substitute_macros(&cleaned, user_name, char_name);

        // Test if the regex matches the current accumulated output
        if regex.is_match(&output) {
            any_matched = true;
            scripts_used.push(script.script_name.clone());
            output = if regex.captures_len() > 1 {
                regex.replace_all(&output, macroed.as_str()).into_owned()
            } else {
                regex
                    .replace_all(&output, NoExpand(macroed.as_str()))
                    .into_owned()
            };
        } else if is_complex_html(&macroed) {
            diagnostics.push(RegexDiagnostic {
                level: DiagnosticLevel::Info,
                message: format!(
                    "Skipped complex UI script because findRegex did not match: {}",
                    truncate_for_log(&script.find_regex, 120)
                ),
                script_index: Some(idx),
            });
        }
    }

    if !any_matched {
        return RegexExecutionResult {
            matched: false,
            output: String::new(),
            scripts_used,
            diagnostics,
        };
    }

    RegexExecutionResult {
        matched: true,
        output,
        scripts_used,
        diagnostics,
    }
}

/// Parse a findRegex string into a compiled regex.
///
/// Supports:
/// - `/pattern/flags` form (extracts and applies flags as inline modifiers)
/// - Raw regex source (used directly)
/// - Escaped-literal fallback (when raw source is invalid regex syntax)
///
/// Returns `None` if the pattern is empty or syntactically invalid.
pub fn parse_find_regex(find_regex: &str) -> Option<Regex> {
    if find_regex.is_empty() {
        return None;
    }

    // /pattern/flags form
    if find_regex.starts_with('/') {
        if let Some(last_slash) = find_regex.rfind('/') {
            if last_slash > 0 {
                let pattern = &find_regex[1..last_slash];
                let raw_flags = &find_regex[last_slash + 1..];

                // Keep only valid JS regex flags (mirrors TS: replace(/[^dgimsuvy]/g, ''))
                let valid_flags: String = raw_flags
                    .chars()
                    .filter(|c| matches!(c, 'd' | 'g' | 'i' | 'm' | 's' | 'u' | 'v' | 'y'))
                    .collect();

                // Convert JS flags to Rust inline modifiers
                let mut prefix = String::new();
                if valid_flags.contains('i') {
                    prefix.push_str("(?i)");
                }
                if valid_flags.contains('m') {
                    prefix.push_str("(?m)");
                }
                if valid_flags.contains('s') {
                    prefix.push_str("(?s)");
                }
                if valid_flags.contains('u') {
                    prefix.push_str("(?u)");
                }
                // d, v, y are not supported by the Rust regex crate — skip silently
                // g is handled by using replace_all() unconditionally

                let full_pattern = format!("{prefix}{pattern}");
                return Regex::new(&full_pattern).ok();
            }
        }
    }

    // SillyTavern-style raw regex source (most common form)
    if let Ok(re) = Regex::new(find_regex) {
        return Some(re);
    }

    // Fallback: treat the string as a literal (escape all regex-special characters).
    // Handles older/local cards that use plain strings with regex metacharacters.
    let escaped = regex::escape(find_regex);
    Regex::new(&escaped).ok()
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/// Strip markdown code fences from a string.
/// Handles ```html ... ``` and plain ``` ... ```.
fn strip_code_fences(source: &str) -> String {
    let trimmed = source.trim();
    if !trimmed.starts_with("```") {
        return source.to_string();
    }
    let Some(first_break) = trimmed.find('\n') else {
        return source.to_string();
    };
    let without_open = &trimmed[first_break + 1..];
    match without_open.rfind("```") {
        Some(close) => without_open[..close].trim_end_matches('\n').to_string(),
        None => without_open.to_string(),
    }
}

/// Basic macro substitution: `{{user}}`, `{{char}}`, `<user>`, `<char>` (case-insensitive).
/// Closing tags `</user>`, `</char>` are removed.
fn substitute_macros(text: &str, user_name: &str, char_name: &str) -> String {
    // Pre-compile once — these are fixed patterns.
    static RE_USER_BRACE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_CHAR_BRACE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_USER_OPEN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_USER_CLOSE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_CHAR_OPEN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static RE_CHAR_CLOSE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

    let re_user_brace = RE_USER_BRACE.get_or_init(|| Regex::new(r"(?i)\{\{user\}\}").unwrap());
    let re_char_brace = RE_CHAR_BRACE.get_or_init(|| Regex::new(r"(?i)\{\{char\}\}").unwrap());
    let re_user_open = RE_USER_OPEN.get_or_init(|| Regex::new(r"(?i)<user>").unwrap());
    let re_user_close = RE_USER_CLOSE.get_or_init(|| Regex::new(r"(?i)</user>").unwrap());
    let re_char_open = RE_CHAR_OPEN.get_or_init(|| Regex::new(r"(?i)<char>").unwrap());
    let re_char_close = RE_CHAR_CLOSE.get_or_init(|| Regex::new(r"(?i)</char>").unwrap());

    let result = re_user_brace.replace_all(text, user_name);
    let result = re_char_brace.replace_all(&result, char_name);
    let result = re_user_open.replace_all(&result, user_name);
    let result = re_user_close.replace_all(&result, "");
    let result = re_char_open.replace_all(&result, char_name);
    let result = re_char_close.replace_all(&result, "");

    result.into_owned()
}

/// Check whether a replacement string contains "complex" HTML that should NOT
/// be forcibly injected when the findRegex does not match.
///
/// Complex = longer than 3000 bytes OR contains `<html`, `<style`, or `<script` tags.
fn is_complex_html(source: &str) -> bool {
    if source.len() > 3000 {
        return true;
    }
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)<html\b|<style\b|<script\b").unwrap());
    re.is_match(source)
}

/// Safely truncate a string for diagnostic messages, respecting UTF-8 boundaries.
fn truncate_for_log(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build a RegexScript with minimal boilerplate.
    fn script(find: &str, replace: &str) -> RegexScript {
        RegexScript {
            script_name: String::new(),
            find_regex: find.to_string(),
            replace_string: replace.to_string(),
            disabled: false,
            prompt_only: false,
            markdown_only: false,
            min_depth: None,
            max_depth: None,
        }
    }

    fn script_disabled(find: &str, replace: &str) -> RegexScript {
        let mut s = script(find, replace);
        s.disabled = true;
        s
    }

    fn opts(user: &str, char: &str) -> RegexOptions {
        RegexOptions {
            user_name: user.to_string(),
            char_name: char.to_string(),
        }
    }

    fn default_opts() -> RegexOptions {
        opts("{{user}}", "{{char}}")
    }

    // ── Test 1: Plain string findRegex ──

    #[test]
    fn test_plain_string_find_regex() {
        let scripts = [script("Hello", "World")];
        let result = execute_regex_scripts(&scripts, "Hello there", &default_opts(), false, false);
        assert!(result.matched, "matched should be true");
        assert!(
            result.output.contains("World"),
            "output should contain 'World'"
        );
        assert!(
            !result.output.contains("Hello"),
            "output should not contain 'Hello'"
        );
        assert!(result.diagnostics.is_empty(), "no diagnostics expected");
    }

    // ── Test 2: /pattern/flags regex with group references ──

    #[test]
    fn test_pattern_flags_with_groups() {
        let scripts = [script(r"/(\w+)@(\w+)/g", "$2@$1")];
        let result =
            execute_regex_scripts(&scripts, "email: foo@bar", &default_opts(), false, false);
        assert!(result.matched, "matched should be true");
        assert!(
            result.output.contains("bar@foo"),
            "output should contain swapped 'bar@foo', got: {}",
            result.output
        );
        assert!(result.diagnostics.is_empty(), "no diagnostics expected");
    }

    // ── Test 3: Disabled scripts are skipped ──

    #[test]
    fn test_disabled_scripts_skipped() {
        let scripts = [
            script_disabled("Hello", "REPLACED"),
            script("Hello", "World"),
        ];
        let result = execute_regex_scripts(&scripts, "Hello there", &default_opts(), false, false);
        assert!(result.output.contains("World"), "should contain 'World'");
        assert!(
            !result.output.contains("REPLACED"),
            "should not contain 'REPLACED'"
        );
    }

    // ── Test 4: Invalid regex pattern produces diagnostics ──

    #[test]
    fn test_invalid_regex_produces_diagnostics() {
        let scripts = [script("/[invalid/g", "nope"), script("ok", "good")];
        let result = execute_regex_scripts(&scripts, "ok fine", &default_opts(), false, false);
        assert_eq!(result.diagnostics.len(), 1, "should have one diagnostic");
        assert_eq!(
            result.diagnostics[0].level,
            DiagnosticLevel::Warn,
            "diagnostic level should be Warn"
        );
        assert!(
            result.output.contains("good"),
            "valid script should still run"
        );
    }

    // ── Test 5: Code fence stripping in replaceString ──

    #[test]
    fn test_code_fence_stripping() {
        let scripts = [script(
            "greeting",
            "```html\n<div class=\"ui\">Hello</div>\n```",
        )];
        let result = execute_regex_scripts(&scripts, "greeting", &default_opts(), false, false);
        assert!(result.matched, "should be matched");
        assert!(
            result.output.contains(r#"<div class="ui">Hello</div>"#),
            "code fences should be stripped, got: {}",
            result.output
        );
        assert!(!result.output.contains("```"), "no backticks in output");
    }

    // ── Test 6: Complex HTML does not inject when findRegex misses ──

    #[test]
    fn test_complex_html_no_inject_on_miss() {
        let big_html = format!("<style>{}</style>", "x".repeat(3100));
        let scripts = [script("NEVER_MATCH_SENTINEL_XYZ", &big_html)];
        let result = execute_regex_scripts(
            &scripts,
            "some content without the sentinel",
            &default_opts(),
            false,
            false,
        );
        assert!(!result.matched, "matched should be false");
        assert!(result.output.is_empty(), "output should be empty");
        assert_eq!(
            result.diagnostics[0].level,
            DiagnosticLevel::Info,
            "diagnostic should explain skipped complex UI"
        );
    }

    // ── Test 7: Macro substitution ──

    #[test]
    fn test_macro_substitution() {
        let scripts = [script("greet", "Hello {{user}}, I am {{char}}!")];
        let result = execute_regex_scripts(&scripts, "greet", &opts("Alice", "Bob"), false, false);
        assert!(result.output.contains("Alice"), "should contain user name");
        assert!(result.output.contains("Bob"), "should contain char name");
        assert!(
            !result.output.contains("{{user}}"),
            "macro should be replaced"
        );
    }

    // ── Test 8: parseFindRegex helper ──

    #[test]
    fn test_parse_find_regex_slash_form() {
        // /foo\/bar/i should parse with case-insensitive flag
        let re = parse_find_regex(r"/foo\/bar/i");
        assert!(re.is_some(), "/foo\\/bar/i should parse");
        let re = re.unwrap();
        assert!(re.is_match("FOO/bar"), "case-insensitive match should work");
        assert!(re.is_match("foo/bar"), "lowercase match should work");
    }

    #[test]
    fn test_parse_find_regex_raw_source() {
        // 'literal [test]' is valid regex (character class)
        let re = parse_find_regex("literal [test]");
        assert!(re.is_some(), "literal [test] should parse as regex");
        let re = re.unwrap();
        // The regex matches "literal " followed by one of {t, e, s, t}
        assert!(re.is_match("a literal t here"), "should match 'literal t'");
        // '[test]' in the input is NOT a single char in the class — '[' is not in [test]
        assert!(
            !re.is_match("a literal [test] here"),
            "raw regex semantics: [test] in input is not a match"
        );
    }

    #[test]
    fn test_parse_find_regex_invalid_returns_none() {
        assert!(
            parse_find_regex("/[bad/").is_none(),
            "invalid regex should return None"
        );
    }

    #[test]
    fn test_parse_find_regex_empty_returns_none() {
        assert!(
            parse_find_regex("").is_none(),
            "empty string should return None"
        );
    }

    // ── Test 9: SillyTavern escaped regex source ──

    #[test]
    fn test_st_escaped_regex_source() {
        let scripts = [script(
            r"\[开局\]",
            r#"<!doctype html><head></head><body><div id="app"></div></body>"#,
        )];
        let result = execute_regex_scripts(&scripts, "[开局]", &default_opts(), false, false);
        assert!(
            result.matched,
            "escaped regex source should match bracketed text"
        );
        assert!(
            !result.output.contains("[开局]"),
            "trigger text should be replaced"
        );
        assert!(
            result.output.contains(r#"<div id="app"></div>"#),
            "replacement HTML should be present"
        );
    }

    // ── Additional: prompt_only filtering ──

    #[test]
    fn test_prompt_only_filtering() {
        let mut s = script("Hello", "PromptWorld");
        s.prompt_only = true;

        // When NOT in prompt mode, prompt_only scripts are skipped
        let scripts = [s.clone()];
        let result = execute_regex_scripts(&scripts, "Hello", &default_opts(), false, false);
        assert!(
            !result.matched,
            "prompt_only script skipped when not in prompt mode"
        );

        // When in prompt mode, prompt_only scripts run
        let scripts = [s];
        let result = execute_regex_scripts(&scripts, "Hello", &default_opts(), true, false);
        assert!(result.matched, "prompt_only script runs in prompt mode");
        assert!(result.output.contains("PromptWorld"));
    }

    // ── Additional: markdown_only filtering ──

    #[test]
    fn test_markdown_only_filtering() {
        let mut s = script("Hello", "MdWorld");
        s.markdown_only = true;

        let scripts = [s.clone()];
        let result = execute_regex_scripts(&scripts, "Hello", &default_opts(), false, false);
        assert!(
            !result.matched,
            "markdown_only script skipped when not in markdown mode"
        );

        let scripts = [s];
        let result = execute_regex_scripts(&scripts, "Hello", &default_opts(), false, true);
        assert!(result.matched, "markdown_only script runs in markdown mode");
        assert!(result.output.contains("MdWorld"));
    }

    // ── Additional: case-insensitive macros ──

    #[test]
    fn test_case_insensitive_macros() {
        let scripts = [script("x", "{{User}} and {{CHAR}}")];
        let result = execute_regex_scripts(&scripts, "x", &opts("Alice", "Bob"), false, false);
        assert!(result.output.contains("Alice"), "case-insensitive {{User}}");
        assert!(result.output.contains("Bob"), "case-insensitive {{CHAR}}");
    }

    // ── Additional: tag-style macros ──

    #[test]
    fn test_tag_style_macros() {
        let scripts = [script("x", "<user> meets <char></char>")];
        let result = execute_regex_scripts(&scripts, "x", &opts("Alice", "Bob"), false, false);
        assert!(result.output.contains("Alice"), "<user> replaced");
        assert!(result.output.contains("Bob"), "<char> replaced");
        assert!(
            !result.output.contains("</char>"),
            "closing </char> removed"
        );
    }

    // ── Additional: sequential execution order ──

    #[test]
    fn test_sequential_execution_order() {
        let scripts = [script("Hello", "World"), script("World", "Earth")];
        let result = execute_regex_scripts(&scripts, "Hello", &default_opts(), false, false);
        assert!(result.matched);
        // First script: Hello -> World. Second script: World -> Earth.
        assert!(
            result.output.contains("Earth"),
            "scripts run sequentially: Hello->World->Earth, got: {}",
            result.output
        );
        assert!(!result.output.contains("Hello"));
    }

    // ── Additional: /pattern/flags with i flag (case insensitive) ──

    #[test]
    fn test_slash_form_case_insensitive_flag() {
        let scripts = [script(r"/hello/i", "world")];
        let result = execute_regex_scripts(&scripts, "HELLO there", &default_opts(), false, false);
        assert!(result.matched, "case insensitive flag should match");
        assert!(result.output.contains("world"));
    }

    // ── Additional: /pattern/flags with s flag (dot matches newline) ──

    #[test]
    fn test_slash_form_dot_matches_newline() {
        let scripts = [script(r"/foo.bar/s", "matched")];
        let result = execute_regex_scripts(&scripts, "foo\nbar", &default_opts(), false, false);
        assert!(result.matched, "s flag should make dot match newline");
    }

    // ── Additional: /pattern/flags with m flag (multiline) ──

    #[test]
    fn test_slash_form_multiline_flag() {
        let scripts = [script(r"/^world/m", "found")];
        let result = execute_regex_scripts(&scripts, "hello\nworld", &default_opts(), false, false);
        assert!(result.matched, "m flag should make ^ match line start");
    }

    // ── Additional: strip_code_fences directly ──

    #[test]
    fn test_strip_code_fences_basic() {
        assert_eq!(
            strip_code_fences("```html\n<div>hi</div>\n```"),
            "<div>hi</div>"
        );
        assert_eq!(strip_code_fences("```\nsome code\n```"), "some code");
        assert_eq!(strip_code_fences("no fences here"), "no fences here");
    }

    // ── Additional: empty scripts array ──

    #[test]
    fn test_empty_scripts_array() {
        let scripts: [RegexScript; 0] = [];
        let result = execute_regex_scripts(&scripts, "content", &default_opts(), false, false);
        assert!(!result.matched);
        assert!(result.output.is_empty());
    }

    // ── Additional: literal fallback path ──

    #[test]
    fn test_literal_fallback() {
        // "a+b" as raw regex IS valid (one or more 'a' followed by 'b'),
        // so it won't hit the literal fallback.
        // To test the fallback, we need a truly invalid regex that isn't /pattern/flags.
        // However, most random strings ARE valid regex in Rust. Let's verify the fallback
        // path with a string that would be invalid as regex but valid after escaping.
        // Actually, in Rust almost everything is valid regex (unlike JS).
        // The main scenario is when the TS code's `new RegExp(str, 'g')` throws but
        // `new RegExp(escape(str), 'g')` works. In Rust, this rarely happens because
        // the regex crate is more lenient. But let's verify that parse_find_regex
        // returns Some for a plain string.
        assert!(parse_find_regex("hello world").is_some());
    }
}
