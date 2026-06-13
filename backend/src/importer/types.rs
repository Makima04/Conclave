use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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

// ─── Diagnostic level ───

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    #[default]
    Info,
    Warn,
    Error,
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

/// Compute sha256 hex string.
pub fn compute_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}
