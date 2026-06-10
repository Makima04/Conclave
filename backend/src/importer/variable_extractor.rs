use crate::importer::types::*;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

// ── Compiled patterns ───────────────────────────────────────────────────

/// getVariables( — captures the full argument
static GET_VARS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"getVariables\s*\(([^)]+)\)").unwrap());

/// setVariables( — captures the full argument
static SET_VARS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"setVariables\s*\(([^)]+)\)").unwrap());

/// updateVariablesWith( — captures the full argument
static UPDATE_VARS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"updateVariablesWith\s*\(([^)]+)\)").unwrap());

/// String literal paths inside array or object keys: "some.path" or 'some.path'
static STRING_LITERAL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"["']([a-zA-Z_][\w./\[\]]*)["']"#).unwrap());

/// const/let/var stat_data = { ... }  or  Mvu.stat_data = { ... }
static MVU_INIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:const|let|var|Mvu\.)\s*stat_data\s*=\s*\{([^}]*)\}").unwrap());

/// const/let/var <name> = { ... } where name contains state/game/data/stats
static STATE_INIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:const|let|var)\s+(\w*(?:state|State|game|Game|data|Data|stats|Stats)\w*)\s*=\s*\{([^}]*)\}"#)
        .unwrap()
});

/// export const Schema = z.object({ ... }) / const Schema = z.object({ ... })
static MVU_SCHEMA_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)(?:export\s+)?const\s+Schema\s*=\s*z\.object\(\s*\{"#).unwrap()
});

/// Key-value pair inside an object literal: key: value
static OBJ_KV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?)|(true|false)|(null))"#)
        .unwrap()
});

/// Common state roots used by bundled ST/MVU HTML apps. These apps often keep
/// their own state object in minified code, so there may be no simple
/// getVariables(["path"]) call to extract.
static BUNDLED_STATE_ROOTS: &[(&str, VariableType, Option<serde_json::Value>)] = &[
    ("statusData", VariableType::Object, None),
    ("memoryDB", VariableType::Object, None),
    ("phoneMessages", VariableType::Object, None),
    ("playerProfile", VariableType::Object, None),
    ("runtimeFlags", VariableType::Object, None),
    ("summaryStore", VariableType::Object, None),
    ("musicPlayer", VariableType::Object, None),
    ("plotLibrary", VariableType::Object, None),
    ("characterCardLibrary", VariableType::Object, None),
    ("uiMessages", VariableType::Array, None),
    ("backgroundTasks", VariableType::Array, None),
    (
        "activeRunId",
        VariableType::String,
        Some(serde_json::Value::Null),
    ),
    (
        "activeSaveId",
        VariableType::String,
        Some(serde_json::Value::Null),
    ),
    ("activeTab", VariableType::String, None),
    (
        "phoneOpen",
        VariableType::Boolean,
        Some(serde_json::Value::Bool(false)),
    ),
    ("phoneRoute", VariableType::String, None),
    ("focusedMessageIndex", VariableType::Number, None),
    (
        "draft",
        VariableType::String,
        Some(serde_json::Value::String(String::new())),
    ),
    (
        "generating",
        VariableType::Boolean,
        Some(serde_json::Value::Bool(false)),
    ),
    ("currentGenerationId", VariableType::String, None),
    ("finalizedGenerationId", VariableType::String, None),
    (
        "notification",
        VariableType::Object,
        Some(serde_json::Value::Null),
    ),
];

// ── Public API ──────────────────────────────────────────────────────────

/// Extract variable declarations from JS analysis.
pub fn extract_variables(js: &[String], _analysis: &JsAnalysisReport) -> Vec<VariableDeclaration> {
    let mut vars = Vec::new();
    vars.extend(scan_variable_apis(js));
    vars.extend(scan_mvu_init(js));
    vars.extend(scan_state_init(js));
    vars.extend(scan_mvu_schema(js));
    vars.extend(scan_bundled_state_roots(js));
    let mut seen = HashSet::new();
    vars.retain(|var| seen.insert(var.path.clone()));
    vars
}

// ── Variable API scanning ───────────────────────────────────────────────

/// Scan for getVariables, setVariables, updateVariablesWith patterns.
/// Extract string literal arguments that look like variable paths.
fn scan_variable_apis(js_sources: &[String]) -> Vec<VariableDeclaration> {
    let mut vars = Vec::new();

    for (i, js) in js_sources.iter().enumerate() {
        let source = format!("script_{}", i);

        // getVariables(["path1", "path2"]) or getVariables({paths: [...]})
        for cap in GET_VARS_RE.captures_iter(js) {
            let arg = cap.get(1).unwrap().as_str();
            for path in extract_paths_from_arg(arg) {
                vars.push(VariableDeclaration {
                    path,
                    var_type: VariableType::String,
                    default_value: None,
                    label: None,
                    source: source.clone(),
                });
            }
        }

        // setVariables({path: value, ...})
        for cap in SET_VARS_RE.captures_iter(js) {
            let arg = cap.get(1).unwrap().as_str();
            vars.extend(extract_kv_declarations(arg, &source));
        }

        // updateVariablesWith({path: value, ...})
        for cap in UPDATE_VARS_RE.captures_iter(js) {
            let arg = cap.get(1).unwrap().as_str();
            vars.extend(extract_kv_declarations(arg, &source));
        }
    }

    vars
}

/// Extract string literal paths from an argument (array or object with paths).
fn extract_paths_from_arg(arg: &str) -> Vec<String> {
    STRING_LITERAL_RE
        .captures_iter(arg)
        .filter_map(|cap| {
            let val = cap.get(1)?.as_str();
            // Only keep things that look like variable paths (contain . or / or [])
            // or are simple identifiers
            if val.contains('.')
                || val.contains('/')
                || val.contains('[')
                || val.chars().all(|c| c.is_alphanumeric() || c == '_')
            {
                Some(val.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Extract key-value variable declarations from a setVariables / updateVariablesWith argument.
fn extract_kv_declarations(arg: &str, source: &str) -> Vec<VariableDeclaration> {
    OBJ_KV_RE
        .captures_iter(arg)
        .map(|cap| {
            let key = cap.get(1).unwrap().as_str().to_string();
            let (default_value, var_type) = if let Some(m) = cap.get(2) {
                (
                    Some(serde_json::Value::String(m.as_str().to_string())),
                    VariableType::String,
                )
            } else if let Some(m) = cap.get(3) {
                (
                    Some(serde_json::Value::String(m.as_str().to_string())),
                    VariableType::String,
                )
            } else if let Some(m) = cap.get(4) {
                let num = m.as_str().parse::<f64>().unwrap_or(0.0);
                (
                    Some(serde_json::Value::Number(
                        serde_json::Number::from_f64(num).unwrap_or(serde_json::Number::from(0)),
                    )),
                    VariableType::Number,
                )
            } else if let Some(m) = cap.get(5) {
                let b = m.as_str() == "true";
                (Some(serde_json::Value::Bool(b)), VariableType::Boolean)
            } else if cap.get(6).is_some() {
                (Some(serde_json::Value::Null), VariableType::String)
            } else {
                (None, VariableType::String)
            };

            VariableDeclaration {
                path: key,
                var_type,
                default_value,
                label: None,
                source: source.to_string(),
            }
        })
        .collect()
}

// ── Mvu / stat_data scanning ───────────────────────────────────────────

/// Scan for Mvu/stat_data initialization objects.
fn scan_mvu_init(js_sources: &[String]) -> Vec<VariableDeclaration> {
    let mut vars = Vec::new();

    for (i, js) in js_sources.iter().enumerate() {
        let source = format!("script_{}", i);

        for cap in MVU_INIT_RE.captures_iter(js) {
            let body = cap.get(1).unwrap().as_str();
            for kv in OBJ_KV_RE.captures_iter(body) {
                let key = kv.get(1).unwrap().as_str();
                let path = format!("stat_data.{}", key);
                let (default_value, var_type) = infer_value_from_kv_captures(&kv);
                vars.push(VariableDeclaration {
                    path,
                    var_type,
                    default_value,
                    label: None,
                    source: source.clone(),
                });
            }
        }
    }

    vars
}

// ── State object scanning ───────────────────────────────────────────────

/// Scan for explicit state initialization objects.
fn scan_state_init(js_sources: &[String]) -> Vec<VariableDeclaration> {
    let mut vars = Vec::new();

    for (i, js) in js_sources.iter().enumerate() {
        let source = format!("script_{}", i);

        for cap in STATE_INIT_RE.captures_iter(js) {
            let var_name = cap.get(1).unwrap().as_str();
            let body = cap.get(2).unwrap().as_str();

            for kv in OBJ_KV_RE.captures_iter(body) {
                let key = kv.get(1).unwrap().as_str();
                let path = format!("{}.{}", var_name, key);
                let (default_value, var_type) = infer_value_from_kv_captures(&kv);
                vars.push(VariableDeclaration {
                    path,
                    var_type,
                    default_value,
                    label: None,
                    source: source.clone(),
                });
            }
        }
    }

    vars
}

fn scan_mvu_schema(js_sources: &[String]) -> Vec<VariableDeclaration> {
    let mut vars = Vec::new();

    for (i, js) in js_sources.iter().enumerate() {
        if !MVU_SCHEMA_RE.is_match(js) || !js.contains("registerMvuSchema") {
            continue;
        }
        let source = format!("script_{}:mvu_schema", i);
        for field in extract_mvu_schema_fields(js) {
            vars.push(VariableDeclaration {
                path: format!("stat_data.{}", field.path),
                var_type: field.var_type,
                default_value: field.default_value,
                label: field.label,
                source: source.clone(),
            });
        }
    }

    vars
}

#[derive(Debug, Clone)]
struct MvuSchemaField {
    path: String,
    var_type: VariableType,
    default_value: Option<serde_json::Value>,
    label: Option<String>,
}

fn extract_mvu_schema_fields(js: &str) -> Vec<MvuSchemaField> {
    let Some(schema_start) = MVU_SCHEMA_RE.find(js).map(|m| m.end()) else {
        return vec![];
    };
    let body = extract_balanced_braces(js, schema_start - 1);
    let Some(schema_body) = body else {
        return vec![];
    };
    let mut fields = Vec::new();
    collect_schema_fields(&schema_body, None, &mut fields);
    fields
}

fn collect_schema_fields(
    schema_body: &str,
    prefix: Option<&str>,
    fields: &mut Vec<MvuSchemaField>,
) {
    let chars: Vec<char> = schema_body.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        skip_schema_separators(&chars, &mut i);
        if i >= chars.len() {
            break;
        }

        let Some(key) = parse_identifier_like(&chars, &mut i) else {
            i += 1;
            continue;
        };
        skip_ws(&chars, &mut i);
        if i >= chars.len() || chars[i] != ':' {
            continue;
        }
        i += 1;
        skip_ws(&chars, &mut i);

        let expression = slice_until_field_delimiter(&chars, i);
        if expression.trim().is_empty() {
            continue;
        }

        let path = match prefix {
            Some(parent) if !parent.is_empty() => format!("{}.{}", parent, key),
            _ => key.clone(),
        };

        fields.push(MvuSchemaField {
            path: path.clone(),
            var_type: infer_schema_var_type(&expression),
            default_value: infer_schema_default_value(&expression),
            label: infer_schema_label(&expression),
        });

        if let Some(child_body) = extract_schema_object_body(&expression) {
            collect_schema_fields(&child_body, Some(&path), fields);
        }

        i += expression.chars().count();
    }
}

fn extract_balanced_braces(source: &str, open_brace_index: usize) -> Option<String> {
    let bytes = source.as_bytes();
    if bytes.get(open_brace_index).copied()? != b'{' {
        return None;
    }
    let mut depth = 0usize;
    let mut in_string: Option<u8> = None;
    let mut escaped = false;
    for (offset, &byte) in bytes[open_brace_index..].iter().enumerate() {
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == quote {
                in_string = None;
            }
            continue;
        }
        match byte {
            b'\'' | b'"' => in_string = Some(byte),
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let start = open_brace_index + 1;
                    let end = open_brace_index + offset;
                    return source.get(start..end).map(|s| s.to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn skip_ws(chars: &[char], i: &mut usize) {
    while *i < chars.len() && chars[*i].is_whitespace() {
        *i += 1;
    }
}

fn skip_schema_separators(chars: &[char], i: &mut usize) {
    while *i < chars.len() {
        let ch = chars[*i];
        if ch.is_whitespace() || ch == ',' {
            *i += 1;
            continue;
        }
        break;
    }
}

fn parse_identifier_like(chars: &[char], i: &mut usize) -> Option<String> {
    if *i >= chars.len() {
        return None;
    }
    if chars[*i] == '\'' || chars[*i] == '"' {
        let quote = chars[*i];
        *i += 1;
        let start = *i;
        while *i < chars.len() && chars[*i] != quote {
            *i += 1;
        }
        let value: String = chars[start..(*i).min(chars.len())].iter().collect();
        if *i < chars.len() {
            *i += 1;
        }
        return if value.is_empty() { None } else { Some(value) };
    }
    let start = *i;
    while *i < chars.len() {
        let ch = chars[*i];
        if ch == ':' || ch.is_whitespace() {
            break;
        }
        if ch == '(' || ch == ')' || ch == '{' || ch == '}' || ch == ',' {
            break;
        }
        *i += 1;
    }
    if *i == start {
        return None;
    }
    Some(chars[start..*i].iter().collect::<String>().trim().to_string())
}

fn slice_until_field_delimiter(chars: &[char], start: usize) -> String {
    let mut i = start;
    let mut paren_depth = 0usize;
    let mut brace_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut in_string: Option<char> = None;
    let mut escaped = false;

    while i < chars.len() {
        let ch = chars[i];
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = None;
            }
            i += 1;
            continue;
        }
        match ch {
            '\'' | '"' => in_string = Some(ch),
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.saturating_sub(1),
            '{' => brace_depth += 1,
            '}' => {
                if paren_depth == 0 && brace_depth == 0 && bracket_depth == 0 {
                    break;
                }
                brace_depth = brace_depth.saturating_sub(1);
            }
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            ',' if paren_depth == 0 && brace_depth == 0 && bracket_depth == 0 => break,
            _ => {}
        }
        i += 1;
    }

    chars[start..i].iter().collect()
}

fn infer_schema_var_type(expression: &str) -> VariableType {
    let lower = expression.trim().to_ascii_lowercase();
    if lower.starts_with("z.object(") || lower.starts_with("z.record(") {
        VariableType::Object
    } else if lower.starts_with("z.array(") {
        VariableType::Array
    } else if lower.starts_with("z.coerce.number") || lower.starts_with("z.number") {
        VariableType::Number
    } else if lower.starts_with("z.boolean") || lower.starts_with("z.coerce.boolean") {
        VariableType::Boolean
    } else if lower.starts_with("z.string") || lower.starts_with("z.enum(") {
        VariableType::String
    } else if lower.contains("z.object") || lower.contains("z.record") {
        VariableType::Object
    } else if lower.contains("z.array") {
        VariableType::Array
    } else if lower.contains("z.number") {
        VariableType::Number
    } else if lower.contains("z.boolean") {
        VariableType::Boolean
    } else {
        VariableType::String
    }
}

fn extract_schema_object_body(expression: &str) -> Option<String> {
    let start = expression.find("z.object")?;
    let brace_index = expression[start..].find('{')? + start;
    extract_balanced_braces(expression, brace_index)
}

fn infer_schema_default_value(expression: &str) -> Option<serde_json::Value> {
    let value = find_top_level_method_argument(expression, "prefault")?;
    parse_js_like_default_value(&value)
}

fn infer_schema_label(expression: &str) -> Option<String> {
    let value = find_top_level_method_argument(expression, "describe")?;
    let trimmed = value.trim();
    if (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
    {
        Some(trimmed[1..trimmed.len().saturating_sub(1)].to_string())
    } else {
        None
    }
}

fn extract_call_argument(source: &str) -> Option<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut depth = 1usize;
    let mut i = 0usize;
    let mut in_string: Option<char> = None;
    let mut escaped = false;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = None;
            }
            i += 1;
            continue;
        }
        match ch {
            '\'' | '"' => in_string = Some(ch),
            '(' => depth += 1,
            ')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(chars[..i].iter().collect::<String>());
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn find_top_level_method_argument(expression: &str, method_name: &str) -> Option<String> {
    let chars: Vec<char> = expression.chars().collect();
    let target: Vec<char> = format!(".{}(", method_name).chars().collect();
    let mut paren_depth = 0usize;
    let mut brace_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut in_string: Option<char> = None;
    let mut escaped = false;
    let mut last_match: Option<usize> = None;
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = None;
            }
            i += 1;
            continue;
        }
        match ch {
            '\'' | '"' => {
                in_string = Some(ch);
                i += 1;
                continue;
            }
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.saturating_sub(1),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.saturating_sub(1),
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            _ => {}
        }

        if paren_depth == 0
            && brace_depth == 0
            && bracket_depth == 0
            && chars.get(i..i + target.len()) == Some(target.as_slice())
        {
            last_match = Some(i + target.len());
            i += target.len();
            continue;
        }

        i += 1;
    }

    let start = char_index_to_byte_offset(expression, last_match?)?;
    extract_call_argument(&expression[start..])
}

fn char_index_to_byte_offset(source: &str, char_index: usize) -> Option<usize> {
    if char_index == 0 {
        return Some(0);
    }
    source
        .char_indices()
        .nth(char_index)
        .map(|(offset, _)| offset)
        .or_else(|| {
            if source.chars().count() == char_index {
                Some(source.len())
            } else {
                None
            }
        })
}

fn parse_js_like_default_value(source: &str) -> Option<serde_json::Value> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "true" {
        return Some(serde_json::Value::Bool(true));
    }
    if trimmed == "false" {
        return Some(serde_json::Value::Bool(false));
    }
    if trimmed == "null" {
        return Some(serde_json::Value::Null);
    }
    if (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
    {
        return Some(serde_json::Value::String(
            trimmed[1..trimmed.len().saturating_sub(1)].to_string(),
        ));
    }
    if let Ok(num) = trimmed.parse::<f64>() {
        return serde_json::Number::from_f64(num).map(serde_json::Value::Number);
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let normalized = normalize_js_like_json(trimmed)?;
        return serde_json::from_str(&normalized).ok();
    }
    None
}

fn normalize_js_like_json(source: &str) -> Option<String> {
    let mut normalized = String::with_capacity(source.len() + 16);
    let chars: Vec<char> = source.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        match chars[i] {
            '\'' | '"' => {
                let quote = chars[i];
                i += 1;
                let mut content = String::new();
                let mut escaped = false;
                while i < chars.len() {
                    let ch = chars[i];
                    if escaped {
                        content.push(ch);
                        escaped = false;
                        i += 1;
                        continue;
                    }
                    if ch == '\\' {
                        escaped = true;
                        i += 1;
                        continue;
                    }
                    if ch == quote {
                        i += 1;
                        break;
                    }
                    content.push(ch);
                    i += 1;
                }
                normalized.push_str(&serde_json::to_string(&content).ok()?);
            }
            _ => {
                normalized.push(chars[i]);
                i += 1;
            }
        }
    }

    let bare_key_re =
        Regex::new(r#"([{\[,]\s*)([\p{L}_$][\p{L}\p{N}_$-]*)\s*:"#).ok()?;
    let trailing_comma_re = Regex::new(r#",\s*([}\]])"#).ok()?;
    let normalized = bare_key_re.replace_all(&normalized, r#"$1"$2":"#);
    let normalized = trailing_comma_re.replace_all(&normalized, "$1");
    Some(normalized.into_owned())
}

/// Detect state roots in minified card apps where the state lives in a bundled
/// object instead of obvious variable API calls.
fn scan_bundled_state_roots(js_sources: &[String]) -> Vec<VariableDeclaration> {
    let mut vars = Vec::new();

    for (i, js) in js_sources.iter().enumerate() {
        let source = format!("script_{}:bundled_state", i);
        for (path, var_type, default_value) in BUNDLED_STATE_ROOTS {
            if contains_state_root_reference(js, path) {
                vars.push(VariableDeclaration {
                    path: (*path).to_string(),
                    var_type: var_type.clone(),
                    default_value: default_value.clone(),
                    label: None,
                    source: source.clone(),
                });
            }
        }

        if contains_any(js, &["getMvuData", "replaceMvuData", "updateVariablesWith"])
            && contains_any(js, &["stat_data", "display_data"])
        {
            vars.push(VariableDeclaration {
                path: "stat_data".to_string(),
                var_type: VariableType::Object,
                default_value: None,
                label: None,
                source: source.clone(),
            });
        }
    }

    vars
}

fn contains_state_root_reference(js: &str, root: &str) -> bool {
    let escaped = regex::escape(root);
    let patterns = [
        format!(r"(?:^|[{{,])\s*{}\s*:", escaped),
        format!(r"\.\s*{}\s*=", escaped),
        format!(r"\.\s*{}\b", escaped),
    ];
    patterns.iter().any(|pattern| {
        Regex::new(pattern)
            .map(|re| re.is_match(js))
            .unwrap_or(false)
    })
}

/// Extract typed value and VariableType from OBJ_KV_RE captures.
fn infer_value_from_kv_captures(
    cap: &regex::Captures,
) -> (Option<serde_json::Value>, VariableType) {
    if let Some(m) = cap.get(2) {
        (
            Some(serde_json::Value::String(m.as_str().to_string())),
            VariableType::String,
        )
    } else if let Some(m) = cap.get(3) {
        (
            Some(serde_json::Value::String(m.as_str().to_string())),
            VariableType::String,
        )
    } else if let Some(m) = cap.get(4) {
        let num = m.as_str().parse::<f64>().unwrap_or(0.0);
        (
            Some(serde_json::Value::Number(
                serde_json::Number::from_f64(num).unwrap_or(serde_json::Number::from(0)),
            )),
            VariableType::Number,
        )
    } else if let Some(m) = cap.get(5) {
        let b = m.as_str() == "true";
        (Some(serde_json::Value::Bool(b)), VariableType::Boolean)
    } else if cap.get(6).is_some() {
        (Some(serde_json::Value::Null), VariableType::String)
    } else {
        (None, VariableType::String)
    }
}

fn infer_type(value: &serde_json::Value) -> VariableType {
    match value {
        serde_json::Value::String(_) => VariableType::String,
        serde_json::Value::Number(_) => VariableType::Number,
        serde_json::Value::Bool(_) => VariableType::Boolean,
        serde_json::Value::Array(_) => VariableType::Array,
        serde_json::Value::Object(_) => VariableType::Object,
        serde_json::Value::Null => VariableType::String,
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::importer::js_analyzer::analyze_js;

    #[test]
    fn test_extract_getvariables_paths() {
        let js = vec![r#"getVariables(["hp", "mp", "player.name"])"#.to_string()];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        let paths: Vec<&str> = vars.iter().map(|v| v.path.as_str()).collect();
        assert!(paths.contains(&"hp"));
        assert!(paths.contains(&"mp"));
        assert!(paths.contains(&"player.name"));
    }

    #[test]
    fn test_extract_setvariables_with_typed_defaults() {
        let js = vec![r#"setVariables({hp: 100, name: "hero", alive: true})"#.to_string()];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);

        let hp = vars.iter().find(|v| v.path == "hp").unwrap();
        assert!(matches!(hp.var_type, VariableType::Number));
        assert_eq!(hp.default_value, Some(serde_json::json!(100.0)));

        let name = vars.iter().find(|v| v.path == "name").unwrap();
        assert!(matches!(name.var_type, VariableType::String));
        assert_eq!(name.default_value, Some(serde_json::json!("hero")));

        let alive = vars.iter().find(|v| v.path == "alive").unwrap();
        assert!(matches!(alive.var_type, VariableType::Boolean));
        assert_eq!(alive.default_value, Some(serde_json::json!(true)));
    }

    #[test]
    fn test_extract_stat_data_init() {
        let js = vec!["const stat_data = {str: 10, dex: 12, cha: 8}".to_string()];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        let paths: Vec<&str> = vars.iter().map(|v| v.path.as_str()).collect();
        assert!(paths.contains(&"stat_data.str"));
        assert!(paths.contains(&"stat_data.dex"));
        assert!(paths.contains(&"stat_data.cha"));
    }

    #[test]
    fn test_extract_state_init() {
        let js = vec![r#"let gameState = {level: 1, score: 0}"#.to_string()];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        let paths: Vec<&str> = vars.iter().map(|v| v.path.as_str()).collect();
        assert!(paths.contains(&"gameState.level"));
        assert!(paths.contains(&"gameState.score"));
    }

    #[test]
    fn test_deduplicate_by_path() {
        // Same variable referenced in both getVariables and setVariables
        let js = vec![
            r#"getVariables(["hp"])"#.to_string(),
            r#"setVariables({hp: 100})"#.to_string(),
        ];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        let hp_count = vars.iter().filter(|v| v.path == "hp").count();
        assert_eq!(hp_count, 1, "Duplicate paths should be deduplicated");
    }

    #[test]
    fn test_infer_type_helper() {
        assert!(matches!(
            infer_type(&serde_json::json!("text")),
            VariableType::String
        ));
        assert!(matches!(
            infer_type(&serde_json::json!(42)),
            VariableType::Number
        ));
        assert!(matches!(
            infer_type(&serde_json::json!(true)),
            VariableType::Boolean
        ));
        assert!(matches!(
            infer_type(&serde_json::json!([1, 2])),
            VariableType::Array
        ));
        assert!(matches!(
            infer_type(&serde_json::json!({"a": 1}),),
            VariableType::Object
        ));
    }

    #[test]
    fn test_updatevariableswith_paths() {
        let js = vec![r#"updateVariablesWith({level: 5, title: "Knight"})"#.to_string()];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        assert_eq!(vars.len(), 2);
        let level = vars.iter().find(|v| v.path == "level").unwrap();
        assert!(matches!(level.var_type, VariableType::Number));
    }

    #[test]
    fn test_extract_mvu_schema_paths() {
        let js = vec![r#"
            const Schema = z.object({
              主角状态: z.object({
                修为: z.object({
                  当前状态描述: z.string().describe('面板文案').prefault('待推演'),
                  当前境界: z.string().prefault('待推演'),
                  进度百分比: z.coerce.number().prefault(0),
                }).prefault({}),
              }).prefault({}),
              世界系统: z.object({
                当前时间: z.string().describe('修真历年月日时辰').prefault('待推演'),
                今日运势: z.object({
                  宜: z.array(z.string()).prefault(['睡大觉', '打坐练功']),
                }).prefault({ 宜: ['睡大觉'] }),
              }).prefault({}),
            });
            registerMvuSchema(Schema);
        "#.to_string()];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        let paths: Vec<&str> = vars.iter().map(|v| v.path.as_str()).collect();
        assert!(paths.contains(&"stat_data.主角状态"));
        assert!(paths.contains(&"stat_data.主角状态.修为"));
        let realm = vars
            .iter()
            .find(|v| v.path == "stat_data.主角状态.修为.当前境界")
            .expect("realm path");
        assert!(matches!(realm.var_type, VariableType::String));
        assert_eq!(realm.default_value, Some(serde_json::json!("待推演")));
        let progress = vars
            .iter()
            .find(|v| v.path == "stat_data.主角状态.修为.进度百分比")
            .expect("progress path");
        assert!(matches!(progress.var_type, VariableType::Number));
        assert_eq!(progress.default_value, Some(serde_json::json!(0.0)));
        let time = vars
            .iter()
            .find(|v| v.path == "stat_data.世界系统.当前时间")
            .expect("time path");
        assert!(matches!(time.var_type, VariableType::String));
        assert_eq!(time.default_value, Some(serde_json::json!("待推演")));
        assert_eq!(time.label.as_deref(), Some("修真历年月日时辰"));
        let desc = vars
            .iter()
            .find(|v| v.path == "stat_data.主角状态.修为.当前状态描述")
            .expect("status description path");
        assert_eq!(desc.label.as_deref(), Some("面板文案"));
        let fortune = vars
            .iter()
            .find(|v| v.path == "stat_data.世界系统.今日运势")
            .expect("fortune object path");
        assert!(matches!(fortune.var_type, VariableType::Object));
        assert_eq!(fortune.default_value, Some(serde_json::json!({ "宜": ["睡大觉"] })));
        let fortune_good = vars
            .iter()
            .find(|v| v.path == "stat_data.世界系统.今日运势.宜")
            .expect("fortune leaf path");
        assert!(matches!(fortune_good.var_type, VariableType::Array));
        assert_eq!(
            fortune_good.default_value,
            Some(serde_json::json!(["睡大觉", "打坐练功"]))
        );
    }

    #[test]
    fn test_extract_bundled_runtime_state_roots() {
        let js = vec![
            r#"
            const mp=wi(pc());
            function wi(e){return{activeRunId:null,statusData:bn(cn),phoneMessages:di(),playerProfile:{name:''},runtimeFlags:{},memoryDB:sa(''),uiMessages:[ci()]}}
            function save(){mp.statusData=bn(cn);mp.phoneMessages.draft='';}
            "#
            .to_string(),
        ];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        let paths: Vec<&str> = vars.iter().map(|v| v.path.as_str()).collect();
        assert!(paths.contains(&"statusData"));
        assert!(paths.contains(&"phoneMessages"));
        assert!(paths.contains(&"playerProfile"));
        assert!(paths.contains(&"runtimeFlags"));
        assert!(paths.contains(&"memoryDB"));
        assert!(paths.contains(&"uiMessages"));
        assert!(paths.contains(&"activeRunId"));
    }

    #[test]
    fn test_real_bundled_card_state_roots_when_available() {
        let Ok(html) = std::fs::read_to_string("/tmp/card_628e2cee_replaceString.html") else {
            return;
        };
        let Some(start) = html.find("<script") else {
            return;
        };
        let Some(open_end) = html[start..].find('>').map(|offset| start + offset + 1) else {
            return;
        };
        let Some(close) = html[open_end..]
            .find("</script>")
            .map(|offset| open_end + offset)
        else {
            return;
        };
        let js = vec![html[open_end..close].to_string()];
        let report = analyze_js(&js);
        let vars = extract_variables(&js, &report);
        let paths: Vec<&str> = vars.iter().map(|v| v.path.as_str()).collect();
        assert!(
            paths.contains(&"statusData"),
            "real bundled card should expose statusData root; got {:?}",
            paths
        );
        assert!(paths.contains(&"memoryDB"));
        assert!(paths.contains(&"phoneMessages"));
        assert!(paths.contains(&"stat_data"));
    }
}
