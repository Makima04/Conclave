use serde::Serialize;

/// Events broadcast through the SSE reconnect channel.
/// Carries all lifecycle events so reconnecting clients see the full turn.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum SseEvent {
    TurnStart {
        turn_number: i32,
    },
    AgentStatus {
        agent_type: String,
        label: String,
        status: String,
    },
    MessageDelta {
        content: String,
    },
    StreamError {
        error: String,
    },
    TurnEnd {
        turn_number: i32,
        message_content: String,
    },
    MemoryStart {
        turn_number: i32,
    },
    MemoryError {
        error: String,
    },
    TurnReady {
        turn_number: i32,
    },
}
