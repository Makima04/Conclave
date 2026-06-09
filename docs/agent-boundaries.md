# Agent 边界与权限架构

> 平台必须清楚定义每个 Agent 能看什么、能做什么、能改什么，以及哪些内部信息永远不能进入用户可见文本。

`Boundaries` · `Permissions` · `Context Isolation` · `Knowledge Boundary` · `Sensitive Key Filter` · `Trace` · `Least Privilege`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [Agent Runtime](agent-runtime.md)
- [Actor Agent 架构](actor-agent-architecture.md)
- [动态总控架构](dynamic-master-architecture.md)
- [长期记忆](long-context-memory.md)

---

## 核心原则

**最小权限。** Agent 默认什么都不能看、不能写，只有 Master 调度时显式授权后才允许。

---

## 实际 Agent 类型与权限

当前 `multi_agent` 模式下的 Agent 类型（参见 `sub_agents` 表）：

| Agent | 可读 | 可写 | 禁止 |
|---|---|---|---|
| `parser` | 用户输入、ContextBundle 摘要 | 结构化 `ParsedIntent`（intent/action_type/tone/target_characters） | 不直接生成叙事文本。 |
| `master` | ContextBundle、ParsedIntent、所有子 Agent 摘要 | `MasterPlan`（调用列表 + 生命周期操作） | 不直接写长期状态。 |
| `user` | User Agent 固定上下文、可见场景、用户角色已知信息 | 用户自动代理行为（可选） | NPC 私密设定、未知秘密。 |
| `npc` | 自身角色卡、可见场景、自己的记忆、关系状态 | 行动意图、台词草稿、可见反应 | 导演计划、其他 Actor 内心、未知秘密。 |
| `writer` | 本轮 NPC 输出、场景摘要、伏笔 | 最终叙事文本 | 擅自改变事实。 |
| `state` | _state_agent_writable 变量、NPC/User Agent 输出 | 通过 `update_variables` tool call 持久化变量变更到 `state_snapshots` | 不生成叙事文本。 |
| `director` | 完整概览（预留，由 Master 按需调用） | 执行计划、裁决结果 | — |

---

## ContextBundle 权限隔离

每个 Agent 收到的不是完整会话，而是按权限裁剪的 `ContextBundle`。构建逻辑在 `context.rs`，过滤逻辑在 `sub_agent.rs`。

### ContextBundle 组成

- `task`：本轮任务。
- `recent_context`：最近 N 轮对话消息。
- `structured_state`：结构化状态快照（经 `filter_state_for_visibility` 过滤敏感 key）。
- `events`：事件账本条目 + `event_visibilities`。
- `foreshadowing`：伏笔条目 + `foreshadow_visibilities`。
- `scene_summary`：最新场景摘要。
- `recalled_events`：通过 Recall 系统检索的相关历史事件（keyword/embedding 模式）。
- `knowledge_events`：知识边界事件（经 `visible_to_agent` 过滤，每个 Agent 只看到自己 know 的事实）。
- `preset_modules`：Preset 模块注入。
- `role_contexts`：角色上下文（含 User Persona）。

### 可见性字段

每条 event 和 foreshadowing 都有 `visibility` 字段（用于事件/伏笔过滤，不用于 structured_state key 过滤）：

| visibility | 说明 |
|---|---|
| `public` | 所有 Agent 可见。 |
| `gm_only` | 只有 master/director 可见。 |
| `writer_only` | 只有 writer 可见（也用于 knowledge events 中的事实隔离）。 |

> **注意**：`character:<id>` visibility 在事件和伏笔过滤中使用。structured_state 的 key-level 过滤不依赖 visibility 字段，而是通过 `filter_sensitive_keys` 的命名模式匹配（`hidden_*`/`secret_*`/`internal_*`/`gm_notes`/`meta`）。

### 隔离目标

- NPC 不知道不该知道的秘密（通过 visibility 过滤）。
- Writer 不擅自改变事实（只拿本轮 NPC 输出和场景摘要）。
- 压缩 Agent 生成的事件带 visibility 标记，后续构建 ContextBundle 时按 Agent 类型过滤。

---

## 结构化输出协议

Agent 输出必须结构化。参见 `types.rs`。

| 输出类型 | 来源 | 用途 |
|---|---|---|
| `ParsedIntent` | parser | intent、action_type、target_characters、compressed_input、tone。 |
| `MasterPlan` | master | `calls[]`（调用列表）、`lifecycle[]`（生命周期操作）、`user_auto`、`final_writer_id`。 |
| `AgentOutput` | npc/writer/director 等 | agent_id、agent_type、text、tool_calls（State Agent 专用）、token 统计。 |
| `CompressionResult` | compression（异步） | scene_summary、events、structured_events、foreshadowing、state_changes。 |
| `KnowledgeExtraction` | knowledge（异步） | events[]，每个含 fact/source_type/actors/targets/observers/knowers/visibility/confidence/evidence。 |

---

## 写入权限与状态变更

### State Agent（Variable Tool Agent）

当前实现中，State Agent 通过 `update_variables` tool call 直接持久化变量变更到 `state_snapshots` 表。**不使用 `pending_proposals` 审批表，不使用风险分级门控。**

| 步骤 | 说明 |
|---|---|
| 1. Tool 注入 | Runtime 为 State Agent 构建 `update_variables` tool（基于 `_state_agent_writable` 动态生成 JSON Schema） |
| 2. Agent 调用 | State Agent 通过 LLM tool call 输出 `{"changes": [{"path": "变量名", "value": 新值}]}` |
| 3. 提取变更 | `extract_tool_call` 解析 tool_calls，将变量路径映射为 `platform_state.变量名` |
| 4. 持久化 | 变更直接写入 `state_snapshots` 新版本（`risk_level='low'`, `committed_by='card_runtime'`），无审批 |

### Compression 状态更新

压缩 Agent 在 post-commit 阶段生成的 `state_changes` 也直接写入 `state_snapshots`，无 pending_proposals 审批流程。

### Single-agent 模式

single_agent 模式同样使用 Variable Tool Agent：在 LLM 调用后单独调用 `propose_variable_changes` 提案 + `persist_variable_changes` 持久化。

---

## 敏感字段过滤

`filter_state_for_visibility` 函数在构建子 Agent 的 ContextBundle 时按 Agent 类型过滤 `structured_state`。

### 规则

| Agent 类型 | 过滤策略 |
|---|---|
| Master / Director / State / Parser | 完整访问，不过滤 |
| NPC / Writer / User | 调用 `filter_sensitive_keys` 过滤敏感 key |

### 敏感 Key 规则

`filter_sensitive_keys` 递归遍历 JSON（支持嵌套对象和数组），移除以下 key：

| 匹配模式 | 说明 |
|---|---|
| `hidden_*` | 前缀匹配，移除所有以 `hidden_` 开头的字段 |
| `secret_*` | 前缀匹配，移除所有以 `secret_` 开头的字段 |
| `internal_*` | 前缀匹配，移除所有以 `internal_` 开头的字段 |
| `gm_notes` | 精确匹配，移除 GM 笔记字段 |
| `meta` | 精确匹配，移除元数据字段 |

---

## 知识边界系统

### 概述

知识边界系统追踪"谁知道什么"，确保多 Agent 场景中角色不会获得不该知道的信息。每轮 post-commit 阶段，从用户输入 + 最终叙事中抽取 `KnowledgeEvent`，写入 `agent_knowledge_events` 表。

### KnowledgeEvent 结构

| 字段 | 说明 |
|---|---|
| `fact` | 事实描述 |
| `source_type` | `speech` / `action` / `visual_observation` / `inner_monologue` / `narration` / `inference` |
| `actors` | 行动或事实主体 |
| `targets` | 被作用对象 |
| `observers` | 明确看见/听见的人 |
| `knowers` | 知道该事实的角色名列表 |
| `visibility` | `public` / `private` / `writer_only` 等 |
| `confidence` | 置信度 (0.0-1.0) |
| `evidence` | 简短证据原文 |

### 可见性过滤规则

`visible_to_agent` 函数决定知识事件对每个 Agent 的可见性：

| Agent 类型 | 规则 |
|---|---|
| Writer / Director / Master / State / Parser | 可见所有事件 |
| NPC / User | `visibility=public` → 可见；`visibility=writer_only` → 不可见；其他 → 仅当 Agent 的 label 或 character_id 在 `knowers` 列表中 |

### 抽取规则（LLM prompt）

1. 明确说出口的信息：knowers 包含说话者和听见者。
2. 明确可观察的动作/表情/状态：knowers 包含在场观察者和本人。
3. 内心独白/秘密动机/未说出口的想法：只给本人；无法确定时 `visibility=writer_only`。
4. 旁白/作者视角但角色未必知道的内容：`visibility=writer_only`。
5. 不确定是否可见时：`visibility=writer_only`，`knowers=[]`。

### 容错

知识抽取失败时（LLM 返回无法解析的结果），fallback 写入一条 `writer_only` 事件，不阻断主流程。

---

## 插件边界（P3 预留）

插件代码节点必须限制在 manifest 声明的权限内。默认没有读取隐藏设定、网络访问、文件访问或写入记忆的权限。所有权限必须在 `permissions.json` 中显式声明。

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| NPC 询问隐藏秘密 | 隐藏秘密通过 visibility 过滤不进入 NPC ContextBundle；`secret_*`/`hidden_*`/`gm_notes` key 被 `filter_sensitive_keys` 移除。 |
| Writer 添加未裁决事实 | State Agent 通过 `update_variables` tool call 直接写入 `state_snapshots`，无 pending_proposals。 |
| 状态变更持久化 | 变更直接写入 `state_snapshots` 新版本（`risk_level='low'`），不经过审批表。 |
| 多 Agent 同时写同一状态 | DAG 并发执行中 State Agent 通过独立 transaction 写入，Compression 在所有子 Agent 执行完毕后统一生成。 |
| 知识边界：公开信息 | `visibility=public` 的事件对所有 NPC 可见。 |
| 知识边界：私密信息 | 内心独白 `visibility=writer_only`，不进入任何 NPC 的 knowers。 |
| 知识边界：推理容错 | 知识抽取失败时 fallback 到 `writer_only` 事件，不阻断主流程。 |
| 敏感字段过滤 | NPC 的 structured_state 不包含 `hidden_motivation`、`secret_plan`、`internal_id`、`gm_notes`、`meta`。 |
