-- Structured events for context recall system
CREATE TABLE IF NOT EXISTS structured_events (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id),
    turn_number     INTEGER NOT NULL,
    characters      TEXT NOT NULL DEFAULT '[]',    -- JSON array of character names
    location        TEXT,
    action          TEXT NOT NULL DEFAULT '',       -- what happened (verb phrase)
    scene_type      TEXT NOT NULL DEFAULT 'other',  -- encounter/dialogue/combat/travel/info/other
    importance      INTEGER NOT NULL DEFAULT 3,     -- 1-5 scale
    raw_text        TEXT NOT NULL,                  -- original event description
    content_hash    TEXT NOT NULL,                  -- hash of normalized text for dedup
    embedding       BLOB,                           -- nullable; f32 little-endian vector
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_structured_events_session_turn
    ON structured_events(session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_structured_events_session_location
    ON structured_events(session_id, location);
CREATE INDEX IF NOT EXISTS idx_structured_events_session_scene
    ON structured_events(session_id, scene_type);
CREATE INDEX IF NOT EXISTS idx_structured_events_hash
    ON structured_events(session_id, content_hash);
