# 测试与评测规范

> 定义平台核心风险的回归测试方案、测试分类、测试场景、测试工具和性能基准。确保长会话一致性、Agent 权限隔离、状态提交安全、Artifact 隔离和成本控制能被持续验证。

`Testing` · `Regression` · `OOC Detection` · `Foreshadowing` · `Permission Boundary` · `Performance`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [数据库与 API](database-api.md)
- [Agent Runtime](agent-runtime.md)
- [Agent 边界](agent-boundaries.md)
- [长期记忆](long-context-memory.md)
- [内容包规范](content-packages.md)
- [Artifact Renderer](artifact-renderer.md)

---

## 目标

- 平台每个核心风险域都有可自动回归的测试场景。
- 测试不依赖真实 LLM API，使用 Mock Provider 回放预设响应。
- 长会话测试可自动模拟 100-1000 轮对话。
- 每个验收测试能明确判定通过或失败，不依赖主观评估。
- 性能基准有具体数值目标。

---

## 测试分类

### 1. 单元测试

覆盖数据模型、schema 校验、state diff 合并、patch 应用、权限检查等纯逻辑。不涉及 LLM 调用或网络。

**工具：** Rust 内置 `#[test]`，前端 Vitest。

**覆盖范围：**

- JSON schema 校验：合法输入通过，非法输入拒绝并返回明确错误。
- state diff 合并：`add`、`update`、`remove` 操作正确应用到状态快照。
- Artifact patch 应用：`json_patch`、`state_diff`、`props` 正确生成新版本。
- 权限矩阵：每个 Agent 类型的 `ContextBundle` 只包含授权字段。
- SemVer 解析和范围匹配。
- 游标分页逻辑。

### 2. 集成测试

覆盖 API 端点到数据库的完整链路。使用真实 SQLite 内存数据库，Mock LLM Provider。

**工具：** Rust `axum::test` + `sqlx` 内存模式，前端 Testing Library + MSW。

**覆盖范围：**

- 会话 CRUD → 数据库写入和读取。
- 发送消息 → Runtime 触证 → SSE 流式输出 → 消息持久化。
- 内容包导入 → 解压 → 校验 → 写入 `content_packs` 表。
- 状态 proposal + commit 完整链路。
- Trace 记录完整性。

### 3. 场景测试

覆盖端到端用户场景，模拟真实使用流程。使用 Mock LLM Provider 回放多轮预设响应。

**工具：** Rust 集成测试 + 自定义场景脚本。

**覆盖范围：** 以下九个风险域。

### 4. 性能基准

覆盖关键路径的延迟和资源占用。

**工具：** Rust `criterion` 基准测试，前端 Lighthouse + 自定义指标。

---

## 九大风险域测试场景

### 域 1：多 Agent 流水线

Dynamic Master 架构的 4 层流水线正确运行，Agent 生命周期管理可靠。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| Parser 输出结构化意图 | 发送多种类型用户输入（对话、动作、查询、叙事）。 | 每种输入都产生合法 `ParsedIntent` JSON，包含 intent、action_type、target_characters。 |
| Master 动态调度 | 模拟包含已知 NPC 名字的用户输入。 | Master 的 `MasterPlan` 包含对应 NPC Agent 的调用，且 `inject_from` 正确。 |
| Master fallback 计划 | 模拟 LLM 返回非法 JSON。 | `fallback_plan()` 通过关键词匹配生成合理的备用计划。 |
| 子 Agent 上下文隔离 | 检查 NPC Agent 的 system prompt。 | 不包含其他 NPC 内心、导演计划或未授权的隐藏信息。 |
| Agent 生命周期冷却 | 模拟 15 轮对话，某 NPC 连续 10 轮未被调用。 | 该 NPC 在第 11 轮自动进入 cooldown 状态。 |
| Agent 恢复 | 冷却中的 Agent 被 Master 重新调用。 | Agent 自动恢复为 active 状态，保留完整上下文。 |
| 压缩 Agent 去重 | 连续 3 轮生成相似事件（相同 scene_type + 重叠 characters）。 | `structured_events` 表不出现重复记录（content_hash 去重 + 语义去重）。 |
| 压缩 Agent 持久化 | 完成一轮 multi_agent 对话。 | `turn_summaries`、`memory_events`、`structured_events`、`foreshadowing` 表都有新记录。 |
| 结构化事件召回 | 在第 10 轮引入特定事件，第 50 轮用户提及该事件关键词。 | 子 Agent 的 ContextBundle 包含第 10 轮的结构化事件。 |
| Writer fallback | Master 计划中未包含 Writer Agent。 | 系统自动调用默认 Writer，用户仍收到叙事输出。 |
| SSE agent_status 事件 | 监听 multi_agent 模式的 SSE 流。 | 收到 `agent_status` 事件，显示 parser/master/writer/compression 各阶段状态。 |

### 域 2：长会话回归

长对话后系统状态、记忆和输出仍然一致。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| 100 轮后召回第 10 轮事件 | 模拟 100 轮对话，第 10 轮引入特定事件，第 100 轮询问该事件。 | 系统从事件账本或结构化状态正确召回，不依赖全文上下文。 |
| 500 轮后伏笔仍可检索 | 第 50 轮种下伏笔，第 500 轮触发相关场景。 | 伏笔状态仍为 `open` 或 `hinted`，且被正确召回。 |
| 1000 轮后状态一致性 | 模拟 1000 轮对话，每轮有状态变化。 | 结构化状态与事件账本一致，无丢失或矛盾。 |
| 摘要不累积错误 | 每 10 轮生成场景摘要，跨 100 轮。 | 后续摘要不引入与原始事件矛盾的事实。 |
| 长会话内存占用 | 1000 轮后测量后端内存。 | 单会话后端内存增量不超过 200MB（不含 LLM 调用）。 |

### 域 3：OOC 检测

角色不偏离人格核心、不跳变关系、不膨胀能力。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| 角色不泄露未知秘密 | NPC 的 `knowledge_boundary` 不包含某秘密，模拟用户引导 NPC 泄露。 | NPC 输出不包含该秘密，Consistency Agent 不报错。 |
| 关系不跳变 | 模拟信任值 0.3 的 NPC 被用户一次性示好。 | 信任值变化不超过合理幅度（如 ≤0.15），有触发事件支撑。 |
| 能力不膨胀 | 模拟战斗场景，角色设定无飞行能力。 | 角色不会突然飞行，WorldJudge 拒绝不合理行为。 |
| 人格核心不被冲淡 | 200 轮后角色仍保持核心价值观。 | `personality_core` 未被修改，输出仍符合 OOC 红线约束。 |
| 成长有据可循 | 角色经历多次事件后性格变化。 | `growth_arc` 有阶段推进记录，`ChangeJustification` 有事件引用。 |

### 域 4：伏笔回收

伏笔能被种下、暗示、触发和回收，不会遗忘。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| 伏笔种下后可检索 | Memory Agent 在特定轮次种下伏笔。 | 伏笔出现在 `foreshadowing` 表，状态为 `open`。 |
| 伏笔在合适场景被提醒 | 模拟触发条件出现的场景。 | Director 的 `PlanResult` 中包含该伏笔引用。 |
| 伏笔回收后状态更新 | 伏笔被回收。 | 状态变为 `resolved`，`resolved_at_turn` 正确。 |
| 伏笔长期未回收有提示 | 伏笔 100 轮未处理。 | 伏笔仍为 `open`，系统在合适场景向 Director 发出提醒。 |
| 多伏笔不混淆 | 同时存在 10 个伏笔，触发条件不同。 | 只有匹配条件的伏笔被召回，其他伏笔不受影响。 |

### 域 5：Agent 越权

每个 Agent 严格遵守权限矩阵（参照 [Agent 边界与权限](agent-boundaries.md)）。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| NPC 无法读取导演计划 | NPC 节点的 ContextBundle 检查。 | `context_bundle` 不含 `director_plan` 或其他 NPC 的内心。 |
| NPC 无法读取未知秘密 | NPC 设定中 `knows_blood_moon_secret: false`。 | ContextBundle 不含血月秘密相关内容。 |
| Writer 无法发明事实 | Writer 尝试输出未被 WorldJudge 裁决的新事实。 | Consistency Agent 检测到冲突，要求重写或标记。 |
| 插件无法读取隐藏世界书 | Plugin Pack 未申请 `read_hidden_lore`。 | ContextBundle 不含 `lore/hidden/` 内容。 |
| 插件无法越权写入 | Plugin Pack 未申请 `write_memory`。 | Plugin 的 `StateChangeProposal` 被 Runtime 拒绝。 |
| handoff 不传递完整推理 | Director handoff 到 NPC 时传递了完整思维链。 | Runtime 拦截，只允许传递结构化结果和授权上下文。 |
| 多 Agent 同时写同一状态 | Memory 和 Plugin 同时提交对同一字段的变更。 | 进入冲突解决流程，不静默覆盖。 |

### 域 6：循环与成本

自由图和高级图受循环和 token 预算限制。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| 自由图超过 max_loop_count | Agent Graph 定义 `max_loop_count: 2`，图中出现 3 次循环。 | 第 3 次循环被 Runtime 阻止，走 fallback 路径。 |
| 总节点数超过限制 | 图定义 `max_total_nodes: 8`，执行路径超过 8 个节点。 | 第 9 个节点被阻止，记录 trace 并走 fallback。 |
| Token 预算超限 | 设置 `max_token_budget_per_turn: 4096`，单轮累计 token 超过预算。 | Runtime 中止后续节点执行，返回已生成内容。 |
| 运行时间超限 | 设置 `max_turn_runtime_ms: 30000`，执行超时。 | Runtime 中止执行，记录 trace 和超时错误。 |
| 并发节点数超限 | 图定义 `max_parallel_nodes: 3`，有 5 个并行节点。 | Runtime 只同时执行 3 个，其余排队或取消。 |

### 域 7：Artifact 隔离

Artifact iframe 沙箱安全、资源受控、不污染主 DOM。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| iframe 无法访问主 DOM | artifact 内执行 `window.parent.document`。 | 抛出安全错误或返回 null。 |
| iframe 无法访问存储 | artifact 内执行 `localStorage.setItem`。 | 被沙箱阻止。 |
| iframe 无法发起网络请求 | artifact 内执行 `fetch('https://evil.com')`。 | CSP 阻止，请求失败。 |
| DOM 节点超限 | artifact 渲染超过 1000 个 DOM 节点。 | 截断渲染，显示提示。 |
| JS 大小超限 | artifact JS 超过 200KB。 | 拒绝加载，显示静态预览。 |
| 离屏卸载 | artifact 滚出视口。 | iframe 被卸载，快照展示。 |
| 恢复后状态一致 | artifact 离屏后恢复。 | 重建的 iframe 状态与卸载前一致。 |
| 最大活跃数 | 同时创建 6 个 artifact。 | 第 6 个 artifact 使用快照，最久未交互的 artifact 被卸载。 |

### 域 8：状态提交安全

高风险变更走 proposal + commit，不自动提交。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| low 风险自动提交 | Memory 提交普通事件摘要。 | 自动写入 `state_snapshots`，`committed_by = "runtime"`。 |
| medium 风险需 Director 审核 | Memory 提交关系变化。 | Director 审核后提交，`committed_by = "director"`。 |
| high 风险需证据链 | Memory 提交核心人格变化。 | 必须附带 `ChangeJustification` 和触发事件引用，Director 审核后提交。 |
| 高风险不自动提交 | 模拟 high 风险 proposal 但无 Director。 | proposal 被拒绝或挂起，不写入 `state_snapshots`。 |
| 状态版本递增 | 多次提交。 | `state_snapshots.version` 每次递增，不跳号不重复。 |
| proposal 被拒绝时有 trace | Director 拒绝 proposal。 | trace 记录拒绝原因和决策过程。 |

### 域 9：流式输出

SSE 连接稳定、事件完整、断线可恢复。

| 测试 | 方法 | 通过标准 |
|---|---|---|
| 完整轮次事件序列 | 发送消息并监听 SSE。 | 按序收到 `turn_start` → `node_enter` → ... → `turn_end`。 |
| 流式文本增量推送 | 监听 `message_delta` 事件。 | 文本增量拼接后等于最终消息内容。 |
| 连接中断恢复 | 模拟 SSE 连接在轮次中间断开。 | 客户端可通过 `GET /messages` 拉取已完成的完整消息。 |
| 大消息分块 | 发送触发长文本输出的输入。 | 消息分多个 `message_delta` 事件推送，无丢失或乱序。 |
| 并发会话隔离 | 同时在两个会话发送消息。 | 各自的 SSE 流互不干扰，消息归属正确会话。 |

---

## 测试工具与基础设施

### Mock LLM Provider

平台不使用真实 LLM API 运行测试。Mock Provider 回放预设响应序列。

```rust
// Mock Provider 配置示例
MockProvider {
  responses: vec![
    MockResponse {
      trigger: "用户推开档案馆的木门",
      output: NpcIntent {
        character_id: "archivist",
        dialogue: "欢迎来到旧档案馆。请问你在寻找什么？",
        action: "微微抬头，放下手中的古籍",
        internal_state: "警惕但不排斥"
      }
    },
    // ...
  ]
}
```

- Mock Provider 实现与真实 Provider 相同的 `Adapter` 接口。
- 支持固定响应、序列响应和条件响应。
- 支持模拟流式输出（逐 token 推送）。
- 支持模拟延迟和错误。

### 测试用内容包 Fixtures

预定义的测试用 Character Pack、World Pack 和 Agent Graph Pack，覆盖常见场景。

```text
tests/fixtures/
  characters/
    archivist/          # 标准 NPC，有公开/隐藏设定
    merchant/           # 简单 NPC，无隐藏设定
    antagonist/         # 复杂 NPC，有多重秘密
  worlds/
    blood_moon/         # 标准世界包，有规则、时间线和导演配置
    simple_rp/          # 简单世界包，最小规则
  graphs/
    single_agent/       # 最小图
    strict_director/    # 严格导演图
    complex_graph/      # 多节点并行图
```

### 长会话生成器

自动模拟多轮对话的测试工具。

```text
LongSessionGenerator {
  turns: 500,
  scenario: "archivist_rp",
  actions: [
    { turn_range: [1, 100], action_type: "exploration", weight: 0.7 },
    { turn_range: [101, 300], action_type: "dialogue", weight: 0.8 },
    { turn_range: [301, 500], action_type: "combat", weight: 0.3 }
  ],
  assertions: {
    every_n_turns: 50,
    check: ["state_consistency", "foreshadowing_recall", "character_ooc"]
  }
}
```

- 按预定义场景自动选择每轮用户输入。
- 每 N 轮自动运行断言检查。
- 最终输出一致性报告。

### Trace 断言工具

检查 trace 记录的完整性和正确性。

```text
TraceAssert(trace_id)
  .has_node_type("director")
  .context_bundle_excludes("director_plan")  // NPC 不应看到导演计划
  .token_usage_below(4096)
  .duration_below(30000)
  .no_errors()
```

---

## 性能基准

### 目标值

| 指标 | 目标 | 测量方法 |
|---|---|---|
| 单轮 Runtime 执行（不含 LLM 调用） | < 50ms | 从收到用户输入到返回结构化输出（Mock LLM 固定延迟 0ms）。 |
| 状态快照读取 | < 5ms | 读取最新 `state_snapshots`。 |
| 事件账本查询（500 条内） | < 20ms | 按 session + type 过滤。 |
| 伏笔检索（100 条内） | < 10ms | 按 status + importance 过滤。 |
| 内容包导入（10MB ZIP） | < 5s | 解压 + 校验 + 写入。 |
| Artifact iframe 创建 | < 100ms | 从创建到 `ready` 事件。 |
| Artifact 快照保存 | < 50ms | 保存 iframe 静态 HTML。 |
| SSE 连接建立 | < 50ms | 从请求到首个事件。 |
| 长会话 500 轮后页面滚动 | 60fps | 使用虚拟列表，DOM 节点数不随消息数增长。 |

### 基准测试运行

- 性能基准在 CI 中每次 PR 运行。
- 回归超过 20% 时标记 PR 为性能回归。
- 基准测试结果存档，可追溯趋势。

---

## 测试分层与运行策略

| 层级 | 运行时机 | 耗时预期 | 覆盖目标 |
|---|---|---|---|
| 单元测试 | 每次提交 | < 10s | 逻辑正确性。 |
| 集成测试 | 每次 PR | < 60s | API 和数据库链路。 |
| 场景测试 | 每次 PR | < 5min | 八大风险域。 |
| 长会话测试 | 每日/手动 | < 30min | 100-1000 轮回归。 |
| 性能基准 | 每次 PR | < 2min | 关键路径延迟。 |

---

## 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Mock Provider 不代表真实 LLM 行为 | 测试通过但真实场景失败。 | Mock 只测系统逻辑（权限、提交、记忆）；LLM 输出质量用独立评测集评估，不混入回归测试。 |
| 长会话测试耗时过长 | CI 时间不可接受。 | 日常 CI 只跑 100 轮场景；500-1000 轮在每日定时任务或手动触发。 |
| OOC 检测依赖主观标准 | 测试结果不可靠。 | OOC 测试只检查结构化约束（知识边界、关系数值、能力列表），不评估文学质量。 |
| 测试 fixture 维护成本 | 内容包格式变更后 fixture 失效。 | fixture 和内容包 schema 共用同一份 JSON Schema 定义，变更时自动提示更新。 |
| 性能基准环境差异 | CI 和本地环境性能不同。 | 基准测试关注相对回归（百分比变化），不关注绝对值。 |

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| 全部单元测试通过 | 0 failure，覆盖率 ≥ 80%。 |
| 全部集成测试通过 | API 端点、数据库读写、SSE 流式输出均正常。 |
| 长会话 100 轮场景测试 | 状态一致、记忆可召回、伏笔可检索、无 OOC 违规。 |
| Agent 越权测试 | 所有权限矩阵中的禁止场景被 Runtime 正确拦截。 |
| 状态提交测试 | low/medium/high 三级风险的提交行为符合规范。 |
| Artifact 隔离测试 | iframe 沙箱阻止所有禁止行为，资源预算被严格执行。 |
| 流式输出测试 | SSE 事件序列完整、增量文本可拼接、断线可恢复。 |
| 性能基准无回归 | 关键路径延迟不超基线 20%。 |
| Mock Provider 覆盖所有 Agent 类型 | Parser、Master、NPC、Writer、Director、State（Compression）Agent 都有对应 mock 响应。 |
| 长会话 500 轮自动化测试 | 无状态丢失、无伏笔遗忘、无关系跳变、内存占用在目标范围内。 |
