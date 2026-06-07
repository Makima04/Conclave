use crate::importer::types::*;
use uuid::Uuid;

/// Build an ImportReport from all pipeline outputs.
pub fn build_report(
    source: &str,
    source_hash: &str,
    stages: Vec<StageResult>,
    rule_traces: Vec<RuleTrace>,
    diagnostics: Vec<ImportDiagnostic>,
) -> ImportReport {
    let status = determine_status(&stages, &diagnostics);
    ImportReport {
        id: Uuid::new_v4().to_string(),
        status,
        source: source.to_string(),
        source_hash: source_hash.to_string(),
        stages,
        rule_traces,
        diagnostics,
        fallback: None,
    }
}

fn determine_status(stages: &[StageResult], diagnostics: &[ImportDiagnostic]) -> ImportStatus {
    let has_error = stages.iter().any(|s| s.status == StageStatus::Error);
    let has_warning = stages.iter().any(|s| s.status == StageStatus::Warning)
        || diagnostics.iter().any(|d| d.level == DiagnosticLevel::Warn);
    let has_blocked = diagnostics
        .iter()
        .any(|d| d.code == "package_build_blocked");

    if has_blocked {
        ImportStatus::Blocked
    } else if has_error {
        ImportStatus::Fallback
    } else if has_warning {
        ImportStatus::Warning
    } else {
        ImportStatus::Success
    }
}

/// Create a StageResult helper.
pub fn make_stage(
    id: &str,
    name: &str,
    status: StageStatus,
    message: Option<String>,
) -> StageResult {
    StageResult {
        id: id.to_string(),
        name: name.to_string(),
        status,
        message,
        started_at: None,
        finished_at: None,
    }
}

/// Create an ImportDiagnostic helper.
pub fn make_diagnostic(
    stage: &str,
    level: DiagnosticLevel,
    code: &str,
    message: &str,
    source: Option<DiagnosticSource>,
    impact: Option<&str>,
    suggestion: Option<&str>,
) -> ImportDiagnostic {
    ImportDiagnostic {
        id: Uuid::new_v4().to_string(),
        stage: stage.to_string(),
        level,
        code: code.to_string(),
        message: message.to_string(),
        source,
        impact: impact.map(|s| s.to_string()),
        suggestion: suggestion.map(|s| s.to_string()),
        rule_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_report_success() {
        let stages = vec![make_stage("s1", "Stage 1", StageStatus::Success, None)];
        let report = build_report("PngCcv3", "sha256:abc", stages, vec![], vec![]);
        assert_eq!(report.status, ImportStatus::Success);
        assert_eq!(report.source, "PngCcv3");
        assert_eq!(report.source_hash, "sha256:abc");
        assert!(report.fallback.is_none());
        assert!(!report.id.is_empty());
    }

    #[test]
    fn test_build_report_warning_from_stage() {
        let stages = vec![
            make_stage("s1", "Stage 1", StageStatus::Success, None),
            make_stage(
                "s2",
                "Stage 2",
                StageStatus::Warning,
                Some("warn".to_string()),
            ),
        ];
        let report = build_report("JsonV2", "sha256:def", stages, vec![], vec![]);
        assert_eq!(report.status, ImportStatus::Warning);
    }

    #[test]
    fn test_build_report_warning_from_diagnostic() {
        let stages = vec![make_stage("s1", "Stage 1", StageStatus::Success, None)];
        let diagnostics = vec![make_diagnostic(
            "s1",
            DiagnosticLevel::Warn,
            "some_warning",
            "warning message",
            None,
            None,
            None,
        )];
        let report = build_report("PngCcv3", "sha256:abc", stages, vec![], diagnostics);
        assert_eq!(report.status, ImportStatus::Warning);
    }

    #[test]
    fn test_build_report_fallback_on_error() {
        let stages = vec![make_stage(
            "s1",
            "Stage 1",
            StageStatus::Error,
            Some("fail".to_string()),
        )];
        let report = build_report("JsonV3", "sha256:err", stages, vec![], vec![]);
        assert_eq!(report.status, ImportStatus::Fallback);
    }

    #[test]
    fn test_build_report_blocked() {
        let stages = vec![make_stage("s1", "Stage 1", StageStatus::Success, None)];
        let diagnostics = vec![make_diagnostic(
            "s1",
            DiagnosticLevel::Error,
            "package_build_blocked",
            "blocked",
            None,
            Some("Cannot proceed"),
            None,
        )];
        let report = build_report("PngCcv3", "sha256:blk", stages, vec![], diagnostics);
        assert_eq!(report.status, ImportStatus::Blocked);
    }

    #[test]
    fn test_build_report_blocked_takes_precedence_over_error() {
        let stages = vec![make_stage(
            "s1",
            "Stage 1",
            StageStatus::Error,
            Some("fail".to_string()),
        )];
        let diagnostics = vec![make_diagnostic(
            "s1",
            DiagnosticLevel::Error,
            "package_build_blocked",
            "blocked",
            None,
            None,
            None,
        )];
        let report = build_report("PngCcv3", "sha256:blk", stages, vec![], diagnostics);
        assert_eq!(report.status, ImportStatus::Blocked);
    }

    #[test]
    fn test_determine_status_empty() {
        let status = determine_status(&[], &[]);
        assert_eq!(status, ImportStatus::Success);
    }

    #[test]
    fn test_make_stage() {
        let stage = make_stage("test_id", "Test Stage", StageStatus::Success, None);
        assert_eq!(stage.id, "test_id");
        assert_eq!(stage.name, "Test Stage");
        assert_eq!(stage.status, StageStatus::Success);
        assert!(stage.message.is_none());
        assert!(stage.started_at.is_none());
        assert!(stage.finished_at.is_none());
    }

    #[test]
    fn test_make_stage_with_message() {
        let stage = make_stage(
            "id",
            "Name",
            StageStatus::Warning,
            Some("details".to_string()),
        );
        assert_eq!(stage.message, Some("details".to_string()));
    }

    #[test]
    fn test_make_diagnostic() {
        let diag = make_diagnostic(
            "stage1",
            DiagnosticLevel::Error,
            "err_code",
            "error message",
            None,
            Some("high impact"),
            Some("fix it"),
        );
        assert_eq!(diag.stage, "stage1");
        assert_eq!(diag.level, DiagnosticLevel::Error);
        assert_eq!(diag.code, "err_code");
        assert_eq!(diag.message, "error message");
        assert!(diag.source.is_none());
        assert_eq!(diag.impact, Some("high impact".to_string()));
        assert_eq!(diag.suggestion, Some("fix it".to_string()));
        assert!(diag.rule_id.is_none());
        assert!(!diag.id.is_empty());
    }

    #[test]
    fn test_make_diagnostic_with_source() {
        let diag = make_diagnostic(
            "js_parse",
            DiagnosticLevel::Error,
            "js_parse_failed",
            "unexpected token",
            Some(DiagnosticSource {
                kind: "js".to_string(),
                script_name: Some("main.js".to_string()),
                field: None,
                offset: Some(42),
                selector: None,
                excerpt: Some("...bad code here...".to_string()),
            }),
            None,
            None,
        );
        assert!(diag.source.is_some());
        let src = diag.source.unwrap();
        assert_eq!(src.kind, "js");
        assert_eq!(src.script_name, Some("main.js".to_string()));
        assert_eq!(src.offset, Some(42));
    }
}
