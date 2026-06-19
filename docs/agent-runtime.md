# Agent Runtime 规范

> 定义平台自己的 RP Agent 编排内核：如何选择运行模式、执行 Agent 图、装配上下文、控制权限、提交状态、记录 trace，以及如何支持高级自由图但保持安全边界。

`RP Runtime` · `Agent Graph` · `Structured Output` · `Variable Tool Agent` · `Knowledge Boundary` · `Trace` · `Advanced Graph`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [Actor Agent 架构](actor-agent-architecture.md)
- Agent 边界

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
3. **Layer 1: Parser**（可选，`parser_enabled` 配置） — 解析用户意图，输出 `ParsedIntent`。Parser 失败时不阻断流程，后续步骤继续。Parser 仅看最近 3 条对话，每条以尾部优先截断到 10000 字（保留消息结尾，即长开场白的"当前剧情位置"）。
4. **Layer 2: Master** — 基于上下文 + 意图 + 子 Agent 摘要，生成 `MasterPlan`（含 `final_writer_id` 可选字段，指定多 Writer 时的最终叙事者）。Master 仅看最近 6 条对话，每条以尾部优先截断到 10000 字。

> **历史截断策略**：Parser/Master 这类规划 Agent 对每条 recent_context 采用**尾部优先**截断（`truncate_str_tail`，上限 10000 字）。原因——长开场白（如 2000+ 字的 first_mes）的结尾（角色变身、新场景切换等）反映"剧情当前位置"，必须让规划层看到；早期版本按头部截断到 200/300 字会丢失结尾，导致 Master 把场景误判成"还在开场白开头"，级联 Director/Writer 重写整段开场（典型症状：首轮回复接不上开场白剧情）。Director/Writer 不做逐条截断，直接拿到全文（受 `max_context_turns` 轮数限制）。
>
> **角色 Agent 不收原文（心智隔离 / 防全知）**：NPC 与 User Agent **不注入 `recent_context`**（最近对话原文）。它们只拿到：本轮 Parser 的 `compressed_input`（去修辞压缩意图，注入到 user 消息）+ 以自身为 knower 过滤后的 `knowledge_events` 感知流（注入 system 段「已知事实」）+ Master 授权的 `inject_from`。原因——把 Writer 润色后的叙事原文回灌给所有角色 Agent 会让每个角色全知，违背分层心智隔离的初衷。Writer/Director 作为全知合成器（叙事者/GM）仍保留 `recent_context`。
>
> **世界书按 ST 语义激活（不再全量灌入）**：世界书条目的激活（何时注入）由运行时 `is_entry_activated`（context.rs）按 SillyTavern 标准语义判断，**在 ContextBundle 构建阶段（load）一次性完成，全 Agent 一致**：①`constant=true` 恒注入；②`constant=false` 且无 key → 保守当常驻；③`constant=false` + `selective=false` → 主 key 命中本轮「激活文本」才注入；④`constant=false` + `selective=true` → 主 key 命中 **且** 次键按 ST `selective_logic`（0=AND ANY / 1=NOT ALL / 2=NOT ANY / 3=AND ALL）组合。激活文本 = `recent_context` 各消息内容 + 当前 `scene_summary`（近似 ST 对 chat context 的 key-scan）。解析器（worldbook_parser）只负责**路由**（category/visibility），把 `constant`/`keys`/`selective`/`secondary_keys`/`selective_logic` 透传；`priority` 保留原始值（不再写死 100）。visibility 路由（`visible_worldbook_entries`，sub_agent.rs）在激活之后做 per-Agent 可见性过滤。
>
> **system 段拼接顺序 = 稳定前置 / 动态后置（prompt cache 友好）**：`build_contextual_system_prompt`（sub_agent.rs）按前缀稳定性分两段拼。**稳定前缀**（跨轮可缓存）：角色定义 → 你的专属上下文 → 预设指令 → 世界书设定 → 当前参与角色。**动态尾巴**（每轮变，不缓存）：当前场景 → 已知事件 → 伏笔线索 → 世界状态 → 已知事实 → 最近对话 → 召回的相关事件。原因——DeepSeek/OpenAI 的 prompt cache 按**前缀 hash** 命中，第一个分叉字节之后全 miss；任何中间生长的块（如 `已知事实` 每轮 +1）会把它后面所有字节整体后移，哪怕后面内容一字不差也断 prefix。Master 的 system 消息保持**纯静态**（规则 + JSON schema），scene/state/events/foreshadow 移到 user 消息。可缓存前缀扩大后，`cached_tokens` 显著上升（Inspector 每个 agent card / 每轮聚合显示缓存率）。
5. **Plan Validator** — 校验 Master 计划：移除不存在的 Agent、截断超长 task（2000 字符）、校验 `inject_from` 依赖、cap 调用数至 `max_active_agents`、阻止删除永久 Agent、限制 lifecycle 操作数至 5。
6. **Runtime 注入 State Agent** — 若存在 `_state_agent_writable` 变量且 Master 未显式调用 State Agent，Runtime 自动将其注入 DAG，依赖所有 NPC/User Agent 的输出。
7. **Runtime 注入 User Agent（`user_auto`）** — 当 Master 计划 `user_auto=true`（战斗 / 需自动补完玩家物理动作的回合）且存在 User Agent、计划未显式调用它时，Runtime 自动把 User Agent 注入 DAG：`inject_from` = 本轮被调用的 NPC（让玩家补完时能看到 NPC 动作），并把 User Agent id 追加进 Writer 的 `inject_from`（让 Writer 合成玩家动作）。注意 DAG 不允许环，文档「战斗互相注入」在运行时简化为 NPC→User Agent→Writer 的串行依赖（`compile_dag`）。
8. **Lifecycle** — 执行计划中的生命周期操作（create/cooldown/delete/restore）。
9. **Layer 3: Sub-Agents (DAG)** — 按计划调用子 Agent。调用列表编译为 DAG，同一层级的 Agent 并发执行（`dag.rs`），**并发上限 `MAX_CONCURRENT_AGENTS=4`**。每个 Agent 有独立上下文和 LLM 调用。State Agent 收到 `update_variables` tool，通过 tool call 直接持久化变量变更。
10. **Fallback Writer** — 若无 Writer 被调用，自动调用默认 Writer（优先使用 `final_writer_id` 指定的 Writer）。
11. **Extract Narrative** — 从 Writer 输出提取最终叙事文本。
12. **Post-commit（非致命）**：
    - **Compression** — 压缩 Agent 分析输出，生成 scene_summary + events + foreshadowing + state_changes，写入对应表。压缩也可通过 `turn_jobs` 后台队列异步执行（如 recompression）。
    - **Knowledge Extraction** — 从用户输入 + 最终叙事中抽取"谁知道什么"事实，写入 `agent_knowledge_events` 表。
13. **Record Traces & Debug Snapshots** — 记录每个 Agent 的执行 trace 和完整调试快照（含 system_prompt、user_prompt、tool_calls、injected_outputs、`prompt_tokens`/`completion_tokens`/`cached_tokens` 等）。`cached_tokens` 来自 provider `usage.prompt_tokens_details.cached_tokens`（OpenAI/DeepSeek prompt cache 命中），存入 `agent_call_debug_snapshots.cached_tokens` 列，经 `get_debug_turn` / 轮次聚合吐出，前端 Inspector 的每个 agent card 与每轮聚合显示「缓存命中 token 数 + 缓存率」。

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

State Agent 通过 `update_variables` tool call 提交本轮**增量**变量变更，后端做**字段级整值 + ST 式 merge + 写入前校验**后落库。**不使用 `pending_proposals` 审批表，不使用风险分级门控。**

写回语义（对齐 SillyTavern / JS-Slash-Runner `mergeWith`，见 `card_state_adapter::merge_variables`）：每个字段是原子单位，LLM 给出该字段的**完整新值**，后端整体替换。对 `[value, 说明]` 数组变量，LLM 给完整新数组（说明通常原样保留），后端整体替换——**不存在把标量塞进 `[0]` 槽位的半截写入**，因此不会产生 `[[value, 说明], 说明]` 双重包装。

写入前校验（`runtime/variable_validation.rs`，在 `persist_normalized_changes_tx` 合并前对每个 change 跑）：只做**确定性、通用**规则，非法的**丢弃单个字段 + `tracing::warn`**，不打断其余字段、不二次调 LLM：

- **类型同构**：现值是数组→新值必须数组；现值是布尔→新值必须布尔。
- **数值范围**：数值字段的 `说明` 文本里的 `范围[min-max]` 标记会被提取（正则），越界值丢弃。提取不到范围则跳过（不误杀）。
- **拒绝 yes/no / 解释串**：`Yes`/`No`/`是`/`否` 及 `Yes (…)`/`No (…)` 形式一律丢弃（LLM 把"是否变化"误当成新值）。
- **拒绝空串/纯空白**。
- `add`/`remove` 结构操作跳过值校验（只校验路径）。

| 属性 | 说明 |
|---|---|
| 工具 | `update_variables`：基于当前变量定义动态生成 JSON Schema（数组字段要求完整新数组、数值字段带 `范围`），State Agent 通过 tool call 提交增量变更 |
| 粒度 | 只报本轮真正变化的字段（prompt 约束 + 范围/类型校验） |
| 持久化 | 变更聚合成 patch → `merge_variables` 整对象深合并（数组整体替换）→ 写 `session_variables` + 镜像到 `state_snapshots` 新版本 |
| 校验 | `variable_validation::validate_change` 写入前逐条校验，非法字段丢弃 |
| 触发方式 | Master 显式调用，或 Runtime 自动注入（当 `_state_agent_writable` 非空且 Master 未包含 State Agent 时） |
| Single-agent 模式 | 同样使用 Variable Tool Agent 提案 + 持久化变量变更 |

> 前端 `store.ts::deepMerge` 已是数组整体替换语义，与后端 `merge_variables` 一致，无需改动。脏数据（历史 `[[v,d],d]` / 裸 `Yes`/`No`）可用 `state_initializer::reinitialize_session_state_from_world_book(force_reset=true)` 重置——InitVar 源是干净的。

### Compression

压缩 Agent（异步 post-commit）生成结构化状态更新：

- `scene_summary`：覆盖式场景状态摘要。
- `events` + `structured_events`：本轮有意义事件。
- `foreshadowing`：伏笔状态更新。
- `state_changes`：直接写入 `state_snapshots`，无审批流程。

### Knowledge Extraction

每轮 post-commit 阶段，从用户输入 + 最终叙事中抽取"谁知道什么"事件，写入 `agent_knowledge_events` 表。详见 Agent 边界与权限中的知识边界系统。

---

## Provider 调用与断线重连

所有 LLM 调用走 `backend/src/provider/openai.rs` 的 `OpenAiProvider`。`ProviderError`（`provider/adapter.rs`）按**可重试性**分两类，决定一次失败是自动重试还是立即终止整轮：

- **`Network`（可重试）**：连接失败 / 超时 / DNS / TLS（`reqwest::Error` 的 `is_connect()` / `is_timeout()`），以及服务端响应 5xx、429。属于瞬时抖动——重新发送通常就成功。
- **`Http`（不可重试）**：其它 4xx（401/403/400/404 等，认证 / 参数 / 模型不存在）。重试只会重现同样的失败，立即抛出。

### 自动重试（用户无感）

- **非流式**：`chat_completion_with_retry(request, 3)` 对「瞬时网络错误 `Network`」**和**「模型返回空内容」都重试，指数退避 ≈ 0.8s / 1.6s / 3.2s（+抖动）。7 个调用点（master、sub_agent、3 处 executor、streaming）签名不变，自动获得网络重试。不可重试的 `Http`/`Parse` 立即失败。
  - 例外保留：tool_choice 请求（如 Variable Tool Agent）合法地以 `content=""` + `tool_calls` 返回，**不**触发空内容重试。
- **流式**：`chat_completion_stream_with_connect_retry` 仅对**建连阶段**的 `Network` 错误重试（请求还没拿到响应时）。一旦连上、token 已经在流中，中途断流**不**重试——已发出的 token 不可复现，继续接续会产出错乱文本。

### 失败兜底：整轮重试（手动「重试本轮」）

若重试耗尽或遇到不可重试错误，错误经 `turn_service` → `stream_error` SSE 事件送达前端，整轮终止。此时：

- **DB 状态干净**：`turn_finalizer` 的核心事务（user 消息 + assistant 消息 + `current_turn` 自增）在 turn **成功后**一次性提交，失败时无残留消息、`current_turn` 未递增。
- **状态机天然支持重入**：`mark_failed_generation` 把 session 置为 `failed_generation`，而 `acquire_processing_status` 的 WHERE 子句**包含** `failed_generation`，重新发送即可重新进入 processing。
- **前端兜底**：`ChatPane` 缓存本轮输入（`lastInputRef`，即便输入框已在发送时清空），`InputDebugRail` 在 `stream_error` 且非流式时显示「重试本轮」按钮 → 调 `controller.retryLast()` 用同一条输入重新 `sendMessage`，等价于干净重跑该 turn。

### 前端重连：切页再切回仍显示「运行中」

多 agent 轮次可能耗时数分钟。前端 `streaming` 状态本是组件内 `useState`，组件卸载（切到别的页面）即丢失；若不处理，切回来时即使后端仍在跑也不显示「运行中」。补全路径：

- **后端广播 + 注册表**：`POST /messages` 在 `active_turns`（`runtime/executor.rs`）里登记该 session 的 `broadcast::Sender`，整轮事件（`TurnStart`/`AgentStatus`/`MessageDelta`/`StreamError`/`StateUpdate`/`TurnEnd`/`TurnReady`）都广播；`TurnReady`/`TurnEnd` 时移除登记。
- **重连端点**：`GET /api/sessions/:id/reconnect`（`routes/messages.rs::reconnect_stream`）对活动轮 `broadcast_tx.subscribe()`，新订阅者从此刻起的后续事件原样收到；无活动轮返回 `404 no_active_turn`。
- **前端自动重连**：`StHost` 与 `ChatPane`（`/chat`）在（重新）挂载后查一次 session，`status === 'processing'` 即调 `api.reconnectStream`（`api/client.ts`）订阅。`reconnectStream` 收到 200 才回调 `onActive → setStreaming(true)`，**收到 404（无活动轮）静默 `onDone` 不亮灯**——避免无谓闪烁。已流出的 token（广播只发未来事件）不会回放，但后续 token 正常追加、`TurnEnd` 时以服务端完整 `message_content` 落定。
- **避免重连抖动**：`reconnectSessionRef` 保证每个 session 每次挂载最多重连一次；轮次正常结束后的 reload 看到 `status=idle` 即为 no-op。

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
