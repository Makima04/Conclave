use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Canonical agent types used throughout the runtime.
/// Variants match the DB string values exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentType {
    Master,
    Parser,
    Npc,
    User,
    Writer,
    Director,
    State,
}

impl AgentType {
    /// Parse from database string value (case-sensitive match on lowercase).
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "master" => Some(Self::Master),
            "parser" => Some(Self::Parser),
            "npc" => Some(Self::Npc),
            "user" => Some(Self::User),
            "writer" => Some(Self::Writer),
            "director" => Some(Self::Director),
            "state" => Some(Self::State),
            _ => None,
        }
    }

    /// Convert to database string value.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Master => "master",
            Self::Parser => "parser",
            Self::Npc => "npc",
            Self::User => "user",
            Self::Writer => "writer",
            Self::Director => "director",
            Self::State => "state",
        }
    }
}

impl Default for AgentType {
    fn default() -> Self {
        Self::Writer
    }
}

impl std::fmt::Display for AgentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for AgentType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_db(s).ok_or_else(|| format!("Unknown agent type: {}", s))
    }
}

// sqlx trait implementations for AgentType ↔ SQLite TEXT
impl sqlx::Type<sqlx::Sqlite> for AgentType {
    fn type_info() -> sqlx::sqlite::SqliteTypeInfo {
        <str as sqlx::Type<sqlx::Sqlite>>::type_info()
    }
}

impl<'r> sqlx::Decode<'r, sqlx::Sqlite> for AgentType {
    fn decode(
        value: <sqlx::Sqlite as sqlx::Database>::ValueRef<'r>,
    ) -> Result<Self, sqlx::error::BoxDynError> {
        let s = <String as sqlx::Decode<'r, sqlx::Sqlite>>::decode(value)?;
        AgentType::from_db(&s).ok_or_else(|| format!("Unknown agent type: {}", s).into())
    }
}

impl<'q> sqlx::Encode<'q, sqlx::Sqlite> for AgentType {
    fn encode_by_ref(
        &self,
        buf: &mut <sqlx::Sqlite as sqlx::Database>::ArgumentBuffer<'q>,
    ) -> Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        <&str as sqlx::Encode<'q, sqlx::Sqlite>>::encode_by_ref(&self.as_str(), buf)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextBundle {
    pub task: String,
    pub recent_context: Vec<ContextMessage>,
    /// Active role agents (NPC/user) that can be used as participant context.
    #[serde(default)]
    pub role_contexts: Vec<RoleContext>,
    /// Knowledge events visible to the current context consumer.
    #[serde(default)]
    pub knowledge_events: Vec<KnowledgeEvent>,
    pub structured_state: serde_json::Value,
    pub events: Vec<String>,
    /// Visibility per event (parallel to `events`). "public", "gm_only", "character:<id>", "writer_only"
    pub event_visibilities: Vec<String>,
    pub foreshadowing: Vec<String>,
    /// Visibility per foreshadowing item (parallel to `foreshadowing`)
    pub foreshadow_visibilities: Vec<String>,
    pub scene_summary: Option<String>,
    /// World book entries for context injection (from session's world_pack_id)
    #[serde(default)]
    pub world_book_entries: Vec<WorldBookContextEntry>,
    /// Preset modules for context injection (from session's active_preset_id)
    #[serde(default)]
    pub preset_modules: Vec<PresetModuleContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleContext {
    pub agent_type: AgentType,
    pub label: String,
    pub character_id: Option<String>,
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KnowledgeEvent {
    pub fact: String,
    pub source_type: String,
    pub actors: Vec<String>,
    pub targets: Vec<String>,
    pub observers: Vec<String>,
    pub knowers: Vec<String>,
    pub visibility: String,
    pub confidence: f32,
    pub evidence: String,
    pub turn_number: i32,
}

/// A preset module ready for context injection into agent prompts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetModuleContext {
    pub name: String,
    pub content: String,
    pub role: String,
    pub target_agents: Vec<String>,
    pub injection_order: i32,
}

/// A world book entry ready for context injection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldBookContextEntry {
    pub content: String,
    pub keys: Vec<String>,
    pub constant: bool,
    pub priority: i32,
    /// Visibility for multi-agent filtering: "public", "writer_only", "gm_only", "character:<id>"
    pub visibility: String,
    /// Category: "global", "writer_only", "gm_only", "npc:<name>", "user"
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMessage {
    pub role: String,
    pub content: String,
    pub turn_number: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriterDraft {
    pub narrative_text: String,
    pub memory_candidates: MemoryProposal,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryProposal {
    pub events: Vec<EventCandidate>,
    pub state_changes: Vec<StateChangeCandidate>,
    pub foreshadowing: Vec<ForeshadowingCandidate>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventCandidate {
    pub event_type: String,
    pub content: String,
    pub characters_involved: Vec<String>,
    pub importance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateChangeCandidate {
    pub op: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<serde_json::Value>,
    pub to: serde_json::Value,
    #[serde(default)]
    pub evidence_turns: Vec<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateChangeProposal {
    pub proposed_by: String,
    pub risk: String,
    pub changes: Vec<StateChangeCandidate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProposalResult {
    pub status: String,
    pub version: i32,
    pub rejected_changes: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeshadowingCandidate {
    pub content: String,
    pub importance: String,
    pub trigger_conditions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnResult {
    pub message_content: String,
    pub writer_draft: WriterDraft,
    pub turn_number: i32,
}

// TurnCommit is defined in turn_finalizer.rs

#[derive(Debug, Clone)]
pub struct AgentTrace {
    pub agent_id: String,
    pub agent_type: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub duration_ms: i32,
    pub input_summary: String,
    pub output_summary: String,
    pub model: String,
}

// --- Parser types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedIntent {
    /// Core intent: "dialogue", "action", "query", "command", etc.
    pub intent: String,
    /// Action type: "speak", "attack", "move", "examine", etc.
    pub action_type: String,
    /// Target characters mentioned by the user
    pub target_characters: Vec<String>,
    /// Compressed/clarified version of user input (stripped of filler)
    pub compressed_input: String,
    /// Emotional tone: "hostile", "friendly", "neutral", "curious", etc.
    pub tone: String,
}

// --- Compression types ---

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompressionResult {
    /// Updated scene summary (replaces previous)
    pub scene_summary: String,
    /// New memory events to record
    pub events: Vec<CompressedEvent>,
    /// Structured events for recall system
    #[serde(default)]
    pub structured_events: Vec<StructuredEvent>,
    /// Foreshadowing updates (new or status changes)
    pub foreshadowing: Vec<CompressedForeshadowing>,
    /// State changes proposal
    pub state_changes: Vec<StateChangeCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedEvent {
    pub event_type: String,
    pub content: String,
    pub characters_involved: Vec<String>,
    pub importance: String,
    /// Visibility: "public", "gm_only", "character:<id>", "writer_only"
    #[serde(default = "default_visibility")]
    pub visibility: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedForeshadowing {
    pub content: String,
    pub importance: String,
    pub trigger_conditions: Vec<String>,
    /// "new" or "update"
    pub action: String,
    /// If updating, the foreshadowing ID
    pub target_id: Option<String>,
    /// If updating, new status
    pub new_status: Option<String>,
    /// Visibility: "public", "gm_only", "character:<id>", "writer_only"
    #[serde(default = "default_visibility")]
    pub visibility: String,
}

fn default_visibility() -> String {
    "public".to_string()
}

// --- Pipeline status streaming ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatusEvent {
    pub agent_type: String,
    pub label: String,
    pub status: String,
}

// --- Agent Config ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Max conversation history turns to inject into this agent's prompt
    #[serde(default)]
    pub max_context_turns: Option<usize>,
    /// Max tokens for this agent's LLM call
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Temperature for this agent's LLM call
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Recall mode: "keyword" (default) or "embedding"
    #[serde(default)]
    pub recall_mode: Option<String>,
    /// Max events to recall for this agent
    #[serde(default)]
    pub max_recall_events: Option<usize>,
    /// Per-agent model override (takes priority over session sub_agent_model)
    #[serde(default)]
    pub model: Option<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_context_turns: None,
            max_tokens: None,
            temperature: None,
            recall_mode: None,
            max_recall_events: None,
            model: None,
        }
    }
}

// --- Structured Events ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredEvent {
    pub characters: Vec<String>,
    pub location: Option<String>,
    pub action: String,
    pub scene_type: String,
    pub importance: i32,
    pub raw_text: String,
}

// --- Multi-Agent types ---

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SubAgent {
    pub id: String,
    pub session_id: String,
    pub agent_type: AgentType,
    pub character_id: Option<String>,
    pub label: String,
    pub system_prompt: String,
    pub context: String,
    pub status: String,
    pub last_active_turn: i32,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MasterPlan {
    #[serde(default)]
    pub calls: Vec<AgentCall>,
    #[serde(default)]
    pub lifecycle: Vec<LifecycleAction>,
    #[serde(default)]
    pub user_auto: bool,
    /// When multiple writers are active, specify which one produces the final narrative.
    #[serde(default)]
    pub final_writer_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCall {
    pub agent_id: String,
    pub task: String,
    #[serde(default)]
    pub inject_from: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LifecycleAction {
    pub action: String,
    #[serde(default)]
    pub agent_type: AgentType,
    #[serde(default)]
    pub character_id: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnState {
    pub turn_number: i32,
    pub agent_outputs: HashMap<String, AgentOutput>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentOutput {
    pub agent_id: String,
    pub agent_type: AgentType,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<crate::provider::types::ToolCall>>,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub duration_ms: i32,
}
