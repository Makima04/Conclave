use crate::runtime::types::{AgentOutput, TurnState};
use std::collections::HashMap;

pub fn new(turn_number: i32, user_input: &str) -> TurnState {
    TurnState {
        turn_number,
        user_input: user_input.to_string(),
        agent_outputs: HashMap::new(),
        final_narrative: String::new(),
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

pub fn get_output<'a>(state: &'a TurnState, agent_id: &str) -> Option<&'a AgentOutput> {
    state.agent_outputs.get(agent_id)
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
                truncate(&o.text, 100)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}
