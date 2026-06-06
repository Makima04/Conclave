-- Add visibility column to memory_events and foreshadowing
-- for per-agent context isolation (public, gm_only, character:<id>, writer_only)

ALTER TABLE memory_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE foreshadowing ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
