CREATE TABLE IF NOT EXISTS world_books (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    original_format TEXT NOT NULL,
    source_data     TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_book_entries (
    id              TEXT PRIMARY KEY,
    world_book_id   TEXT NOT NULL REFERENCES world_books(id) ON DELETE CASCADE,
    keys            TEXT NOT NULL DEFAULT '[]',
    content         TEXT NOT NULL DEFAULT '',
    comment         TEXT NOT NULL DEFAULT '',
    constant        INTEGER NOT NULL DEFAULT 0,
    priority        INTEGER NOT NULL DEFAULT 100,
    enabled         INTEGER NOT NULL DEFAULT 1,
    position        TEXT NOT NULL DEFAULT 'before_char',
    selective       INTEGER NOT NULL DEFAULT 0,
    secondary_keys  TEXT NOT NULL DEFAULT '[]',
    selective_logic INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wb_entries_book ON world_book_entries(world_book_id);
