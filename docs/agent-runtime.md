# Agent Runtime 规范

> 定义平台自己的 RP Agent 编排内核：如何选择运行模式、执行 Agent 图、装配上下文、控制权限、提交状态、记录 trace，以及如何支持高级自由图但保持安全边界。

`RP Runtime` · `Agent Graph` · `Structured Output` · `Proposal Commit` · `Trace` · `Advanced Graph`

---

- [文档中心](docs.md)
- [架构首页](index.md)
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
| `multi_agent` | 动态总控多 Agent 架构。Parser → Master → 子 Agent → Writer → 压缩。 | 4 层流水线，详见 [动态总控架构](dynamic-master-architecture.md) |

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
- `npc`：NPC 角色执行，拥有独立上下文和 LLM 调用。
- `Writer`：最终叙事合成，输出用户可见文本。
- `Director`：叙事节奏排列（可选，由 Master 按需调用）。
- `State`（Compression Agent）：后处理压缩，生成 scene_summary + events + foreshadowing + state_changes。
- `user_proxy`：用户角色代理，自动生成用户角色行为（可选）。

### single_agent 模式

单 Agent 模式下，一次 LLM 调用完成所有工作：输入 → ContextBundle → LLM → 输出。

---

## 每轮执行流程

### multi_agent 模式（4 层流水线）

1. **Build ContextBundle** — 从 DB 加载最近对话、结构化状态、事件、伏笔和摘要。
2. **Auto-cooldown** — 检查并冷却不活跃的子 Agent。
3. **Layer 1: Parser**（可选） — 解析用户意图，输出 `ParsedIntent`。
4. **Layer 2: Master** — 基于上下文 + 意图 + 子 Agent 摘要，生成 `MasterPlan`。
5. **Lifecycle** — 执行 Master 计划中的生命周期操作（create/cooldown/delete/restore）。
6. **Layer 3: Sub-Agents** — 按计划调用子 Agent。调用列表编译为 DAG，同一层级的 Agent 并发执行（`dag.rs`），每个有独立上下文和 LLM 调用。
7. **Fallback Writer** — 若无 Writer 被调用，自动调用默认 Writer。
8. **Extract Narrative** — 从 Writer 输出提取最终叙事文本。
9. **Layer 4: Compression** — 压缩 Agent 分析输出，生成 scene_summary + events + foreshadowing + state_changes。
10. **Record Traces** — 记录每个 Agent 的执行 trace。

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
| `MasterPlan` | Master | 本轮调用列表 (`AgentCall[]`)、生命周期操作 (`LifecycleAction[]`)、是否激活 User Agent。 |
| `AgentOutput` | 子 Agent | Agent 的结构化输出，写入 Turn State。 |
| `CompressionResult` | State (Compression) | scene_summary、events、structured_events、foreshadowing、state_changes。 |

```json
{
  "type": "master_plan",
  "calls": [
    {"agent_id": "npc_archivist", "task": "回应玩家关于银钥匙的询问", "inject_from": []},
    {"agent_id": "writer_1", "task": "根据以上互动，创作叙事文本", "inject_from": ["npc_archivist"]}
  ],
  "lifecycle": [],
  "user_auto": false
}
```

---

## 状态提交与风险等级

Runtime 使用 proposal + commit。Agent 只能提出候选变更，Runtime 根据风险等级和权限决定是否提交。

| 风险 | 例子 | 提交规则 |
|---|---|---|
| `low` | 普通事件摘要、物品数量、短期情绪、场景过渡。 | schema 和权限通过后可自动提交。 |
| `medium` | 关系变化、任务状态、伏笔 hint、角色短期目标变化。 | Director 审核后提交。 |
| `high` | 核心人格变化、死亡、阵营变化、世界规则变化、隐藏秘密公开。 | Director 审核，可选用户确认，必须记录证据链。 |

---

## 运行限制

### 多 Agent 限制

- `max_active_agents`：8（用户可配置）。
- `cooldown_turns`：10 轮不活跃自动冷却（用户可配置）。
- `max_turn_runtime_ms`：按模型和部署配置。
- `max_token_budget_per_turn`：由用户或会话配置。

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
| multi_agent 模式 4 层流水线 | Parser → Master → Sub-agents → Writer → Compression 按序执行，每层有 trace。 |
| Master 动态调度 | Master 根据用户输入自主决定调用哪些 NPC，无需预定义图。 |
| 子 Agent 上下文隔离 | NPC 的 ContextBundle 不包含其他 NPC 内心或导演计划。 |
| Agent 生命周期管理 | 连续 N 轮不活跃的 Agent 自动冷却，被调用时自动恢复。 |
| 压缩 Agent 去重 | 相同事件在 3 轮内不会重复写入 structured_events 表。 |
| single_agent 模式回退 | session.mode == "single_agent" 时走单 Agent 路径，行为不变。 |
| 节点输出 JSON 无法解析 | Runtime 触发修复、重试或 fallback，不能把错误结构写入状态。 |
| 压缩 Agent state_changes | 高风险状态变更走 proposal + commit，不自动提交。 |
