CREATE TABLE IF NOT EXISTS session_variables (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL UNIQUE,
    variables     TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_variables_session_id
    ON session_variables(session_id);
