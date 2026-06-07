-- Import reports for card import normalization
CREATE TABLE IF NOT EXISTS import_reports (
    id                TEXT PRIMARY KEY,
    character_card_id TEXT REFERENCES character_cards(id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'pending',
    source_format     TEXT NOT NULL DEFAULT '',
    source_hash       TEXT NOT NULL DEFAULT '',
    report_json       TEXT NOT NULL DEFAULT '{}',
    package_json      TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_reports_card ON import_reports(character_card_id);
CREATE INDEX IF NOT EXISTS idx_import_reports_hash ON import_reports(source_hash);

-- Failed import samples for debugging
CREATE TABLE IF NOT EXISTS import_failure_samples (
    id            TEXT PRIMARY KEY,
    source_hash   TEXT NOT NULL,
    filename      TEXT NOT NULL DEFAULT '',
    raw_bytes     BLOB,
    report_json   TEXT NOT NULL DEFAULT '{}',
    user_notes    TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);
