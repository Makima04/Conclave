//! Simplified import orchestrator — v3: parse-only, no analysis pipeline.
//!
//! Responsibilities:
//! 1. Parse raw bytes into `ExternalCard` (faithful preservation).
//! 2. Build a minimal `ConclaveCardPackage` directly from the raw card data.
//! 3. Generate a simple `ImportReport`.

use crate::importer::types::*;
use crate::importer::{json_parser, png_parser, report};
use uuid::Uuid;

/// Run the simplified import pipeline on raw file bytes.
/// v3: Parses PNG/JSON → returns minimal package + report. No analysis, no package building.
/// Returns (package_draft, import_report, original_card).
pub async fn run_import(
    bytes: Vec<u8>,
    filename: &str,
) -> Result<(ConclaveCardPackage, ImportReport, ExternalCard), ImportError> {
    // 1. Parse source — faithful card preservation
    let card = parse_source(&bytes, filename)?;

    // 2. Build minimal package directly from raw card data (no analysis)
    let package = build_minimal_package(&card);

    // 3. Build simple import report
    let stages = vec![
        report::make_stage("parse", "Parse Source", StageStatus::Success, None),
        report::make_stage("package_build", "Package Build", StageStatus::Success, None),
    ];
    let import_report = report::build_report(
        &card.source_format.to_string(),
        &card.source_hash,
        stages,
        vec![],
        vec![],
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

/// Build a minimal `ConclaveCardPackage` directly from an `ExternalCard`.
/// v3: No analysis — the package carries raw card data verbatim.
/// InitVar / state interpretation is deferred to runtime.
fn build_minimal_package(card: &ExternalCard) -> ConclaveCardPackage {
    let manifest = PackageManifest {
        pack_type: "character_card".to_string(),
        id: Uuid::new_v4().to_string(),
        name: card.name.clone(),
        version: "1.0".to_string(),
        source: card.source_format.to_string(),
        source_hash: card.source_hash.clone(),
        importer_version: "3.0.0".to_string(),
    };

    let greetings: Vec<Greeting> = card
        .alternate_greetings
        .iter()
        .enumerate()
        .map(|(i, g)| Greeting {
            id: format!("greeting_{}", i),
            label: format!("Alternate Greeting {}", i + 1),
            content: g.clone(),
        })
        .collect();

    let ui = PackageUi {
        ui_type: UiType::RawPreview,
        html: Some(card.first_mes.clone()),
        css: vec![],
        js: vec![],
        entry: None,
        assets: vec![],
    };

    let runtime_hints = PackageRuntimeHints {
        st_regex_scripts_present: false,
        opening_regex_matched: false,
        raw_opening_html_candidate: false,
        raw_opening_full_document: false,
        regex_opening_html_candidate: false,
        regex_opening_full_document: false,
        canonical_state_root: String::new(),
        projection_root: String::new(),
        runtime_local_root: String::new(),
    };

    let raw_source = RawCardSource {
        character_book: card.extensions.get("character_book").cloned(),
        first_mes: card.first_mes.clone(),
        alternate_greetings: card.alternate_greetings.clone(),
        extensions: card.extensions.clone(),
    };

    ConclaveCardPackage {
        manifest,
        greetings,
        ui,
        runtime_hints,
        extraction_layers: ExtractionLayers::default(),
        variables: vec![],
        state_schema: CardStateSchema::default(),
        state_adapter: CardStateAdapter::default(),
        actions: vec![],
        compatibility: CompatibilityReport::default(),
        raw_source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parses_json_card_and_builds_minimal_package() {
        let bytes = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "Test Card",
                "first_mes": "Hello world",
                "extensions": {}
            }
        })
        .to_string()
        .into_bytes();

        let (package, report, card) = run_import(bytes, "card.json").await.unwrap();

        assert_eq!(card.name, "Test Card");
        assert_eq!(package.manifest.name, "Test Card");
        assert_eq!(package.ui.ui_type, UiType::RawPreview);
        assert!(
            package
                .ui
                .html
                .as_deref()
                .unwrap_or_default()
                .contains("Hello world")
        );
        assert_eq!(report.status, ImportStatus::Success);
        assert_eq!(package.variables.len(), 0);
        assert_eq!(package.actions.len(), 0);
    }

    #[tokio::test]
    async fn preserves_raw_source_data() {
        let bytes = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "Source Test",
                "first_mes": "Greetings",
                "alternate_greetings": ["Alt 1", "Alt 2"],
                "extensions": {
                    "character_book": {"entries": []}
                }
            }
        })
        .to_string()
        .into_bytes();

        let (package, _report, _card) = run_import(bytes, "card.json").await.unwrap();

        // Raw source is faithfully preserved
        assert_eq!(package.raw_source.first_mes, "Greetings");
        assert_eq!(package.raw_source.alternate_greetings.len(), 2);
        assert!(package.raw_source.character_book.is_some());
        // Greetings are derived from alternate_greetings
        assert_eq!(package.greetings.len(), 2);
        assert_eq!(package.greetings[0].content, "Alt 1");
    }

    #[test]
    fn parse_source_detects_png_magic_bytes() {
        // Minimal PNG header: 8-byte signature
        let mut png_bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        // The parse will fail because this isn't a real PNG, but it should be
        // routed to the PNG parser (which will error), not the JSON parser
        let result = parse_source(&png_bytes, "unknown");
        // Should be a PNG parse error, not a JSON parse error
        assert!(matches!(result, Err(ImportError::PngParse(_))));

        // Add more bytes to make it non-empty for JSON fallback test
        png_bytes.extend_from_slice(b"more stuff");
        let result = parse_source(&png_bytes, "unknown");
        assert!(matches!(result, Err(ImportError::PngParse(_))));
    }

    #[test]
    fn parse_source_falls_back_to_json() {
        let json_bytes = b"{\"spec\":\"chara_card_v2\",\"data\":{\"name\":\"Test\"}}";
        let result = parse_source(json_bytes, "data.json");
        assert!(result.is_ok());
        let card = result.unwrap();
        assert_eq!(card.name, "Test");
    }
}
