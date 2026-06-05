-- P1 initial schema
-- Reference: docs/database-api.md

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL DEFAULT 'single_agent',
  character_pack_id TEXT,
  world_pack_id     TEXT,
  graph_pack_id     TEXT,
  config          TEXT NOT NULL DEFAULT '{}',
  current_turn    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  turn_number   INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_turn ON messages(session_id, turn_number);

CREATE TABLE IF NOT EXISTS state_snapshots (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  version       INTEGER NOT NULL,
  state_json    TEXT NOT NULL,
  risk_level    TEXT NOT NULL DEFAULT 'low',
  committed_by  TEXT NOT NULL DEFAULT 'runtime',
  proposal_id   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_session_version ON state_snapshots(session_id, version);

CREATE TABLE IF NOT EXISTS memory_events (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  turn_number         INTEGER NOT NULL,
  event_type          TEXT NOT NULL,
  content             TEXT NOT NULL,
  characters_involved TEXT NOT NULL DEFAULT '[]',
  location            TEXT,
  importance          TEXT NOT NULL DEFAULT 'normal',
  is_public           INTEGER NOT NULL DEFAULT 1,
  related_state_keys  TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_turn ON memory_events(session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_events_session_type ON memory_events(session_id, event_type);

CREATE TABLE IF NOT EXISTS foreshadowing (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  content           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  importance        TEXT NOT NULL DEFAULT 'normal',
  related_characters TEXT NOT NULL DEFAULT '[]',
  trigger_conditions TEXT NOT NULL DEFAULT '[]',
  resolution_plan   TEXT,
  planted_at_turn   INTEGER NOT NULL,
  last_hint_turn    INTEGER,
  resolved_at_turn  INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_foreshadow_session_status ON foreshadowing(session_id, status);

CREATE TABLE IF NOT EXISTS character_states (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  character_id      TEXT NOT NULL,
  personality_core  TEXT NOT NULL DEFAULT '{}',
  personality_state TEXT NOT NULL DEFAULT '{}',
  growth_arc        TEXT NOT NULL DEFAULT '{}',
  relationships     TEXT NOT NULL DEFAULT '{}',
  updated_at        TEXT NOT NULL,
  UNIQUE(session_id, character_id)
);

CREATE TABLE IF NOT EXISTS traces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  turn_number     INTEGER NOT NULL,
  node_id         TEXT NOT NULL,
  node_type       TEXT NOT NULL,
  agent_id        TEXT,
  input_summary   TEXT NOT NULL DEFAULT '',
  output_summary  TEXT NOT NULL DEFAULT '',
  output_type     TEXT,
  context_bundle  TEXT,
  model_config    TEXT NOT NULL DEFAULT '{}',
  token_usage     TEXT NOT NULL DEFAULT '{}',
  duration_ms     INTEGER,
  risk_level      TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_session_turn ON traces(session_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_traces_session_node ON traces(session_id, node_type);

CREATE TABLE IF NOT EXISTS turn_summaries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  turn_number     INTEGER NOT NULL,
  summary_type    TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_summaries_session_type ON turn_summaries(session_id, summary_type);

CREATE TABLE IF NOT EXISTS content_packs (
  id              TEXT PRIMARY KEY,
  pack_type       TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  author          TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  manifest_json   TEXT NOT NULL,
  storage_path    TEXT NOT NULL,
  imported_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_packs_type ON content_packs(pack_type);

CREATE TABLE IF NOT EXISTS provider_configs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
  base_url      TEXT NOT NULL,
  api_key       TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
