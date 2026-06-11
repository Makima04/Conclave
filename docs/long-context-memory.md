# 长期记忆与叙事一致性架构

> 解决 100 轮、200 轮、40 万字、80 万字甚至百万字级 RP / 小说写作中，细节不丢、人物不 OOC、伏笔不遗忘、世界状态不混乱的问题。

`Long Context` · `Narrative State` · `Foreshadowing` · `Character Consistency` · `Memory Agent` · `Retrieval`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [技术选型](tech-selection.md)
- [Agent Runtime](agent-runtime.md)
- Agent 边界

---

## 问题定义

长篇 RP 和小说写作的失败通常不是模型不会写，而是系统没有管理叙事状态。把几十万字历史直接塞进上下文，会导致注意力下降、检索不稳定、旧事实被新文本覆盖、角色人格漂移、伏笔无法回收。

### 细节丢失

旧物品、伤势、承诺、地点、人物关系、秘密线索没有被抽取成可查询事实。

### 人物 OOC

角色核心人格、知识边界、长期目标没有被稳定注入，模型会被最近几轮风格带偏。

### 伏笔遗忘

伏笔只出现在聊天正文或摘要里，没有生命周期、重要性、触发条件和回收状态。

> **架构结论：** 平台必须把"长篇一致性"当作核心运行时能力，而不是附加记忆插件。

---

## 设计原则

### 不要依赖单一长上下文

上下文窗口再大，也不能替代结构化状态、检索、摘要和一致性检查。长上下文只是一种输入容量，不是记忆系统。

### 事实和文风分离

事件事实、人物状态、伏笔、关系变化要结构化保存；文风、氛围、语气由写手 Agent 在生成时处理。

### 角色记忆隔离

每个 NPC 只能获得自己应该知道的信息。隐藏秘密、导演计划和其他角色内心不能进入它的上下文。

### 每轮都要留下账

重要事实、状态变化、检索命中、导演裁决、伏笔变化都要进入 trace，后续可以复盘和纠错。

---

## 记忆分层

推荐最少七层。不同层的更新频率、召回方式和可见权限不同。

1. **Recent Context / 最近上下文** — 最近几轮完整消息，用于保持当下对话的自然衔接。窗口有限，不能承载长期事实。（已实现）
2. **Scene Summary / 场景摘要** — 当前场景内的滚动摘要，包括地点、参与者、当前冲突、未完成动作。（已实现，turn-level 摘要）
3. **Chapter Summary / 章节摘要** — 跨场景摘要，用于小说章节、长 RP 阶段、剧情大段落压缩。（**未实现**，当前只有 turn-level 摘要，无跨场景章节级压缩）
4. **Structured State / 结构化状态** — 人物位置、生命状态、物品、关系、目标、已知信息、世界时间、任务状态。它是长期一致性的主账本。（已实现）
5. **Event Ledger / 事件账本** — 关键事件按时间线入账，记录发生了什么、谁参与、影响了哪些状态、是否公开。（已实现）
6. **Foreshadowing Registry / 伏笔登记表** — 登记伏笔、谜团、承诺、隐藏秘密、未来回收点，状态包括 open、hinted、triggered、resolved、abandoned。（已实现）
7. **Character Profile Memory / 角色人格记忆** — 角色核心人格、语气、价值观、欲望、恐惧、禁忌、关系变化和 OOC 红线。（**完全未实现**，PersonalityCore、GrowthArc、ChangeJustification 数据模型不存在）
8. **Retrieval Memory / 检索记忆** — 关键词检索和向量检索，用于召回旧细节。召回后必须由记忆 Agent 或导演过滤，避免无关旧事污染当前轮。（已部分实现：关键词 LIKE 查询可用；向量检索和记忆 Agent 均未实现）

### 检索记忆实现（structured_events + recall）

第 8 层检索记忆基于 `structured_events` 表和 `recall.rs` 模块实现。

**structured_events 表**：由压缩 Agent 每轮自动生成的结构化事件记录，包含：

- `characters`：涉及的角色（JSON 数组）
- `location`：事件发生地点
- `action`：发生的事情（动词短语）
- `scene_type`：场景类型（encounter / dialogue / combat / travel / info / other）
- `importance`：重要性 1-5 级
- `content_hash`：规范化文本哈希，用于精确去重
- `embedding`：预留向量字段（nullable BLOB）

**召回流程（recall.rs）**：

1. 从用户输入提取关键词
2. 对 `structured_events` 执行 LIKE 查询
3. 合并关键词匹配结果与最近事件
4. 按重要性降序、轮次降序排列
5. 返回 `RecalledContext`，注入子 Agent 的 ContextBundle

**去重机制（当前状态）**：

- **精确去重**：`content_hash` 字段存在于 schema 中，但**当前未被写入**，精确去重未实际生效。
- **语义去重**：3 轮窗口内相同 `scene_type` 和重叠 `characters` 的事件合并 — **未实现**，当前仅有 id 级去重。

**向量检索**：`recall_by_embedding()` 函数存在但为**占位实现**，实际回退到关键词模式。`embedding` 字段（nullable BLOB）从未被写入数据。

---

## 角色成长与不 OOC 的边界

角色可以成长、堕落、和解、黑化、成熟或改变立场，但这种变化必须有过程、有原因、有痕迹。平台需要区分"合理成长"和"OOC 崩坏"。

### 稳定人格核心

不轻易改变的部分，包括价值观底线、核心恐惧、长期欲望、表达习惯、能力边界、知识边界和关键创伤。

- 用于判断角色是否 OOC。
- 除非有重大剧情事件，否则不能突然改写。
- 即使成长，也要保留可识别的角色连续性。

### 可演化人格状态

可以随剧情变化的部分，包括信任、关系、短期目标、情绪模式、对某事件的看法、勇气、依赖、警惕、执念。

- 每次变化都应记录触发事件。
- 变化需要幅度和速度限制。
- 重要转变需要多个事件铺垫。

| 变化类型 | 合理成长 | OOC 风险 | 系统处理 |
|---|---|---|---|
| 关系变化 | 多次互动后从戒备变成信任。 | 一轮对话后突然无条件深爱。 | 用关系状态、触发事件和变化幅度约束。 |
| 信念变化 | 经历重大打击后开始怀疑旧信念。 | 没有事件支撑就完全背叛价值观。 | 重大信念变化需要 Director 或 Consistency Agent 审核。 |
| 性格成熟 | 胆怯角色在多次成功后更敢表达。 | 突然变成完全不同的强势人格。 | 使用成长轨迹和阶段标签。 |
| 黑化 / 堕落 | 长期失去、背叛、诱惑后逐步转变。 | 为了剧情刺激突然黑化。 | 登记转变伏笔、关键事件和心理阈值。 |

### 新增数据模型

> **全部未实现。** 以下数据模型仅存在于文档设计中，代码中无对应 struct 定义。

- `PersonalityCore`：稳定人格核心和 OOC 红线。（**未实现**）
- `PersonalityState`：当前情绪、关系倾向、短期信念和行为倾向。（**未实现**）
- `GrowthArc`：成长方向、阶段、触发事件、允许变化范围。（**未实现**）
- `ChangeJustification`：人格变化的证据链。（**未实现**）

### 关键原则

- 成长不是重写角色卡，而是追加成长轨迹。
- 角色变化必须能追溯到事件账本。
- 越核心的人格变化，越需要导演或一致性审查。
- 不同角色的成长速度可以不同，但机制要通用。

---

## 每轮运行流程

每一轮生成都应该经历记忆准备、权限裁决、上下文装配、生成、审查和入账。

1. **输入解析** — Parser Agent 识别用户意图、动作类型、目标角色，输出结构化 ParsedIntent。
2. **上下文加载** — Runtime 从 messages 表加载最近 N 轮对话（`recent_context`，用于保持对话自然衔接），同时从 state_snapshots、turn_summaries、memory_events、foreshadowing 表加载压缩状态（用于长期推理）。这就是双轨上下文的核心。
3. **调度决策** — Master Agent 基于 ContextBundle + ParsedIntent 生成执行计划。
4. **子 Agent 执行** — 按 Agent 类型注入不同上下文切片（NPC 拿 scene + events + foreshadowing + recalled_structured_events，Writer 拿 scene + foreshadowing）。每个子 Agent 通过 `recall.rs` 从 `structured_events` 表召回与当前输入相关的结构化事件。
5. **叙事合成** — Writer 输出最终叙事文本，存入 messages 表（仅供前端展示）。
6. **状态压缩** — 压缩 Agent 分析 Writer 输出 + 当前上下文，生成 scene_summary + events + foreshadowing + state_changes，持久化到各自表。下一轮推理读取这些压缩状态，而非原始对话。

### 双轨上下文

核心原则：**展示给用户的上下文（messages 表）和模型推理用的上下文（压缩状态）是分离的。**

- messages 表存储用户输入 + Writer 润色输出，仅供前端回显和用户查看
- 子 Agent 推理时读取的是 ContextBundle，包含 scene_summary、events、foreshadowing、structured_state
- 每轮结束后由独立压缩 Agent 生成新的压缩状态，实现"工作记忆 + 长期记忆"双系统
- Writer 的修饰性文字不会回流到推理上下文，避免上下文膨胀和信息噪声

> **实际偏差：** Writer 输出（叙事文本）会进入 messages 表并通过 `recent_context` 被后续轮次加载，因此 Writer 输出实际上参与了后续推理上下文。文档描述的"不回流"是设计意图，当前实现尚未完全隔离。

### Knowledge Events 上下文注入

> **已实现但文档未记录。** `knowledge.rs` 模块实现了 Knowledge Events 系统：
> - `generate_knowledge_events()`：从用户输入 + 叙事输出中提取知识事件
> - `persist_knowledge_events()`：持久化到数据库
> - `load_knowledge_events()`：在 `context.rs` 中加载并注入 ContextBundle
> - 知识事件作为独立上下文层参与子 Agent 推理

---

## 核心数据模型

| 模型 | 用途 | 关键字段 |
|---|---|---|
| `CharacterState` | 保持人物长期一致性。 | 位置、状态、目标、关系、物品、已知信息、隐藏秘密、OOC 红线。 |
| `GrowthArc` | 管理角色成长、黑化、成熟、立场变化。 | 成长方向、当前阶段、触发事件、允许变化范围、证据链。 |
| `WorldState` | 保持世界事实稳定。 | 时间、地点、势力、规则、公开事件、不可逆事件。 |
| `MemoryEvent` | 记录关键事件。 | 时间、参与者、地点、摘要、影响、公开性、重要性、引用消息。 |
| `ForeshadowingItem` | 管理伏笔和未回收线索。 | 描述、创建时间、涉及角色、触发条件、状态、回收建议、重要性。 |
| `ConsistencyIssue` | 记录冲突和 OOC 风险。 | 类型、严重度、相关证据、建议修复、是否已处理。（**未实现**，数据模型不存在） |
| `ContextBundle` | 每个 Agent 的最终上下文包。 | 角色 profile、可见状态、召回记忆、当前任务、禁止信息。 |

```json
{
  "foreshadowing_item": {
    "id": "fs_blood_moon_key",
    "status": "open",
    "importance": "high",
    "description": "银钥匙上的旧王室纹章与血月仪式有关",
    "related_characters": ["player", "archivist_npc"],
    "trigger_conditions": ["player_visits_old_archive", "blood_moon_event_near"],
    "created_at_turn": 42,
    "last_hint_turn": 88,
    "resolution_plan": "在旧档案馆揭示钥匙能打开王陵侧门"
  }
}
```

---

## 多 Agent 在记忆系统中的分工

### Master Agent

- 基于 ContextBundle（recent_context + scene_summary + events + foreshadowing + structured_state）和 Parser 输出生成调度计划。
- 管理子 Agent 生命周期（创建、冷却、退休、删除）。

### 子 Agent（NPC / Writer / Director）

- 每个子 Agent 通过 `recall.rs` 从 `structured_events` 表召回相关事件。
- 上下文按 Agent 类型隔离：NPC 拿 scene + events + foreshadowing，Writer 拿 scene + foreshadowing，Director 拿完整概览。

### Compression Agent（State Agent）

- 每轮后处理，分析 Writer 输出 + 当前上下文。
- 生成 `CompressionResult`：scene_summary、events、structured_events、foreshadowing、state_changes。
- 持久化到 `turn_summaries`、`memory_events`、`structured_events`、`foreshadowing` 表。
- state_changes 通过 proposal 系统提交。

### Memory Agent / 检索过滤 Agent

> **未实现。** 文档设计中 Memory Agent 负责检索结果过滤、知识边界检查和摘要污染检测。当前召回结果直接注入 ContextBundle，无独立 Agent 过滤。

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| 200 轮后召回第 20 轮获得的物品 | 系统能从结构化状态或事件账本召回，不依赖全文上下文。 |
| NPC 不知道自己未见过的秘密 | 该秘密不进入 NPC 的 ContextBundle，输出不会泄露。 |
| 角色长期目标被最近剧情冲淡 | 角色人格记忆仍能提醒模型维持目标和底线。 |
| 伏笔 100 轮未回收 | 伏笔表仍保留 open 状态，并在合适场景提醒导演。 |
| 模型生成与旧事实冲突 | ConsistencyIssue 被记录，系统可要求重写或给出修复路径。 |
| 百万字会话继续写作 | 输入上下文由摘要、状态、事件、伏笔和相关检索组成，而不是塞入百万字全文。 |
| 角色经历多次事件后发生性格成长 | 系统能说明变化依据，GrowthArc 有阶段推进，PersonalityCore 没被无理由覆盖。 |

---

## 还必须解决的问题

除细节、OOC 和伏笔外，长篇多 Agent RP 还会遇到一组系统性问题，需要在架构上提前留位置。

- **知识边界泄露** — NPC 说出自己不该知道的秘密、导演计划或其他角色内心。（**未实现检测**）
- **时间线错乱** — 角色同时出现在两个地点，已经死亡的人继续行动，事件顺序被模型写反。（**未实现检测**）
- **关系跳变** — 好感、仇恨、信任、恐惧变化过快，没有事件支撑。
- **能力膨胀** — 角色突然拥有未设定能力，战斗和世界规则失去约束。
- **叙事节奏失控** — 模型急着揭示秘密、跳过过程、过早回收伏笔或无意义拖延。
- **设定冲突** — 新生成内容与世界书、旧事件、角色卡或插件状态互相矛盾。
- **摘要污染** — 错误摘要进入长期记忆后，会持续误导后续剧情。（**未实现检测**）
- **检索污染** — 召回了看似相关但实际不适用的旧事件，导致当前输出跑偏。
- **用户叙事权冲突** — 用户想推进剧情，但世界模式不允许直接改写事实，需要导演合理化。
