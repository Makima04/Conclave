# Agent 边界与权限架构

> 平台必须清楚定义每个 Agent 能看什么、能做什么、能改什么，以及哪些内部信息永远不能进入用户可见文本。

`Boundaries` · `Permissions` · `Context Isolation` · `Handoff` · `Trace` · `Least Privilege`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [Agent Runtime](agent-runtime.md)
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
| `npc` | 自身角色卡、可见场景、自己的记忆、关系状态 | 行动意图、台词草稿、可见反应 | 导演计划、其他 NPC 内心、未知秘密。 |
| `writer` | 本轮 NPC 输出、场景摘要、伏笔 | 最终叙事文本 | 擅自改变事实。 |
| `state` | 本轮对话、ContextBundle、叙事文本 | `CompressionResult`（scene_summary + events + structured_events + foreshadowing + state_changes） | 不生成叙事文本。 |
| `director` | 完整概览（预留，由 Master 按需调用） | 执行计划、裁决结果 | — |
| `user_proxy` | 场景、最近 events（预留） | 用户角色行为 | — |

---

## ContextBundle 权限隔离

每个 Agent 收到的不是完整会话，而是按权限裁剪的 `ContextBundle`。构建逻辑在 `context.rs`，过滤逻辑在 `sub_agent.rs`。

### ContextBundle 组成

- `task`：本轮任务。
- `recent_context`：最近 N 轮对话消息。
- `structured_state`：结构化状态快照。
- `events`：事件账本条目 + `event_visibilities`。
- `foreshadowing`：伏笔条目 + `foreshadow_visibilities`。
- `scene_summary`：最新场景摘要。

### 可见性字段

每条 event 和 foreshadowing 都有 `visibility` 字段：

| visibility | 说明 |
|---|---|
| `public` | 所有 Agent 可见。 |
| `gm_only` | 只有 master/director 可见。 |
| `character:<id>` | 只有指定角色 NPC 可见。 |
| `writer_only` | 只有 writer 可见。 |

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
| `MasterPlan` | master | `calls[]`（调用列表）、`lifecycle[]`（生命周期操作）、`user_auto`。 |
| `AgentOutput` | npc/writer/director 等 | agent_id、agent_type、text、token 统计。 |
| `CompressionResult` | state | scene_summary、events、structured_events、foreshadowing、state_changes。 |

---

## 写入权限与双阶段提交

长期记忆和世界状态不能由 LLM 直接覆盖。当前实现中，压缩 Agent 的 `state_changes` 通过 `pending_proposals` 表暂存，经审批后提交到 `state_snapshots`。

### 流程

1. 压缩 Agent 输出 `CompressionResult`，其中 `state_changes` 进入 `pending_proposals`。
2. `events`、`structured_events`、`foreshadowing`、`scene_summary` 直接写入对应表。
3. `pending_proposals` 中 `risk: "high"` 的变更需要审核，`"low"` 自动提交。

---

## 插件边界（P3 预留）

插件代码节点必须限制在 manifest 声明的权限内。默认没有读取隐藏设定、网络访问、文件访问或写入记忆的权限。所有权限必须在 `permissions.json` 中显式声明。

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| NPC 询问隐藏秘密 | 隐藏秘密通过 visibility 过滤不进入 NPC ContextBundle。 |
| Writer 添加未裁决事实 | 压缩 Agent 生成的 state_changes 走 proposal + commit。 |
| 高风险状态变更 | 进入 pending_proposals，不自动提交到 state_snapshots。 |
| 多 Agent 同时写同一状态 | 压缩 Agent 在所有子 Agent 执行完毕后统一生成，避免并发冲突。 |
