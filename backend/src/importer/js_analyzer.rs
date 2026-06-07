use crate::importer::types::*;
use regex::Regex;
use std::sync::LazyLock;

// ── Patterns (compiled once) ────────────────────────────────────────────

static DYNAMIC_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"import\s*\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap());

// ── Public API ──────────────────────────────────────────────────────────

/// Analyze JavaScript sources for syntax validity and API usage.
pub fn analyze_js(js_sources: &[String]) -> JsAnalysisReport {
    let mut all_errors = Vec::new();
    let mut all_apis: Vec<DetectedApi> = Vec::new();
    let mut all_dynamic_imports = Vec::new();

    for (i, js) in js_sources.iter().enumerate() {
        let file_label = format!("script_{}", i);
        all_errors.extend(check_syntax(js, &file_label));

        let apis = detect_apis(js, &file_label);
        for api in apis {
            if let Some(existing) = all_apis.iter_mut().find(|a| a.name == api.name) {
                existing.occurrences.extend(api.occurrences);
            } else {
                all_apis.push(api);
            }
        }

        all_dynamic_imports.extend(scan_dynamic_imports(js, &file_label));
    }

    JsAnalysisReport {
        syntax_valid: all_errors.is_empty(),
        syntax_errors: all_errors,
        detected_apis: all_apis,
        dynamic_imports: all_dynamic_imports,
    }
}

// ── Syntax checking (balanced delimiters) ───────────────────────────────

/// Check JS syntax using heuristic balanced-brace analysis.
/// Skips content inside string/template literals and comments.
fn check_syntax(js: &str, _file_label: &str) -> Vec<SyntaxError> {
    let mut errors = Vec::new();
    let chars: Vec<char> = js.chars().collect();
    let len = chars.len();

    // Stack of expected closing delimiters
    let mut stack: Vec<(char, usize, usize, usize)> = Vec::new(); // (expected_close, offset, line, col)

    let mut line: usize = 1;
    let mut col: usize = 1;
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        // ── Skip single-line comment ──
        if ch == '/' && i + 1 < len && chars[i + 1] == '/' {
            while i < len && chars[i] != '\n' {
                advance(&chars, &mut i, &mut line, &mut col);
            }
            continue;
        }

        // ── Skip multi-line comment ──
        if ch == '/' && i + 1 < len && chars[i + 1] == '*' {
            i += 2;
            col += 2;
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                advance(&chars, &mut i, &mut line, &mut col);
            }
            if i + 1 < len {
                i += 2;
                col += 2;
            }
            continue;
        }

        // ── Skip regex literal ──
        if ch == '/' && likely_regex_literal_start(&chars, i) {
            skip_regex_literal(&chars, &mut i, &mut line, &mut col);
            continue;
        }

        // ── Skip single-quoted string ──
        if ch == '\'' {
            advance(&chars, &mut i, &mut line, &mut col);
            while i < len && chars[i] != '\'' {
                if chars[i] == '\\' && i + 1 < len {
                    advance(&chars, &mut i, &mut line, &mut col);
                }
                advance(&chars, &mut i, &mut line, &mut col);
            }
            if i < len {
                advance(&chars, &mut i, &mut line, &mut col); // closing quote
            }
            continue;
        }

        // ── Skip double-quoted string ──
        if ch == '"' {
            advance(&chars, &mut i, &mut line, &mut col);
            while i < len && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < len {
                    advance(&chars, &mut i, &mut line, &mut col);
                }
                advance(&chars, &mut i, &mut line, &mut col);
            }
            if i < len {
                advance(&chars, &mut i, &mut line, &mut col);
            }
            continue;
        }

        // ── Skip template literal ──
        if ch == '`' {
            advance(&chars, &mut i, &mut line, &mut col);
            while i < len && chars[i] != '`' {
                if chars[i] == '\\' && i + 1 < len {
                    advance(&chars, &mut i, &mut line, &mut col);
                }
                advance(&chars, &mut i, &mut line, &mut col);
            }
            if i < len {
                advance(&chars, &mut i, &mut line, &mut col); // closing backtick
            }
            continue;
        }

        // ── Track opening delimiters ──
        if ch == '(' || ch == '{' || ch == '[' {
            let expected = match ch {
                '(' => ')',
                '{' => '}',
                '[' => ']',
                _ => unreachable!(),
            };
            stack.push((expected, i, line, col));
            advance(&chars, &mut i, &mut line, &mut col);
            continue;
        }

        // ── Track closing delimiters ──
        if ch == ')' || ch == '}' || ch == ']' {
            if let Some((expected, _open_off, _open_line, _open_col)) = stack.last() {
                if *expected == ch {
                    stack.pop();
                } else {
                    if errors.len() < 10 {
                        let (excerpt, _) = excerpt_at(&chars, i, 80);
                        errors.push(SyntaxError {
                            message: format!(
                                "Mismatched delimiter: expected '{}' but found '{}'",
                                expected, ch
                            ),
                            line,
                            column: col,
                            offset: i,
                            excerpt,
                        });
                    }
                    // Pop anyway to avoid cascading
                    stack.pop();
                }
            } else if errors.len() < 10 {
                let (excerpt, _) = excerpt_at(&chars, i, 80);
                errors.push(SyntaxError {
                    message: format!("Unmatched closing delimiter '{}'", ch),
                    line,
                    column: col,
                    offset: i,
                    excerpt,
                });
            }
            advance(&chars, &mut i, &mut line, &mut col);
            continue;
        }

        advance(&chars, &mut i, &mut line, &mut col);
    }

    // Report unclosed delimiters
    for &(_expected, off, open_line, open_col) in stack.iter() {
        if errors.len() >= 10 {
            break;
        }
        let (excerpt, _) = excerpt_at(&chars, off, 80);
        errors.push(SyntaxError {
            message: "Unclosed delimiter".to_string(),
            line: open_line,
            column: open_col,
            offset: off,
            excerpt,
        });
    }

    errors
}

fn likely_regex_literal_start(chars: &[char], offset: usize) -> bool {
    match previous_significant_char(chars, offset) {
        None => true,
        Some(ch) => matches!(
            ch,
            '(' | '{'
                | '['
                | ','
                | ';'
                | ':'
                | '='
                | '!'
                | '?'
                | '+'
                | '-'
                | '*'
                | '%'
                | '&'
                | '|'
                | '^'
                | '~'
                | '<'
                | '>'
        ),
    }
}

fn previous_significant_char(chars: &[char], offset: usize) -> Option<char> {
    let mut i = offset;
    while i > 0 {
        i -= 1;
        if !chars[i].is_whitespace() {
            return Some(chars[i]);
        }
    }
    None
}

fn skip_regex_literal(chars: &[char], i: &mut usize, line: &mut usize, col: &mut usize) {
    advance(chars, i, line, col);
    let mut in_class = false;

    while *i < chars.len() {
        let ch = chars[*i];
        if ch == '\\' && *i + 1 < chars.len() {
            advance(chars, i, line, col);
            advance(chars, i, line, col);
            continue;
        }
        if ch == '[' {
            in_class = true;
            advance(chars, i, line, col);
            continue;
        }
        if ch == ']' {
            in_class = false;
            advance(chars, i, line, col);
            continue;
        }
        if ch == '/' && !in_class {
            advance(chars, i, line, col);
            while *i < chars.len() && chars[*i].is_ascii_alphabetic() {
                advance(chars, i, line, col);
            }
            break;
        }
        if ch == '\n' {
            break;
        }
        advance(chars, i, line, col);
    }
}

/// Advance one character, tracking line/column.
fn advance(chars: &[char], i: &mut usize, line: &mut usize, col: &mut usize) {
    if *i < chars.len() {
        if chars[*i] == '\n' {
            *line += 1;
            *col = 1;
        } else {
            *col += 1;
        }
        *i += 1;
    }
}

/// Extract an excerpt around the given offset.
fn excerpt_at(chars: &[char], offset: usize, radius: usize) -> (String, usize) {
    let len = chars.len();
    let start = offset.saturating_sub(radius);
    let end = (offset + radius).min(len);
    let text: String = chars[start..end].iter().collect();
    (text, start)
}

// ── API detection ───────────────────────────────────────────────────────

/// Detect known API usage by pattern matching.
fn detect_apis(js: &str, file_label: &str) -> Vec<DetectedApi> {
    let api_patterns: &[(&str, ApiClassification)] = &[
        // PlatformNative
        ("getVariables", ApiClassification::PlatformNative),
        ("setVariables", ApiClassification::PlatformNative),
        ("updateVariablesWith", ApiClassification::PlatformNative),
        ("getChatMessages", ApiClassification::PlatformNative),
        ("setChatMessages", ApiClassification::PlatformNative),
        ("setChatMessage", ApiClassification::PlatformNative),
        ("waitGlobalInitialized", ApiClassification::PlatformNative),
        ("TavernHelper", ApiClassification::PlatformNative),
        ("getMvuData", ApiClassification::PlatformNative),
        ("replaceMvuData", ApiClassification::PlatformNative),
        ("Mvu", ApiClassification::PlatformNative),
        // BrowserShim
        ("localStorage", ApiClassification::BrowserShim),
        ("sessionStorage", ApiClassification::BrowserShim),
        ("indexedDB", ApiClassification::BrowserShim),
        ("openDatabase", ApiClassification::BrowserShim),
        // Unsupported
        ("eventOn", ApiClassification::Unsupported),
        ("eventOnce", ApiClassification::Unsupported),
        ("eventRemoveListener", ApiClassification::Unsupported),
        // Dangerous
        ("eval", ApiClassification::Dangerous),
        ("document.write", ApiClassification::Dangerous),
        ("innerHTML", ApiClassification::Dangerous),
    ];

    let mut results: Vec<DetectedApi> = Vec::new();

    for (name, classification) in api_patterns {
        // Use word-boundary matching. For names with dots (e.g. "document.write"),
        // we escape the dot for the regex.
        let escaped: String = name
            .chars()
            .map(|c| {
                if c == '.' {
                    "\\.".to_string()
                } else {
                    c.to_string()
                }
            })
            .collect();
        let pattern = format!(r"\b{}\b", escaped);
        let re = match Regex::new(&pattern) {
            Ok(re) => re,
            Err(_) => continue,
        };

        let occurrences: Vec<SourceLocation> = re
            .find_iter(js)
            .map(|m| {
                let offset = m.start();
                let (excerpt, _) = excerpt_around(js, offset, 80);
                SourceLocation {
                    file: file_label.to_string(),
                    offset,
                    excerpt,
                }
            })
            .collect();

        if !occurrences.is_empty() {
            results.push(DetectedApi {
                name: name.to_string(),
                occurrences,
                classification: classification.clone(),
            });
        }
    }

    results
}

/// Get an excerpt of ~`radius` chars around `offset` in a string.
fn excerpt_around(s: &str, offset: usize, radius: usize) -> (String, usize) {
    let start = offset.saturating_sub(radius);
    let end = (offset + radius).min(s.len());
    // Snap to char boundaries
    let start = snap_boundary(s, start);
    let end = snap_boundary(s, end);
    (s[start..end].to_string(), start)
}

fn snap_boundary(s: &str, mut idx: usize) -> usize {
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

// ── Dynamic imports ─────────────────────────────────────────────────────

/// Scan for dynamic `import()` calls.
fn scan_dynamic_imports(js: &str, file_label: &str) -> Vec<DynamicImport> {
    DYNAMIC_IMPORT_RE
        .captures_iter(js)
        .filter_map(|cap| {
            let m = cap.get(0)?;
            let source = cap.get(1)?.as_str().to_string();
            let offset = m.start();
            let (excerpt, _) = excerpt_around(js, offset, 80);
            Some(DynamicImport {
                source,
                location: SourceLocation {
                    file: file_label.to_string(),
                    offset,
                    excerpt,
                },
            })
        })
        .collect()
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_js_no_errors() {
        let js = "function foo() { return 1 + 2; }".to_string();
        let report = analyze_js(&[js]);
        assert!(report.syntax_valid, "Expected no syntax errors");
        assert!(report.syntax_errors.is_empty());
    }

    #[test]
    fn test_mismatched_brace_detected() {
        let js = "function foo() { return (1 + 2; }".to_string();
        let report = analyze_js(&[js]);
        assert!(!report.syntax_valid);
        assert!(!report.syntax_errors.is_empty());
    }

    #[test]
    fn test_detect_platform_native_apis() {
        let js = r#"
            const vars = getVariables(["hp", "mp"]);
            setVariables({hp: 100});
            TavernHelper.getVersion();
        "#
        .to_string();
        let report = analyze_js(&[js]);
        let api_names: Vec<&str> = report
            .detected_apis
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert!(
            api_names.contains(&"getVariables"),
            "Should detect getVariables"
        );
        assert!(
            api_names.contains(&"setVariables"),
            "Should detect setVariables"
        );
        assert!(
            api_names.contains(&"TavernHelper"),
            "Should detect TavernHelper"
        );
    }

    #[test]
    fn test_detect_dangerous_apis() {
        let js = "eval(code); document.write(html);".to_string();
        let report = analyze_js(&[js]);
        let dangerous: Vec<&str> = report
            .detected_apis
            .iter()
            .filter(|a| matches!(a.classification, ApiClassification::Dangerous))
            .map(|a| a.name.as_str())
            .collect();
        assert!(dangerous.contains(&"eval"));
        assert!(dangerous.contains(&"document.write"));
    }

    #[test]
    fn test_detect_browser_shim_apis() {
        let js = "localStorage.setItem('x', '1'); sessionStorage.getItem('y');".to_string();
        let report = analyze_js(&[js]);
        let shim_names: Vec<&str> = report
            .detected_apis
            .iter()
            .filter(|a| matches!(a.classification, ApiClassification::BrowserShim))
            .map(|a| a.name.as_str())
            .collect();
        assert!(shim_names.contains(&"localStorage"));
        assert!(shim_names.contains(&"sessionStorage"));
    }

    #[test]
    fn test_detect_unsupported_apis() {
        let js = "eventOn('click', handler);".to_string();
        let report = analyze_js(&[js]);
        let unsupported: Vec<&str> = report
            .detected_apis
            .iter()
            .filter(|a| matches!(a.classification, ApiClassification::Unsupported))
            .map(|a| a.name.as_str())
            .collect();
        assert!(unsupported.contains(&"eventOn"));
    }

    #[test]
    fn test_dynamic_imports() {
        let js =
            r#"const mod = import("./local-module.js"); import('https://cdn.example.com/lib.js');"#
                .to_string();
        let report = analyze_js(&[js]);
        assert_eq!(report.dynamic_imports.len(), 2);
        assert_eq!(report.dynamic_imports[0].source, "./local-module.js");
        assert_eq!(
            report.dynamic_imports[1].source,
            "https://cdn.example.com/lib.js"
        );
    }

    #[test]
    fn test_apis_merged_across_sources() {
        let js1 = "getVariables(['a']);".to_string();
        let js2 = "getVariables(['b']);".to_string();
        let report = analyze_js(&[js1, js2]);
        let gv = report
            .detected_apis
            .iter()
            .find(|a| a.name == "getVariables")
            .unwrap();
        assert_eq!(
            gv.occurrences.len(),
            2,
            "Should merge occurrences from both files"
        );
        assert_eq!(gv.occurrences[0].file, "script_0");
        assert_eq!(gv.occurrences[1].file, "script_1");
    }

    #[test]
    fn test_strings_and_comments_skipped_in_syntax_check() {
        let js = r#"const s = "(unmatched"; // { unclosed comment
const arr = [1, 2, 3];"#
            .to_string();
        let report = analyze_js(&[js]);
        // The paren inside the string and the brace in comment should not cause errors
        // The square brackets in arr are balanced
        assert!(
            report.syntax_valid,
            "Should not flag delimiters inside strings/comments"
        );
    }

    #[test]
    fn test_template_literals_are_not_brace_checked() {
        let js = r#"
const html = `<button data-action="${action}">${label}</button>`;
const rows = items.map(item => `<div>${item.name}</div>`);
"#
        .to_string();
        let report = analyze_js(&[js]);
        assert!(
            report.syntax_valid,
            "Template literal markup should not confuse the heuristic scan"
        );
    }

    #[test]
    fn test_regex_literals_are_not_brace_checked() {
        let js = r#"
const tags = source.match(/<div[^>]*data-action=["']([^"']+)["'][^>]*>/g) || [];
const next = tags.filter(tag => /memory-(save|cancel|edit)/.test(tag));
"#
        .to_string();
        let report = analyze_js(&[js]);
        assert!(
            report.syntax_valid,
            "Regex literal character classes should not be scanned as JS delimiters"
        );
    }
}
