CREATE TABLE IF NOT EXISTS agent_call_debug_snapshots (
    id                    TEXT PRIMARY KEY,
    session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_number           INTEGER NOT NULL,
    phase                 TEXT NOT NULL DEFAULT 'sub_agent',
    level_index           INTEGER,
    agent_id              TEXT,
    agent_type            TEXT NOT NULL DEFAULT '',
    agent_label           TEXT NOT NULL DEFAULT '',
    model                 TEXT NOT NULL DEFAULT '',
    task                  TEXT NOT NULL DEFAULT '',
    system_prompt         TEXT NOT NULL DEFAULT '',
    user_prompt           TEXT NOT NULL DEFAULT '',
    injected_from_json    TEXT NOT NULL DEFAULT '[]',
    injected_outputs_json TEXT NOT NULL DEFAULT '[]',
    preset_modules_json   TEXT NOT NULL DEFAULT '[]',
    worldbook_entries_json TEXT NOT NULL DEFAULT '[]',
    recent_messages_json  TEXT NOT NULL DEFAULT '[]',
    recalled_events_json  TEXT NOT NULL DEFAULT '[]',
    state_slice_json      TEXT NOT NULL DEFAULT '{}',
    raw_output            TEXT NOT NULL DEFAULT '',
    tool_calls_json       TEXT NOT NULL DEFAULT '[]',
    duration_ms           INTEGER,
    prompt_tokens         INTEGER NOT NULL DEFAULT 0,
    completion_tokens     INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_debug_session_turn
    ON agent_call_debug_snapshots(session_id, turn_number, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_debug_agent
    ON agent_call_debug_snapshots(session_id, agent_id, turn_number);
