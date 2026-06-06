-- Character cards table: stores CCv2/v3 character card metadata
-- Linked 1:1 with world_books (the character_book entries live in world_book_entries)
CREATE TABLE IF NOT EXISTS character_cards (
    id                        TEXT PRIMARY KEY,
    world_book_id             TEXT NOT NULL UNIQUE REFERENCES world_books(id) ON DELETE CASCADE,
    name                      TEXT NOT NULL DEFAULT '',
    description               TEXT NOT NULL DEFAULT '',
    personality               TEXT NOT NULL DEFAULT '',
    scenario                  TEXT NOT NULL DEFAULT '',
    first_mes                 TEXT NOT NULL DEFAULT '',
    avatar                    TEXT NOT NULL DEFAULT 'none',
    creator                   TEXT NOT NULL DEFAULT '',
    character_version         TEXT NOT NULL DEFAULT '',
    tags                      TEXT NOT NULL DEFAULT '[]',
    alternate_greetings       TEXT NOT NULL DEFAULT '[]',
    system_prompt             TEXT NOT NULL DEFAULT '',
    post_history_instructions TEXT NOT NULL DEFAULT '',
    creator_notes             TEXT NOT NULL DEFAULT '',
    mes_example               TEXT NOT NULL DEFAULT '',
    extensions                TEXT NOT NULL DEFAULT '{}',
    spec                      TEXT NOT NULL DEFAULT 'chara_card_v2',
    source_data               TEXT NOT NULL DEFAULT '{}',
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cc_wb ON character_cards(world_book_id);
