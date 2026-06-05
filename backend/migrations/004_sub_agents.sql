CREATE TABLE IF NOT EXISTS sub_agents (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_type TEXT NOT NULL,
    character_id TEXT,
    label TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    last_active_turn INTEGER NOT NULL DEFAULT 0,
    cooldown_reason TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_agents_session ON sub_agents(session_id);
CREATE INDEX IF NOT EXISTS idx_sub_agents_session_status ON sub_agents(session_id, status);
