use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextBundle {
    pub task: String,
    pub recent_context: Vec<ContextMessage>,
    pub structured_state: serde_json::Value,
    pub events: Vec<String>,
    pub foreshadowing: Vec<String>,
    pub scene_summary: Option<String>,
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
