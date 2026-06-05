# AGENT.md

本文件给参与本项目的 LLM 编程 Agent 使用。它不是产品说明，而是工程协作协议。

LLM Agent 在本项目中工作时，必须优先遵守本文的文档同步、目录索引、模块边界和实现流程规则。

## 当前项目状态

当前项目仍处于架构文档阶段，尚未进入正式代码实现。

当前已有文件：

- `AGENT.md`
  - LLM 编程 Agent 工程协作协议。
- `README.md`
  - 项目名称入口。
- `docs/*.md`
  - Markdown 版架构文档、文档中心、技术选型、长期记忆、Agent Runtime、Agent 边界、实现优先级、数据库与 API、内容包、Artifact Renderer、测试与评测、文档同步。
- `docs/html/*.html`
  - HTML 版文档，与 `docs/*.md` 保持同步。

当前尚未创建的代码目录：

- `crates/`
- `packages/`
- `tests/`
- `examples/`
- `schemas/`
- `plugins/`

当前已有代码目录：

- `backend/` — Rust 后端服务（axum + SQLite + sqlx）
- `frontend/` — React 前端（TypeScript + Vite）

如果后续创建这些目录，必须同步更新本文的“项目结构索引”。

## 项目结构索引

当前结构：

```text
multi-agent-rp-platform/
  AGENT.md
  README.md
  docs/
    docs.md
    index.md
    long-context-memory.md
    agent-runtime.md
    agent-boundaries.md
    tech-selection.md
    implementation-priority.md
    database-api.md
    content-packages.md
    artifact-renderer.md
    testing.md
    docs-sync.md
    html/
      docs.html
      index.html
      long-context-memory.html
      agent-runtime.html
      agent-boundaries.html
      tech-selection.html
      implementation-priority.html
      database-api.html
      content-packages.html
      artifact-renderer.html
      testing.html
      docs-sync.html
```

计划结构：

```text
multi-agent-rp-platform/
  AGENT.md
  README.md
  docs/
    docs.md
    index.md
    long-context-memory.md
    agent-runtime.md
    agent-boundaries.md
    tech-selection.md
    implementation-priority.md
    html/
      docs.html
      index.html
      long-context-memory.html
      agent-runtime.html
      agent-boundaries.html
      tech-selection.html
      implementation-priority.html

  backend/                 # Rust 后端，axum + SQLite + sqlx
    src/
      main.rs              # 入口
      config.rs            # 环境变量配置
      db.rs                # SQLite 连接池和迁移
      error.rs             # 统一错误模型
      routes/              # API 路由：health, sessions, messages
      runtime/             # Single Agent Runtime 执行器
      memory/              # 5 层记忆：state, events, foreshadowing, summaries
      provider/            # LLM Provider Adapter（OpenAI 兼容）
      trace/               # 执行追踪记录
    migrations/            # SQLite schema 迁移
  frontend/                # React 前端，TypeScript + Vite
    src/
      api/                 # API 客户端和类型
      pages/               # SessionList, Chat
      components/          # 预留
      styles/              # 全局 CSS
  crates/                  # 可拆分 Rust crate（暂未创建）
  schemas/                 # JSON schema（暂未创建）
  packages/                # 示例内容包（暂未创建）
  plugins/                 # 示例插件（暂未创建）
  tests/                   # 集成测试（暂未创建）
  examples/                # 示例（暂未创建）
```

创建任何新顶层目录后，必须更新本节。

## 文档阅读顺序

实现前按顺序阅读：

1. `docs/html/docs.html`
2. `docs/html/index.html`
3. `docs/html/long-context-memory.html`
4. `docs/html/agent-runtime.html`
5. `docs/html/agent-boundaries.html`
6. `docs/html/tech-selection.html`
7. `docs/html/database-api.html`
8. `docs/html/content-packages.html`
9. `docs/html/artifact-renderer.html`
10. `docs/html/testing.html`
11. `docs/html/implementation-priority.html`
12. `docs/html/docs-sync.html`

如果要改某个功能，必须先读对应文档：

- 改长期记忆、摘要、事件账本、伏笔、角色成长：读 `docs/html/long-context-memory.html`
- 改 Runtime、Agent 图、节点、边、状态提交、trace：读 `docs/html/agent-runtime.html`
- 改 Agent 权限、上下文隔离、handoff、插件权限：读 `docs/html/agent-boundaries.html`
- 改技术栈、框架、数据库、前端方案：读 `docs/html/tech-selection.html`
- 改实现顺序、MVP 范围、项目进度或阶段目标：读 `docs/html/implementation-priority.html`
- 改文档结构或新增文档：读 `docs/html/docs.html`
- 改数据库 schema、API 端点或数据模型：读 `docs/html/database-api.html`
- 改内容包格式、manifest 或导入导出：读 `docs/html/content-packages.html`
- 改 Artifact 渲染、沙箱或资源预算：读 `docs/html/artifact-renderer.html`
- 改测试场景、性能基准或 Mock Provider：读 `docs/html/testing.html`
- 改文档同步规则或索引维护：读 `docs/html/docs-sync.html`

## 文档同步规则

任何代码或设计变更，都必须检查是否需要同步文档。

必须同步的情况：

- 修改 Runtime 行为：更新 `docs/agent-runtime.md` 和 `docs/html/agent-runtime.html`
- 修改 Agent 权限或上下文可见性：更新 `docs/agent-boundaries.md` 和 `docs/html/agent-boundaries.html`
- 修改长期记忆、状态、事件、伏笔或角色成长：更新 `docs/long-context-memory.md` 和 `docs/html/long-context-memory.html`
- 修改技术栈、依赖、数据库、前端框架：更新 `docs/tech-selection.md` 和 `docs/html/tech-selection.html`
- 修改数据库 schema、API 端点或数据模型：更新 `docs/database-api.md` 和 `docs/html/database-api.html`
- 修改内容包格式、manifest 或导入导出：更新 `docs/content-packages.md` 和 `docs/html/content-packages.html`
- 修改 Artifact 渲染、沙箱或资源预算：更新 `docs/artifact-renderer.md` 和 `docs/html/artifact-renderer.html`
- 修改测试场景、性能基准或 Mock Provider：更新 `docs/testing.md` 和 `docs/html/testing.html`
- 修改实现顺序、阶段目标、MVP 范围或项目进度：更新 `docs/implementation-priority.md` 和 `docs/html/implementation-priority.html`
- 新增文档：更新 `docs/docs.md`、`docs/index.md`、`docs/html/docs.html` 和 `docs/html/index.html`
- 新增顶层目录或重要模块：更新本文件的“项目结构索引”
- 新增 schema：更新相关规范文档，并在 `schemas/` 中建立索引
- 新增示例包或插件：更新 `packages/` 或 `plugins/` 的索引文件

禁止出现“代码已经改变，但文档仍描述旧架构”的状态。

正式文档必须保持 Markdown 与 HTML 版本同步。更新 `docs/*.md` 时必须检查对应 `docs/html/*.html`，更新 `docs/html/*.html` 时也必须检查对应 Markdown。项目实际进度、目录结构、文档中心、架构首页和实现优先级文档必须描述同一状态。

## 新增功能流程

新增功能时按以下顺序工作：

1. 找到对应文档和模块。
2. 如果没有对应文档，先补文档或在 `docs/docs.md` 和 `docs/html/docs.html` 的待补文档中登记。
3. 明确该功能属于哪个边界：
   - Runtime
   - Memory
   - Agent Boundary
   - Artifact Renderer
   - Content Package
   - Plugin System
   - Frontend UI
   - Provider Adapter
4. 实现代码。
5. 补充测试。
6. 更新文档。
7. 更新索引。
8. 最后检查本文件是否需要更新。

## 模块职责边界

### Runtime

Runtime 负责：

- 选择运行模式
- 选择或执行 Agent Graph
- 装配 `ContextBundle`
- 调用节点
- 校验结构化输出
- 执行 proposal + commit
- 记录 trace
- 限制循环、并发、token 和运行时间

Runtime 不负责：

- 直接写最终文学文本
- 直接扮演 NPC
- 直接相信 LLM 输出的状态变更

### Memory

Memory 负责：

- 最近上下文
- 场景摘要
- 章节摘要
- 结构化状态
- 事件账本
- 伏笔登记表
- 角色人格记忆
- 检索记忆

Memory 不应只依赖向量库。

重要事实必须进入结构化状态或事件账本，不能只保存在自然语言摘要里。

### Agent Boundary

Agent Boundary 负责：

- Agent 能看什么
- Agent 能写什么
- Agent 能调用什么工具
- handoff 时传递哪些信息
- 插件能读取哪些数据

NPC 不能读取导演计划、其他 NPC 内心、未知隐藏秘密或完整隐藏世界书。

### Artifact Renderer

Artifact Renderer 负责：

- 角色卡 UI
- LLM 输出的 UI 变化
- `artifact_id` / `version`
- state diff / props / patch
- iframe sandbox
- 离屏卸载或快照
- 资源预算和安全限制

不要把任意 HTML / CSS / JS 直接追加进主聊天 DOM。

### Content Package

Content Package 负责：

- Character Pack
- World Pack
- Agent Graph Pack
- Plugin Pack
- assets
- 版本兼容
- 导入导出
- SillyTavern 迁移

内容包规范尚未完成。实现前应先补文档。

### Provider Adapter

Provider Adapter 负责统一接入模型供应商。

节点不应直接绑定具体模型 API。

后续支持：

- OpenAI
- OpenRouter
- Ollama
- vLLM
- LM Studio
- Anthropic
- Gemini

## 工程约束

### 结构化优先

优先使用结构化 schema，不要依赖临时字符串解析。

以下对象必须结构化：

- Agent Graph
- ContextBundle
- Node Output
- StateChangeProposal
- MemoryEvent
- ForeshadowingItem
- ArtifactPatch
- Trace
- Content Package manifest
- Plugin manifest

### 类型和 schema

新增重要数据结构时：

- 后端要有类型定义。
- 前端要有对应类型。
- 如跨模块或跨包使用，应放入 `schemas/`。
- schema 变更必须更新文档。

### Trace 优先

任何 Runtime 执行路径都必须可追踪。

新增节点或状态变更逻辑时，必须考虑 trace 如何记录。

### 测试优先覆盖边界

优先测试：

- 状态写入是否走 proposal + commit
- NPC 是否无法读取隐藏秘密
- 插件是否无法越权
- 高风险状态是否不会自动提交
- 自由图是否受到循环和成本限制
- Artifact 是否不会污染主页面
- 长会话是否能召回旧事件和伏笔

## 自由图责任边界

高级用户可以制作 Agent Graph Pack，其他用户可以导入使用。

平台负责：

- schema 校验
- 权限校验
- 沙箱
- 成本限制
- 超时限制
- trace
- 防止越权读取
- 防止危险写入

平台不负责第三方图包的：

- 剧情质量
- Prompt 质量
- Agent 是否好玩
- token 成本是否经济
- 节点流程是否优雅
- 是否频繁触发重写
- 输出是否符合创作者预期

质量风险由图包创作者和使用者承担，安全边界由平台承担。

## 禁止事项

禁止：

- 把完整聊天历史无条件传给所有 Agent。
- 让 Agent 直接修改长期状态。
- 让插件默认读取隐藏世界书。
- 让 NPC 看到导演计划。
- 把自定义 HTML / JS 直接插入主聊天 DOM。
- 新增功能但不更新相关文档。
- 新增顶层目录但不更新项目结构索引。
- 用临时文本解析替代明确 schema。
- 静默提交高风险状态变更。
- 让自由图无限循环或无限消耗 token。
- 把平台核心绑定到单一外部 Agent 框架。

## 修改检查清单

每次改动结束前检查：

- 是否读过相关文档？
- 是否修改了对应文档？
- 是否需要更新 `docs/docs.md` 和 `docs/html/docs.html`？
- 是否需要更新 `docs/index.md` 和 `docs/html/index.html`？
- 是否需要更新对应 Markdown 或 HTML 文档，保持两者同步？
- 是否需要更新 `docs/implementation-priority.md` 和 `docs/html/implementation-priority.html`？
- 是否需要更新 `AGENT.md` 的项目结构索引？
- 是否新增了 schema？
- 是否新增了测试？
- 是否记录了 trace？
- 是否破坏了 Agent 边界？
- 是否引入了未授权读取或写入？

## 后续待补规范

当前待补文档：

- 插件系统规范
- SillyTavern 兼容与迁移规范

已完成文档：

- 内容包规范 → `docs/content-packages.md`
- Artifact Renderer 规范 → `docs/artifact-renderer.md`
- 数据库与 API 规范 → `docs/database-api.md`
- 测试与评测规范 → `docs/testing.md`
- 文档同步规则 → `docs/docs-sync.md`

补充这些文档时，必须同步更新 `docs/docs.md` 和 `docs/html/docs.html` 的待补文档和当前文档列表。
