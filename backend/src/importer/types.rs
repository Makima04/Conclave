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
    #[serde(default)]
    pub placement: Option<Vec<i32>>,
    #[serde(default)]
    pub trim_strings: Option<Vec<String>>,
    #[serde(default)]
    pub substitute_regex: Option<serde_json::Value>,
    #[serde(default)]
    pub run_on_edit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegexOptions {
    pub user_name: String,
    pub char_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RegexExecutionResult {
    pub matched: bool,
    pub output: String,
    pub scripts_used: Vec<String>,
    pub diagnostics: Vec<RegexDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RegexDiagnostic {
    pub level: DiagnosticLevel,
    pub message: String,
    pub script_index: Option<usize>,
}

// ─── Diagnostic level ───

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    #[default]
    Info,
    Warn,
    Error,
}

// ─── HTML split ───

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HtmlAppSplit {
    pub html: String,
    pub css: Vec<String>,
    pub js: Vec<String>,
    pub script_types: Vec<String>, // "module", "classic", or ""
    pub entry_node: Option<String>,
    pub is_full_document: bool,
}

// ─── Resource scan ───

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ResourceManifest {
    pub resources: Vec<ResourceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ResourceEntry {
    pub url: String,
    pub kind: ResourceKind,
    pub source_location: SourceLocation,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    #[default]
    Image,
    Audio,
    Video,
    CssUrl,
    JsStatic,
    Font,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceLocation {
    pub file: String, // "inline_html", "script_0", "style_0", etc.
    pub offset: usize,
    pub excerpt: String, // surrounding context (~100 chars)
}

// ─── JS analysis ───

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JsAnalysisReport {
    pub syntax_valid: bool,
    pub syntax_errors: Vec<SyntaxError>,
    pub detected_apis: Vec<DetectedApi>,
    pub dynamic_imports: Vec<DynamicImport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyntaxError {
    pub file: String,
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
pub enum ExtractedSignalKind {
    VariablePath,
    StateSchemaPath,
    ActionHint,
    UiDependency,
    RuntimeRoot,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedSignal {
    pub id: String,
    pub kind: ExtractedSignalKind,
    pub path: Option<String>,
    pub label: Option<String>,
    pub source: String,
    pub confidence: f64,
    pub excerpt: Option<String>,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExtractionLayers {
    pub state_signals: Vec<ExtractedSignal>,
    pub ui_signals: Vec<ExtractedSignal>,
    pub action_signals: Vec<ExtractedSignal>,
    pub unresolved_signals: Vec<ExtractedSignal>,
}

// ─── State conversion layer ───

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CardStateSchema {
    pub roots: Vec<StateRootDeclaration>,
    pub fields: Vec<StateFieldDeclaration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateRootDeclaration {
    pub path: String,
    pub role: StateRootRole,
    pub source: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateRootRole {
    World,
    CharacterCollection,
    Character,
    Relationship,
    Inventory,
    Memory,
    Summary,
    UiRuntime,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateFieldDeclaration {
    pub path: String,
    pub canonical_path: Option<String>,
    #[serde(rename = "type")]
    pub field_type: VariableType,
    pub default_value: Option<serde_json::Value>,
    pub role: StateFieldRole,
    pub writable: bool,
    pub source: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateFieldRole {
    Time,
    Location,
    CharacterName,
    RelationshipScore,
    RelationshipStage,
    InventoryItem,
    MemoryEntry,
    SummaryEntry,
    UiFlag,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CardStateAdapter {
    pub adapter_version: String,
    pub source_format: String,
    pub read_rules: Vec<StateMappingRule>,
    pub write_rules: Vec<StateMappingRule>,
    pub variable_rules: Vec<VariableRule>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateMappingRule {
    pub card_path: String,
    pub platform_path: String,
    pub direction: MappingDirection,
    pub transform: MappingTransform,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingDirection {
    Read,
    Write,
    Bidirectional,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingTransform {
    Identity,
    FirstArrayItem,
    CollectionById,
    JsonBlob,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariableRule {
    pub path_pattern: String,
    pub role: StateFieldRole,
    pub writable: bool,
    pub update_policy: VariableUpdatePolicy,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VariableUpdatePolicy {
    AgentTool,
    DerivedFromMessages,
    UiOnly,
    ManualReview,
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

// ─── Raw card source (faithful preservation, no semantic parsing) ───

/// Raw card data preserved verbatim from the source card.
/// InitVar / state interpretation is deferred to runtime — this struct is
/// the ingestr's "ground truth" and must not lose information.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RawCardSource {
    /// character_book entries as-is (may contain InitVar, world info, etc.)
    pub character_book: Option<serde_json::Value>,
    /// Original first_mes text (may contain `<UpdateVariable><initvar>…`)
    pub first_mes: String,
    /// Original alternate_greetings texts
    pub alternate_greetings: Vec<String>,
    /// Full extensions object as-is (regex_scripts, tavern_helper, etc.)
    pub extensions: serde_json::Value,
}

// ─── Analysis result (decoupled from import) ───

/// All outputs from the analysis pass (regex, HTML split, JS analysis, etc.).
/// Decoupled from the import pass so analysis can be re-run independently.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AnalysisResult {
    pub regex_result: RegexExecutionResult,
    pub html_split: HtmlAppSplit,
    pub resources: ResourceManifest,
    pub js_analysis: JsAnalysisReport,
    pub actions: Vec<ActionDeclaration>,
    pub variables: Vec<VariableDeclaration>,
    pub state_schema: CardStateSchema,
    pub state_adapter: CardStateAdapter,
    pub extraction_layers: ExtractionLayers,
    pub compatibility: CompatibilityReport,
    pub stages: Vec<StageResult>,
    pub diagnostics: Vec<ImportDiagnostic>,
    pub rule_traces: Vec<RuleTrace>,
}

// ─── Output: ConclaveCardPackage ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConclaveCardPackage {
    pub manifest: PackageManifest,
    pub greetings: Vec<Greeting>,
    pub ui: PackageUi,
    pub runtime_hints: PackageRuntimeHints,
    #[serde(default)]
    pub extraction_layers: ExtractionLayers,
    pub variables: Vec<VariableDeclaration>,
    pub state_schema: CardStateSchema,
    pub state_adapter: CardStateAdapter,
    pub actions: Vec<ActionDeclaration>,
    pub compatibility: CompatibilityReport,
    /// Faithfully preserved raw card source — no semantic interpretation.
    /// Runtime reads InitVar / world book from this + DB, not from the importer.
    #[serde(default)]
    pub raw_source: RawCardSource,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageRuntimeHints {
    pub st_regex_scripts_present: bool,
    pub opening_regex_matched: bool,
    pub raw_opening_html_candidate: bool,
    pub raw_opening_full_document: bool,
    pub regex_opening_html_candidate: bool,
    pub regex_opening_full_document: bool,
    pub canonical_state_root: String,
    pub projection_root: String,
    pub runtime_local_root: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompatibilityReport {
    pub required_apis: Vec<String>,
    pub unsupported_apis: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub api_mappings: Vec<ApiCompatibilityMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiCompatibilityMapping {
    pub api: String,
    pub status: String,
    pub replacement: String,
    pub notes: String,
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
