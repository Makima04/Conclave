# 数据库与 API 规范

> 定义平台核心数据模型和 HTTP API 契约。后端、前端、Runtime 和记忆系统共享同一套 schema，避免各模块自造临时结构。

`SQLite` · `API Contract` · `SSE` · `Data Model` · `Schema` · `Trace`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [长期记忆](long-context-memory.md)
- [Agent Runtime](agent-runtime.md)
- [Agent 边界](agent-boundaries.md)
- [技术选型](tech-selection.md)

---

## 目标

- 为会话、消息、状态、记忆、trace 和 artifact 提供统一数据模型。
- 定义后端 HTTP API 的路径、请求和响应格式，作为前后端和 Runtime 的共同契约。
- 确保数据模型能承载八层记忆、proposal + commit、多 Agent trace 和 artifact 版本管理。
- V1 使用 SQLite，schema 设计兼容未来迁移到 PostgreSQL。

---

## 数据模型

### 设计原则

- 所有表使用 UUID 作为主键，避免分布式部署时冲突。
- 时间戳统一使用 ISO 8601 UTC 字符串（`TEXT`），前端按用户时区展示。
- 结构化状态和复杂嵌套数据使用 JSON 字段（SQLite 的 `TEXT` 存储 JSON），应用层做 schema 校验。
- 变更历史和 trace 不做物理删除，通过 `deleted_at` 或状态字段软删除。

### ER 关系概览

```text
sessions ──< messages
sessions ──< state_snapshots
sessions ──< memory_events
sessions ──< foreshadowing
sessions ──< character_states
sessions ──< traces
sessions ──< artifacts
sessions ──< turn_summaries
content_packs (独立，被 sessions 引用)
```

---

### sessions — 会话

一个会话对应一次持续的 RP 或写作活动，绑定角色、世界和 Agent 图。

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
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
```

| 字段 | 说明 |
|---|---|
| `mode` | 运行模式：`single_agent`、`strict_director`、`collaborative_director`、`free_writing`、`multi_npc_scene`、`advanced_graph`。 |
| `character_pack_id` | 引用 `content_packs.id`，当前绑定的角色包。 |
| `world_pack_id` | 引用 `content_packs.id`，当前绑定的世界包。 |
| `graph_pack_id` | 引用 `content_packs.id`，高级模式下的自定义 Agent Graph 包。 |
| `config` | 会话级配置 JSON：模型选择、温度、token 预算、导演强度等。 |
| `current_turn` | 当前轮次号，每轮递增，用于消息、事件和 trace 关联。 |

---

### messages — 消息

每条消息对应一轮对话中的一个角色发言或系统事件。

```sql
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  turn_number   INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_messages_session_turn ON messages(session_id, turn_number);
```

| 字段 | 说明 |
|---|---|
| `role` | `user`、`assistant`、`npc:<character_id>`、`director`、`system`。 |
| `artifact_refs` | JSON 数组，引用本轮涉及的 artifact id 和版本：`[{"artifact_id":"...","version":3}]`。 |
| `metadata` | JSON 对象，包含 LLM 模型名、token 用量、渲染提示等。 |

---

### state_snapshots — 结构化状态快照

结构化状态是长期一致性的主账本。每次提交生成新版本，保留历史。

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
| `state_json` | 完整结构化状态 JSON，包含 `world_state`、`characters`、`items`、`relationships`、`tasks` 等。 |
| `risk_level` | `low`、`medium`、`high`。参照 [Agent Runtime — 状态提交与风险等级](agent-runtime.md)。 |
| `committed_by` | 提交者：`runtime`（自动）、`director`（导演审核后）、`user`（用户确认后）。 |
| `proposal_id` | 关联触发本次提交的 proposal trace id。 |

#### state_json 结构草案

```json
{
  "world_state": {
    "current_time": "第三纪元·血月前夜",
    "current_location": "旧档案馆",
    "global_flags": {}
  },
  "characters": {
    "player": {
      "location": "旧档案馆",
      "status": "alive",
      "inventory": ["silver_key", "old_journal"],
      "relationships": {},
      "known_info": ["blood_moon_rumor"]
    },
    "archivist": {
      "location": "旧档案馆",
      "status": "alive",
      "inventory": [],
      "relationships": { "player": { "trust": 0.42 } },
      "known_info": ["archive_secret"],
      "hidden_info": ["blood_moon_key_location"]
    }
  },
  "active_quests": [],
  "global_flags": {}
}
```

---

### memory_events — 事件账本

关键事件按时间线入账，记录发生了什么、谁参与、影响了哪些状态。

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
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_events_session_turn ON memory_events(session_id, turn_number);
CREATE INDEX idx_events_session_type ON memory_events(session_id, event_type);
```

| 字段 | 说明 |
|---|---|
| `event_type` | `action`、`dialogue`、`discovery`、`combat`、`state_change`、`world_event`、`system`。 |
| `characters_involved` | JSON 数组：`["player", "archivist"]`。 |
| `importance` | `trivial`、`normal`、`important`、`critical`。影响检索优先级和摘要保留。 |
| `is_public` | 1 = 公开事件，0 = 隐藏事件（如秘密对话、暗中行动）。 |
| `related_state_keys` | JSON 数组，本次事件影响的结构化状态路径：`["characters.player.inventory", "characters.archivist.relationships.player.trust"]`。 |

---

### foreshadowing — 伏笔登记表

管理伏笔、谜团、承诺、隐藏秘密和未来回收点。

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
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_foreshadow_session_status ON foreshadowing(session_id, status);
```

| 字段 | 说明 |
|---|---|
| `status` | `open`、`hinted`、`triggered`、`resolved`、`abandoned`。 |
| `importance` | `low`、`normal`、`high`、`critical`。 |
| `trigger_conditions` | JSON 数组，触发回收的条件描述：`["player_visits_old_archive", "blood_moon_event_near"]`。 |
| `resolution_plan` | 创作者或导演的回收计划，可为空。 |

---

### character_states — 角色人格状态

维护每个角色的人格核心、可演化状态和成长轨迹。

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

| 字段 | JSON 结构 | 说明 |
|---|---|---|
| `personality_core` | `PersonalityCore` | 稳定人格：价值观、核心恐惧、长期欲望、知识边界、OOC 红线。参照 [长期记忆 — 角色成长](long-context-memory.md)。 |
| `personality_state` | `PersonalityState` | 可演化状态：当前情绪、短期信念、行为倾向、信任、警惕。 |
| `growth_arc` | `GrowthArc` | 成长方向、阶段、触发事件、允许变化范围、证据链。 |
| `relationships` | `RelationshipMap` | 与其他角色的关系状态：信任、好感、恐惧、敌意等数值和历史。 |

#### personality_core 示例

```json
{
  "values": ["knowledge_preservation", "loyalty_to_institution"],
  "fears": ["loss_of_memory", "being_forgotten"],
  "desires": ["uncover_blood_moon_truth"],
  "knowledge_boundary": ["archive_layout", "ancient_scripts", "blood_moon_partial"],
  "ooc_redlines": ["sudden_betrayal_without_cause", "casual_violence"]
}
```

---

### traces — 执行追踪

每次 Runtime 执行路径的完整记录。参照 [Agent Runtime — Trace](agent-runtime.md)。

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
| `node_id` | 图中节点实例 id，同一轮可有多个同类节点。 |
| `node_type` | `director`、`world_judge`、`npc`、`writer`、`memory`、`consistency`、`artifact`、`tool`。 |
| `agent_id` | 具体 Agent 标识，如 `npc_archivist`。 |
| `output_type` | 结构化输出类型：`plan_result`、`judge_result`、`npc_intent`、`writer_draft`、`memory_proposal`、`state_change_proposal`、`artifact_patch`。 |
| `context_bundle` | 该节点收到的 `ContextBundle` JSON，用于回溯信息可见性。 |
| `model_config` | JSON：`{"model":"...","temperature":0.7,"max_tokens":2048}`。 |
| `token_usage` | JSON：`{"prompt_tokens":1200,"completion_tokens":800}`。 |
| `risk_level` | 该节点输出的风险等级，用于 proposal + commit 决策。 |

---

### artifacts — Artifact 存储

Artifact 的内容和版本管理。参照 [Artifact Renderer](artifact-renderer.md)（待补）。

```sql
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  artifact_type   TEXT NOT NULL,
  schema_version  TEXT NOT NULL DEFAULT '1',
  content_hash    TEXT NOT NULL,
  payload         TEXT NOT NULL,
  parent_version  INTEGER,
  patch_type      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_artifacts_session ON artifacts(session_id);
CREATE UNIQUE INDEX idx_artifacts_id_version ON artifacts(id, content_hash);
```

| 字段 | 说明 |
|---|---|
| `artifact_type` | `data_ui`、`themed_component`、`custom_html`。对应三层渲染模型。 |
| `payload` | Artifact 内容 JSON，根据 `artifact_type` 结构不同。 |
| `parent_version` | 增量更新时指向父版本，首版为 NULL。 |
| `patch_type` | `full`（全量）、`state_diff`、`json_patch`、`props`。 |

---

### turn_summaries — 轮次摘要

每轮结束后生成的摘要，用于 Scene Summary 和 Chapter Summary 层。

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

| 字段 | 说明 |
|---|---|
| `summary_type` | `scene`（场景摘要）、`chapter`（章节摘要）、`turn`（单轮摘要）。 |

---

### content_packs — 已导入内容包

记录导入平台的角色包、世界包、Agent Graph 包和插件包。详细内容包规范参见 [内容包规范](content-packages.md)（待补）。

```sql
CREATE TABLE content_packs (
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

CREATE INDEX idx_packs_type ON content_packs(pack_type);
```

| 字段 | 说明 |
|---|---|
| `pack_type` | `character`、`world`、`graph`、`plugin`。 |
| `manifest_json` | 完整 manifest 内容，用于快速查询和兼容性检查。 |
| `storage_path` | 包文件在本地文件系统或对象存储中的路径。 |

---

## API 规范

### 通用约定

- 基础路径：`/api`
- 请求和响应统一 JSON（SSE 流式端点除外）
- 时间字段使用 ISO 8601 UTC
- ID 字段使用 UUID v4
- 分页使用 `?cursor=<id>&limit=<n>` 游标分页，避免 offset 在长列表下的性能问题

### 统一错误响应

```json
{
  "error": {
    "code": "session_not_found",
    "message": "会话不存在",
    "details": {}
  }
}
```

| HTTP 状态码 | 场景 |
|---|---|
| 400 | 请求参数校验失败、schema 不匹配。 |
| 404 | 资源不存在。 |
| 409 | 状态冲突，如并发写入同一状态。 |
| 422 | 结构化输出无法解析，如 LLM 返回的 JSON 不符合 schema。 |
| 500 | 内部错误。 |

---

### 会话

#### 创建会话

```text
POST /api/sessions
```

```json
{
  "title": "旧档案馆之夜",
  "mode": "strict_director",
  "character_pack_id": "char_archivist_v1",
  "world_pack_id": "world_blood_moon",
  "config": {
    "model": "default",
    "director_strength": "strict"
  }
}
```

响应 `201`：

```json
{
  "id": "sess_abc123",
  "title": "旧档案馆之夜",
  "mode": "strict_director",
  "character_pack_id": "char_archivist_v1",
  "world_pack_id": "world_blood_moon",
  "graph_pack_id": null,
  "config": { "model": "default", "director_strength": "strict" },
  "current_turn": 0,
  "created_at": "2026-06-04T12:00:00Z",
  "updated_at": "2026-06-04T12:00:00Z"
}
```

#### 获取会话列表

```text
GET /api/sessions?cursor=<id>&limit=20
```

响应 `200`：

```json
{
  "items": [ /* session objects */ ],
  "next_cursor": "sess_def456"
}
```

#### 获取单个会话

```text
GET /api/sessions/:id
```

#### 更新会话

```text
PATCH /api/sessions/:id
```

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
```

```json
{
  "content": "我推开档案馆的木门，手里紧握银钥匙。",
  "role": "user"
}
```

响应 `201`，返回用户消息对象。同时在后台触发一轮 Runtime 执行，通过 SSE 推送结果。

#### 获取消息列表

```text
GET /api/sessions/:id/messages?cursor=<id>&limit=50
```

#### 获取单条消息

```text
GET /api/sessions/:id/messages/:message_id
```

---

### 流式输出

#### SSE 事件流

```text
GET /api/sessions/:id/stream
```

客户端发送消息后，通过 SSE 接收本轮 Runtime 的完整执行过程。

**SSE 事件类型：**

| 事件 | 数据 | 说明 |
|---|---|---|
| `turn_start` | `{"turn_number": 42}` | 新轮次开始。 |
| `node_enter` | `{"node_id":"...","node_type":"director","agent_id":"director"}` | 节点开始执行。 |
| `node_output` | `{"node_id":"...","output_type":"npc_intent","content":"..."}` | 节点输出，可流式增量推送。 |
| `state_proposal` | `{"proposal_id":"...","risk":"medium","changes":[...]}` | 状态变更提案。 |
| `state_commit` | `{"proposal_id":"...","version":15,"committed_by":"director"}` | 状态已提交。 |
| `artifact_update` | `{"artifact_id":"...","version":4,"patch_type":"state_diff"}` | Artifact 更新。 |
| `message_delta` | `{"content":"推开门的瞬间..."}` | 最终用户可见文本的增量部分。 |
| `turn_end` | `{"turn_number":42,"token_usage":{...}}` | 轮次结束。 |
| `error` | `{"code":"...","message":"..."}` | 错误。 |

**连接说明：**

- 客户端在发送消息前建立 SSE 连接，或在 POST 消息的响应中通过 `200` + `Transfer-Encoding: chunked` 流式返回。
- 单次连接只服务一轮对话。轮次结束后连接关闭。
- 断线后客户端可通过 `GET /api/sessions/:id/messages` 拉取已完成的完整消息。

---

### 结构化状态

#### 获取当前状态

```text
GET /api/sessions/:id/state
```

返回最新版本的 `state_snapshots.state_json`。

#### 获取状态历史

```text
GET /api/sessions/:id/state/history?cursor=<version>&limit=20
```

返回状态版本列表，每个版本包含 `version`、`risk_level`、`committed_by`、`created_at` 和变更摘要。

#### 获取指定版本

```text
GET /api/sessions/:id/state/versions/:version
```

---

### 记忆

#### 事件账本

```text
GET /api/sessions/:id/memory/events?cursor=<id>&limit=50&type=discovery&importance=critical
```

支持按 `type`、`importance`、`characters_involved` 过滤。

#### 伏笔登记表

```text
GET /api/sessions/:id/memory/foreshadowing?status=open&importance=high
```

#### 角色状态

```text
GET /api/sessions/:id/memory/characters/:character_id
```

返回 `character_states` 行，包含 `personality_core`、`personality_state`、`growth_arc` 和 `relationships`。

#### 轮次摘要

```text
GET /api/sessions/:id/memory/summaries?type=scene&limit=10
```

---

### Trace

#### 获取轮次 trace 列表

```text
GET /api/sessions/:id/trace/:turn_number
```

返回该轮所有节点的 trace 记录，按执行顺序排列。

#### 获取单条 trace

```text
GET /api/sessions/:id/trace/detail/:trace_id
```

返回完整 trace，包含 `context_bundle`、`model_config`、`token_usage`。

#### 获取 trace 统计

```text
GET /api/sessions/:id/trace/stats
```

返回聚合统计：总轮次、总 token、平均每轮 token、总运行时间、错误率。

---

### 内容包

#### 获取已导入包列表

```text
GET /api/packs?type=character
```

#### 获取单个包详情

```text
GET /api/packs/:id
```

#### 导入包

```text
POST /api/packs/import
Content-Type: multipart/form-data
```

接收 ZIP 文件，执行 manifest 校验 → schema 校验 → 权限声明 → 资源完整性检查。

响应 `201`，返回导入报告：

```json
{
  "pack_id": "char_archivist_v1",
  "warnings": [],
  "errors": []
}
```

#### 导出包

```text
GET /api/packs/:id/export
```

返回 ZIP 文件流。

#### 删除包

```text
DELETE /api/packs/:id
```

检查是否有会话引用该包，有引用时拒绝删除并返回关联会话列表。

---

### Artifacts

#### 获取 Artifact

```text
GET /api/artifacts/:id
```

返回最新版本。

#### 获取指定版本

```text
GET /api/artifacts/:id/versions/:version
```

#### 获取版本历史

```text
GET /api/artifacts/:id/versions?limit=20
```

#### 应用 Patch

```text
POST /api/artifacts/:id/patch
```

```json
{
  "patch_type": "state_diff",
  "parent_version": 3,
  "payload": { "items": { "add": [{ "id": "blood_moon_shard", "name": "血月碎片" }] } }
}
```

响应 `201`，返回新版本号。

---

## 数据迁移策略

- V1 使用 SQLite，`sqlx` 的 migrate 工具管理 schema 版本。
- 迁移文件放在 `backend/migrations/` 目录，命名格式：`<timestamp>_<description>.sql`。
- 每次迁移必须可逆（提供 `down.sql`），除非是不可逆的数据清理。
- 迁移前自动备份数据库文件。

---

## 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| JSON 字段缺乏数据库级约束 | 应用层 bug 可能写入格式错误的状态、事件或 trace。 | 所有 JSON 字段在应用层使用 schema 校验（`serde` + `jsonschema`），写入前验证。 |
| SQLite 并发写入限制 | 多个 Runtime 实例同时写入可能冲突。 | V1 单实例部署，使用 WAL 模式；后续多人版切换 PostgreSQL。 |
| trace 和事件表无限增长 | 长会话百万轮后查询变慢。 | 按 session 分表查询，旧 trace 可归档到独立文件，保留索引。 |
| 状态快照全量存储 | 每轮都存完整状态 JSON，存储膨胀。 | 存储压缩（gzip），或定期合并旧快照只保留里程碑版本。 |
| 游标分页在删除场景下失效 | 软删除后游标可能指向已删除记录。 | 查询时跳过 `deleted_at` 非空记录，游标使用不可变字段（id + created_at）。 |

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| 创建会话并发送消息 | 会话和消息正确写入数据库，`current_turn` 递增。 |
| SSE 流式输出完整轮次 | 客户端按序收到 `turn_start` → `node_enter` → `node_output` → `state_commit` → `turn_end`。 |
| 状态 proposal + commit | `low` 风险自动提交，`medium` 需 Director 审核，`high` 需证据链，`state_snapshots.version` 递增。 |
| 事件账本查询 | 按类型、重要性和角色过滤正确返回，长会话 500+ 轮后查询延迟可接受。 |
| 伏笔登记与回收 | 伏笔可从 `open` 经 `hinted`、`triggered` 变为 `resolved`，每个状态变更记录对应 turn。 |
| 角色人格状态隔离 | 查询 NPC 角色状态时，`personality_core` 包含知识边界，不包含其他角色的隐藏信息。 |
| Trace 完整性 | 每轮每个节点都有 trace 记录，`context_bundle` 反映实际注入的信息范围。 |
| Artifact 版本管理 | 首次创建为 `full`，后续 `state_diff` 增量更新，版本号递增，可回溯历史版本。 |
| 内容包导入导出 | 导入 ZIP 校验通过后写入 `content_packs` 和文件系统；导出 ZIP 可重新导入且内容一致。 |
| 错误响应格式 | 所有错误端点返回统一 JSON 格式，包含 `code`、`message`、`details`。 |
