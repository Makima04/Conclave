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
    ("activeRunId", VariableType::String, Some(serde_json::Value::Null)),
    ("activeSaveId", VariableType::String, Some(serde_json::Value::Null)),
    ("activeTab", VariableType::String, None),
    ("phoneOpen", VariableType::Boolean, Some(serde_json::Value::Bool(false))),
    ("phoneRoute", VariableType::String, None),
    ("focusedMessageIndex", VariableType::Number, None),
    ("draft", VariableType::String, Some(serde_json::Value::String(String::new()))),
    ("generating", VariableType::Boolean, Some(serde_json::Value::Bool(false))),
    ("currentGenerationId", VariableType::String, None),
    ("finalizedGenerationId", VariableType::String, None),
    ("notification", VariableType::Object, Some(serde_json::Value::Null)),
];

// ── Public API ──────────────────────────────────────────────────────────

/// Extract variable declarations from JS analysis.
pub fn extract_variables(js: &[String], _analysis: &JsAnalysisReport) -> Vec<VariableDeclaration> {
    let mut vars = Vec::new();
    vars.extend(scan_variable_apis(js));
    vars.extend(scan_mvu_init(js));
    vars.extend(scan_state_init(js));
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
        let Some(close) = html[open_end..].find("</script>").map(|offset| open_end + offset)
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
