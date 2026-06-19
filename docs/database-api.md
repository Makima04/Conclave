# 数据库与 API 规范

> 定义平台核心数据模型和 HTTP API 契约。后端、前端、Runtime 和记忆系统共享同一套 schema，避免各模块自造临时结构。

`SQLite` · `API Contract` · `SSE` · `Data Model` · `Schema` · `Trace`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [长期记忆](long-context-memory.md)
- [Agent Runtime](agent-runtime.md)
- [动态总控架构](dynamic-master-architecture.md)

---

## 目标

- 为会话、消息、状态、记忆、trace 和子 Agent 提供统一数据模型。
- 定义后端 HTTP API 的路径、请求和响应格式。
- 确保数据模型能承载八层记忆、proposal + commit、多 Agent trace 和结构化事件召回。
- 当前使用 SQLite + WAL 模式，schema 设计兼容未来迁移到 PostgreSQL。

---

## 数据模型

### 设计原则

- 所有表使用 UUID 作为主键。
- 时间戳统一使用 ISO 8601 UTC 字符串（`TEXT`）。
- 结构化状态和复杂嵌套数据使用 JSON 字段（`TEXT`），应用层做 schema 校验。
- 软删除通过 `deleted_at` 字段。

### ER 关系概览

```text
sessions ──< messages
sessions ──< state_snapshots
sessions ──< memory_events
sessions ──< foreshadowing
sessions ──< character_states
sessions ──< traces
sessions ──< turn_summaries
sessions ──< sub_agents
sessions ──< structured_events
sessions ──< pending_proposals
sessions ──< turn_jobs
sessions ──< agent_call_debug_snapshots
sessions ──< presets (可选，session_id)
world_books ──< world_book_entries
world_books 1──1 character_cards
character_cards ──< import_reports
provider_configs (独立)
app_settings (独立，KV 配置)
import_failure_samples (独立，调试用)
agent_knowledge_events ── sessions
```

---

### sessions — 会话

```sql
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL DEFAULT 'single_agent',
  character_pack_id TEXT,
  world_pack_id     TEXT,
  graph_pack_id     TEXT,
  config          TEXT NOT NULL DEFAULT '{}',
  current_turn    INTEGER NOT NULL DEFAULT 0,
  title_source    TEXT NOT NULL DEFAULT 'auto',
  status          TEXT NOT NULL DEFAULT 'idle',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
```

| 字段 | 说明 |
|---|---|
| `mode` | `single_agent` 或 `multi_agent`（动态总控 4 层流水线）。 |
| `character_pack_id` | **已弃用**，预留字段，当前未使用。 |
| `graph_pack_id` | **已弃用**，预留字段，当前未使用。 |
| `config` | JSON 配置：`max_context_turns`、`stream`、`temperature`、`top_p`、`max_tokens`、`frequency_penalty`、`presence_penalty`、`system_prompt`、`master_model`、`sub_agent_model`、`compression_model`、`variable_tool_model`（变量工具模型）、`render_mode`（`auto`/`schema`/`sandbox`/`text`，默认 `auto`）、`active_preset_id`（可选，当前激活的 preset ID）、`cooldown_turns`（默认 10）、`user_auto_mode`（默认 "ask"）、`max_active_agents`（默认 8）、`parser_enabled`（默认 true）、`user_persona`（JSON 对象：`name`、`avatar`、`address`、`background`、`style`）、`user_setting_merge_strategy`（`user_overrides_worldbook` 或 `worldbook_overrides_user`）。 |
| `current_turn` | 当前轮次号，每轮递增。 |
| `title_source` | `auto`（LLM 自动生成）或 `manual`（用户手动命名）。 |
| `status` | `idle`、`processing`、`compressing`、`failed_generation`、`failed_compression`。后端启动时自动重置 `processing`/`compressing`/`failed_generation`/`failed_compression` 为 `idle`。 |

---

### messages — 消息

```sql
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  turn_number   INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  metadata      TEXT NOT NULL DEFAULT '{}',
  variants      TEXT NOT NULL DEFAULT '[]',
  variant_index INTEGER NOT NULL DEFAULT -1,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_messages_session_turn ON messages(session_id, turn_number);
```

| 字段 | 说明 |
|---|---|
| `role` | `user`、`assistant`、`system`。 |
| `variants` | JSON 数组，重新生成时保存历史版本内容。 |
| `variant_index` | 当前展示的变体索引，`-1` 表示使用最新版本（`content` 字段）。 |
| `artifact_refs` | JSON 数组，引用 artifact id 和版本（P3 预留）。 |
| `metadata` | JSON 对象，包含 LLM 模型名、token 用量等。 |

---

### state_snapshots — 结构化状态快照

```sql
CREATE TABLE state_snapshots (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  version       INTEGER NOT NULL,
  state_json    TEXT NOT NULL,
  risk_level    TEXT NOT NULL DEFAULT 'low',
  committed_by  TEXT NOT NULL DEFAULT 'runtime',
  proposal_id   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_state_session_version ON state_snapshots(session_id, version);
```

| 字段 | 说明 |
|---|---|
| `state_json` | 完整结构化状态 JSON（`world_state`、`characters`、`items`、`relationships` 等）。 |
| `risk_level` | `low`、`medium`、`high`。 |
| `committed_by` | `runtime`（自动）、`director`（审核后）、`user`（用户确认后）。 |

---

### memory_events — 事件账本

```sql
CREATE TABLE memory_events (
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
  visibility          TEXT NOT NULL DEFAULT 'public',
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_events_session_turn ON memory_events(session_id, turn_number);
CREATE INDEX idx_events_session_type ON memory_events(session_id, event_type);
```

| 字段 | 说明 |
|---|---|
| `event_type` | `action`、`dialogue`、`discovery`、`combat`、`state_change`、`world_event`、`system`。 |
| `importance` | `trivial`、`normal`、`important`、`critical`。 |
| `visibility` | `public`、`gm_only`、`character:<id>`、`writer_only`。用于上下文隔离。 |

---

### foreshadowing — 伏笔登记表

```sql
CREATE TABLE foreshadowing (
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
  visibility        TEXT NOT NULL DEFAULT 'public',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_foreshadow_session_status ON foreshadowing(session_id, status);
```

| 字段 | 说明 |
|---|---|
| `status` | `open`、`hinted`、`triggered`、`resolved`、`abandoned`。 |
| `visibility` | `public`、`gm_only`、`character:<id>`、`writer_only`。 |

---

### character_states — 角色人格状态

```sql
CREATE TABLE character_states (
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
```

---

### traces — 执行追踪

```sql
CREATE TABLE traces (
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

CREATE INDEX idx_traces_session_turn ON traces(session_id, turn_number);
CREATE INDEX idx_traces_session_node ON traces(session_id, node_type);
```

| 字段 | 说明 |
|---|---|
| `node_type` | `parser`、`master`、`user`、`npc`、`writer`、`state`、`director`。 |
| `token_usage` | JSON：`{"prompt_tokens":N,"completion_tokens":N}`。 |

---

### turn_summaries — 轮次摘要

```sql
CREATE TABLE turn_summaries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  turn_number     INTEGER NOT NULL,
  summary_type    TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_summaries_session_type ON turn_summaries(session_id, summary_type);
```

---

### sub_agents — Agent 管理

```sql
CREATE TABLE sub_agents (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  agent_type      TEXT NOT NULL,
  character_id    TEXT,
  label           TEXT NOT NULL DEFAULT '',
  system_prompt   TEXT NOT NULL DEFAULT '',
  context         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  last_active_turn INTEGER NOT NULL DEFAULT 0,
  cooldown_reason TEXT,
  config          TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_sub_agents_session ON sub_agents(session_id);
CREATE INDEX idx_sub_agents_session_status ON sub_agents(session_id, status);
```

| 字段 | 说明 |
|---|---|
| `agent_type` | `master`、`parser`、`user`、`npc`、`writer`、`director`、`state`。`user` 是固定 Actor Agent，每个 multi-agent 会话有且只有一个。 |
| `status` | `active`、`cooldown`、`retired`、`dead`。 |
| `config` | JSON：`max_context_turns`、`max_tokens`、`temperature`、`recall_mode`、`max_recall_events`。 |

---

### structured_events — 结构化事件（检索记忆）

```sql
CREATE TABLE structured_events (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  turn_number     INTEGER NOT NULL,
  characters      TEXT NOT NULL DEFAULT '[]',
  location        TEXT,
  action          TEXT NOT NULL DEFAULT '',
  scene_type      TEXT NOT NULL DEFAULT 'other',
  importance      INTEGER NOT NULL DEFAULT 3,
  raw_text        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  embedding       BLOB,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_structured_events_session_turn ON structured_events(session_id, turn_number);
CREATE INDEX idx_structured_events_session_location ON structured_events(session_id, location);
CREATE INDEX idx_structured_events_session_scene ON structured_events(session_id, scene_type);
CREATE INDEX idx_structured_events_hash ON structured_events(session_id, content_hash);
```

| 字段 | 说明 |
|---|---|
| `scene_type` | `encounter`、`dialogue`、`combat`、`travel`、`info`、`other`。 |
| `importance` | 1-5 级，5 最高。 |
| `content_hash` | 规范化文本哈希，用于精确去重。 |
| `embedding` | 可选 f32 小端向量，预留向量检索。 |

---

### pending_proposals — 待审核提案

```sql
CREATE TABLE pending_proposals (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  turn_number     INTEGER NOT NULL,
  proposed_by     TEXT NOT NULL,
  risk            TEXT NOT NULL,
  proposal_json   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  reviewed_by     TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX idx_proposals_session_status ON pending_proposals(session_id, status);
```

| 字段 | 说明 |
|---|---|
| `risk` | `low`、`medium`、`high`。 |
| `status` | `pending`、`approved`、`rejected`。 |
| `proposal_json` | 完整提案内容 JSON。 |

---

### provider_configs — LLM Provider 配置

```sql
CREATE TABLE provider_configs (
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
```

---

### agent_knowledge_events — Agent 认知事件

```sql
CREATE TABLE agent_knowledge_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  turn_number INTEGER NOT NULL,
  fact        TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'narration',
  actors      TEXT NOT NULL DEFAULT '[]',
  targets     TEXT NOT NULL DEFAULT '[]',
  observers   TEXT NOT NULL DEFAULT '[]',
  knowers     TEXT NOT NULL DEFAULT '[]',
  visibility  TEXT NOT NULL DEFAULT 'writer_only',
  confidence  REAL NOT NULL DEFAULT 0.5,
  evidence    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
```

| 字段 | 说明 |
|---|---|
| `fact` | 被抽取出的事实。 |
| `source_type` | `speech`、`action`、`visual_observation`、`inner_monologue`、`narration`、`inference`。 |
| `knowers` | JSON 数组，知道该事实的 Actor 名称或 character_id。 |
| `visibility` | `public`、`private`、`observed_by`、`told_to`、`writer_only`。 |
| `confidence` | 0-1 置信度。 |
| `evidence` | 简短证据文本。 |

> 注：`agent_knowledge_events` 表无公开 API 端点，仅由 Runtime 内部写入，通过上下文构建（`build_context`）注入 Agent prompt。

---

### world_books — 世界书

```sql
CREATE TABLE world_books (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  original_format TEXT NOT NULL,
  source_data     TEXT NOT NULL,
  parse_status    TEXT NOT NULL DEFAULT 'none',
  parsed_entries  TEXT NOT NULL DEFAULT '[]',
  single_agent_parse_status TEXT NOT NULL DEFAULT 'none',
  single_agent_parsed_entries TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

| 字段 | 说明 |
|---|---|
| `original_format` | `ccv2`（Character Card V2/V3）或 `sillytavern`。 |
| `source_data` | 原始导入 JSON 文本。 |
| `parse_status` | `none`、`parsing`、`done`、`error`。LLM 分类多 Agent 条目的状态。 |
| `parsed_entries` | JSON 数组，LLM 解析后的多 Agent 条目（含 `category`、`visibility`、`reason`，并透传 ST 激活字段 `constant`/`keys`/`selective`/`secondary_keys`/`selective_logic` + 原始 `priority`）。解析器只决定**路由**，激活（是否注入）由运行时 `is_entry_activated`（context.rs）按 ST 语义判断。 |
| `single_agent_parse_status` | 单 Agent 路由解析状态，值同 `parse_status`。 |
| `single_agent_parsed_entries` | JSON 数组，单 Agent 路由解析后的条目（字段同 `parsed_entries`）。 |

---

### world_book_entries — 世界书条目

```sql
CREATE TABLE world_book_entries (
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

CREATE INDEX idx_wb_entries_book ON world_book_entries(world_book_id);
```

| 字段 | 说明 |
|---|---|
| `keys` | JSON 数组，触发关键词列表。 |
| `constant` | 0/1，是否始终注入。 |
| `priority` | 优先级，数值越大越优先。 |
| `position` | 插入位置：`before_char`、`after_char`、`@D`、`@A` 等 SillyTavern 标准位。 |
| `selective` | 0/1，是否需要同时匹配 `secondary_keys`。 |
| `selective_logic` | 0 = AND ANY，1 = NOT ALL，2 = NOT ANY，3 = AND ALL（SillyTavern 标准）。运行时 `is_entry_activated` 按此组合 `secondary_keys`。 |

---

### character_cards — 角色卡

```sql
CREATE TABLE character_cards (
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

CREATE INDEX idx_cc_wb ON character_cards(world_book_id);
```

| 字段 | 说明 |
|---|---|
| `world_book_id` | 1:1 关联 `world_books`，角色卡的世界书条目存在 `world_book_entries` 中。 |
| `spec` | CCv2/CCv3 规范版本标识。 |
| `source_data` | 原始导入 JSON。 |
| `tags` | JSON 数组。 |
| `alternate_greetings` | JSON 数组，可选开场白。 |
| `extensions` | JSON 对象，CCv2 扩展字段。 |

---

### presets — 预设

```sql
CREATE TABLE presets (
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

CREATE INDEX idx_presets_session ON presets(session_id);
```

| 字段 | 说明 |
|---|---|
| `session_id` | 可选，关联到特定会话的预设。 |
| `source_format` | 导入来源格式，默认 `sillytavern`。 |
| `raw_json` | 原始导入 JSON。 |
| `model_params` | JSON 对象，模型采样参数覆盖。 |
| `parse_status` | `none`、`parsing`、`done`、`error`。LLM 模块分类状态。 |

---

### preset_modules — 预设模块

```sql
CREATE TABLE preset_modules (
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

CREATE INDEX idx_preset_modules_preset ON preset_modules(preset_id);
```

| 字段 | 说明 |
|---|---|
| `identifier` | 模块标识符（原始预设中的 key）。 |
| `role` | `system` 或 `user`。 |
| `target_agents` | JSON 数组，该模块应注入的 Agent 类型列表（如 `["npc", "writer"]`）。 |
| `injection_order` | 注入顺序，数值越小越靠前。 |
| `classification` | LLM 分类结果：`rule`、`jailbreak`、`impersonation`、`narrative`、`other`。 |

---

### import_reports — 导入报告

```sql
CREATE TABLE import_reports (
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

CREATE INDEX idx_import_reports_card ON import_reports(character_card_id);
CREATE INDEX idx_import_reports_hash ON import_reports(source_hash);
```

| 字段 | 说明 |
|---|---|
| `status` | `success`、`warning`、`fallback`、`blocked`。 |
| `report_json` | JSON 对象，完整导入诊断报告（阶段状态、规则追踪、诊断信息）。 |
| `package_json` | JSON 对象，生成的 Conclave 卡包数据。 |

---

### import_failure_samples — 导入失败样本

```sql
CREATE TABLE import_failure_samples (
  id            TEXT PRIMARY KEY,
  source_hash   TEXT NOT NULL,
  filename      TEXT NOT NULL DEFAULT '',
  raw_bytes     BLOB,
  report_json   TEXT NOT NULL DEFAULT '{}',
  user_notes    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
```

> 调试用途表，无公开 API（通过 `/api/charactercards/import/{import_id}/save-failure` 写入）。

---

### app_settings — 应用设置

```sql
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

| 字段 | 说明 |
|---|---|
| `key` | 设置键名，如 `llm_concurrency_limit`。 |
| `value` | 设置值，JSON 或纯文本字符串。 |

---

### turn_jobs — 后台任务队列

```sql
CREATE TABLE turn_jobs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  turn_number INTEGER NOT NULL,
  job_type    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  payload     TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_turn_jobs_status ON turn_jobs(status);
CREATE INDEX idx_turn_jobs_session ON turn_jobs(session_id, turn_number);
```

| 字段 | 说明 |
|---|---|
| `job_type` | `compression`（首次压缩）或 `recompression`（编辑后重压缩）。 |
| `status` | `pending`、`running`、`completed`、`failed`。 |
| `attempts` | 已重试次数。 |

---

### agent_call_debug_snapshots — Agent 调试快照

```sql
CREATE TABLE agent_call_debug_snapshots (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number            INTEGER NOT NULL,
  phase                  TEXT NOT NULL DEFAULT 'sub_agent',
  level_index            INTEGER,
  agent_id               TEXT,
  agent_type             TEXT NOT NULL DEFAULT '',
  agent_label            TEXT NOT NULL DEFAULT '',
  model                  TEXT NOT NULL DEFAULT '',
  task                   TEXT NOT NULL DEFAULT '',
  system_prompt          TEXT NOT NULL DEFAULT '',
  user_prompt            TEXT NOT NULL DEFAULT '',
  injected_from_json     TEXT NOT NULL DEFAULT '[]',
  injected_outputs_json  TEXT NOT NULL DEFAULT '[]',
  preset_modules_json    TEXT NOT NULL DEFAULT '[]',
  worldbook_entries_json TEXT NOT NULL DEFAULT '[]',
  recent_messages_json   TEXT NOT NULL DEFAULT '[]',
  recalled_events_json   TEXT NOT NULL DEFAULT '[]',
  state_slice_json       TEXT NOT NULL DEFAULT '{}',
  raw_output             TEXT NOT NULL DEFAULT '',
  tool_calls_json        TEXT NOT NULL DEFAULT '[]',
  duration_ms            INTEGER,
  prompt_tokens          INTEGER NOT NULL DEFAULT 0,
  completion_tokens      INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL
);

CREATE INDEX idx_agent_debug_session_turn
  ON agent_call_debug_snapshots(session_id, turn_number, created_at);
CREATE INDEX idx_agent_debug_agent
  ON agent_call_debug_snapshots(session_id, agent_id, turn_number);
```

| 字段 | 说明 |
|---|---|
| `phase` | `sub_agent`、`master`、`state`、`parser`、`director`、`variable_tool` 等执行阶段。 |
| `level_index` | DAG 执行层级，同层并行。 |
| `injected_from_json` | JSON 数组，注入了哪些上游 Agent 输出。 |
| `preset_modules_json` | JSON 数组，注入的预设模块列表。 |
| `worldbook_entries_json` | JSON 数组，注入的世界书条目。 |
| `tool_calls_json` | JSON 数组，LLM 工具调用记录。 |

---

## API 规范

### 通用约定

- 基础路径：`/api`
- 请求和响应统一 JSON（SSE 流式端点除外）
- 时间字段使用 ISO 8601 UTC
- ID 字段使用 UUID v4
- 列表端点使用 `?limit=<n>` 分页

### 统一错误响应

```json
{
  "error": {
    "code": "not_found",
    "message": "资源不存在"
  }
}
```

| HTTP 状态码 | code | 场景 |
|---|---|---|
| 400 | `bad_request` | 请求参数校验失败。 |
| 404 | `not_found` | 资源不存在。 |
| 500 | `database_error` | 数据库错误。 |
| 502 | `provider_error` | LLM Provider 调用失败。 |
| 500 | `internal_error` | 其他内部错误。 |

---

### 会话

#### 创建会话

```text
POST /api/sessions
```

```json
{
  "title": "旧档案馆之夜",
  "mode": "multi_agent",
  "world_pack_id": "uuid-of-world-book",
  "config": { "temperature": 0.8, "render_mode": "sandbox" }
}
```

响应 `200`：返回会话对象，包含默认 `config` 和 `status: "idle"`。

- `world_pack_id`：可选，关联世界书。设置后自动使用该世界书的条目和角色卡。
- `config`：可选，`SessionConfig` 对象，未提供的字段使用全局默认值。

#### 获取会话列表

```text
GET /api/sessions?limit=20&world_pack_id=uuid
```

- `limit`：可选，分页大小。
- `world_pack_id`：可选，按关联世界书过滤。

响应 `200`：`{ "items": [SessionResponse] }`

#### 获取单个会话

```text
GET /api/sessions/:id
```

#### 更新会话

```text
PATCH /api/sessions/:id
```

```json
{
  "title": "新标题",
  "config": { "temperature": 0.9 }
}
```

手动设置 `title` 时自动将 `title_source` 改为 `"manual"`。

#### 删除会话

```text
DELETE /api/sessions/:id
```

软删除，设置 `deleted_at`。

---

### 消息

#### 发送消息（触发 Runtime）

```text
POST /api/sessions/:id/messages
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "content": "我推开档案馆的木门，手里紧握银钥匙。",
  "stream": true
}
```

响应为 SSE 流，同时返回用户消息和 Runtime 执行过程。

**SSE 事件类型：**

| 事件 | 数据 | 说明 |
|---|---|---|
| `turn_start` | `{"turn_number": N}` | 新轮次开始。 |
| `agent_status` | `{"agent_type":"parser","label":"解析器","status":"working"}` | Agent 开始/结束工作。`status` 为 `working` 或 `done`。 |
| `message_delta` | `{"content":"推开门的瞬间..."}` | 最终叙事文本的增量推送。 |
| `memory_start` | `{"turn_number": N}` | 记忆压缩阶段开始（Runtime 收到最终回复后触发）。 |
| `state_update` | `{"turn_number": N, "status":"done"}` | 结构化状态更新完成。`status` 为 `done` 或 `error`。 |
| `turn_ready` | `{"turn_number": N}` | 轮次所有后处理完成，前端可刷新数据。 |
| `turn_end` | `{"turn_number": N, "message_content":"..."}` | 轮次结束，`message_content` 为最终完整回复文本。 |
| `stream_error` | `{"error":"错误描述"}` | 流式过程中的错误。 |

#### SSE 重连

```text
GET /api/sessions/:id/reconnect
Accept: text/event-stream
```

当用户在 turn 进行中退出再重新进入会话时，通过此端点重新订阅活跃 turn 的事件流。

- `200`：有活跃 turn，返回 SSE 流（`agent_status` + `message_delta` 事件），turn 结束时发 `turn_end`。
- `404`：无活跃 turn，客户端应直接拉取消息列表。

#### 获取消息列表

```text
GET /api/sessions/:id/messages
```

#### 编辑消息

```text
PUT /api/sessions/:id/messages/:msg_id
```

```json
{ "content": "修改后的消息内容" }
```

#### 删除消息

```text
DELETE /api/sessions/:id/messages/:msg_id
```

#### 重新生成回复

```text
POST /api/sessions/:id/messages/:msg_id/regenerate
```

将当前回复推入 `variants`，重新调用 LLM 生成新回复。

#### 切换变体

```text
PUT /api/sessions/:id/messages/:msg_id/switch_variant
```

```json
{ "index": 0 }
```

#### 应用开场白

```text
POST /api/sessions/:id/opening
```

```json
{ "content": "这是开场白文本" }
```

写入一条 `role: "system"` 的开场白消息。前端角色卡使用 `first_mes` 或 `alternate_greetings` 时调用。

#### 安静生成（不触发 SSE 流）

```text
POST /api/sessions/:id/quiet-generate
```

非流式 LLM 调用，用于后台任务（如标题生成、世界书解析辅助）。返回 JSON 而非 SSE 流。

#### 更新会话变量

```text
PUT /api/sessions/:id/variables
```

```json
{ "hp": 100, "location": "tavern" }
```

直接写入结构化状态中的变量，同步更新 `state_snapshots` 和角色卡变量。

#### 更新消息 metadata

```text
PUT /api/sessions/:id/messages/:msg_id/metadata
```

```json
{ "model": "gpt-4o", "custom_key": "value" }
```

部分更新消息的 `metadata` JSON 字段。

---

### Agent 管理

#### 获取 Agent 列表

```text
GET /api/sessions/:id/agents
```

响应 `200`：`{ "items": [AgentResponse] }`

`AgentResponse` 字段：`id`、`session_id`、`agent_type`、`character_id`、`label`、`status`、`last_active_turn`、`context`（完整上下文文本）、`context_preview`（截断到 100 字符）、`config`（JSON 对象）、`fixed`（bool，`user` 类型 Agent 固定为 true，不可删除）。

#### 创建 Agent

```text
POST /api/sessions/:id/agents
```

```json
{
  "agent_type": "npc",
  "character_id": "merchant",
  "label": "酒馆老板",
  "context": "你是酒馆老板，热情好客，知道很多小道消息...",
  "system_prompt": "你是酒馆老板，热情好客..."
}
```

- `context`：可选，Agent 的角色上下文描述（注入到 prompt）。
- `system_prompt`：可选，自定义 system prompt（留空使用默认模板）。
- `model`：可选，覆盖该 Agent 使用的模型。

#### 更新 Agent

```text
PUT /api/sessions/:id/agents/:aid
```

#### 冷却 Agent

```text
POST /api/sessions/:id/agents/:aid/cooldown
```

#### 恢复 Agent

```text
POST /api/sessions/:id/agents/:aid/restore
```

#### 删除 Agent

```text
DELETE /api/sessions/:id/agents/:aid
```

---

### 结构化状态

#### 获取当前状态

```text
GET /api/sessions/:id/state
```

---

### 记忆

#### 事件账本

```text
GET /api/sessions/:id/memory/events
```

#### 伏笔登记表

```text
GET /api/sessions/:id/memory/foreshadowing
```

---

### Trace

#### 获取轮次 trace 列表

```text
GET /api/sessions/:id/trace/:turn_number
```

---

### Proposals

#### 获取提案列表

```text
GET /api/sessions/:id/proposals
```

#### 批准提案

```text
POST /api/sessions/:id/proposals/:pid/approve
```

#### 拒绝提案

```text
POST /api/sessions/:id/proposals/:pid/reject
```

---

### Provider

#### 获取 Provider 列表

```text
GET /api/providers
```

#### 创建 Provider

```text
POST /api/providers
```

```json
{
  "name": "OpenAI",
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxx",
  "model": "gpt-4o",
  "is_default": true
}
```

#### 获取单个 Provider

```text
GET /api/providers/:id
```

#### 更新 Provider

```text
PUT /api/providers/:id
```

#### 删除 Provider

```text
DELETE /api/providers/:id
```

#### 获取可用模型列表

```text
POST /api/providers/fetch-models
```

```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxx"
}
```

响应 `200`：`{ "models": ["gpt-4o", "gpt-4o-mini"] }`

> **安全说明**：Provider 响应中 `api_key` 字段被替换为 `api_key_set: bool`，表示是否已配置密钥，不暴露明文。

---

### 世界书

#### 获取世界书列表

```text
GET /api/worldbooks
```

响应 `200`：`{ "items": [WorldBookSummary] }`

#### 导入世界书

```text
POST /api/worldbooks
```

```json
{
  "data": { "character_book": { "entries": [...] }, "name": "..." }
}
```

支持 SillyTavern 原生格式和 Character Card V2/V3 格式。响应 `200`：返回完整 `WorldBookDetail`。

#### 获取世界书详情

```text
GET /api/worldbooks/:id
```

响应包含 `entries`（原始条目）、`parsed_entries`（多 Agent 解析结果）、`single_agent_parsed_entries`、`has_character_card`、`character_card_id`。

#### 更新世界书

```text
PATCH /api/worldbooks/:id
```

```json
{ "name": "新名称", "description": "新描述" }
```

#### 删除世界书

```text
DELETE /api/worldbooks/:id
```

#### 导出世界书

```text
GET /api/worldbooks/:id/export
```

#### 解析世界书（多 Agent）

```text
POST /api/worldbooks/:id/parse
```

触发 LLM 对条目进行分类（NPC/用户/全局等），结果存入 `parsed_entries`。

#### 解析世界书（单 Agent 路由）

```text
POST /api/worldbooks/:id/parse-single-agent
```

#### 获取世界书关联的角色卡

```text
GET /api/worldbooks/:id/character-card
```

#### 更新世界书条目

```text
PUT /api/worldbooks/:id/entries/:entry_id
```

#### 删除世界书条目

```text
DELETE /api/worldbooks/:id/entries/:entry_id
```

---

### 角色卡

#### 获取角色卡列表

```text
GET /api/charactercards
```

响应 `200`：`{ "items": [{ "id", "name", "creator", "created_at" }] }`

#### 获取单个角色卡

```text
GET /api/charactercards/:id
```

响应 `200`：`CharacterCardResponse`，自动附带最新的 `conclave_package` 和 `import_report`。

#### 更新角色卡

```text
PATCH /api/charactercards/:id
```

可更新字段：`name`、`description`、`personality`、`scenario`、`first_mes`、`system_prompt`、`post_history_instructions`、`creator_notes`、`mes_example`。

---

### 角色卡导入

#### 发起导入

```text
POST /api/charactercards/import
```

```json
{
  "file_bytes": "base64...",
  "filename": "character.png",
  "source_format": "png_ccv3"
}
```

响应 `200`：`{ "import_id": "uuid", "package_draft": {...}, "import_report": {...} }`

#### 确认导入

```text
POST /api/charactercards/import/:import_id/confirm
```

```json
{ "degrade_to_schema": false }
```

将内存中的导入草稿持久化到数据库（创建 `world_books`、`character_cards`、`import_reports`）。

#### 重新导入已有角色卡

```text
POST /api/charactercards/:id/run-import
```

对已有角色卡重新执行导入流程。

#### LLM 辅助

```text
POST /api/charactercards/import/:import_id/llm-assist
```

请求 LLM 对导入中的待分类字段提供分类建议。

#### 获取导入报告

```text
GET /api/charactercards/import/:import_id/report
```

#### 原始预览

```text
POST /api/charactercards/import/:import_id/raw-preview
```

#### 保存失败样本

```text
POST /api/charactercards/import/:import_id/save-failure
```

---

### 预设

#### 获取预设列表

```text
GET /api/presets?session_id=uuid
```

`session_id` 可选，过滤特定会话的预设。响应 `200`：`{ "items": [PresetSummary] }`

#### 导入预设

```text
POST /api/presets
```

```json
{
  "data": { "injection_prompts": [...], "model_params": {...} },
  "session_id": "uuid-or-null",
  "file_name": "preset.json"
}
```

#### 获取预设详情

```text
GET /api/presets/:id
```

响应包含 `modules`（模块列表）和 `model_params`。

#### 更新预设

```text
PATCH /api/presets/:id
```

```json
{ "name": "新名称" }
```

#### 删除预设

```text
DELETE /api/presets/:id
```

#### 解析预设模块

```text
POST /api/presets/:id/parse
```

触发 LLM 对模块进行分类（target_agents 分配）。

#### 更新预设模块

```text
PUT /api/presets/:id/modules/:mid
```

#### 删除预设模块

```text
DELETE /api/presets/:id/modules/:mid
```

---

### 运行时设置

#### 获取运行时设置

```text
GET /api/settings/runtime
```

响应 `200`：`{ "llm_concurrency_limit": 4 }`

#### 更新运行时设置

```text
PUT /api/settings/runtime
```

```json
{ "llm_concurrency_limit": 8 }
```

---

### 调试

#### 获取会话调试概览

```text
GET /api/sessions/:id/debug
```

响应 `200`：

```json
{
  "messages": [{ "id", "turn_number", "role", "content", "created_at" }],
  "turns": [{ "turn_number", "call_count", "agent_count", "total_prompt_tokens", "total_completion_tokens", "total_duration_ms" }]
}
```

#### 获取轮次调试详情

```text
GET /api/sessions/:id/debug/:turn
```

响应 `200`：`{ "items": [AgentCallDebugSnapshot] }`，包含每轮所有 Agent 调用的完整快照（system_prompt、user_prompt、注入上下文、raw_output、tool_calls 等）。

---

### 健康检查

```text
GET /api/health
```

---

## 数据迁移策略

- 当前使用内联迁移（`db.rs` 中的 `run_migrations`），运行 001-015 SQL 文件 + 条件 ALTER TABLE。
- 新增列使用 `pragma_table_info` 检查后条件添加，确保幂等。
- 后端启动时自动重置残留的 `processing`/`compressing`/`failed_generation`/`failed_compression` 会话状态为 `idle`。
- 迁移文件：`backend/migrations/001_initial.sql` ~ `015_agent_debug_snapshots.sql`。
- 迁移文件编号：001（initial）、002（variants）、003（proposals）、004（sub_agents）、005（structured_events）、006（visibility）、007（session_status）、008（world_books）、009（concurrency_reliability）、010（character_cards）、011（presets）、012（agent_knowledge）、013（card_import）、014（app_settings）、015（agent_debug_snapshots）。

---

## 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| JSON 字段缺乏数据库级约束 | 应用层 bug 可能写入格式错误的数据。 | 所有 JSON 字段在应用层使用 `serde` 校验。 |
| SQLite 并发写入限制 | 多实例写入可能冲突。 | WAL 模式 + 单实例部署；后续多人版切换 PostgreSQL。 |
| trace 和事件表无限增长 | 长会话后查询变慢。 | 按 session 分表查询，旧 trace 可归档。 |
