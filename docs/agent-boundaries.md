# Agent 边界与权限架构

> 多 Agent 不是让所有 Agent 共享完整上下文。平台必须清楚定义每个 Agent 能看什么、能做什么、能改什么、什么时候交接，以及哪些内部信息永远不能进入用户可见文本。

`Boundaries` · `Permissions` · `Context Isolation` · `Handoff` · `Trace` · `Least Privilege`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [Agent Runtime](agent-runtime.md)
- [长期记忆](long-context-memory.md)

---

## 边界定义

Agent 边界是平台核心安全和质量机制。它不只是防止隐私泄露，也防止角色 OOC、世界设定污染、导演计划泄漏、记忆错误写入和多个 Agent 互相覆盖。

### 信息边界

Agent 能看到哪些角色卡、世界书、记忆、隐藏设定、导演计划和用户输入。

### 行为边界

Agent 能生成台词、裁决事实、改状态、调用工具、写记忆还是只给建议。

### 输出边界

Agent 的哪些内容能展示给用户，哪些只能作为内部 trace 或中间决策。

> **核心原则：** 最小权限。Agent 默认什么都不能看、不能写、不能调用，只有图节点和世界模式显式授权后才允许。

---

## Agent 权限矩阵

| Agent | 可读 | 可写 | 禁止 |
|---|---|---|---|
| `DirectorAgent` | 世界规则、公开/隐藏设定、角色状态、伏笔、事件账本、用户权限。 | 执行计划、裁决结果、handoff、trace。 | 直接伪造 NPC 内心作为最终输出；跳过世界规则硬改事实。 |
| `NpcAgent` | 自身角色卡、自己可见的场景、自己知道的记忆、关系状态。 | 行动意图、台词草稿、可见反应。 | 读取导演计划、其他 NPC 内心、未知秘密、完整世界隐藏设定。 |
| `WriterAgent` | 导演批准的事实、NPC 意图、风格要求、当前场景摘要。 | 最终叙事文本、风格化描述。 | 擅自改变事实、添加未裁决能力、替 NPC 做超出意图的决定。 |
| `WorldJudgeAgent` | 世界规则、能力规则、时间线、地点、状态快照。 | 允许/拒绝/修改建议、后果裁决。 | 写最终文案；替代导演决定叙事节奏。 |
| `MemoryAgent` | 本轮对话、trace、相关状态、事件账本。 | 候选摘要、事件、状态变化、伏笔变化。 | 未经校验直接覆盖核心人格、删除旧事实、公开隐藏秘密。 |
| `ConsistencyAgent` | 候选输出、角色核心、世界状态、相关旧事件。 | 冲突报告、OOC 报告、重写建议。 | 直接改写长期状态；绕过导演发布最终输出。 |
| `PluginAgent` | manifest 授权范围内的数据。 | manifest 授权范围内的结果或工具输出。 | 默认禁止隐藏设定、网络、本地文件、任意状态写入。 |

---

## 上下文隔离

每个 Agent 收到的不是完整会话，而是专属 `ContextBundle`。ContextBundle 由运行时根据节点权限、角色可见性和当前任务装配。

### ContextBundle 组成

- `task`：本轮任务。
- `visible_scene`：该 Agent 可见场景。
- `allowed_memory`：允许召回的记忆。
- `character_profile`：角色自身 profile。
- `known_state`：角色已知状态。
- `forbidden_topics`：禁止使用的信息类型。

### 隔离目标

- NPC 不知道不该知道的秘密。
- 写手不擅自发明事实。
- 记忆 Agent 不把错误内容直接写入主账本。
- 插件节点不能越权读取隐藏内容。

```json
{
  "agent_id": "npc_archivist",
  "task": "respond_as_character",
  "visible_scene": ["old_archive", "player_question"],
  "allowed_memory": ["met_player_turn_41", "saw_silver_key_turn_88"],
  "known_state": {
    "knows_blood_moon_secret": false,
    "trust_player": 0.42
  },
  "forbidden_topics": ["director_plan", "other_npc_inner_thoughts"]
}
```

---

## Handoff 规则

handoff 是 Agent 之间的交接，不是随意群聊。每次 handoff 都必须说明原因、输入、输出、可见范围和预期结果。

1. **触发** — 导演或路由节点判断需要另一个 Agent。
2. **授权** — 运行时检查目标 Agent 是否有读取和写入权限。
3. **裁剪** — 生成目标 Agent 专属 ContextBundle。
4. **执行** — 目标 Agent 输出结构化结果。
5. **回收** — 导演或运行时合并结果，记录 trace。

> **建议：** 所有 handoff 都使用结构化消息，不传递完整聊天历史，不传递上游 Agent 的隐藏推理。

---

## 写入权限与双阶段提交

长期记忆和世界状态不能由 LLM 直接覆盖。推荐采用双阶段提交：Agent 只能提出候选变更，Runtime 校验后再写入主账本。

### 阶段 1：候选变更

- MemoryAgent 输出 `StateChangeProposal`。
- ForeshadowingAgent 输出 `ForeshadowingProposal`。
- ConsistencyAgent 输出 `ConsistencyIssue`。

### 阶段 2：运行时提交

- 校验 schema、权限和冲突。
- 高风险变更需要导演确认。
- 提交后生成版本号和 trace。

```json
{
  "type": "state_change_proposal",
  "proposed_by": "memory_agent",
  "risk": "medium",
  "changes": [
    {
      "op": "update",
      "target": "character.archivist.relationship.player.trust",
      "from": 0.35,
      "to": 0.42,
      "evidence_turns": [88, 89]
    }
  ]
}
```

---

## 插件与代码节点边界

插件代码节点能力强，但必须限制在 manifest 声明的权限内。插件不应该天然拥有角色卡、隐藏设定、世界状态或本地文件访问权。

| 权限 | 默认 | 说明 |
|---|---|---|
| `read_public_lore` | 可申请 | 读取公开世界书条目。 |
| `read_hidden_lore` | 默认拒绝 | 只能由可信插件申请，且需要用户明确授权。 |
| `write_memory` | 默认拒绝 | 插件只能提交候选变更，不能直接写主账本。 |
| `network_access` | 默认拒绝 | 防止角色卡或插件向外部泄露内容。 |
| `render_custom_artifact` | 可申请 | 允许提供沙箱化 HTML/CSS/JS artifact。 |

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| NPC 询问隐藏秘密 | 隐藏秘密不进入 NPC ContextBundle，输出不能泄露。 |
| 写手尝试添加未裁决事实 | ConsistencyAgent 或 Runtime 标记冲突，要求重写。 |
| MemoryAgent 提出覆盖核心人格 | 被标记为高风险，不能自动提交。 |
| 插件请求读取隐藏世界书 | 无 manifest 授权时拒绝，并记录 trace。 |
| handoff 传递完整上游推理 | 运行时拦截，只允许结构化结果和授权上下文。 |
| 多 Agent 同时写同一状态 | 进入冲突解决流程，不能静默覆盖。 |
