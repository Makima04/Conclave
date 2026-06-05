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

| 模式 | 用途 | 默认图 |
|---|---|---|
| `single_agent` | 类 SillyTavern 单角色会话。 | UserInput -> Npc/Writer -> Memory |
| `strict_director` | 超真实模式，用户不能直接口胡世界事实。 | Director -> WorldJudge -> NPCs -> Writer -> Memory |
| `collaborative_director` | 用户可提出剧情方向，导演负责合理化。 | Director -> Router -> NPCs/Writer -> Consistency -> Memory |
| `free_writing` | 小说创作模式，用户叙事权更高。 | Writer -> Consistency -> Memory |
| `multi_npc_scene` | 多 NPC 场景，按可见性、动机和关系召唤角色。 | Director -> Router -> NPC parallel -> Writer -> Memory |
| `advanced_graph` | 高级创作者提供自定义 Agent Graph Pack。 | 由图包定义，但受 Runtime 安全限制。 |

---

## 图分级与责任边界

### 官方模板图

平台维护，默认推荐。平台负责稳定性、基础质量和安全边界。

### 自动生成图

由角色卡和世界书生成。平台负责基础稳定，创作者负责内容质量。

### 高级自由图

高级创作者制作，其他用户可导入。平台负责安全边界，不负责第三方图包剧情质量。

| 图类型 | 平台负责 | 平台不负责 |
|---|---|---|
| `OfficialGraphTemplate` | 质量、安全、成本上限、稳定性。 | 用户自改后的效果。 |
| `GeneratedGraph` | 生成规则、基础校验、安全限制。 | 角色卡和世界书原始质量。 |
| `CommunityGraphPack` | schema 校验、权限校验、沙箱、trace。 | 剧情质量、Prompt 质量、成本经济性、是否好玩。 |
| `UnverifiedGraphPack` | 强限制运行、禁止高危权限、显示风险提示。 | 第三方图包稳定性和输出质量。 |
| `TrustedGraphPack` | 仍负责安全边界和权限限制。 | 创作者设计导致的叙事问题。 |

> **责任边界：** 质量风险由图包创作者和使用者承担，安全边界由平台承担。

---

## 节点与边

### V1 节点类型

- `DirectorNode`：规划、权限、召唤、裁决。
- `RouterNode`：条件分支和模式路由。
- `WorldJudgeNode`：世界规则和事实裁决。
- `NpcNode`：NPC 意图、台词、行为反应。
- `WriterNode`：最终叙事合成。
- `MemoryNode`：摘要、事件和状态候选变更。
- `ConsistencyNode`：OOC、冲突和伏笔检查。
- `ArtifactNode`：UI artifact 状态和 patch。
- `ToolNode`：受限工具调用。

### 边类型

- `sequence`：顺序执行。
- `condition`：按结构化条件分支。
- `handoff`：受控 Agent 交接。
- `parallel`：并行执行多个节点。
- `merge`：合并多个节点结果。
- `fallback`：失败后的备用路径。

> **后续扩展：** V2/V3 可加入 `PluginNode`、`CustomPromptNode`、`ParallelGroupNode`、`HumanApprovalNode`。

---

## 每轮执行流程

1. **UserInput** — 用户输入、创作指令或角色行动。
2. **Load State** — 读取会话、世界、角色、记忆和图配置。
3. **Select Graph** — 按世界模式选择官方图、生成图或高级图。
4. **Plan** — Director / Router 生成本轮执行计划。
5. **Execute** — Runtime 裁剪上下文并执行节点。
6. **Validate** — 校验输出、权限、冲突和风险。
7. **Commit** — 输出给用户，提交状态，保存 trace。

---

## 节点输出协议

节点输出必须结构化。自然语言可以作为字段值，但不能作为唯一结果。

| 输出类型 | 来源节点 | 用途 |
|---|---|---|
| `PlanResult` | Director / Router | 本轮调用哪些节点、是否检索、是否审查、是否需要用户确认。 |
| `JudgeResult` | WorldJudge | 用户行为或剧情事实是否成立，以及后果。 |
| `NpcIntent` | NpcNode | NPC 的行动意图、台词草稿和可见反应。 |
| `WriterDraft` | WriterNode | 用户可见叙事文本。 |
| `MemoryProposal` | MemoryNode | 摘要、事件、伏笔和状态候选变更。 |
| `StateChangeProposal` | Memory / Tool / Plugin | 候选状态变更，必须经过 Runtime 提交。 |
| `ArtifactPatch` | ArtifactNode | UI artifact 的 props、state diff 或 patch。 |

```json
{
  "type": "plan_result",
  "mode": "strict_director",
  "nodes": ["world_judge", "npc_archivist", "writer", "memory"],
  "retrieval": {
    "events": ["silver_key", "old_archive"],
    "foreshadowing": ["blood_moon_key"]
  },
  "requires_consistency_check": true
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

## 高级自由图限制

自由图可以开放给高级创作者，并允许其他用户导入使用。但 Runtime 必须限制循环、并发、成本、工具和写入权限。

### V1 建议限制

- `max_loop_count`：2-3。
- `max_total_nodes_per_turn`：12。
- `max_parallel_nodes`：3。
- `max_turn_runtime_ms`：按模型和部署配置。
- `max_token_budget_per_turn`：由用户或世界书设置。

### 默认禁用

- 未授权插件代码。
- 任意网络访问。
- 本地文件访问。
- 直接写长期记忆。
- 读取隐藏设定和用户私密数据。

> **导入提示：** 高级 Agent Graph Pack 由创作者自行设计。平台会进行基础安全校验和运行时限制，但不保证第三方图包的叙事质量、角色一致性、成本效率或稳定性。

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| 严格导演模式下用户口胡世界事实 | Runtime 调用 WorldJudge，拒绝或合理化，不能直接写入事实。 |
| 多 NPC 场景 | Runtime 只召唤相关且可见的 NPC，并给每个 NPC 独立 ContextBundle。 |
| 自由图出现循环 | 超过 max_loop_count 后停止并走 fallback。 |
| 插件节点请求隐藏设定 | 未授权时拒绝，并记录 trace。 |
| MemoryNode 提出高风险状态变更 | 不能自动提交，必须 Director 审核并保留证据链。 |
| 节点输出 JSON 无法解析 | Runtime 触发修复、重试或 fallback，不能把错误结构写入状态。 |
| 社区图包成本过高 | Runtime 按预算中止，并提示用户这是第三方图包质量/成本风险。 |
