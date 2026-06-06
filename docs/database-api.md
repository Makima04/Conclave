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
provider_configs (独立)
content_packs (独立，P3 预留)
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
| `config` | JSON 配置：`max_context_turns`、`stream`、`temperature`、`top_p`、`max_tokens`、`frequency_penalty`、`presence_penalty`、`system_prompt`、`master_model`、`sub_agent_model`、`compression_model`、`cooldown_turns`（默认 10）、`user_auto_mode`（默认 "ask"）、`max_active_agents`（默认 8）、`parser_enabled`（默认 true）、`user_persona`、`user_setting_merge_strategy`（`user_overrides_worldbook` 或 `worldbook_overrides_user`）。 |
| `current_turn` | 当前轮次号，每轮递增。 |
| `title_source` | `auto`（LLM 自动生成）或 `manual`（用户手动命名）。 |
| `status` | `idle` 或 `processing`。后端启动时自动重置残留的 `processing` 状态。 |

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
  "mode": "multi_agent"
}
```

响应 `200`：返回会话对象，包含默认 `config` 和 `status: "idle"`。

#### 获取会话列表

```text
GET /api/sessions?limit=20
```

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
| `turn_end` | `{"turn_number":N,"token_usage":{...}}` | 轮次结束。 |
| `error` | `{"code":"...","message":"..."}` | 错误。 |

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

---

### Agent 管理

#### 获取 Agent 列表

```text
GET /api/sessions/:id/agents
```

响应 `200`：`{ "items": [SubAgent] }`

#### 创建 Agent

```text
POST /api/sessions/:id/agents
```

```json
{
  "agent_type": "npc",
  "character_id": "merchant",
  "label": "酒馆老板",
  "system_prompt": "你是酒馆老板，热情好客..."
}
```

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

---

### 健康检查

```text
GET /api/health
```

---

## 数据迁移策略

- 当前使用内联迁移（`db.rs` 中的 `run_migrations`），运行 001-005 SQL 文件 + 条件 ALTER TABLE。
- 新增列使用 `pragma_table_info` 检查后条件添加，确保幂等。
- 后端启动时自动重置残留的 `processing` 会话状态。
- 迁移文件：`backend/migrations/001_initial.sql` ~ `005_structured_events.sql`。

---

## 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| JSON 字段缺乏数据库级约束 | 应用层 bug 可能写入格式错误的数据。 | 所有 JSON 字段在应用层使用 `serde` 校验。 |
| SQLite 并发写入限制 | 多实例写入可能冲突。 | WAL 模式 + 单实例部署；后续多人版切换 PostgreSQL。 |
| trace 和事件表无限增长 | 长会话后查询变慢。 | 按 session 分表查询，旧 trace 可归档。 |
