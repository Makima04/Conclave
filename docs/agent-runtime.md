# Agent Runtime 规范

> 定义平台自己的 RP Agent 编排内核：如何选择运行模式、执行 Agent 图、装配上下文、控制权限、提交状态、记录 trace，以及如何支持高级自由图但保持安全边界。

`RP Runtime` · `Agent Graph` · `Structured Output` · `Variable Tool Agent` · `Knowledge Boundary` · `Trace` · `Advanced Graph`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [Actor Agent 架构](actor-agent-architecture.md)
- [Agent 边界](agent-boundaries.md)

---

## Runtime 定义

Agent Runtime 是平台自己的 RP 编排内核，不直接绑定 LangGraph、AutoGen、CrewAI 或 OpenAI Agents SDK。外部框架可以作为参考或 adapter，但不能决定平台的角色、记忆、权限、世界状态和内容包格式。

### Runtime 负责控制

- 选择本轮 Agent 图。
- 装配每个节点的 `ContextBundle`。
- 校验权限、成本、循环和输出格式。
- 提交状态变化并记录 trace。

### Agent 负责建议

- 输出计划、裁决、意图、草稿或候选变更。
- 不能直接读取未授权信息。
- 不能直接写长期状态。
- 不能直接调用未授权工具。

> **核心原则：** Runtime 负责控制，Agent 负责建议。

---

## 运行模式

| 模式 | 用途 | 实现方式 |
|---|---|---|
| `single_agent` | 类 SillyTavern 单角色会话。单次 LLM 调用，ContextBundle 提供结构化上下文。 | ContextBundle → 单 Agent → Writer 输出 |
| `multi_agent` | 动态总控多 Agent 架构。Parser → Master → 子 Agent → Writer → State Agent(variables) → Compression → Knowledge。 | 4 层流水线，详见 [动态总控架构](dynamic-master-architecture.md) |

---

## Agent Graph 管理

旧架构使用固定模板图（`strict_director`、`collaborative_director` 等预定义图），已废弃。新架构采用动态总控（Dynamic Master）方案，由 Master Agent 每轮动态决定调用哪些子 Agent。详见 [动态总控架构](dynamic-master-architecture.md)。

### Agent Graph Pack（预留）

未来支持高级创作者制作自定义 Agent Graph Pack，其他用户可导入使用。平台负责 schema 校验、权限校验、沙箱、成本限制和 trace，不负责第三方图包的剧情质量和 Prompt 质量。

| 图类型 | 平台负责 | 平台不负责 |
|---|---|---|
| 内置 Dynamic Master | 质量、安全、成本上限、稳定性。 | — |
| `CommunityGraphPack`（预留） | schema 校验、权限校验、沙箱、trace。 | 剧情质量、Prompt 质量、成本经济性、是否好玩。 |
| `UnverifiedGraphPack`（预留） | 强限制运行、禁止高危权限、显示风险提示。 | 第三方图包稳定性和输出质量。 |

> **责任边界：** 质量风险由图包创作者和使用者承担，安全边界由平台承担。

---

## Agent 类型与职责

### 动态总控架构中的 Agent

`multi_agent` 模式下，Agent 由 Master 动态管理，不再使用固定节点图。各 Agent 职责：

- `Parser`：解析用户意图，输出结构化 `ParsedIntent`。
- `Master`：总控调度，基于上下文和意图生成 `MasterPlan`。
- `user`：固定 Actor Agent，代表用户扮演角色；每个 multi-agent 会话有且只有一个，不可删除或冷却。
- `npc`：动态 Actor Agent，拥有独立上下文和 LLM 调用，可由 Master 或用户调节生命周期。
- `Writer`：最终叙事合成，输出用户可见文本。
- `Director`：叙事节奏排列（可选，由 Master 按需调用）。
- `State`（Variable Tool Agent）：通过 `update_variables` tool call 直接持久化变量变更到 `state_snapshots` 表。Runtime 会自动注入 State Agent 到 DAG 中（当存在 `_state_agent_writable` 变量且 Master 未显式调用时）。

### single_agent 模式

单 Agent 模式下，一次 LLM 调用完成所有工作：输入 → ContextBundle → LLM → 输出。

---

## 每轮执行流程

### multi_agent 模式（4 层流水线）

1. **Build ContextBundle** — 从 DB 加载最近对话、结构化状态、事件、伏笔、摘要；注入 recall 上下文（关键词或 embedding 模式检索 `structured_events`）、Preset 模块、User Persona、世界书条目。
2. **Auto-cooldown** — 检查并冷却不活跃的子 Agent。
3. **Layer 1: Parser**（可选，`parser_enabled` 配置） — 解析用户意图，输出 `ParsedIntent`。Parser 失败时不阻断流程，后续步骤继续。
4. **Layer 2: Master** — 基于上下文 + 意图 + 子 Agent 摘要，生成 `MasterPlan`（含 `final_writer_id` 可选字段，指定多 Writer 时的最终叙事者）。
5. **Plan Validator** — 校验 Master 计划：移除不存在的 Agent、截断超长 task（2000 字符）、校验 `inject_from` 依赖、cap 调用数至 `max_active_agents`、阻止删除永久 Agent、限制 lifecycle 操作数至 5。
6. **Runtime 注入 State Agent** — 若存在 `_state_agent_writable` 变量且 Master 未显式调用 State Agent，Runtime 自动将其注入 DAG，依赖所有 NPC/User Agent 的输出。
7. **Lifecycle** — 执行计划中的生命周期操作（create/cooldown/delete/restore）。
8. **Layer 3: Sub-Agents (DAG)** — 按计划调用子 Agent。调用列表编译为 DAG，同一层级的 Agent 并发执行（`dag.rs`），**并发上限 `MAX_CONCURRENT_AGENTS=4`**。每个 Agent 有独立上下文和 LLM 调用。State Agent 收到 `update_variables` tool，通过 tool call 直接持久化变量变更。
9. **Fallback Writer** — 若无 Writer 被调用，自动调用默认 Writer（优先使用 `final_writer_id` 指定的 Writer）。
10. **Extract Narrative** — 从 Writer 输出提取最终叙事文本。
11. **Post-commit（非致命）**：
    - **Compression** — 压缩 Agent 分析输出，生成 scene_summary + events + foreshadowing + state_changes，写入对应表。压缩也可通过 `turn_jobs` 后台队列异步执行（如 recompression）。
    - **Knowledge Extraction** — 从用户输入 + 最终叙事中抽取"谁知道什么"事实，写入 `agent_knowledge_events` 表。
12. **Record Traces & Debug Snapshots** — 记录每个 Agent 的执行 trace 和完整调试快照（含 system_prompt、user_prompt、tool_calls、injected_outputs 等）。

### single_agent 模式

1. **UserInput** — 用户输入。
2. **Load Context** — 从 DB 加载 ContextBundle。
3. **LLM Call** — 单次 LLM 调用。
4. **Save & Record** — 保存消息，记录 trace。

---

## 结构化输出协议

Agent 输出必须结构化。自然语言可以作为字段值，但不能作为唯一结果。

| 输出类型 | 来源 Agent | 用途 |
|---|---|---|
| `ParsedIntent` | Parser | 用户意图、动作类型、目标角色、压缩输入、语气。 |
| `MasterPlan` | Master | 本轮调用列表 (`AgentCall[]`)、生命周期操作 (`LifecycleAction[]`)、是否激活 User Agent、`final_writer_id`（可选）。 |
| `AgentOutput` | 子 Agent | Agent 的结构化输出（含 `tool_calls`），写入 Turn State。 |
| `CompressionResult` | Compression（异步） | scene_summary、events、structured_events、foreshadowing、state_changes。 |
| `KnowledgeExtraction` | Knowledge（异步） | 本轮"谁知道什么"事件列表，写入 `agent_knowledge_events`。 |

```json
{
  "type": "master_plan",
  "calls": [
    {"agent_id": "npc_archivist", "task": "回应玩家关于银钥匙的询问", "inject_from": []},
    {"agent_id": "writer_1", "task": "根据以上互动，创作叙事文本", "inject_from": ["npc_archivist"]}
  ],
  "lifecycle": [],
  "user_auto": false,
  "final_writer_id": null
}
```

---

## 状态提交与变量变更

### State Agent（Variable Tool Agent）

State Agent 通过 `update_variables` tool call 直接持久化变量变更到 `state_snapshots` 表。**不使用 `pending_proposals` 审批表，不使用风险分级门控。**

| 属性 | 说明 |
|---|---|
| 工具 | `update_variables`：基于当前变量定义动态生成 JSON Schema，State Agent 通过 tool call 提交变更 |
| 持久化 | 变更直接写入 `state_snapshots` 新版本（`risk_level='low'`, `committed_by='card_runtime'`） |
| 触发方式 | Master 显式调用，或 Runtime 自动注入（当 `_state_agent_writable` 非空且 Master 未包含 State Agent 时） |
| Single-agent 模式 | 同样使用 Variable Tool Agent 提案 + 持久化变量变更 |

### Compression

压缩 Agent（异步 post-commit）生成结构化状态更新：

- `scene_summary`：覆盖式场景状态摘要。
- `events` + `structured_events`：本轮有意义事件。
- `foreshadowing`：伏笔状态更新。
- `state_changes`：直接写入 `state_snapshots`，无审批流程。

### Knowledge Extraction

每轮 post-commit 阶段，从用户输入 + 最终叙事中抽取"谁知道什么"事件，写入 `agent_knowledge_events` 表。详见 [Agent 边界与权限](agent-boundaries.md) 中的知识边界系统。

---

## 运行限制

### 多 Agent 限制

- `max_active_agents`：8（用户可配置）。
- `cooldown_turns`：10 轮不活跃自动冷却（用户可配置）。
- `MAX_CONCURRENT_AGENTS`：DAG 同一层级并发上限 4（硬编码常量）。
- `max_turn_runtime_ms`：待实现。
- `max_token_budget_per_turn`：待实现。

### 默认禁用

- 未授权插件代码。
- 任意网络访问。
- 本地文件访问。
- 直接写长期记忆。
- 读取隐藏设定和用户私密数据。

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| multi_agent 模式 4 层流水线 | Parser → Master → Plan Validator → Sub-agents(DAG) → Writer → Compression + Knowledge 按序执行，每层有 trace。 |
| Master 动态调度 | Master 根据用户输入自主决定调用哪些 NPC，无需预定义图。 |
| 子 Agent 上下文隔离 | NPC 的 ContextBundle 不包含其他 NPC 内心或导演计划；敏感 key（`secret_*`/`hidden_*`/`gm_notes`）被过滤。 |
| Agent 生命周期管理 | 连续 N 轮不活跃的 Agent 自动冷却，被调用时自动恢复。 |
| 压缩 Agent 去重 | 相同事件在 3 轮内不会重复写入 structured_events 表。 |
| single_agent 模式回退 | session.mode == "single_agent" 时走单 Agent 路径，行为不变。 |
| 节点输出 JSON 无法解析 | Runtime 触发修复、重试或 fallback，不能把错误结构写入状态。 |
| State Agent 变量变更 | State Agent 通过 update_variables tool call 直接持久化到 state_snapshots，无 pending_proposals。 |
| Knowledge 边界抽取 | 每轮 post-commit 抽取 knowledge events，writer_only 事件不进入 NPC knowers。 |
| Plan Validator 约束 | 无效 Agent 调用被移除，永久 Agent 不可删除，调用数不超 max_active_agents。 |
