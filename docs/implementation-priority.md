# 项目实现优先级

> 本文把当前架构文档落成可执行的实现顺序。优先级围绕一个目标：先跑通安全、可追踪、可长期续写的 RP 最小闭环，再扩展高级 Agent 图、Artifact 和插件生态。

`Implementation Priority` · `MVP` · `Runtime First` · `Memory First` · `Docs Sync`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [长期记忆](long-context-memory.md)
- [Agent Runtime](agent-runtime.md)
- [Agent 边界](agent-boundaries.md)
- [技术选型](tech-selection.md)

---

## 排序原则

实现顺序不按功能炫目程度排序，而按系统风险和依赖关系排序。

### 先定义契约，再写实现

跨后端、前端、Runtime、记忆和内容包共享的数据结构必须先有 schema 或规范。没有契约时，代码会很快分叉成互不兼容的临时结构。

### 先跑通单轮，再扩展多 Agent

首个可用版本应先支持 `single_agent` 最小闭环，再加入 Director、WorldJudge、Consistency 和高级图。多 Agent 编排建立在消息、状态、记忆、trace 都可工作的基础上。

### 先保证边界，再开放扩展

插件、自由图、自定义 artifact 都是高风险能力。必须在权限、沙箱、预算、trace 和 proposal + commit 稳定后再开放。

### Markdown 与 HTML 同步

每份正式文档必须同时维护 Markdown 和 HTML 版本。文档入口、阅读顺序、待补列表和实现进度也要同步，避免用户读到两套不同状态。

---

## P0：实现前必补

P0 是进入代码实现前的前置工作。它们不直接产出产品界面，但决定后续实现是否能保持一致。

| 事项 | 产出 | 为什么优先 |
|---|---|---|
| 数据库与 API 规范 | 会话、消息、状态、记忆、trace、artifact 的 API 和数据模型草案。 | 后端、前端、Runtime 需要共同契约。 |
| 内容包规范 | `Character Pack`、`World Pack`、`Agent Graph Pack`、assets、版本兼容和导入导出。 | 普通创作者入口依赖内容包，SillyTavern 迁移也依赖它。 |
| Artifact Renderer 规范 | UI schema、props、state diff、patch、iframe sandbox、资源预算和快照策略。 | 防止 LLM 生成代码污染主 DOM 或拖垮长会话性能。 |
| 测试与评测规范 | 长会话、OOC、伏笔、权限、循环、成本和 artifact 隔离测试。 | 平台核心风险必须能回归验证。 |
| 文档同步规则 | `AGENT.md`、Markdown 文档、HTML 文档、文档中心和架构首页同步规则。 | 防止实现进度与文档描述长期漂移。 |

> **P0 已完成。** 五个规范文档已创建：[数据库与 API](database-api.md)、[内容包](content-packages.md)、[Artifact Renderer](artifact-renderer.md)、[测试与评测](testing.md)、[文档同步](docs-sync.md)。对应 HTML 版本和索引已同步更新。

**P0 完成标准：**

- `docs/` 中有核心规范文档入口。
- 关键结构对象有明确命名和边界。
- `AGENT.md` 明确要求项目进度、Markdown 和 HTML 文档同步。
- 文档中心能看到已完成文档、待补文档和推荐阅读顺序。

---

## P1：最小可运行 MVP

P1 目标是做出一个可自托管、能聊天、能流式输出、能记录 trace、能保存基础记忆的最小系统。

### 后端骨架

- 创建 Rust workspace 或后端 crate。
- 使用 `axum + tokio + sqlx + SQLite`。
- 实现健康检查、会话、消息、流式输出和基础错误模型。
- 建立 provider adapter 边界，节点不直接绑定具体模型 API。

### 前端骨架

- 创建 `React + TypeScript + Vite` 前端。
- 实现会话列表、聊天 / 写作界面、流式输出展示。
- 建立基础角色卡和世界书编辑入口。
- 预留 trace、上下文预览和 artifact 面板入口。

### Single Agent Runtime

- 实现 `UserInput -> Npc/Writer -> Memory`。
- 输出仍然要求结构化包装，不能只保存自然语言文本。
- 每轮记录 trace：输入、上下文、模型配置、输出、记忆候选和错误。

### 基础记忆

V1 最少实现五层：

- Recent Context
- Scene Summary
- Structured State
- Event Ledger
- Foreshadowing Registry

**P1 完成标准：**

- 用户能创建会话并发送消息。
- 输出支持流式展示。
- 每轮有可查看 trace。
- 基础状态、事件和伏笔能写入并在后续轮次召回。

> **P1 骨架已完成（2026-06-04）。** 后端 Rust + axum + SQLite 骨架、前端 React + Vite 骨架、Single Agent Runtime、OpenAI 兼容 Provider Adapter、5 层记忆系统和 API 端点已实现。可运行 `cargo run`（后端）和 `npm run dev`（前端）启动。

---

## P2：平台核心差异化

P2 开始体现本项目不是普通聊天 UI，而是受控多 Agent RP / 写作 Runtime。

### 官方模板图

优先实现：

1. `single_agent`
2. `collaborative_director`
3. `strict_director`

后续再做 `multi_npc_scene` 和 `advanced_graph`。

### Proposal + Commit

Memory、Tool、Plugin、Agent 都只能提出候选变更。Runtime 负责校验 schema、权限、风险等级和冲突，再提交到主状态。

### ContextBundle 权限隔离

每个 Agent 只拿自己有权读取的信息：

- NPC 不能读取导演计划。
- NPC 不能读取未知隐藏秘密。
- Writer 不能擅自发明未裁决事实。
- Plugin 只能读取 manifest 授权范围内的数据。

### Consistency 检查

先实现结构化检查，再引入 LLM 审查：

- 世界事实冲突
- 时间线错乱
- 角色 OOC
- 关系跳变
- 能力膨胀
- 伏笔长期未处理

**P2 完成标准：**

- 严格导演模式下，用户不能直接口胡世界事实。
- 高风险状态变更不会自动提交。
- NPC ContextBundle 不包含未知秘密。
- trace 能解释本轮为什么召唤某个 Agent、采用哪些记忆、提交哪些状态。

---

## P3：高级创作者能力

P3 面向高级创作者，但仍然以安全边界和可调试性为前提。

### Agent Graph 编辑

- 使用 React Flow 做图编辑。
- 支持节点、边、条件、模型、预算和权限配置。
- 导入图包必须经过 schema 校验和安全限制。

### Artifact Renderer

- 聊天消息只引用 `artifact_id` 和 `version`。
- 普通 UI 使用 JSON schema / props / state diff。
- 高级 UI 才允许 iframe sandbox 自定义 HTML/CSS/JS。
- 离屏 artifact 卸载或转静态快照。

### SillyTavern 迁移

- 支持导入角色卡、世界书和预设。
- 把历史上下文迁移为摘要、事件账本和结构化状态候选。
- 对无法可靠迁移的隐藏设定和旧记忆显示风险提示。

**P3 完成标准：**

- 高级用户能编辑和导入受限 Agent Graph Pack。
- Artifact 不污染主页面，也不会随长会话无限增加 DOM。
- SillyTavern 内容能进入平台内容包模型。

---

## P4：插件与生态

P4 是生态层，不应早于 Runtime、Memory、Boundary 和 Artifact 的基本稳定。

### 插件系统

- 插件 manifest。
- 权限申请与用户授权。
- 代码节点沙箱。
- 工具调用预算和超时。
- 插件输出结构化校验。

### 图包与插件分发

- `TrustedGraphPack` / `UnverifiedGraphPack` 分级。
- 版本兼容声明。
- 风险提示和导入报告。
- 示例包和测试夹具。

**P4 完成标准：**

- 插件不能默认读取隐藏世界书、网络、本地文件或长期状态。
- 插件只能提交候选变更，不能直接改主账本。
- 第三方图包质量风险和平台安全责任边界清晰展示。

---

## 推荐落地顺序

```text
1. docs/ 数据库与 API 规范
2. docs/ 内容包规范
3. docs/ Artifact Renderer 规范
4. schemas/ 核心 JSON schema 草案
5. backend/ axum + SQLite 最小服务
6. frontend/ React + Vite 最小界面
7. provider adapter + 流式输出
8. single_agent Runtime
9. Recent Context + Scene Summary + Structured State
10. Event Ledger + Foreshadowing Registry
11. trace 查看与回放
12. Character Pack / World Pack 导入
13. Director / WorldJudge / Writer 官方模板图
14. ContextBundle 权限隔离
15. proposal + commit 风险提交
16. Consistency 检查
17. Artifact Renderer
18. Agent Graph 编辑器
19. SillyTavern 迁移
20. 插件系统
```

---

## 暂不优先

- 复杂插件市场。
- 向量库作为唯一记忆方案。
- 自由图无限开放。
- 多供应商高级路由策略。
- 桌面端 Tauri 打包。
- 大规模多人协作权限。

这些能力可以预留接口，但不应该阻塞 MVP。

---

## 进度同步要求

每次推进实现或调整优先级时，必须检查：

- `implementation-priority.md` 是否仍反映真实进度。
- 对应 HTML 文档是否同步。
- `docs.md` 和 `docs/html/docs.html` 是否同步更新入口。
- `index.md` 和 `docs/html/index.html` 是否同步更新总览。
- `AGENT.md` 的项目结构索引、当前状态、待补规范是否需要调整。

禁止出现 Markdown、HTML、项目实际目录三者描述不同步的状态。
