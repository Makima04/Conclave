# AGENT.md

本文件给参与本项目的 LLM 编程 Agent 使用。它不是产品说明，而是工程协作协议。

LLM Agent 在本项目中工作时，必须优先遵守本文的文档同步、目录索引、模块边界和实现流程规则。

## 角色卡兼容原则

禁止为单张角色卡、单个世界书或某个具体 UI 名称写硬解析、硬编码渲染器或专属字段映射。

处理 SillyTavern、TavernHelper、MVU、正则脚本、状态栏或附件渲染问题时，必须优先实现通用兼容层：

- 复用角色卡原始脚本、扩展元数据、运行时 API 或导入规范。
- 新增解析器必须面向协议/格式本身，而不是面向某张卡的中文字段名、UI 文案、固定路径或固定 DOM。
- 不得用诸如“检测到苍玄界/灵机/主角状态/世界系统就渲染某组件”的方式兜底。
- 如果需要临时降级，只能展示通用错误、缺失 API、缺失扩展或原始内容预览，并说明缺少的运行时能力。
- 修改前应先分析原卡数据和相关脚本，找出通用机制缺口，再补平台能力。

## 当前项目状态

项目已完成 P0 规格定义 + P1 后端/前端骨架 + P2 核心 Runtime 实现。

当前已有代码：

- `backend/` — Rust 后端服务（axum + SQLite + sqlx）
  - 动态总控多 Agent Runtime（Parser → Master → Sub-agents → Writer → Compression）
  - DAG 并行执行 + plan_validator 校验
  - 双轨上下文架构（压缩状态用于推理，messages 用于展示）
  - 记忆系统（state_snapshots, memory_events, foreshadowing, turn_summaries, structured_events）
  - 结构化事件召回（recall.rs，关键词匹配，预留向量检索）
  - LLM Provider Adapter（OpenAI 兼容）
  - SSE 流式输出 + agent_status 事件 + SSE 重连
  - broadcast channel 支持多订阅者重连
  - 会话状态（idle/processing）+ 启动时重置残留状态
  - 执行追踪（traces）
  - Proposal + Commit（pending_proposals 表）
  - turn_service（回合服务编排，从 graph.rs 中抽取）
  - background_jobs（后台任务调度）
  - knowledge（知识检索子系统）
  - llm_limiter（LLM 调用限流）
  - variable_tool_agent（变量工具 Agent，处理变量读写工具调用）
  - variable_update（变量更新逻辑）
  - worldbook_parser（世界书解析）
  - preset_parser（预设解析）
  - card_state_adapter（卡片状态适配）
  - state_initializer（会话状态初始化，替代原 initializer.rs 的部分职责）
  - str_utils（字符串工具函数）
  - sse_types（SSE 类型定义）
  - user_settings（用户设置运行时支持）
  - importer/ — 卡片导入模块（SillyTavern 角色卡 / PNG 解析 / JSON 解析 / HTML 拆分 / JS 分析 / 正则执行 / 变量提取 / 动作提取 / 资源扫描 / LLM 辅助 / 状态适配 / 报告生成 / 包构建 / 仓储 / 编排）
  - routes/ — API 路由：health, sessions, messages, providers, proposals, agents, worldbooks, charactercards, presets, card_import, settings
- `frontend/` — React 前端（TypeScript + Vite）
  - 会话列表（含 processing spinner）
  - 聊天界面（SSE 流式 + Agent 状态实时显示 + SSE 重连恢复）
  - Agent 管理面板
  - Provider 设置
  - 消息编辑/删除/重新生成/变体切换
  - 世界书管理（WorldBooks）
  - 角色卡管理（CharacterCard）
  - 预设管理（Presets）
  - 卡片导入工作台（ImportWorkbench）
  - 卡片内容渲染（card-content、card-schema-builders、card-schema-types）
  - Sandbox HTML 渲染（SandboxHtmlRenderer、IframeHtmlRuntimeHost、DirectHtmlRuntimeHost）
  - TavernHelper 运行时宿主（TavernHelperRuntimeHost、SessionTavernHelperRuntimeHost）
  - 持久化卡片运行时宿主（PersistentCardRuntimeHost）
  - ST 正则执行器（st-regex-executor）
  - 会话调试（SessionDebug）
  - 侧边栏工具（ToolRail、ToolDrawer、InspectorSidebar）
  - 设置子模块（modelSelection、sessionDefaults）
  - 导入工作台子组件（ActionBar、DiagnosticsPanel、LlmAssistPanel、PackagePreview、PaginationControls、PipelineVisualization、RuleTracePanel）
  - 聊天 hooks（useChatSession、useMessageStream、useStreamRecovery）
- `docs/` — 架构文档（Markdown 单一来源）
- `backend/schemas/` — JSON Schema 定义

## 项目结构索引

当前结构：

```text
multi-agent-rp-platform/
  AGENT.md
  README.md
  CLAUDE.md                   # Claude Code Agent 工作流程指令
  start.sh                    # 项目启动脚本
  chat-layout-prototype.html  # 聊天布局原型
  skills-lock.json            # 技能锁定配置

  docs/
    docs.md                   # 文档中心（主索引）
    index.md                  # 架构首页
    long-context-memory.md
    agent-runtime.md
    agent-boundaries.md
    actor-agent-architecture.md
    dynamic-master-architecture.md
    tech-selection.md
    implementation-priority.md
    database-api.md
    content-packages.md
    card-import-normalization.md
    card-rendering-runtime.md
    card-runtime-refactor-architecture.md
    artifact-renderer.md
    testing.md
    docs-sync.md

  backend/                    # Rust 后端，axum + SQLite + sqlx
    src/
      main.rs                 # 入口
      config.rs               # 环境变量配置
      db.rs                   # SQLite 连接池和迁移
      error.rs                # 统一错误模型
      routes/                 # API 路由
        mod.rs
        health.rs             # 健康检查
        sessions.rs           # 会话管理
        messages.rs           # 消息管理
        providers.rs          # Provider 管理
        proposals.rs          # 提案管理
        agents.rs             # Agent 管理
        worldbooks.rs         # 世界书管理
        charactercards.rs     # 角色卡管理
        presets.rs            # 预设管理
        card_import.rs        # 卡片导入
        settings.rs           # 应用设置
      runtime/                # 多 Agent Runtime
        mod.rs
        graph.rs              # 总调度：Parser → Master → Sub-agents → Writer → Compression
        master.rs             # 总控 Agent（ContextBundle + ParsedIntent → MasterPlan）
        parser.rs             # 解析 Agent（用户输入 → ParsedIntent）
        sub_agent.rs          # 子 Agent 执行（上下文感知 prompt 构建）
        compression.rs        # 压缩 Agent（后处理：生成 scene_summary + events + foreshadowing + state）
        dag.rs                # DAG 编译（MasterPlan calls → 并行层级）
        plan_validator.rs     # Master 计划合法性校验
        executor.rs           # 流式执行器（SSE + broadcast channel 重连）
        structured_output.rs  # LLM JSON 输出提取和校验
        turn_finalizer.rs     # Turn 终结（消息保存 + 记忆写入 + trace + 状态提交）
        turn_service.rs       # 回合服务编排（从 graph.rs 抽取的完整 turn 流程）
        context.rs            # ContextBundle 构建（从 DB 加载结构化状态）
        recall.rs             # 结构化事件召回（关键词匹配，预留向量检索）
        turn_state.rs         # 单轮内 Agent 输出共享
        state_initializer.rs  # 会话状态初始化（从 DB 恢复 RuntimeState）
        initializer.rs        # 多 Agent 会话初始化
        types.rs              # 核心类型定义
        sse_types.rs          # SSE 事件类型定义
        str_utils.rs          # 字符串工具函数
        background_jobs.rs    # 后台任务调度（清理、过期等）
        knowledge.rs          # 知识检索子系统
        llm_limiter.rs        # LLM 调用限流
        variable_tool_agent.rs # 变量工具 Agent（处理变量读写工具调用）
        variable_update.rs    # 变量更新逻辑
        worldbook_parser.rs   # 世界书解析
        preset_parser.rs      # 预设解析
        card_state_adapter.rs # 卡片状态适配
        user_settings.rs      # 用户设置运行时支持
      importer/               # 卡片导入模块
        mod.rs
        orchestrator.rs       # 导入编排（Pipeline 主流程）
        types.rs              # 导入类型定义
        json_parser.rs        # JSON/TavernAI 角色卡解析
        png_parser.rs         # PNG 嵌入数据解析
        html_splitter.rs      # HTML 拆分
        js_analyzer.rs        # JS 脚本分析
        regex_executor.rs     # 正则脚本执行
        variable_extractor.rs # 变量提取
        action_extractor.rs   # 动作提取
        resource_scanner.rs   # 资源扫描
        llm_assist.rs         # LLM 辅助导入
        state_adapter.rs      # 状态适配
        report.rs             # 导入报告生成
        package_builder.rs    # 包构建
        storage.rs            # 导入仓储
      memory/                 # 记忆层
        mod.rs
        state.rs              # 结构化状态
        summaries.rs          # 摘要管理
      provider/               # LLM Provider Adapter（OpenAI 兼容）
        mod.rs
        adapter.rs
        openai.rs
        types.rs
    migrations/               # SQLite schema 迁移（001-015）
    schemas/                  # JSON Schema 定义（10 个）
      agent-graph.schema.json
      common.schema.json
      content-pack-manifest.schema.json
      context-bundle.schema.json
      foreshadowing.schema.json
      memory-event.schema.json
      node-output.schema.json
      session-config.schema.json
      state-change-proposal.schema.json
      trace.schema.json

  frontend/                   # React 前端，TypeScript + Vite
    src/
      App.tsx
      main.tsx
      vite-env.d.ts
      api/                    # API 客户端和类型
        client.ts
        sse.ts
        types.ts
      components/             # 通用组件
        AppShell.tsx
        ErrorBoundary.tsx
        NewSessionDialog.tsx
        Sidebar.tsx
        Toast.tsx
      contexts/
        AppContext.tsx         # 全局上下文
      settings/               # 设置子模块
        modelSelection.tsx
        sessionDefaults.ts
      pages/
        Chat.tsx              # 聊天页面
        SessionList.tsx       # 会话列表
        SessionDebug.tsx      # 会话调试
        AgentManager.tsx      # Agent 管理
        Settings.tsx          # 设置页面
        WorldBooks.tsx        # 世界书管理
        CharacterCard.tsx     # 角色卡管理
        Presets.tsx           # 预设管理
        ImportWorkbench.tsx   # 卡片导入工作台
        card-content.tsx      # 卡片内容渲染
        card-schema-builders.ts
        card-schema-types.ts
        card-utils.ts
        sandbox-document.ts   # Sandbox 文档构建
        st-html-app-runtime.ts
        st-regex-executor.ts  # ST 正则执行器
        st-regex-executor.test.ts
        components/           # 页面子组件（14 个）
          CodeBlock.tsx
          CustomStatusRenderer.tsx
          DirectHtmlRuntimeHost.tsx
          IframeHtmlRuntimeHost.tsx
          InputPanel.tsx
          InspectorSidebar.tsx
          MessageContent.tsx
          MessageHtmlAppRenderer.tsx
          PersistentCardRuntimeHost.tsx
          SandboxHtmlRenderer.tsx
          SessionTavernHelperRuntimeHost.tsx
          TavernHelperRuntimeHost.tsx
          ToolDrawer.tsx
          ToolRail.tsx
        hooks/                # 页面 hooks
          useChatSession.ts
          useMessageStream.ts
          useStreamRecovery.ts
        import/               # 导入工作台子组件
          ActionBar.tsx
          DiagnosticsPanel.tsx
          LlmAssistPanel.tsx
          PackagePreview.tsx
          PaginationControls.tsx
          PipelineVisualization.tsx
          RuleTracePanel.tsx

  crates/                     # 可拆分 Rust crate（暂未创建）
  packages/                   # 示例内容包（暂未创建）
  plugins/                    # 示例插件（暂未创建）
  tests/                      # 集成测试（暂未创建）
  examples/                   # 示例（暂未创建）
```

创建任何新顶层目录后，必须更新本节。

## 文档阅读顺序

实现前按顺序阅读：

1. `docs/docs.md`
2. `docs/index.md`
3. `docs/long-context-memory.md`
4. `docs/agent-runtime.md`
5. `docs/dynamic-master-architecture.md`
6. `docs/actor-agent-architecture.md`
7. `docs/agent-boundaries.md`
8. `docs/tech-selection.md`
9. `docs/database-api.md`
10. `docs/content-packages.md`
11. `docs/card-import-normalization.md`
12. `docs/card-rendering-runtime.md`
13. `docs/card-runtime-refactor-architecture.md`
14. `docs/artifact-renderer.md`
15. `docs/testing.md`
16. `docs/implementation-priority.md`
17. `docs/docs-sync.md`

如果要改某个功能，必须先读对应文档：

- 改长期记忆、摘要、事件账本、伏笔、角色成长：读 `docs/long-context-memory.md`
- 改 Runtime、Agent 图、节点、边、状态提交、trace：读 `docs/agent-runtime.md`
- 改动态总控架构、4 层流水线、Agent 生命周期、Turn State、压缩 Agent：读 `docs/dynamic-master-architecture.md`
- 改互动角色建模、NPC/配角/临时角色抽象：读 `docs/actor-agent-architecture.md`
- 改 Agent 权限、上下文隔离、handoff、插件权限：读 `docs/agent-boundaries.md`
- 改技术栈、框架、数据库、前端方案：读 `docs/tech-selection.md`
- 改实现顺序、MVP 范围、项目进度或阶段目标：读 `docs/implementation-priority.md`
- 改文档结构或新增文档：读 `docs/docs.md` 和 `docs/docs-sync.md`
- 改数据库 schema、API 端点或数据模型：读 `docs/database-api.md`
- 改内容包格式、manifest 或导入导出：读 `docs/content-packages.md`
- 改卡片导入、ST 迁移、导入报告：读 `docs/card-import-normalization.md`
- 改角色卡渲染、sandbox、共享存档、开场白、iframe 性能：读 `docs/card-rendering-runtime.md`
- 改角色卡兼容重构、前端 regex 单点执行、统一运行时模型或 canonical state/card projection 变量链路：读 `docs/card-runtime-refactor-architecture.md`
- 改 Artifact 渲染、沙箱或资源预算：读 `docs/artifact-renderer.md`
- 改测试场景、性能基准或 Mock Provider：读 `docs/testing.md`
- 改文档维护规则或索引维护：读 `docs/docs-sync.md`

## 文档同步规则

任何代码或设计变更，都必须检查是否需要同步文档。

必须同步的情况：

- 修改 Runtime 行为：更新 `docs/agent-runtime.md`
- 修改 Agent 权限或上下文可见性：更新 `docs/agent-boundaries.md`
- 修改长期记忆、状态、事件、伏笔或角色成长：更新 `docs/long-context-memory.md`
- 修改技术栈、依赖、数据库、前端框架：更新 `docs/tech-selection.md`
- 修改数据库 schema、API 端点或数据模型：更新 `docs/database-api.md`
- 修改内容包格式、manifest 或导入导出：更新 `docs/content-packages.md`
- 修改卡片导入或 ST 迁移：更新 `docs/card-import-normalization.md`
- 修改角色卡渲染、sandbox、共享存档、开场白或 iframe 性能：更新 `docs/card-rendering-runtime.md`
- 修改角色卡兼容架构、前端 regex 真相源、统一运行时模型或动态变量投影链路：更新 `docs/card-runtime-refactor-architecture.md`
- 修改 Artifact 渲染、沙箱或资源预算：更新 `docs/artifact-renderer.md`
- 修改测试场景、性能基准或 Mock Provider：更新 `docs/testing.md`
- 修改实现顺序、阶段目标、MVP 范围或项目进度：更新 `docs/implementation-priority.md`
- 新增文档：更新 `docs/docs.md` 和 `docs/index.md`
- 新增顶层目录或重要模块：更新本文件的“项目结构索引”
- 新增 schema：更新相关规范文档，并在 `schemas/` 中建立索引
- 新增示例包或插件：更新 `packages/` 或 `plugins/` 的索引文件

禁止出现“代码已经改变，但文档仍描述旧架构”的状态。

正式文档以 Markdown 为唯一来源。项目实际进度、目录结构、文档中心、架构首页和实现优先级文档必须描述同一状态。

## 新增功能流程

新增功能时按以下顺序工作：

1. 找到对应文档和模块。
2. 如果没有对应文档，先补文档或在 `docs/docs.md` 的待补文档中登记。
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

- 选择运行模式（single_agent / multi_agent）
- 执行 4 层流水线（Parser → Master → Sub-agents → Writer → Compression）
- 装配 `ContextBundle`（从压缩状态表加载，不从 messages 表读取原始对话）
- 上下文感知的子 Agent prompt 构建（按 Agent 类型注入不同上下文切片）
- 后处理压缩（State Agent 生成 scene_summary + events + foreshadowing + state_changes）
- 校验结构化输出
- 执行 proposal + commit
- 记录 trace
- 限制循环、并发、token 和运行时间

Runtime 不负责：

- 直接写最终文学文本
- 直接扮演 NPC
- 直接相信 LLM 输出的状态变更

### Memory

Memory 模块包含 3 个文件：`mod.rs`、`state.rs`（结构化状态管理）、`summaries.rs`（摘要管理）。

Memory 负责：

- 最近上下文
- 场景摘要（summaries.rs）
- 章节摘要（summaries.rs）
- 结构化状态（state.rs）
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

- LLM 输出的 UI 变化
- `artifact_id` / `version`
- state diff / props / patch
- iframe sandbox
- 离屏卸载或快照
- 资源预算和安全限制

不要把任意 HTML / CSS / JS 直接追加进主聊天 DOM。

### Character Card Rendering

Character Card Rendering 负责：

- 导入后角色卡 UI。
- ConclaveCardPackage HTML app。
- ST 风格 sandbox 兼容层。
- TavernHelper / MVU shim。
- 共享存档桥接。
- 开场白选择。
- iframe 懒挂载、resize 节流和重载控制。

不要为单张卡无限新增私有运行时 API；新增 shim 必须能服务一类卡，并更新 `docs/card-rendering-runtime.md`。

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

内容包规范已存在。修改内容包或导入导出前应先读 `docs/content-packages.md` 和 `docs/card-import-normalization.md`。

### Importer

Importer 负责：

- SillyTavern 角色卡导入（JSON / PNG 嵌入 / HTML 拆分）
- JS 脚本分析与正则执行器
- 变量提取与动作提取
- 资源扫描
- LLM 辅助导入
- 状态适配（state_adapter）
- 导入报告生成（report）
- 包构建（package_builder）
- 导入编排（orchestrator — Pipeline 主流程）
- 导入仓储（storage）

Importer 不负责：

- 运行时变量求值（归 variable_tool_agent）
- 角色卡渲染（归 Character Card Rendering）
- 世界书运行时解析（归 worldbook_parser）

修改导入流程前应先读 `docs/card-import-normalization.md`。

### Variable Tool Agent

Variable Tool Agent 负责：

- 处理 LLM 返回的变量读写工具调用
- 将变量变更应用到 RuntimeState
- 与 variable_update 协作完成变量持久化

Variable Tool Agent 不负责：

- 变量的初始注入（归 state_initializer）
- 卡片状态适配（归 card_state_adapter）
- 模板变量替换（归 str_utils）

### Knowledge

Knowledge 负责：

- 知识条目的检索和注入
- 与世界书（worldbook_parser）协作提供运行时知识上下文

Knowledge 不负责：

- 世界书的存储和 CRUD（归 routes/worldbooks）
- 导入阶段的知识提取（归 importer）

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
- 角色卡 sandbox 是否不会误拦截卡自身交互
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
- 是否需要更新 `docs/docs.md`？
- 是否需要更新 `docs/index.md`？
- 是否需要更新对应 Markdown 文档？
- 是否需要更新 `docs/implementation-priority.md`？
- 是否需要更新 `AGENT.md` 的项目结构索引？
- 是否新增了 schema？
- 是否新增了测试？
- 是否记录了 trace？
- 是否破坏了 Agent 边界？
- 是否引入了未授权读取或写入？

## 后续待补规范

当前待补文档：

- 插件系统规范

已完成文档：

- 内容包规范 → `docs/content-packages.md`
- 卡片导入标准化规范 → `docs/card-import-normalization.md`
- 角色卡渲染运行时 → `docs/card-rendering-runtime.md`
- 角色卡兼容运行时重构架构 → `docs/card-runtime-refactor-architecture.md`
- Artifact Renderer 规范 → `docs/artifact-renderer.md`
- 数据库与 API 规范 → `docs/database-api.md`
- 测试与评测规范 → `docs/testing.md`
- 文档维护规则 → `docs/docs-sync.md`

补充这些文档时，必须同步更新 `docs/docs.md` 的待补文档和当前文档列表。
