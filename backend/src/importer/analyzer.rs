//! Card analysis pass — decoupled from import.
//!
//! `run_analysis` takes an `ExternalCard` (already parsed by the importer) and
//! produces all analysis outputs: regex execution, HTML split, JS analysis,
//! variable/action extraction, state schema/adapter, and diagnostics.
//!
//! This module does NOT parse InitVar — that is deferred to runtime
//! (`state_initializer`). It also does NOT touch raw card data preservation;
//! that is the importer's job (`RawCardSource`).

use crate::importer::types::*;
use crate::importer::*;

/// Run the full analysis pipeline on an already-parsed `ExternalCard`.
///
/// Returns an `AnalysisResult` containing all analysis outputs, stages,
/// diagnostics, and rule traces. The caller (orchestrator) combines this with
/// `RawCardSource` and feeds both into `package_builder`.
pub fn run_analysis(card: &ExternalCard) -> AnalysisResult {
    let mut stages = Vec::new();
    let mut diagnostics = Vec::new();
    let mut rule_traces: Vec<RuleTrace> = Vec::new();

    // ── Stage 1: Regex execution ──
    let regex_scripts = extract_regex_scripts(card);
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

    // ── Stage 2: HTML split ──
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

    // ── Stage 3: Resource scan ──
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

    // ── Stage 4: JS analysis ──
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
        let (code, impact, suggestion) = match api.classification {
            ApiClassification::PlatformNative => (
                "platform_api_detected",
                Some(
                    "This API is part of the platform bridge surface and should resolve through the unified runtime model.",
                ),
                Some(
                    "Prefer keeping this call on the main runtime path; no legacy ST side channel is needed.",
                ),
            ),
            ApiClassification::BrowserShim => (
                "browser_shim_api_detected",
                Some(
                    "This API depends on the sandbox/browser shim layer rather than the canonical card state bridge.",
                ),
                Some(
                    "Verify the card still behaves correctly inside the sandbox if it relies on client-side persistence.",
                ),
            ),
            ApiClassification::Unsupported => (
                "unsupported_api",
                Some(
                    "This API is not guaranteed to preserve SillyTavern semantics in the platform runtime.",
                ),
                Some("Replace it with a bridged platform API or keep it in raw preview only."),
            ),
            ApiClassification::Dangerous => (
                "dangerous_api_detected",
                Some(
                    "This API can mutate DOM or execute code in ways that make sandbox behavior and layout harder to stabilize.",
                ),
                Some(
                    "Review and normalize this code before trusting runtime behavior or auto-sizing.",
                ),
            ),
        };
        diagnostics.push(report::make_diagnostic(
            "api_scan",
            match api.classification {
                ApiClassification::Dangerous => DiagnosticLevel::Warn,
                ApiClassification::Unsupported => DiagnosticLevel::Warn,
                _ => DiagnosticLevel::Info,
            },
            code,
            &format!("API detected: {} ({:?})", api.name, api.classification),
            api.occurrences.first().map(|o| DiagnosticSource {
                kind: "js".to_string(),
                script_name: Some(o.file.clone()),
                field: None,
                offset: Some(o.offset),
                selector: None,
                excerpt: Some(o.excerpt.clone()),
            }),
            impact,
            suggestion,
        ));
    }
    if js_analysis
        .detected_apis
        .iter()
        .any(|api| api.name == "generateRaw")
    {
        diagnostics.push(report::make_diagnostic(
            "api_scan",
            DiagnosticLevel::Info,
            "secondary_generation_bridge_detected",
            "generateRaw was detected. It is bridged through the platform quiet-generation RPC instead of a direct SillyTavern side channel.",
            None,
            Some("Card-side summaries or analysis can request a background generation, but user-facing input should still use Generate()/submitText so it stays synchronized with the main chat pipeline."),
            Some("Keep generateRaw for background analysis only; map visible send buttons to Generate()/submitText or data-xrp-submit-chat."),
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
                script_name: Some(err.file.clone()),
                field: None,
                offset: Some(err.offset),
                selector: None,
                excerpt: Some(err.excerpt.clone()),
            }),
            Some("The extracted script fragment is structurally invalid, so variable/action inference may already be incomplete before runtime."),
            Some("Compare this script fragment with the original ST card source. If ST can run it but this fragment is broken, the HTML/JS split pipeline likely damaged the script."),
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

    // ── Stage 5: Action extraction ──
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

    // ── Stage 6: Variable extraction (JS only — no InitVar) ──
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
        if variables.is_empty() {
            StageStatus::Warning
        } else {
            StageStatus::Success
        },
        if variables.is_empty() {
            Some("No card state variables were detected from JS".to_string())
        } else {
            None
        },
    ));

    let extraction_layers = build_extraction_layers(
        card,
        &regex_scripts,
        &variables,
        &actions,
        &html_split,
        &resources,
    );

    // ── Stage 7: State schema + adapter ──
    let (state_schema, state_adapter) = state_adapter::build_state_conversion(card, &variables);
    for field in &state_schema.fields {
        rule_traces.push(RuleTrace {
            rule_id: format!("state_field_{}", field.path),
            stage: "state_adapter".to_string(),
            status: if field.canonical_path.is_some() {
                RuleStatus::Matched
            } else {
                RuleStatus::Skipped
            },
            confidence: field.confidence,
            input_ref: Some(field.path.clone()),
            output_ref: field.canonical_path.clone(),
            diagnostics: if field.canonical_path.is_none() {
                vec!["Card-private state field requires adapter review".to_string()]
            } else {
                vec![]
            },
        });
    }
    stages.push(report::make_stage(
        "state_adapter",
        "State Adapter Build",
        if state_schema.fields.is_empty() {
            StageStatus::Warning
        } else {
            StageStatus::Success
        },
        if state_schema.fields.is_empty() {
            Some("No card state fields were detected".to_string())
        } else if state_adapter.write_rules.is_empty() {
            Some("Card-private runtime fields were detected; no platform Agent write mappings were generated".to_string())
        } else {
            None
        },
    ));

    let card_private_fields = state_schema
        .fields
        .iter()
        .filter(|field| field.canonical_path.is_none())
        .map(|field| field.path.as_str())
        .collect::<Vec<_>>();
    if !card_private_fields.is_empty() {
        let preview = card_private_fields
            .iter()
            .take(12)
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        let overflow = card_private_fields.len().saturating_sub(12);
        let message = if overflow > 0 {
            format!(
                "{} card-private runtime fields detected: {} ... (+{} more)",
                card_private_fields.len(),
                preview,
                overflow
            )
        } else {
            format!(
                "{} card-private runtime fields detected: {}",
                card_private_fields.len(),
                preview
            )
        };
        diagnostics.push(report::make_diagnostic(
            "state_adapter",
            DiagnosticLevel::Info,
            "card_private_state_detected",
            &message,
            None,
            Some("These fields are preserved as card runtime state/projection fields, but platform Agents will not write them automatically."),
            Some("Add explicit adapter mappings only for fields that should be updated by the platform State Agent."),
        ));
    }

    // ── Stage 8: Compatibility report ──
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

    AnalysisResult {
        regex_result,
        html_split,
        resources,
        js_analysis,
        actions,
        variables,
        state_schema,
        state_adapter,
        extraction_layers,
        compatibility,
        stages,
        diagnostics,
        rule_traces,
    }
}

// ─── Helpers ───

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

fn empty_html_split(_content: &str) -> HtmlAppSplit {
    HtmlAppSplit {
        html: String::new(),
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
        api_mappings: build_api_mappings(js_analysis),
    }
}

fn build_api_mappings(js_analysis: &JsAnalysisReport) -> Vec<ApiCompatibilityMapping> {
    let mut mappings = Vec::new();

    for api in &js_analysis.detected_apis {
        let mapping = match api.name.as_str() {
            "Generate" | "generate" | "submitText" => Some(ApiCompatibilityMapping {
                api: api.name.clone(),
                status: "bridged".to_string(),
                replacement: "submitText -> main chat pipeline".to_string(),
                notes: "User-facing card input is routed through the same sendMessageStream flow as the platform input panel.".to_string(),
            }),
            "generateRaw" => Some(ApiCompatibilityMapping {
                api: api.name.clone(),
                status: "partial".to_string(),
                replacement: "quietGenerate host RPC".to_string(),
                notes: "Background card-side generation is routed through the platform quiet-generation endpoint. User-facing sends should still use Generate()/submitText.".to_string(),
            }),
            "getVariables" | "getAllVariables" => Some(ApiCompatibilityMapping {
                api: api.name.clone(),
                status: "bridged".to_string(),
                replacement: "platform runtime variables".to_string(),
                notes: "Reads from the current platform/card runtime variable projection.".to_string(),
            }),
            "setVariables" | "updateVariablesWith" | "replaceMvuData" => {
                Some(ApiCompatibilityMapping {
                    api: api.name.clone(),
                    status: "bridged".to_string(),
                    replacement: "platform state bridge".to_string(),
                    notes: "Writes are forwarded to the sandbox action bridge and reconciled with platform state rules.".to_string(),
                })
            }
            "setChatMessage" | "setChatMessages" => Some(ApiCompatibilityMapping {
                api: api.name.clone(),
                status: "bridged".to_string(),
                replacement: "message/opening bridge".to_string(),
                notes: "Message edits are routed through sandbox actions instead of directly mutating platform storage.".to_string(),
            }),
            "eventOn" | "eventOnce" | "eventRemoveListener" => Some(ApiCompatibilityMapping {
                api: api.name.clone(),
                status: "partial".to_string(),
                replacement: "runtime event shim".to_string(),
                notes: "Common runtime events are shimmed; unsupported event names may no-op.".to_string(),
            }),
            _ if matches!(api.classification, ApiClassification::BrowserShim) => {
                Some(ApiCompatibilityMapping {
                    api: api.name.clone(),
                    status: "shimmed".to_string(),
                    replacement: "browser storage shim".to_string(),
                    notes: "Provided inside the sandboxed card runtime.".to_string(),
                })
            }
            _ => None,
        };

        if let Some(mapping) = mapping {
            if !mappings
                .iter()
                .any(|existing: &ApiCompatibilityMapping| existing.api == mapping.api)
            {
                mappings.push(mapping);
            }
        }
    }

    mappings
}

fn build_extraction_layers(
    card: &ExternalCard,
    regex_scripts: &[RegexScript],
    variables: &[VariableDeclaration],
    actions: &[ActionDeclaration],
    html_split: &HtmlAppSplit,
    resources: &ResourceManifest,
) -> ExtractionLayers {
    let mut state_signals = variables
        .iter()
        .map(|var| ExtractedSignal {
            id: format!("state:{}", var.path),
            kind: if var.path.starts_with("stat_data.") || var.path == "stat_data" {
                ExtractedSignalKind::StateSchemaPath
            } else {
                ExtractedSignalKind::VariablePath
            },
            path: Some(var.path.clone()),
            label: var.label.clone(),
            source: var.source.clone(),
            confidence: 0.8,
            excerpt: None,
            details: Some(serde_json::json!({
                "type": var.var_type,
                "default_value": var.default_value,
                "declared_label": var.label,
                "path_depth": var.path.split('.').count(),
                "root": var.path.split('.').next().unwrap_or(""),
                "is_schema_root": !var.path.contains('.'),
                "source_kind": if var.source.contains("mvu_schema") {
                    "mvu_schema"
                } else if var.source.contains("bundled_state") {
                    "bundled_state"
                } else {
                    "runtime_api"
                },
            })),
        })
        .collect::<Vec<_>>();

    let mut action_signals = actions
        .iter()
        .map(|action| ExtractedSignal {
            id: format!("action:{}", action.id),
            kind: ExtractedSignalKind::ActionHint,
            path: action.selector.clone(),
            label: Some(action.label.clone()),
            source: serde_json::to_string(&action.source)
                .unwrap_or_else(|_| "unknown".to_string()),
            confidence: 0.9,
            excerpt: None,
            details: Some(serde_json::json!({
                "kind": action.kind,
                "selector": action.selector,
            })),
        })
        .collect::<Vec<_>>();

    let mut ui_signals = Vec::new();
    if !html_split.html.trim().is_empty() {
        ui_signals.push(ExtractedSignal {
            id: "ui:html".to_string(),
            kind: ExtractedSignalKind::UiDependency,
            path: None,
            label: Some("html".to_string()),
            source: "html_split".to_string(),
            confidence: 1.0,
            excerpt: Some(html_split.html.chars().take(240).collect()),
            details: Some(serde_json::json!({
                "is_full_document": html_split.is_full_document,
                "css_count": html_split.css.len(),
                "js_count": html_split.js.len(),
                "entry_node": html_split.entry_node,
                "script_types": html_split.script_types,
            })),
        });
    }

    for (index, script) in regex_scripts.iter().enumerate() {
        let categories = classify_regex_script_categories(script);
        ui_signals.push(ExtractedSignal {
            id: format!("ui:regex_script:{}", index),
            kind: ExtractedSignalKind::UiDependency,
            path: None,
            label: Some(script.script_name.clone()),
            source: "regex_script".to_string(),
            confidence: 0.82,
            excerpt: Some(script.replace_string.chars().take(220).collect()),
            details: Some(serde_json::json!({
                "script_name": script.script_name,
                "find_regex": script.find_regex,
                "disabled": script.disabled,
                "prompt_only": script.prompt_only,
                "markdown_only": script.markdown_only,
                "min_depth": script.min_depth,
                "max_depth": script.max_depth,
                "categories": categories,
                "replace_length": script.replace_string.len(),
            })),
        });
    }

    let helper_scripts = extract_tavern_helper_scripts(card);
    for (index, script) in helper_scripts.iter().enumerate() {
        let categories = classify_tavern_helper_categories(&script.content);
        let state_categories = categories
            .iter()
            .copied()
            .filter(|category| matches!(*category, "mvu_schema" | "state_api" | "runtime_root"))
            .collect::<Vec<_>>();
        let action_categories = categories
            .iter()
            .copied()
            .filter(|category| {
                matches!(
                    *category,
                    "generation_api" | "message_bridge" | "submit_handler"
                )
            })
            .collect::<Vec<_>>();
        let ui_categories = categories
            .iter()
            .copied()
            .filter(|category| {
                matches!(*category, "status_renderer" | "dom_ui" | "html_launcher")
            })
            .collect::<Vec<_>>();

        ui_signals.push(ExtractedSignal {
            id: format!("ui:tavern_helper:{}", index),
            kind: ExtractedSignalKind::UiDependency,
            path: None,
            label: Some(script.name.clone()),
            source: "tavern_helper".to_string(),
            confidence: 0.78,
            excerpt: Some(script.content.chars().take(220).collect()),
            details: Some(serde_json::json!({
                "script_name": script.name,
                "categories": categories,
                "ui_categories": ui_categories,
                "content_length": script.content.len(),
            })),
        });

        if !state_categories.is_empty() {
            let runtime_roots = extract_runtime_roots_from_script(&script.content);
            state_signals.push(ExtractedSignal {
                id: format!("state:tavern_helper:{}", index),
                kind: if runtime_roots.is_empty() {
                    ExtractedSignalKind::StateSchemaPath
                } else {
                    ExtractedSignalKind::RuntimeRoot
                },
                path: runtime_roots.first().cloned(),
                label: Some(script.name.clone()),
                source: "tavern_helper".to_string(),
                confidence: 0.76,
                excerpt: Some(script.content.chars().take(220).collect()),
                details: Some(serde_json::json!({
                    "script_name": script.name,
                    "categories": state_categories,
                    "runtime_roots": runtime_roots,
                    "source_kind": "tavern_helper_script",
                })),
            });
        }

        if !action_categories.is_empty() {
            action_signals.push(ExtractedSignal {
                id: format!("action:tavern_helper:{}", index),
                kind: ExtractedSignalKind::ActionHint,
                path: None,
                label: Some(script.name.clone()),
                source: "tavern_helper".to_string(),
                confidence: 0.74,
                excerpt: Some(script.content.chars().take(220).collect()),
                details: Some(serde_json::json!({
                    "categories": action_categories,
                    "script_name": script.name,
                })),
            });
        }
    }

    for (index, resource) in resources.resources.iter().enumerate() {
        ui_signals.push(ExtractedSignal {
            id: format!("ui:asset:{}", index),
            kind: ExtractedSignalKind::UiDependency,
            path: Some(resource.url.clone()),
            label: Some(format!("{:?}", resource.kind)),
            source: resource.source_location.file.clone(),
            confidence: 0.7,
            excerpt: Some(resource.source_location.excerpt.clone()),
            details: Some(serde_json::json!({
                "offset": resource.source_location.offset,
            })),
        });
    }

    let mut unresolved_signals = if variables.is_empty() {
        vec![ExtractedSignal {
            id: "unresolved:variables".to_string(),
            kind: ExtractedSignalKind::Unresolved,
            path: None,
            label: Some("变量提取为空".to_string()),
            source: "variable_extract".to_string(),
            confidence: 1.0,
            excerpt: None,
            details: Some(serde_json::json!({
                "reason": "No variable declarations were extracted from JS",
            })),
        }]
    } else {
        vec![]
    };

    if !helper_scripts.is_empty() {
        let unclassified_helpers = helper_scripts
            .iter()
            .enumerate()
            .filter(|(_, script)| classify_tavern_helper_categories(&script.content).is_empty())
            .collect::<Vec<_>>();
        if !unclassified_helpers.is_empty() {
            unresolved_signals.push(ExtractedSignal {
                id: "unresolved:tavern_helper".to_string(),
                kind: ExtractedSignalKind::Unresolved,
                path: None,
                label: Some("存在未分类的 TavernHelper 脚本".to_string()),
                source: "tavern_helper".to_string(),
                confidence: 0.64,
                excerpt: None,
                details: Some(serde_json::json!({
                    "count": unclassified_helpers.len(),
                    "script_names": unclassified_helpers.into_iter().map(|(_, script)| script.name.clone()).collect::<Vec<_>>(),
                    "reason": "Script content was retained but did not match current state/ui/action classifiers",
                })),
            });
        }
    }

    ExtractionLayers {
        state_signals,
        ui_signals,
        action_signals,
        unresolved_signals,
    }
}

#[derive(Debug, Clone)]
struct TavernHelperScript {
    name: String,
    content: String,
}

fn extract_tavern_helper_scripts(card: &ExternalCard) -> Vec<TavernHelperScript> {
    let Some(scripts) = card
        .extensions
        .get("tavern_helper")
        .and_then(|value| value.get("scripts"))
        .and_then(|value| value.as_array())
    else {
        return vec![];
    };

    scripts
        .iter()
        .filter_map(|script| {
            let disabled = script
                .get("disabled")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || script
                    .get("enabled")
                    .and_then(|value| value.as_bool())
                    .map(|value| !value)
                    .unwrap_or(false);
            if disabled {
                return None;
            }
            let content = script
                .get("content")
                .and_then(|value| value.as_str())
                .or_else(|| script.get("script").and_then(|value| value.as_str()))
                .unwrap_or("")
                .trim()
                .to_string();
            if content.is_empty() {
                return None;
            }
            Some(TavernHelperScript {
                name: script
                    .get("name")
                    .and_then(|value| value.as_str())
                    .or_else(|| script.get("script_name").and_then(|value| value.as_str()))
                    .or_else(|| script.get("scriptName").and_then(|value| value.as_str()))
                    .unwrap_or("TavernHelper Script")
                    .to_string(),
                content,
            })
        })
        .collect()
}

fn classify_regex_script_categories(script: &RegexScript) -> Vec<&'static str> {
    let mut categories = Vec::new();
    let lower_find = script.find_regex.to_ascii_lowercase();
    let lower_replace = script.replace_string.to_ascii_lowercase();
    if lower_replace.contains("<!doctype")
        || lower_replace.contains("<html")
        || lower_replace.contains("<script")
    {
        categories.push("html_app");
    }
    if lower_replace.contains("status-card")
        || lower_find.contains("statusplaceholderimpl")
        || lower_replace.contains("statusplaceholderimpl")
    {
        categories.push("status_renderer");
    }
    if lower_find.contains("gamestart")
        || lower_find.contains("开局")
        || lower_replace.contains("gamestart")
    {
        categories.push("opening_trigger");
    }
    if lower_replace.contains("updatevariable") || lower_replace.contains("setvariables") {
        categories.push("variable_macro");
    }
    if script.replace_string.len() > 1200 {
        categories.push("large_replacement");
    }
    categories
}

fn classify_tavern_helper_categories(content: &str) -> Vec<&'static str> {
    let lower = content.to_ascii_lowercase();
    let mut categories = Vec::new();
    if lower.contains("registermvuschema") {
        categories.push("mvu_schema");
    }
    if contains_any_ci(
        &lower,
        &[
            "getvariables",
            "getallvariables",
            "setvariables",
            "updatevariableswith",
            "replacemvudata",
        ],
    ) {
        categories.push("state_api");
    }
    if contains_any_ci(&lower, &["stat_data", "display_data", "variables.", "statusdata"]) {
        categories.push("runtime_root");
    }
    if contains_any_ci(
        &lower,
        &["generate(", "submittext", "generateraw", "setchatmessage", "setchatmessages"],
    ) {
        categories.push("generation_api");
    }
    if contains_any_ci(
        &lower,
        &["form.addEventListener(\"submit\"", "onsubmit", "requestsubmit"],
    ) {
        categories.push("submit_handler");
    }
    if contains_any_ci(&lower, &["status-card", "statusplaceholderimpl", "renderstatus"]) {
        categories.push("status_renderer");
    }
    if contains_any_ci(
        &lower,
        &["innerhtml", "createelement", "queryselector", "appendchild"],
    ) {
        categories.push("dom_ui");
    }
    if contains_any_ci(&lower, &["cx-launcher", "view-container", "<html", "<script"]) {
        categories.push("html_launcher");
    }
    if contains_any_ci(&lower, &["setchatmessage", "setchatmessages"]) {
        categories.push("message_bridge");
    }
    categories
}

fn extract_runtime_roots_from_script(content: &str) -> Vec<String> {
    let lower = content.to_ascii_lowercase();
    let mut roots = Vec::new();
    for candidate in ["stat_data", "display_data", "statusData", "memoryDB", "phoneMessages"] {
        if lower.contains(&candidate.to_ascii_lowercase()) {
            roots.push(candidate.to_string());
        }
    }
    roots
}

fn contains_any_ci(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}
