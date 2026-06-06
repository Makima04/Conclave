-- Preset system for SillyTavern preset import and multi-agent distribution

CREATE TABLE IF NOT EXISTS presets (
    id              TEXT PRIMARY KEY,
    session_id      TEXT,
    name            TEXT NOT NULL,
    source_format   TEXT NOT NULL DEFAULT 'sillytavern',
    raw_json        TEXT NOT NULL,
    model_params    TEXT NOT NULL DEFAULT '{}',
    parse_status    TEXT NOT NULL DEFAULT 'none',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preset_modules (
    id              TEXT PRIMARY KEY,
    preset_id       TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    identifier      TEXT NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user',
    content         TEXT NOT NULL DEFAULT '',
    target_agents   TEXT NOT NULL DEFAULT '[]',
    enabled         INTEGER NOT NULL DEFAULT 1,
    injection_order INTEGER NOT NULL DEFAULT 100,
    classification  TEXT NOT NULL DEFAULT 'rule',
    reason          TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_preset_modules_preset ON preset_modules(preset_id);
CREATE INDEX IF NOT EXISTS idx_presets_session ON presets(session_id);
