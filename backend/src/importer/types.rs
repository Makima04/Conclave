use serde::{Deserialize, Serialize};

// ─── Intermediate: unified external card ───

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceFormat {
    PngCcv3,
    PngChara,
    JsonV2,
    JsonV3,
}

impl std::fmt::Display for SourceFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SourceFormat::PngCcv3 => write!(f, "png_ccv3"),
            SourceFormat::PngChara => write!(f, "png_chara"),
            SourceFormat::JsonV2 => write!(f, "json_v2"),
            SourceFormat::JsonV3 => write!(f, "json_v3"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalCard {
    pub name: String,
    pub description: String,
    pub personality: String,
    pub scenario: String,
    pub first_mes: String,
    pub alternate_greetings: Vec<String>,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub creator_notes: String,
    pub mes_example: String,
    pub creator: String,
    pub character_version: String,
    pub tags: Vec<String>,
    pub spec: String,
    pub extensions: serde_json::Value,
    pub avatar: String,
    pub source_format: SourceFormat,
    pub source_hash: String,
}

// ─── Regex execution ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegexScript {
    pub script_name: String,
    pub find_regex: String,
    pub replace_string: String,
    pub disabled: bool,
    pub prompt_only: bool,
    pub markdown_only: bool,
    pub min_depth: Option<i32>,
    pub max_depth: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegexOptions {
    pub user_name: String,
    pub char_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegexExecutionResult {
    pub matched: bool,
    pub output: String,
    pub scripts_used: Vec<String>,
    pub diagnostics: Vec<RegexDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegexDiagnostic {
    pub level: DiagnosticLevel,
    pub message: String,
    pub script_index: Option<usize>,
}

// ─── Diagnostic level ───

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Info,
    Warn,
    Error,
}

// ─── HTML split ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HtmlAppSplit {
    pub html: String,
    pub css: Vec<String>,
    pub js: Vec<String>,
    pub script_types: Vec<String>, // "module", "classic", or ""
    pub entry_node: Option<String>,
    pub is_full_document: bool,
}

// ─── Resource scan ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceManifest {
    pub resources: Vec<ResourceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceEntry {
    pub url: String,
    pub kind: ResourceKind,
    pub source_location: SourceLocation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Image,
    Audio,
    Video,
    CssUrl,
    JsStatic,
    Font,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceLocation {
    pub file: String, // "inline_html", "script_0", "style_0", etc.
    pub offset: usize,
    pub excerpt: String, // surrounding context (~100 chars)
}

// ─── JS analysis ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsAnalysisReport {
    pub syntax_valid: bool,
    pub syntax_errors: Vec<SyntaxError>,
    pub detected_apis: Vec<DetectedApi>,
    pub dynamic_imports: Vec<DynamicImport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyntaxError {
    pub message: String,
    pub line: usize,
    pub column: usize,
    pub offset: usize,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedApi {
    pub name: String,
    pub occurrences: Vec<SourceLocation>,
    pub classification: ApiClassification,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiClassification {
    PlatformNative, // getVariables, setVariables, etc. -> will be bridged
    BrowserShim,    // localStorage, indexedDB -> already shimmed
    Unsupported,    // unknown APIs
    Dangerous,      // eval, document.write
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicImport {
    pub source: String, // the import target
    pub location: SourceLocation,
}

// ─── Actions ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionDeclaration {
    pub id: String,
    pub label: String,
    pub kind: ActionKind,
    pub selector: Option<String>,
    pub source: ActionSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Start,
    LoadSave,
    SetMessage,
    SetVariable,
    OpenPanel,
    FormSubmit,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionSource {
    Html,
    Js,
    Regex,
}

// ─── Variables ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariableDeclaration {
    pub path: String,
    #[serde(rename = "type")]
    pub var_type: VariableType,
    pub default_value: Option<serde_json::Value>,
    pub label: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VariableType {
    String,
    Number,
    Boolean,
    Object,
    Array,
}

// ─── Output: ConclaveCardPackage ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConclaveCardPackage {
    pub manifest: PackageManifest,
    pub greetings: Vec<Greeting>,
    pub ui: PackageUi,
    pub variables: Vec<VariableDeclaration>,
    pub actions: Vec<ActionDeclaration>,
    pub compatibility: CompatibilityReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageManifest {
    pub pack_type: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub source_hash: String,
    pub importer_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Greeting {
    pub id: String,
    pub label: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageUi {
    #[serde(rename = "type")]
    pub ui_type: UiType,
    pub html: Option<String>,
    pub css: Vec<String>,
    pub js: Vec<String>,
    pub entry: Option<String>,
    pub assets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UiType {
    Schema,
    HtmlApp,
    HtmlFragment,
    Text,
    RawPreview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatibilityReport {
    pub required_apis: Vec<String>,
    pub unsupported_apis: Vec<String>,
    pub warnings: Vec<String>,
}

// ─── Import report ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportReport {
    pub id: String,
    pub status: ImportStatus,
    pub source: String,
    pub source_hash: String,
    pub stages: Vec<StageResult>,
    pub rule_traces: Vec<RuleTrace>,
    pub diagnostics: Vec<ImportDiagnostic>,
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    Success,
    Warning,
    Fallback,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageResult {
    pub id: String,
    pub name: String,
    pub status: StageStatus,
    pub message: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    Success,
    Warning,
    Error,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleTrace {
    pub rule_id: String,
    pub stage: String,
    pub status: RuleStatus,
    pub confidence: f64,
    pub input_ref: Option<String>,
    pub output_ref: Option<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleStatus {
    Matched,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportDiagnostic {
    pub id: String,
    pub stage: String,
    pub level: DiagnosticLevel,
    pub code: String,
    pub message: String,
    pub source: Option<DiagnosticSource>,
    pub impact: Option<String>,
    pub suggestion: Option<String>,
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticSource {
    pub kind: String, // "png_text", "regex_script", "html", "css", "js"
    pub script_name: Option<String>,
    pub field: Option<String>,
    pub offset: Option<usize>,
    pub selector: Option<String>,
    pub excerpt: Option<String>,
}

// ─── Import draft (in-memory, for draft store) ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportDraft {
    pub import_id: String,
    pub package_draft: ConclaveCardPackage,
    pub import_report: ImportReport,
    pub original_card: ExternalCard,
    pub created_at: String,
}

// ─── Error type ───

#[derive(Debug)]
pub enum ImportError {
    PngParse(String),
    JsonParse(String),
    Internal(String),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::PngParse(msg) => write!(f, "PNG parse error: {}", msg),
            ImportError::JsonParse(msg) => write!(f, "JSON parse error: {}", msg),
            ImportError::Internal(msg) => write!(f, "Internal error: {}", msg),
        }
    }
}

impl std::error::Error for ImportError {}
