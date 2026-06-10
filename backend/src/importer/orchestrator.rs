//! Import orchestrator — faithful card ingestion + analysis coordination.
//!
//! Responsibilities:
//! 1. Parse raw bytes into `ExternalCard` (faithful preservation).
//! 2. Call `analyzer::run_analysis` for all analysis work.
//! 3. Call `package_builder::build_package` to assemble the final package.
//! 4. Generate the `ImportReport`.

use crate::importer::types::*;
use crate::importer::*;

/// Run the full import pipeline on raw file bytes.
/// Returns (package_draft, import_report, original_card).
pub async fn run_import(
    bytes: Vec<u8>,
    filename: &str,
) -> Result<(ConclaveCardPackage, ImportReport, ExternalCard), ImportError> {
    // 1. Parse source — faithful card preservation
    let card = parse_source(&bytes, filename)?;

    // 2. Analyse — regex, HTML split, JS analysis, variable/action extraction
    let analysis = analyzer::run_analysis(&card);

    // 3. Assemble package
    let package = package_builder::build_package(&card, &analysis);

    // 4. Build import report
    let mut stages = vec![report::make_stage(
        "metadata",
        "Metadata Extract",
        StageStatus::Success,
        None,
    )];
    stages.extend(analysis.stages.clone());
    stages.push(report::make_stage(
        "package_build",
        "Package Build",
        StageStatus::Success,
        None,
    ));

    let import_report = report::build_report(
        &card.source_format.to_string(),
        &card.source_hash,
        stages,
        analysis.rule_traces.clone(),
        analysis.diagnostics.clone(),
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
        assert!(package.runtime_hints.opening_regex_matched);
        assert!(package.runtime_hints.regex_opening_full_document);
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
        assert!(!package.runtime_hints.opening_regex_matched);
        assert!(package.runtime_hints.st_regex_scripts_present);
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

    #[tokio::test]
    async fn card_private_state_roots_are_informational() {
        let html = r#"```html
<!doctype html>
<html>
<body>
<div id="app"></div>
<script>
const mp = { activeRunId: null, statusData: {}, phoneMessages: {}, memoryDB: {}, uiMessages: [] };
function render(){ mp.statusData = {}; mp.phoneMessages.draft = ''; }
</script>
</body>
</html>
```"#;
        let bytes = json_card_with_regex(r"\[开局\]", html, "[开局]");

        let (package, report, _card) = run_import(bytes, "card.json").await.unwrap();

        assert!(package.variables.iter().any(|var| var.path == "statusData"));
        assert!(
            package
                .variables
                .iter()
                .any(|var| var.path == "phoneMessages")
        );
        assert!(
            report.stages.iter().any(|stage| {
                stage.id == "state_adapter" && stage.status == StageStatus::Success
            })
        );
        assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
            == "card_private_state_detected"
            && diagnostic.level == DiagnosticLevel::Info));
        assert!(
            !report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "state_field_manual_review")
        );
    }

    #[tokio::test]
    async fn initvar_from_character_book_is_preserved_in_raw_source_not_variables() {
        let bytes = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "InitVar YAML Card",
                "first_mes": "开场",
                "extensions": {
                    "character_book": {
                        "entries": [
                            {
                                "comment": "[InitVar]",
                                "content": r#"<initvar>
主角状态:
  修为:
    当前境界: 筑基五层
    进度百分比: 0
世界系统:
  当前时间: 修真历4500年9月10日 子时一刻
</initvar>"#
                            }
                        ]
                    }
                }
            }
        })
        .to_string()
        .into_bytes();

        let (package, _report, _card) = run_import(bytes, "card.json").await.unwrap();

        let paths: Vec<&str> = package.variables.iter().map(|var| var.path.as_str()).collect();
        assert!(!paths.contains(&"主角状态.修为.当前境界"));
        assert!(!paths.contains(&"世界系统.当前时间"));

        let book = package
            .raw_source
            .character_book
            .expect("character_book preserved");
        let entries = book
            .get("entries")
            .and_then(|v| v.as_array())
            .expect("entries array");
        assert_eq!(entries.len(), 1);
        assert!(entries[0]
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap()
            .contains("主角状态"));
    }

    #[tokio::test]
    async fn initvar_from_opening_is_preserved_in_raw_source_not_variables() {
        let initvar_text = r#"<UpdateVariable>
<initvar>
人际交往:
  当前接触人物:
    沈慕微:
      心情: 心虚
主角状态:
  灵石钱包:
    下品灵石: 50
</initvar>
</UpdateVariable>"#;
        let bytes = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "Opening InitVar Card",
                "first_mes": initvar_text,
                "extensions": {}
            }
        })
        .to_string()
        .into_bytes();

        let (package, _report, _card) = run_import(bytes, "card.json").await.unwrap();

        let paths: Vec<&str> = package.variables.iter().map(|var| var.path.as_str()).collect();
        assert!(!paths.contains(&"人际交往.当前接触人物.沈慕微.心情"));
        assert!(!paths.contains(&"主角状态.灵石钱包.下品灵石"));

        assert!(package.raw_source.first_mes.contains("UpdateVariable"));
        assert!(package.raw_source.first_mes.contains("沈慕微"));
    }
}
