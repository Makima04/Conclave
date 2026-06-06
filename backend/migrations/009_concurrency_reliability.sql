-- Clean up any duplicate messages from the race condition before adding unique index
DELETE FROM messages WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM messages GROUP BY session_id, turn_number, role
);

-- Unique constraint preventing duplicate messages per turn/role
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_turn_role
    ON messages(session_id, turn_number, role);

-- Background jobs table (compression, re-compression after edits)
CREATE TABLE IF NOT EXISTS turn_jobs (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    turn_number INTEGER NOT NULL,
    job_type    TEXT NOT NULL,           -- 'compression', 'recompression'
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending/running/completed/failed
    payload     TEXT NOT NULL DEFAULT '{}',
    error       TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_jobs_status ON turn_jobs(status);
CREATE INDEX IF NOT EXISTS idx_turn_jobs_session ON turn_jobs(session_id, turn_number);
