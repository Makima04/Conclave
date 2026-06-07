use crate::importer::types::*;
use crate::importer::*;

/// Run the full import pipeline on raw file bytes.
/// Returns (package_draft, import_report, original_card).
pub async fn run_import(
    bytes: Vec<u8>,
    filename: &str,
) -> Result<(ConclaveCardPackage, ImportReport, ExternalCard), ImportError> {
    let mut stages = Vec::new();
    let mut diagnostics = Vec::new();
    let mut rule_traces: Vec<RuleTrace> = Vec::new();

    // Stage 1: Parse source
    let card = parse_source(&bytes, filename)?;
    stages.push(report::make_stage(
        "metadata",
        "Metadata Extract",
        StageStatus::Success,
        None,
    ));

    // Stage 2: Execute regex_scripts
    let regex_scripts = extract_regex_scripts(&card);
    let regex_result = if !regex_scripts.is_empty() {
        regex_executor::execute_regex_scripts(
            &regex_scripts,
            &card.first_mes,
            &RegexOptions {
                user_name: "User".to_string(),
                char_name: card.name.clone(),
            },
            false,
            true,
        )
    } else {
        RegexExecutionResult {
            matched: false,
            output: card.first_mes.clone(),
            scripts_used: vec![],
            diagnostics: vec![],
        }
    };

    let content = if regex_result.matched {
        &regex_result.output
    } else {
        &card.first_mes
    };

    // Collect regex diagnostics and rule traces
    for diag in &regex_result.diagnostics {
        diagnostics.push(report::make_diagnostic(
            "regex",
            diag.level.clone(),
            "regex_diagnostic",
            &diag.message,
            None,
            None,
            None,
        ));
    }

    // Add rule traces for each regex script
    for (i, script_name) in regex_result.scripts_used.iter().enumerate() {
        rule_traces.push(RuleTrace {
            rule_id: format!("regex_{}", i),
            stage: "regex".to_string(),
            status: RuleStatus::Matched,
            confidence: 1.0,
            input_ref: Some(script_name.clone()),
            output_ref: None,
            diagnostics: vec![],
        });
    }
    if !regex_scripts.is_empty() && !regex_result.matched {
        diagnostics.push(report::make_diagnostic(
            "regex",
            DiagnosticLevel::Warn,
            "regex_no_match",
            "No regex scripts matched the card opening content",
            None,
            Some("The imported card UI cannot be normalized from its ST regex replacement and will fall back to raw preview unless another UI source is detected"),
            Some("Check the regex findRegex, placement, and markdownOnly/promptOnly flags against the card first_mes"),
        ));
        rule_traces.push(RuleTrace {
            rule_id: "regex_no_match".to_string(),
            stage: "regex".to_string(),
            status: RuleStatus::Failed,
            confidence: 0.0,
            input_ref: None,
            output_ref: None,
            diagnostics: vec!["No regex scripts matched the content".to_string()],
        });
    }

    stages.push(report::make_stage(
        "regex",
        "ST Regex",
        if regex_result.matched {
            StageStatus::Success
        } else {
            StageStatus::Warning
        },
        if !regex_result.matched {
            Some("No regex scripts matched".to_string())
        } else {
            None
        },
    ));

    // Stage 3: Split HTML
    let should_split_html = looks_like_html_candidate(content);
    let html_split = if should_split_html {
        html_splitter::split_html_app(content)
    } else {
        empty_html_split(content)
    };
    stages.push(report::make_stage(
        "html_split",
        "HTML Split",
        if !should_split_html {
            StageStatus::Skipped
        } else if html_split.is_full_document {
            StageStatus::Success
        } else {
            StageStatus::Warning
        },
        if should_split_html {
            None
        } else {
            Some("No HTML app candidate was produced by ST regex or source content".to_string())
        },
    ));

    // Stage 4: Scan resources
    let resources = if should_split_html {
        resource_scanner::scan_resources(&html_split.html, &html_split.css, &html_split.js)
    } else {
        ResourceManifest { resources: vec![] }
    };

    if !resources.resources.is_empty() {
        diagnostics.push(report::make_diagnostic(
            "asset_rewrite",
            DiagnosticLevel::Info,
            "remote_asset_detected",
            &format!("{} resources detected", resources.resources.len()),
            None,
            None,
            None,
        ));
    }
    stages.push(report::make_stage(
        "asset_rewrite",
        "Asset Rewrite",
        if !should_split_html {
            StageStatus::Skipped
        } else if resources.resources.is_empty() {
            StageStatus::Success
        } else {
            StageStatus::Warning
        },
        if should_split_html {
            None
        } else {
            Some("Skipped because no HTML content was available".to_string())
        },
    ));

    // Stage 5: JS analysis
    let has_js = !html_split.js.is_empty();
    let js_analysis = if has_js {
        js_analyzer::analyze_js(&html_split.js)
    } else {
        JsAnalysisReport {
            syntax_valid: true,
            syntax_errors: vec![],
            detected_apis: vec![],
            dynamic_imports: vec![],
        }
    };

    for api in &js_analysis.detected_apis {
        diagnostics.push(report::make_diagnostic(
            "api_scan",
            match api.classification {
                ApiClassification::Dangerous => DiagnosticLevel::Warn,
                ApiClassification::Unsupported => DiagnosticLevel::Warn,
                _ => DiagnosticLevel::Info,
            },
            "unsupported_api",
            &format!("API detected: {} ({:?})", api.name, api.classification),
            api.occurrences.first().map(|o| DiagnosticSource {
                kind: "js".to_string(),
                script_name: Some(o.file.clone()),
                field: None,
                offset: Some(o.offset),
                selector: None,
                excerpt: Some(o.excerpt.clone()),
            }),
            None,
            None,
        ));
    }

    for err in &js_analysis.syntax_errors {
        diagnostics.push(report::make_diagnostic(
            "js_parse",
            DiagnosticLevel::Warn,
            "js_parse_failed",
            &err.message,
            Some(DiagnosticSource {
                kind: "js".to_string(),
                script_name: None,
                field: None,
                offset: Some(err.offset),
                selector: None,
                excerpt: Some(err.excerpt.clone()),
            }),
            Some("Heuristic JS syntax scan found a possible issue; runtime sandbox will report real execution errors"),
            Some("Review the source card JS if the rendered card fails at runtime"),
        ));
    }

    stages.push(report::make_stage(
        "js_parse",
        "JS Parse",
        if !has_js {
            StageStatus::Skipped
        } else if js_analysis.syntax_valid {
            StageStatus::Success
        } else {
            StageStatus::Warning
        },
        if has_js {
            None
        } else {
            Some("Skipped because no inline JavaScript was extracted".to_string())
        },
    ));

    // Stage 6: Extract actions
    let actions = if should_split_html {
        action_extractor::extract_actions(&html_split.html, &html_split.js, &js_analysis)
    } else {
        vec![]
    };
    for action in &actions {
        rule_traces.push(RuleTrace {
            rule_id: format!("action_{}", action.id),
            stage: "action_extract".to_string(),
            status: RuleStatus::Matched,
            confidence: 0.9,
            input_ref: Some(
                serde_json::to_value(&action.source)
                    .unwrap_or_default()
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
            ),
            output_ref: Some(action.label.clone()),
            diagnostics: vec![],
        });
    }
    stages.push(report::make_stage(
        "action_extract",
        "Action Extract",
        if !should_split_html {
            StageStatus::Skipped
        } else if actions.is_empty() {
            StageStatus::Warning
        } else {
            StageStatus::Success
        },
        if should_split_html {
            None
        } else {
            Some("Skipped because no HTML content was available".to_string())
        },
    ));

    // Stage 7: Extract variables
    let variables = if has_js {
        variable_extractor::extract_variables(&html_split.js, &js_analysis)
    } else {
        vec![]
    };
    for var in &variables {
        rule_traces.push(RuleTrace {
            rule_id: format!("var_{}", var.path),
            stage: "variable_extract".to_string(),
            status: RuleStatus::Matched,
            confidence: 0.85,
            input_ref: Some(var.source.clone()),
            output_ref: Some(var.path.clone()),
            diagnostics: vec![],
        });
    }
    stages.push(report::make_stage(
        "variable_extract",
        "Variable Extract",
        if !has_js {
            StageStatus::Skipped
        } else if variables.is_empty() {
            StageStatus::Warning
        } else {
            StageStatus::Success
        },
        if has_js {
            None
        } else {
            Some("Skipped because no inline JavaScript was extracted".to_string())
        },
    ));

    // Stage 8: Build compatibility report
    let compatibility = build_compatibility(
        &js_analysis,
        &resources,
        !regex_scripts.is_empty(),
        regex_result.matched,
        &html_split,
    );

    if !html_split.is_full_document && !regex_result.matched {
        diagnostics.push(report::make_diagnostic(
            "package_build",
            DiagnosticLevel::Warn,
            "raw_preview_fallback",
            "Package UI fell back to raw preview because no executable HTML app was extracted",
            None,
            Some("The card can be saved, but the platform cannot run its original UI from the normalized package"),
            Some("Use LLM assist or add/import a normalization rule that converts this card into platform schema or html_app"),
        ));
    }

    // Stage 9: Build package
    let package = package_builder::build_package(
        &card,
        &regex_result,
        &html_split,
        &resources,
        &actions,
        &variables,
        &compatibility,
    );
    stages.push(report::make_stage(
        "package_build",
        "Package Build",
        StageStatus::Success,
        None,
    ));

    // Generate final report
    let import_report = report::build_report(
        &card.source_format.to_string(),
        &card.source_hash,
        stages,
        rule_traces,
        diagnostics,
    );

    Ok((package, import_report, card))
}

/// Parse raw bytes into an ExternalCard, auto-detecting format from filename or magic bytes.
fn parse_source(bytes: &[u8], filename: &str) -> Result<ExternalCard, ImportError> {
    let lower = filename.to_lowercase();
    if lower.ends_with(".png") {
        return png_parser::parse_png(bytes);
    }
    if lower.ends_with(".json") {
        return json_parser::parse_json_card(bytes);
    }

    // Try PNG first (check 8-byte signature), then JSON
    if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        png_parser::parse_png(bytes)
    } else {
        json_parser::parse_json_card(bytes)
    }
}

fn looks_like_html_candidate(content: &str) -> bool {
    let lower = content.to_lowercase();
    lower.contains("<!doctype")
        || lower.contains("<html")
        || lower.contains("<head")
        || lower.contains("<body")
        || lower.contains("<script")
        || lower.contains("<style")
        || lower.contains("<div")
}

fn empty_html_split(content: &str) -> HtmlAppSplit {
    HtmlAppSplit {
        html: content.to_string(),
        css: vec![],
        js: vec![],
        script_types: vec![],
        entry_node: None,
        is_full_document: false,
    }
}

/// Extract regex_scripts from card.extensions (SillyTavern camelCase format).
fn extract_regex_scripts(card: &ExternalCard) -> Vec<RegexScript> {
    let Some(scripts_val) = card.extensions.get("regex_scripts") else {
        return vec![];
    };
    let Some(arr) = scripts_val.as_array() else {
        return vec![];
    };

    arr.iter()
        .filter_map(|s| {
            Some(RegexScript {
                script_name: s.get("scriptName")?.as_str()?.to_string(),
                find_regex: s.get("findRegex")?.as_str()?.to_string(),
                replace_string: s.get("replaceString")?.as_str()?.to_string(),
                disabled: s.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false),
                prompt_only: s
                    .get("promptOnly")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                markdown_only: s
                    .get("markdownOnly")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                min_depth: s.get("minDepth").and_then(|v| v.as_i64()).map(|v| v as i32),
                max_depth: s.get("maxDepth").and_then(|v| v.as_i64()).map(|v| v as i32),
            })
        })
        .collect()
}

/// Build a CompatibilityReport from JS analysis and resource scan results.
fn build_compatibility(
    js_analysis: &JsAnalysisReport,
    resources: &ResourceManifest,
    has_regex_scripts: bool,
    regex_matched: bool,
    html_split: &HtmlAppSplit,
) -> CompatibilityReport {
    let required: Vec<String> = js_analysis
        .detected_apis
        .iter()
        .filter(|a| {
            matches!(
                a.classification,
                ApiClassification::PlatformNative | ApiClassification::BrowserShim
            )
        })
        .map(|a| a.name.clone())
        .collect();

    let unsupported: Vec<String> = js_analysis
        .detected_apis
        .iter()
        .filter(|a| matches!(a.classification, ApiClassification::Unsupported))
        .map(|a| a.name.clone())
        .collect();

    let mut warnings = Vec::new();
    if !js_analysis.dynamic_imports.is_empty() {
        warnings.push(format!(
            "{} dynamic import(s) detected",
            js_analysis.dynamic_imports.len()
        ));
    }
    if !resources.resources.is_empty() {
        warnings.push(format!(
            "{} remote resource(s) detected",
            resources.resources.len()
        ));
    }
    if has_regex_scripts && !regex_matched {
        warnings
            .push("regex_no_match: ST regex scripts did not match the opening content".to_string());
    }
    if !html_split.is_full_document {
        warnings.push("raw_preview_fallback: no full HTML app was extracted".to_string());
    }

    CompatibilityReport {
        required_apis: required,
        unsupported_apis: unsupported,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_card_with_regex(find_regex: &str, replace_string: &str, first_mes: &str) -> Vec<u8> {
        serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "Import Test Card",
                "first_mes": first_mes,
                "extensions": {
                    "regex_scripts": [
                        {
                            "scriptName": "replace opening",
                            "findRegex": find_regex,
                            "replaceString": replace_string,
                            "disabled": false,
                            "promptOnly": false,
                            "markdownOnly": true
                        }
                    ]
                }
            }
        })
        .to_string()
        .into_bytes()
    }

    #[tokio::test]
    async fn imports_markdown_only_st_regex_as_html_app() {
        let html = r#"```html
<!doctype html>
<html>
<head><style>body { color: red; }</style></head>
<body>
<div id="app"></div>
<script type="module">localStorage.setItem('k', `${1}`);</script>
</body>
</html>
```"#;
        let bytes = json_card_with_regex(r"\[开局\]", html, "[开局]");

        let (package, report, _card) = run_import(bytes, "card.json").await.unwrap();

        assert_eq!(package.ui.ui_type, UiType::HtmlApp);
        assert!(
            package
                .ui
                .html
                .as_deref()
                .unwrap_or_default()
                .contains("id=\"app\"")
        );
        assert_eq!(package.ui.js.len(), 1);
        assert!(
            package.ui.js[0].contains("`${1}`"),
            "replacement text should preserve JS template dollars"
        );
        assert!(
            report
                .rule_traces
                .iter()
                .any(|trace| { trace.stage == "regex" && trace.status == RuleStatus::Matched })
        );
        assert!(
            !report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "regex_no_match")
        );
    }

    #[tokio::test]
    async fn reports_regex_miss_and_raw_preview_fallback() {
        let html = r#"```html
<!doctype html><html><body><div id="app"></div></body></html>
```"#;
        let bytes = json_card_with_regex("NEVER_MATCHES", html, "[开局]");

        let (package, report, _card) = run_import(bytes, "card.json").await.unwrap();

        assert_eq!(package.ui.ui_type, UiType::RawPreview);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "regex_no_match")
        );
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "raw_preview_fallback")
        );
        assert!(
            package
                .compatibility
                .warnings
                .iter()
                .any(|warning| warning.contains("regex_no_match"))
        );
        assert!(
            package
                .compatibility
                .warnings
                .iter()
                .any(|warning| warning.contains("raw_preview_fallback"))
        );
        assert!(
            report
                .stages
                .iter()
                .any(|stage| { stage.id == "js_parse" && stage.status == StageStatus::Skipped })
        );
    }
}
