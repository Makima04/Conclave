# 动态总控架构 (Dynamic Master Architecture)

> 本文档定义 Conclave 平台的新一代 Agent 编排架构。旧架构使用固定的模板图（如 `strict_director`、`collaborative_director` 等预定义图），新架构改为由 Master Agent 动态管理子 Agent 的 4 层流水线，根据每轮故事上下文自主决定调用哪些 Agent、传递哪些信息、管理哪些生命周期。

`Dynamic Master` · `4-Layer Pipeline` · `Turn State` · `Agent Lifecycle` · `Context Isolation`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [Agent Runtime 规范](agent-runtime.md)
- [Agent 边界与权限](agent-boundaries.md)

---

## 概述

Conclave 平台采用 **4 层流水线架构**，由 Master Agent（总控）驱动，替代旧的固定模板图方案。每轮用户输入经过理解层（Parser）解析后，由 Master Agent 基于当前故事状态和子 Agent 摘要生成执行计划，子 Agent 在执行层独立运行，最终由合成层（Director + Writer + State）生成面向用户的叙事文本和状态变更。

核心变化：

- **旧架构**：用户选择运行模式 → 加载固定图 → 按图节点顺序执行。
- **新架构**：用户输入 → Parser 解析 → Master 动态决策 → 按需调用子 Agent → 合成输出。

Master Agent 不再是固定图中的一个节点，而是每轮都运行的调度中心。它决定本轮调用哪些 NPC Agent、是否激活 User Agent、是否创建新角色、是否冷却闲置角色。

---

## 核心设计原则

1. **总控 Agent 动态管理子 Agent 生命周期** -- Master 根据剧情上下文自主决定创建、调用、冷却、退休或删除子 Agent，不需要预定义图。
2. **子 Agent 独立 LLM 调用，上下文隔离** -- 每个子 Agent 有独立的 LLM 调用和专属上下文（ContextBundle），互不可见。
3. **信息通过 Turn State 共享，避免总控上下文爆炸** -- 子 Agent 输出写入内存中的 Turn State，Master 只看到每个子 Agent 的一行摘要，而非完整输出。
4. **用户可通过可视化界面管理所有 Agent** -- 用户可实时查看、手动干预所有 Agent 的状态和配置。

---

## 架构总览

### 4 层流水线

```
用户输入
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 理解层 (Parser)                                    │
│  解析用户意图、提取动作、压缩上下文                               │
│  输出: 结构化 JSON (intent, action_type, targets, ...)        │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: 决策层 (Master Agent)                               │
│  读取 Parser 输出 + 各子 Agent 一行状态摘要                      │
│  输出: 执行计划 JSON (call, inject, user_auto, lifecycle)      │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: 执行层 (Sub-Agents)                                 │
│  按 Master 计划调用 NPC Agent / User Agent                     │
│  每个 Agent 独立 LLM 调用，输出写入 Turn State                   │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: 合成层 (Director + Writer + State)                   │
│  Director 排列叙事节奏 → Writer 合成最终文本 → State 提取状态变更   │
│  输出: 最终叙事文本 + 状态变更写入数据库                           │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
输出给用户
```

---

## Layer 1: 理解层 (Understanding)

**解析 Agent (Parser)** -- 永久 Agent，每轮必运行。

| 属性 | 说明 |
|---|---|
| 输入 | 用户原始文本 |
| 输出 | 结构化 JSON |
| 目的 | 上下文压缩、意图识别、动作提取 |

### Parser 输出格式（ParsedIntent）

```json
{
  "intent": "dialogue",
  "action_type": "speak",
  "target_characters": ["张三"],
  "compressed_input": "玩家向张三询问银钥匙来历",
  "tone": "curious"
}
```

### 意图类型

| intent | 说明 |
|---|---|
| `dialogue` | 用户与 NPC 或环境进行语言交互 |
| `action` | 用户执行物理动作（攻击、移动、使用物品等） |
| `query` | 用户查询信息或状态 |
| `command` | 平台操作指令（如修改设置） |
| `narrative` | 用户以创作者身份推进剧情 |

### 动作类型

| action_type | 说明 |
|---|---|
| `speak` | 与 NPC 或角色进行语言交流 |
| `attack` | 发起战斗或攻击行为 |
| `move` | 移动或探索 |
| `examine` | 检查物品或环境 |
| `interact` | 与物品或环境互动 |
| `describe` | 创作者描述场景或事件 |
| `other` | 其他未分类动作 |

---

## Layer 2: 决策层 (Decision)

**总控 Agent (Master)** -- 永久 Agent，每轮必运行。

| 属性 | 说明 |
|---|---|
| 输入 | Parser 输出 + 所有活跃子 Agent 状态摘要（每人一行） |
| 输出 | 执行计划（纯 JSON，不包含叙事文本） |
| 上下文 | 各子 Agent 状态摘要、上轮关键事件、Parser 输出 |

### 执行计划格式（MasterPlan）

```json
{
  "calls": [
    {"agent_id": "npc_张三", "task": "回应玩家关于银钥匙的询问", "inject_from": []},
    {"agent_id": "writer_1", "task": "根据以上互动，创作叙事文本", "inject_from": ["npc_张三"]}
  ],
  "lifecycle": [
    {"action": "create", "agent_type": "npc", "character_id": "王五", "label": "王五", "reason": "新角色登场"},
    {"action": "cooldown", "character_id": "npc_赵六", "reason": "10轮未出场"},
    {"action": "delete", "character_id": "npc_钱七", "reason": "角色死亡"}
  ],
  "user_auto": false
}
```

### 计划字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `calls` | `AgentCall[]` | 本轮调用列表。每项包含 `agent_id`、`task`（具体任务描述）和 `inject_from`（可读取的其他 Agent 输出 ID） |
| `lifecycle` | `LifecycleAction[]` | Agent 生命周期操作：`create`、`cooldown`、`delete`、`restore` |
| `user_auto` | `boolean` | 是否激活 User Agent 自动生成用户行为 |

### 上下文爆炸防护

Master 只接收每个子 Agent 的一行状态摘要（如 `"npc_张三: 活跃, 当前在酒馆, 情绪平静, 上轮与玩家讨论了银钥匙"`），而非完整输出。这保证 Master 的上下文长度与子 Agent 数量线性相关，而非与输出长度相乘。

---

## Layer 3: 执行层 (Execution)

子 Agent 根据 Master 的执行计划独立运行。每个子 Agent 拥有：

- **独立的 LLM 调用** -- 不共享对话历史
- **独立的上下文 (ContextBundle)** -- 包含世界观、角色档案、Master 授权注入的其他 Agent 输出
- **输出写入 Turn State** -- 所有输出写入内存中的 Turn State，供下游读取

### 子 Agent 执行规则

1. Master 的 `call` 列表决定哪些 Agent 参与本轮
2. Master 的 `inject` 字段决定 Agent 间的信息可见性
3. 未被 call 的 Agent 本轮不执行，但保持上下文
4. 每个 Agent 只能读取 Master 授权注入的内容

### Turn State

Turn State 是本轮执行过程中的内存共享数据存储。子 Agent 写入输出，Writer 读取所有输出合成叙事。

```rust
pub struct TurnState {
    pub turn_number: i32,
    pub user_input: String,
    pub agent_outputs: HashMap<String, AgentOutput>,  // keyed by agent_id
    pub final_narrative: String,
}
```

---

## Layer 4: 压缩层 (Post-Turn Compression)

Writer 输出最终叙事文本后，由独立的 **State Agent（压缩 Agent）** 执行后处理，将本轮交互压缩为结构化状态更新。

### 压缩 Agent (State)

- 接收：用户输入 + Writer 最终叙事 + 当前 ContextBundle
- 输出：结构化 JSON（CompressionResult），包含：
  - `scene_summary`：更新后的完整场景状态摘要（覆盖式，非增量）
  - `events`：本轮新发生的有意义事件
  - `foreshadowing`：新伏笔或伏笔状态更新
  - `state_changes`：具体的状态变更提案（关系、位置、物品等）
- 持久化到对应表：`turn_summaries`、`memory_events`、`foreshadowing`、`state_snapshots`

### 为什么用独立 Agent 而非复用 Writer

- **关注点分离**：Writer 专注叙事创作，State Agent 专注信息压缩
- **上下文隔离**：Writer 不需要知道状态管理细节
- **可独立调优**：压缩模型可以使用更便宜/更快的模型

---

## 子 Agent 清单

| Agent | 类型 | 上下文 | 生命周期 |
|---|---|---|---|
| Master | 总控 | ContextBundle（scene_summary + events + foreshadowing + structured_state）+ Parser 输出 + 子 Agent 状态摘要 | 永久 |
| Parser | 理解 | 用户输入 + 最近 3 条对话 | 永久 |
| `npc_{角色名}` | 执行 | 角色档案 + scene_summary + events + foreshadowing + structured_state + 注入的 Agent 输出 | 动态（创建 → 活跃 → 冷却 → 退休/死亡） |
| User Agent | 执行 | 用户角色设定 + scene_summary + events | 按需激活 |
| Writer | 合成 | 文风预设 + scene_summary + foreshadowing + 本轮 Agent 输出 | 永久 |
| State (压缩) | 压缩 | 用户输入 + Writer 叙事 + 当前 ContextBundle | 每轮自动运行 |

---

## 子 Agent 生命周期管理

### 状态流转

```
创建(active) → 活跃 → 冷却(cooldown) → 退休(retired) / 死亡(dead)
                  ↑         |
                  └─────────┘  (重新被调用时恢复活跃)
```

### 触发条件

| 事件 | 触发者 | 说明 |
|---|---|---|
| **创建** | Master | 判断有新角色登场，或世界书初始化时预创建 |
| **冷却** | Master | 连续 N 轮未被 Master 调用（N 用户可配置，默认 10） |
| **退休** | Master | 剧情中该角色永久退场（Master 判断） |
| **死亡** | Master | 剧情中该角色死亡 |
| **恢复** | 自动 | 被冷却的 Agent 重新被 Master 调用时，自动恢复活跃 |

### 冷却策略

- **轮数冷却**: 用户可设置阈值（默认 10 轮）。超过阈值未被调用的 Agent 自动进入冷却。
- **事件触发**: Master 可以主动触发冷却（如"张三离开了房间"）。
- **冷却保留上下文**: 冷却中的 Agent 保留完整上下文，只是不被调用。恢复时可无缝继续。
- **上下文归档**: 退休/死亡的 Agent 上下文归档到事件日志，供后续回忆或闪回使用。

---

## 场景走查

### 场景 1: 用户与 NPC 对话

```
用户输入: "张三，你觉得这个银钥匙是什么来历？"
    │
    ▼ Layer 1
Parser 输出:
    {intent: "互动", action_type: "对话", targets: ["npc_张三"],
     compressed_content: "玩家向张三询问银钥匙来历", emotion: "好奇"}
    │
    ▼ Layer 2
Master 执行计划:
    {call: ["npc_张三"], inject: {}, user_auto: false, lifecycle: []}
    │
    ▼ Layer 3
npc_张三 独立运行:
    上下文 = 世界观 + 张三角色档案 + "玩家询问银钥匙来历"
    输出 = 张三的台词和反应
    写入 Turn State["npc_张三"]
    │
    ▼ Layer 4
Director: 排列张三台词的叙事节奏
Writer: 合成最终叙事文本
State: 提取可能的状态变化（如张三的好感度微调）
    │
    ▼
输出给用户: "张三接过银钥匙，翻来覆去看了几遍，眉头渐渐皱起。
            '这东西...我好像在哪里见过。'他的声音压低了几分。"
```

### 场景 2: 战斗场景（User Agent 自动补完）

```
用户输入: "拔剑，朝那个影子砍过去！"
    │
    ▼ Layer 1
Parser 输出:
    {intent: "互动", action_type: "攻击", targets: ["shadow_enemy"],
     compressed_content: "玩家拔剑攻击影子敌人", emotion: "紧张"}
    │
    ▼ Layer 2
Master 执行计划:
    {call: ["npc_shadow_enemy", "user_agent"],
     inject: {"user_agent": ["npc_shadow_enemy"],
              "npc_shadow_enemy": ["user_agent"]},
     user_auto: true, lifecycle: []}
    │
    ▼ Layer 3
User Agent 和 npc_shadow_enemy 并行执行:
    User Agent: 根据用户角色设定 + 战斗场景，自动生成用户战斗动作细节
    npc_shadow_enemy: 生成敌人的战斗反应
    两者通过 inject 互相可见对方输出
    │
    ▼ Layer 4
Director: 排列战斗叙事节奏（攻防交替）
Writer: 合成紧张的战斗叙事
State: 更新双方生命值、战斗状态
    │
    ▼
输出给用户: 完整的战斗回合叙事
```

### 场景 3: 新角色登场

```
用户输入: "酒馆的门被推开，一个身穿黑袍的老者走了进来。"
    │
    ▼ Layer 1
Parser 输出:
    {intent: "剧情安排", action_type: "新角色", targets: ["黑袍老者"],
     compressed_content: "一个黑袍老者进入酒馆", emotion: "神秘"}
    │
    ▼ Layer 2
Master 执行计划:
    {call: ["npc_张三"], inject: {}, user_auto: false,
     lifecycle: [
       {action: "create", type: "npc", character: "黑袍老者",
        reason: "用户引入新角色，进入酒馆场景"}
     ]}
    │
    ▼ Layer 3
Master 先执行 lifecycle: 创建 npc_黑袍老者 Agent（从世界书或 LLM 生成初始档案）
npc_张三: 生成张三对陌生人的反应
    │
    ▼ Layer 4
Director: 黑袍老者入场 → 张三反应 → 环境描写
Writer: 合成场景叙事
State: 记录新角色出场事件
```

### 场景 4: 纯剧情推进

```
用户输入: "三天过去了。"
    │
    ▼ Layer 1
Parser 输出:
    {intent: "剧情推进", action_type: "探索", targets: [],
     compressed_content: "时间推进三天", emotion: "平淡"}
    │
    ▼ Layer 2
Master 执行计划:
    {call: ["npc_张三", "npc_李四"],
     inject: {"npc_李四": ["npc_张三"]},
     user_auto: false, lifecycle: []}
    Master 根据故事上下文判断张三和李四在这三天中可能有相关剧情
    │
    ▼ Layer 3
npc_张三: 生成张三这三天的动态
npc_李四: 生成李四这三天的动态（可读取张三的输出）
    │
    ▼ Layer 4
Director: 以蒙太奇方式排列三天的时间线
Writer: 合成时间流逝的叙事
State: 更新时间线、角色位置、关系变化
```

### 场景 5: 数值变化

```
用户输入: "/set 张三 好感度 +10"
    │
    ▼ Layer 1
Parser 输出:
    {intent: "系统指令", action_type: "数值修改", targets: ["npc_张三"],
     compressed_content: "修改张三好感度 +10", emotion: null}
    │
    ▼ Layer 2
Master 执行计划:
    {call: [], inject: {}, user_auto: false,
     lifecycle: []}
    系统指令无需调用子 Agent
    │
    ▼ Layer 3
无子 Agent 执行。数值变更直接进入 Turn State。
    │
    ▼ Layer 4
State Agent: 直接应用数值变更到数据库
    │
    ▼
输出给用户: "张三的好感度: 45 → 55"
```

---

## 信息流控制

### 总控 Agent 上下文管理

Master 的上下文通过 ContextBundle 注入，保证不随剧情增长而爆炸：

| 输入项 | 来源 | 说明 |
|---|---|---|
| Parser 输出 | `ParsedIntent` 结构体 | 本轮用户输入的结构化解析 |
| 子 Agent 状态摘要 | `sub_agents` 表 | 每个活跃 Agent 的一行摘要 |
| 场景摘要 | `turn_summaries` 表 | State Agent 生成的当前场景状态 |
| 已知事件 | `memory_events` 表 | 最近 20 条记忆事件 |
| 伏笔线索 | `foreshadowing` 表 | 状态为 open/hinted 的伏笔 |
| 世界状态 | `state_snapshots` 表 | 当前版本的结构化状态快照 |

Master 不读取原始 messages 表。它基于压缩后的结构化信息做调度决策。

### 子 Agent 间信息传递

子 Agent 之间的信息传递完全由 Master 的 `inject` 字段控制：

- **默认隔离**: 子 Agent 之间默认互不可见
- **按需注入**: Master 通过 `inject` 指定哪些 Agent 可以读取哪些 Agent 的输出
- **单向可见**: `inject: {"npc_李四": ["npc_张三"]}` 表示李四可以读取张三的输出，但张三看不到李四的

典型注入场景：

| 场景 | 注入策略 |
|---|---|
| 同一房间内对话 | 互相注入 |
| 不同房间各自行动 | 不注入 |
| 战斗中攻防 | 互相注入（需要知道对方动作） |
| 谋划秘密行动 | 只单向注入（知情方 → 不知情方不注入） |

---

## 双轨上下文架构

### 核心问题

Writer 输出给用户的是经过润色的叙事文本。如果把这份文本直接作为下一轮子 Agent 的推理上下文，会导致：
- **上下文膨胀**：修饰性文字占据大量 token 但无推理价值
- **信息噪声**：子 Agent 需要的是事实和状态，不是文学描写
- **违背分层初衷**：多层架构的目标之一就是缓解上下文压力

### 解决方案：展示上下文 ≠ 推理上下文

```
展示给用户的上下文（messages 表）：
  用户输入 → Writer 润色输出 → 前端展示
  ↓ 存入 messages 表，仅供前端回显

推理用的上下文（压缩状态）：
  state_snapshots + turn_summaries + memory_events + foreshadowing
  ↓ 由 ContextBundle 组装，传入子 Agent
```

### 数据流

```
Turn N:
  用户输入
    ↓
  Parser → 结构化意图
    ↓
  ContextBundle 加载（structured_state + events + foreshadowing + scene_summary）
    ↓
  Master 调度（基于上下文 + 意图）
    ↓
  子 Agent 执行（每个收到上下文切片 + 任务）
    ↓
  Writer → 叙事文本 → 存入 messages 表（仅供展示）
    ↓
  压缩 Agent → scene_summary + events + foreshadowing + state_changes
    → 存入各自表

Turn N+1:
  ContextBundle 从 state/events/foreshadowing/summaries 表读取
  （不从 messages 表读取原始对话用于推理）
```

### 上下文注入策略（按 Agent 类型）

| Agent 类型 | 收到的上下文 | 不收到的 |
|---|---|---|
| NPC | scene_summary + events + foreshadowing + structured_state | 原始对话历史、其他 NPC 内心 |
| Writer | scene_summary + foreshadowing + 本轮其他 Agent 输出 | 原始对话历史、完整 events |
| Director | scene_summary + events + structured_state | 原始对话历史 |
| User Proxy | scene_summary + events（最近 5 条） | 完整 events、foreshadowing |
| Master | 结构化意图 + agent 状态摘要 + scene_summary + events + foreshadowing | 原始对话、完整状态 JSON |

---

## 用户可配置参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `master_model` | 用户选择 | 总控 Agent 使用的模型 |
| `sub_agent_model` | 用户选择 | 子 Agent 使用的模型 |
| `compression_model` | 同 sub_agent_model | 压缩 Agent 使用的模型（可独立配置以节省成本） |
| `cooldown_turns` | 10 | 多少轮不活跃进入冷却 |
| `user_auto_mode` | `"ask"` | User Agent 自动模式: `ask`（每次询问）/ `always`（总是自动生成）/ `never`（禁用） |
| `max_active_agents` | 8 | 最大同时活跃子 Agent 数 |
| `parser_enabled` | `true` | 是否启用解析 Agent（禁用时用户输入直接进入 Master） |

---

## 与世界书的集成

### 世界书解析流程

```
世界书输入 (SillyTavern JSON / 自定义格式)
    │
    ▼ 纯代码解析器 (不调用 LLM)
    │
    ├─ world_lore      → 全局世界观 ──→ 注入所有 NPC Agent
    ├─ characters[]     → 每个角色独立档案 ──→ 创建对应 npc_agent
    ├─ writing_style    → Writer Agent 上下文
    ├─ parser_rules     → Parser Agent + State Agent 上下文
    └─ relationships    → 角色间关系图 ──→ 注入相关 NPC Agent
```

### 世界书格式支持

| 阶段 | 格式 | 说明 |
|---|---|---|
| Phase 1 | SillyTavern character card JSON | 兼容现有生态，快速导入 |
| Phase 2 | 自定义 Conclave 世界书格式 | 平台原生格式，支持完整特性 |
| Phase 3 | Markdown 自由格式 | LLM 辅助解析，降低创作门槛 |

世界书解析是纯代码操作，不涉及 LLM 调用。解析结果直接用于初始化 Agent 上下文和创建子 Agent。

---

## 可视化管理

### Agent 管理面板

- **实时状态**: 查看所有 Agent 的当前状态（active / cooldown / retired / dead）
- **手动干预**: 手动创建、删除、冷却 Agent
- **上下文查看**: 查看每个 Agent 的当前上下文和最近输出
- **配置修改**: 修改 Agent 配置（模型、system prompt、冷却阈值）
- **关系图**: Agent 间关系图可视化（谁可以看到谁的输出）

### Turn 执行可视化

每轮执行过程全程可追溯：

1. **Parser 输出** -- 查看用户输入的结构化解析结果
2. **Master 执行计划** -- 查看 Master 的调度决策（调用谁、注入什么、生命周期操作）
3. **子 Agent 输入/输出** -- 查看每个子 Agent 收到的上下文和生成的输出
4. **Turn State 数据流** -- 查看数据在 Agent 间的流动路径
5. **最终合成结果** -- 查看 Director pacing、Writer 最终文本和 State 变更

可视化面板面向两类用户：

- **普通用户**: 简化视图，查看哪些角色参与了本轮、最终叙事和状态变化
- **高级创作者/调试者**: 完整 trace 视图，查看每个 Agent 的输入输出和决策过程
