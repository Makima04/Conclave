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
