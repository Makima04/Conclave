use super::str_utils::truncate_with_suffix;
use crate::runtime::types::{AgentOutput, TurnState};
use std::collections::HashMap;

pub fn new(turn_number: i32, _user_input: &str) -> TurnState {
    TurnState {
        turn_number,
        agent_outputs: HashMap::new(),
    }
}

pub fn set_output(state: &mut TurnState, agent_id: &str, output: AgentOutput) {
    tracing::trace!(
        turn = state.turn_number,
        agent_id = agent_id,
        agent_type = %output.agent_type,
        text_len = output.text.len(),
        "TurnState: agent output stored"
    );
    state.agent_outputs.insert(agent_id.to_string(), output);
}

/// Concatenate outputs from specified agents for injection into another agent's context
pub fn get_outputs_text(state: &TurnState, agent_ids: &[String]) -> String {
    let mut parts = Vec::new();
    for id in agent_ids {
        if let Some(output) = state.agent_outputs.get(id) {
            parts.push(format!("[{}] {}", id, output.text));
        }
    }
    parts.join("\n\n")
}

/// One-line summary per agent for the Master Agent's overview
pub fn get_all_summaries(state: &TurnState) -> String {
    if state.agent_outputs.is_empty() {
        return "(本轮尚无子Agent输出)".to_string();
    }
    state
        .agent_outputs
        .values()
        .map(|o| {
            format!(
                "- {}({}): {}...",
                o.agent_id,
                o.agent_type,
                truncate_with_suffix(&o.text, 100, "...")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
