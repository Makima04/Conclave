CREATE TABLE IF NOT EXISTS agent_knowledge_events (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    turn_number     INTEGER NOT NULL,
    fact            TEXT NOT NULL DEFAULT '',
    source_type     TEXT NOT NULL DEFAULT 'narration',
    actors          TEXT NOT NULL DEFAULT '[]',
    targets         TEXT NOT NULL DEFAULT '[]',
    observers       TEXT NOT NULL DEFAULT '[]',
    knowers         TEXT NOT NULL DEFAULT '[]',
    visibility      TEXT NOT NULL DEFAULT 'writer_only',
    confidence      REAL NOT NULL DEFAULT 0.5,
    evidence        TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_session_turn
    ON agent_knowledge_events(session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_session_visibility
    ON agent_knowledge_events(session_id, visibility);
