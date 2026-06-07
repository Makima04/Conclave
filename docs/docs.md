# 文档中心

> 当前阶段先把项目拆成清晰的架构文档。每份文档解决一个决策域，避免把技术选型、Agent 边界、长期记忆和内容包规范混在一起。

---

- [架构首页](index.md)

---

## 当前文档

### 总览 — [项目总架构](index.md)

说明项目目标、整体架构、Agent 图、内容包、Artifact Renderer、动态 UI 和路线图。

### 核心 — [长期记忆与叙事一致性](long-context-memory.md)

解决百万字级长文本、多轮对话、人物成长、不 OOC、伏笔、事件账本和状态一致性。

### 核心 — [Agent Runtime 规范](agent-runtime.md)

定义运行模式（single_agent / multi_agent）、Agent 类型、每轮执行流程、输出协议、状态提交和运行限制。

### 核心 — [动态总控架构](dynamic-master-architecture.md)

定义 multi_agent 模式的 4 层流水线（Parser → Master → Sub-agents → Writer → Compression）、Agent 生命周期管理、Turn State、上下文注入策略和双轨上下文架构。

### 核心 — [Agent 边界与权限](agent-boundaries.md)

定义 parser、master、npc、writer、state 等 Agent 的信息边界、行为边界、写入边界和 visibility 隔离。

### 工程 — [技术选型](tech-selection.md)

整理 Rust 后端、React 前端、数据库、检索、Artifact Renderer 和跨平台部署的推荐方案。

### 工程 — [项目实现优先级](implementation-priority.md)

定义 P0-P4 的实现顺序、MVP 边界、暂不优先事项，以及项目进度、Markdown、HTML 文档同步要求。

---

## 建议阅读顺序

| 顺序 | 文档 | 为什么先读 |
|---|---|---|
| 1 | [项目总架构](index.md) | 先明确项目不是普通聊天应用，而是长篇叙事和多 Agent 编排平台。 |
| 2 | [长期记忆与叙事一致性](long-context-memory.md) | 这是平台最核心的问题域，决定后端、Agent、数据库和测试方式。 |
| 3 | [Agent Runtime 规范](agent-runtime.md) | 先明确多 Agent 每轮如何执行、Agent 类型、状态如何提交。 |
| 3.5 | [动态总控架构](dynamic-master-architecture.md) | 深入理解 multi_agent 模式的 4 层流水线和 Agent 生命周期。 |
| 4 | [Agent 边界与权限](agent-boundaries.md) | 多 Agent 是否有效，取决于上下文隔离、权限和写入控制。 |
| 5 | [技术选型](tech-selection.md) | 最后再看技术栈，确保技术选择服务架构目标。 |
| 6 | [数据库与 API 规范](database-api.md) | 进入实现前先明确数据模型和 API 契约。 |
| 7 | [内容包规范](content-packages.md) | 创作者入口依赖内容包，SillyTavern 迁移也依赖它。 |
| 8 | [Artifact Renderer 规范](artifact-renderer.md) | 防止 LLM 生成代码污染 DOM 或拖垮长会话性能。 |
| 9 | [测试与评测规范](testing.md) | 平台核心风险必须能回归验证。 |
| 10 | [项目实现优先级](implementation-priority.md) | 进入实现前确认先做哪些契约、MVP 和核心 Runtime 能力。 |
| 11 | [文档同步规则](docs-sync.md) | 理解文档维护规则，防止实现与文档长期漂移。 |

### 工程 — [数据库与 API 规范](database-api.md)

定义 SQLite schema、Rust API、SSE 流式输出、会话、消息、状态、记忆、trace 和 artifact 接口。

### 工程 — [内容包规范](content-packages.md)

定义 Character Pack、World Pack、Agent Graph Pack、Plugin Pack、manifest schema、资源约定、版本规则、导入导出和 SillyTavern 迁移。

### 工程 — [卡片导入标准化规范](card-import-normalization.md)

定义 SillyTavern 等外部角色卡如何在导入期转换为平台原生卡包；运行时 ST sandbox 兼容标记为 deprecated，仅作为失败兜底和迁移对照。

### 工程 — [Artifact Renderer 规范](artifact-renderer.md)

定义三层渲染模型、UI Schema、Artifact 生命周期、iframe 沙箱、资源预算和快照策略。

### 工程 — [测试与评测规范](testing.md)

定义长会话回归、OOC 检测、伏笔回收、Agent 越权、循环与成本、Artifact 隔离、状态提交和流式输出测试。

### 工程 — [文档同步规则](docs-sync.md)

定义同步矩阵、更新触发条件、Markdown ↔ HTML 一致性要求、索引维护和自动化检查建议。

---

## 待补文档

### 插件系统规范

定义 manifest、权限、代码沙箱、工具调用、插件节点和安全审核。

---

## 维护规则

- `index.md` 只放总览和入口，不承载过深细节。
- 长期一致性、Agent 边界、内容包、Artifact、插件、API 分别独立成文。
- 每份文档都必须包含：目标、关键设计、风险、验收测试。
- 技术选型必须服从长期记忆与 Agent 边界，而不是反过来。
- 后续进入实现前，先把数据模型和 API 文档补齐。
- 正式文档必须保持 Markdown 与 HTML 版本同步，文档入口和项目进度说明也必须同步。
