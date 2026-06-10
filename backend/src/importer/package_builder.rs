use crate::importer::types::*;

const IMPORTER_VERSION: &str = "0.1.0";

/// Assemble a ConclaveCardPackage from the parsed card and its analysis result.
pub fn build_package(
    card: &ExternalCard,
    analysis: &AnalysisResult,
) -> ConclaveCardPackage {
    let ui_type = determine_ui_type(&analysis.html_split);
    let manifest = build_manifest(card);
    let greetings = build_greetings(card);
    let ui = build_ui(ui_type, &analysis.html_split, &analysis.resources);
    let runtime_hints = build_runtime_hints(card, &analysis.regex_result, &analysis.html_split);

    ConclaveCardPackage {
        manifest,
        greetings,
        ui,
        runtime_hints,
        extraction_layers: analysis.extraction_layers.clone(),
        variables: analysis.variables.to_vec(),
        state_schema: analysis.state_schema.clone(),
        state_adapter: analysis.state_adapter.clone(),
        actions: analysis.actions.to_vec(),
        compatibility: analysis.compatibility.clone(),
        raw_source: build_raw_source(card),
    }
}

fn determine_ui_type(html_split: &HtmlAppSplit) -> UiType {
    if html_split.is_full_document && !html_split.js.is_empty() {
        UiType::HtmlApp
    } else if html_split.is_full_document {
        UiType::HtmlFragment
    } else if !html_split.html.trim().is_empty() && html_split.html.contains('<') {
        UiType::HtmlFragment
    } else if !html_split.html.trim().is_empty() {
        UiType::Text
    } else {
        UiType::RawPreview
    }
}

fn build_manifest(card: &ExternalCard) -> PackageManifest {
    let id = generate_package_id(&card.source_hash, &card.name);
    PackageManifest {
        pack_type: "character".to_string(),
        id,
        name: card.name.clone(),
        version: "0.1.0".to_string(),
        source: match card.source_format {
            SourceFormat::PngCcv3 | SourceFormat::PngChara => "sillytavern".to_string(),
            SourceFormat::JsonV2 | SourceFormat::JsonV3 => "custom_json".to_string(),
        },
        source_hash: card.source_hash.clone(),
        importer_version: IMPORTER_VERSION.to_string(),
    }
}

fn build_greetings(card: &ExternalCard) -> Vec<Greeting> {
    let mut greetings = Vec::new();
    if !card.first_mes.is_empty() {
        greetings.push(Greeting {
            id: "opening_default".to_string(),
            label: "\u{9ed8}\u{8ba4}\u{5f00}\u{573a}".to_string(), // "默认开场"
            content: card.first_mes.clone(),
        });
    }
    for (i, alt) in card.alternate_greetings.iter().enumerate() {
        greetings.push(Greeting {
            id: format!("opening_alt_{}", i),
            label: format!("\u{5907}\u{9009}\u{5f00}\u{573a} {}", i + 1), // "备选开场 {n}"
            content: alt.clone(),
        });
    }
    greetings
}

fn build_ui(ui_type: UiType, html_split: &HtmlAppSplit, resources: &ResourceManifest) -> PackageUi {
    PackageUi {
        ui_type,
        html: if html_split.is_full_document {
            Some(html_split.html.clone())
        } else {
            None
        },
        css: html_split.css.clone(),
        js: html_split.js.clone(),
        entry: html_split.entry_node.clone(),
        assets: resources.resources.iter().map(|r| r.url.clone()).collect(),
    }
}

fn build_runtime_hints(
    card: &ExternalCard,
    regex_result: &RegexExecutionResult,
    html_split: &HtmlAppSplit,
) -> PackageRuntimeHints {
    let raw_opening = card.first_mes.trim();
    let regex_opening = regex_result.output.trim();
    PackageRuntimeHints {
        st_regex_scripts_present: !card
            .extensions
            .get("regex_scripts")
            .and_then(|value| value.as_array())
            .map(|items| items.is_empty())
            .unwrap_or(true),
        opening_regex_matched: regex_result.matched,
        raw_opening_html_candidate: raw_opening.contains('<'),
        raw_opening_full_document: raw_opening.to_ascii_lowercase().contains("<html")
            || raw_opening.to_ascii_lowercase().contains("<!doctype"),
        regex_opening_html_candidate: regex_opening.contains('<'),
        regex_opening_full_document: html_split.is_full_document,
        canonical_state_root: "state".to_string(),
        projection_root: "variables".to_string(),
        runtime_local_root: "_runtime".to_string(),
    }
}

/// Faithfully preserve raw card source data — no semantic parsing.
/// Character book, extensions, and opening text are kept verbatim.
fn build_raw_source(card: &ExternalCard) -> RawCardSource {
    let character_book = card
        .extensions
        .get("__character_book")
        .or_else(|| card.extensions.get("character_book"))
        .cloned();

    RawCardSource {
        character_book,
        first_mes: card.first_mes.clone(),
        alternate_greetings: card.alternate_greetings.clone(),
        extensions: card.extensions.clone(),
    }
}

fn generate_package_id(source_hash: &str, name: &str) -> String {
    let clean_name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == ' ')
        .map(|c| if c == ' ' { '_' } else { c })
        .collect::<String>()
        .to_lowercase();
    let hash_body = source_hash.split(':').next_back().unwrap_or(source_hash);
    let short_hash = &hash_body[..16.min(hash_body.len())];
    format!("char_{}_{}", clean_name, short_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_card(name: &str) -> ExternalCard {
        ExternalCard {
            name: name.to_string(),
            description: String::new(),
            personality: String::new(),
            scenario: String::new(),
            first_mes: "Hello!".to_string(),
            alternate_greetings: vec!["Hi!".to_string(), "Hey!".to_string()],
            system_prompt: String::new(),
            post_history_instructions: String::new(),
            creator_notes: String::new(),
            mes_example: String::new(),
            creator: "Test".to_string(),
            character_version: "1.0".to_string(),
            tags: vec![],
            spec: "chara_card_v2".to_string(),
            extensions: serde_json::json!({}),
            avatar: "none".to_string(),
            source_format: SourceFormat::PngCcv3,
            source_hash: "sha256:abcdef1234567890abcdef1234567890".to_string(),
        }
    }

    fn make_html_split(is_full: bool, has_js: bool) -> HtmlAppSplit {
        HtmlAppSplit {
            html: if is_full {
                "<!DOCTYPE html><html><body><div id='app'></div></body></html>".to_string()
            } else {
                "<div>fragment</div>".to_string()
            },
            css: vec![],
            js: if has_js {
                vec!["console.log('hi')".to_string()]
            } else {
                vec![]
            },
            script_types: vec![],
            entry_node: if is_full {
                Some("app".to_string())
            } else {
                None
            },
            is_full_document: is_full,
        }
    }

    fn make_regex_result(matched: bool, output: &str) -> RegexExecutionResult {
        RegexExecutionResult {
            matched,
            output: output.to_string(),
            scripts_used: vec![],
            diagnostics: vec![],
        }
    }

    fn make_empty_resources() -> ResourceManifest {
        ResourceManifest { resources: vec![] }
    }

    fn make_empty_compatibility() -> CompatibilityReport {
        CompatibilityReport {
            required_apis: vec![],
            unsupported_apis: vec![],
            warnings: vec![],
            api_mappings: vec![],
        }
    }

    #[test]
    fn test_determine_ui_type_html_app() {
        let split = make_html_split(true, true);
        assert_eq!(determine_ui_type(&split), UiType::HtmlApp);
    }

    #[test]
    fn test_determine_ui_type_html_fragment_full_doc_no_js() {
        let split = make_html_split(true, false);
        assert_eq!(determine_ui_type(&split), UiType::HtmlFragment);
    }

    #[test]
    fn test_determine_ui_type_html_fragment_from_split_html() {
        let split = make_html_split(false, false);
        assert_eq!(determine_ui_type(&split), UiType::HtmlFragment);
    }

    #[test]
    fn test_determine_ui_type_text() {
        let split = HtmlAppSplit {
            html: "plain text output".to_string(),
            css: vec![],
            js: vec![],
            script_types: vec![],
            entry_node: None,
            is_full_document: false,
        };
        assert_eq!(determine_ui_type(&split), UiType::Text);
    }

    #[test]
    fn test_determine_ui_type_raw_preview() {
        let split = HtmlAppSplit {
            html: String::new(),
            css: vec![],
            js: vec![],
            script_types: vec![],
            entry_node: None,
            is_full_document: false,
        };
        assert_eq!(determine_ui_type(&split), UiType::RawPreview);
    }

    #[test]
    fn test_build_manifest_png_source() {
        let card = make_card("TestChar");
        let manifest = build_manifest(&card);
        assert_eq!(manifest.pack_type, "character");
        assert_eq!(manifest.name, "TestChar");
        assert_eq!(manifest.source, "sillytavern");
        assert!(manifest.id.starts_with("char_testchar_"));
        assert_eq!(manifest.importer_version, "0.1.0");
    }

    #[test]
    fn test_build_manifest_json_source() {
        let mut card = make_card("JsonChar");
        card.source_format = SourceFormat::JsonV2;
        let manifest = build_manifest(&card);
        assert_eq!(manifest.source, "custom_json");
    }

    #[test]
    fn test_build_greetings_with_first_mes_and_alts() {
        let card = make_card("GreetChar");
        let greetings = build_greetings(&card);
        assert_eq!(greetings.len(), 3); // default + 2 alternates
        assert_eq!(greetings[0].id, "opening_default");
        assert_eq!(greetings[0].content, "Hello!");
        assert_eq!(greetings[1].id, "opening_alt_0");
        assert_eq!(greetings[1].content, "Hi!");
        assert_eq!(greetings[2].id, "opening_alt_1");
        assert_eq!(greetings[2].content, "Hey!");
    }

    #[test]
    fn test_build_greetings_empty_first_mes() {
        let mut card = make_card("EmptyChar");
        card.first_mes = String::new();
        card.alternate_greetings = vec!["Alt only".to_string()];
        let greetings = build_greetings(&card);
        assert_eq!(greetings.len(), 1);
        assert_eq!(greetings[0].id, "opening_alt_0");
    }

    #[test]
    fn test_generate_package_id() {
        let id = generate_package_id("sha256:abcdef1234567890zzz", "My Character");
        assert!(id.starts_with("char_my_character_"));
        assert!(id.contains("abcdef1234567890"));
    }

    #[test]
    fn test_generate_package_id_special_chars() {
        let id = generate_package_id("sha256:abc123", "Test!@#Name");
        // Special chars stripped, only alphanumeric + underscore + space kept
        assert!(id.starts_with("char_testname_"));
    }

    #[test]
    fn test_generate_package_id_short_hash() {
        let id = generate_package_id("short", "Char");
        // Hash shorter than 16 chars — should not panic
        assert!(id.starts_with("char_char_short"));
    }

    #[test]
    fn test_build_package_assembly() {
        let card = make_card("AssemblyTest");
        let analysis = AnalysisResult {
            regex_result: make_regex_result(false, ""),
            html_split: HtmlAppSplit {
                html: String::new(),
                css: vec![],
                js: vec![],
                script_types: vec![],
                entry_node: None,
                is_full_document: false,
            },
            resources: make_empty_resources(),
            compatibility: make_empty_compatibility(),
            ..Default::default()
        };

        let pkg = build_package(&card, &analysis);

        assert_eq!(pkg.manifest.name, "AssemblyTest");
        assert_eq!(pkg.greetings.len(), 3);
        assert_eq!(pkg.ui.ui_type, UiType::RawPreview);
        assert_eq!(pkg.runtime_hints.projection_root, "variables");
        assert!(pkg.variables.is_empty());
        assert!(pkg.state_schema.fields.is_empty());
        assert!(pkg.actions.is_empty());
    }

    #[test]
    fn test_build_ui_with_full_document() {
        let split = make_html_split(true, true);
        let resources = make_empty_resources();
        let ui = build_ui(UiType::HtmlApp, &split, &resources);

        assert_eq!(ui.ui_type, UiType::HtmlApp);
        assert!(ui.html.is_some());
        assert_eq!(ui.entry, Some("app".to_string()));
    }

    #[test]
    fn test_build_ui_without_full_document() {
        let split = make_html_split(false, false);
        let resources = make_empty_resources();
        let ui = build_ui(UiType::Text, &split, &resources);

        assert_eq!(ui.ui_type, UiType::Text);
        assert!(ui.html.is_none());
        assert!(ui.entry.is_none());
    }

    #[test]
    fn test_build_ui_assets() {
        let split = make_html_split(false, false);
        let resources = ResourceManifest {
            resources: vec![
                ResourceEntry {
                    url: "https://example.com/img.png".to_string(),
                    kind: ResourceKind::Image,
                    source_location: SourceLocation {
                        file: "inline_html".to_string(),
                        offset: 0,
                        excerpt: String::new(),
                    },
                },
                ResourceEntry {
                    url: "https://example.com/style.css".to_string(),
                    kind: ResourceKind::CssUrl,
                    source_location: SourceLocation {
                        file: "inline_html".to_string(),
                        offset: 100,
                        excerpt: String::new(),
                    },
                },
            ],
        };
        let ui = build_ui(UiType::RawPreview, &split, &resources);
        assert_eq!(ui.assets.len(), 2);
        assert_eq!(ui.assets[0], "https://example.com/img.png");
    }
}
