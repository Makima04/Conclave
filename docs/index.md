# 多 Agent RP / 写作平台架构文档

> 一个可自托管的网页平台：普通创作者像使用 SillyTavern 一样导入角色卡和世界书，高级创作者可以扩展 Agent 图、插件节点和渲染能力。

`Rust 后端` · `动态总控 Runtime` · `双轨上下文` · `结构化事件召回` · `SSE 流式输出`

---

**架构重点**

- **内容包** — 角色卡、世界书、开场白、关系、模式配置（P3 预留）
- **行为包** — 动态总控多 Agent 编排（已实现）
- **能力包** — 插件节点、外部工具、检索器、渲染组件（P4 预留）
- **运行时** — 权限、上下文隔离、记忆、trace、模型路由（已实现）

---

- [文档中心](docs.md)
- [技术选型](tech-selection.md)
- [长期记忆](long-context-memory.md)
- [Agent Runtime](agent-runtime.md)
- [Actor Agent 架构](actor-agent-architecture.md)
- [动态总控架构](dynamic-master-architecture.md)
- [Agent 边界](agent-boundaries.md)
- [实现优先级](implementation-priority.md)
- [数据库与 API](database-api.md)
- [卡片导入标准化](card-import-normalization.md)
- [角色卡渲染运行时](card-rendering-runtime.md)
- [角色卡兼容运行时重构架构](card-runtime-refactor-architecture.md)

---

## 技术栈（已选定）

| 层 | 选型 |
|---|---|
| 后端 | Rust + axum + tokio + sqlx + SQLite (WAL) |
| 前端 | React + TypeScript + Vite |
| LLM 接入 | OpenAI 兼容 Provider Adapter |
| 流式输出 | SSE（Server-Sent Events） |
| 数据库 | SQLite，schema 兼容未来迁移 PostgreSQL |

---

## 总体架构

- **Web Client** — 聊天界面、会话管理、Agent 管理面板、Provider 设置。
- **Backend API** — 会话、消息、Agent 管理、Provider、提案、记忆、trace、SSE 流式输出。
- **RP Runtime Core** — 动态总控 4 层流水线（Parser → Master → Sub-agents → Writer → Compression）、上下文装配、状态变更、trace 记录。
- **Memory Layer** — 结构化状态、事件账本、伏笔、场景摘要、结构化事件召回。
- **Provider Adapter** — LLM 模型路由，支持会话级独立模型配置。

---

## Agent 编排架构

采用动态总控（Dynamic Master）架构，由 Master Agent 每轮动态决定调用哪些 Agent。互动角色统一为 Actor Agent，详见 [Actor Agent 架构](actor-agent-architecture.md)。

**4 层流水线：**

1. **Parser** — 解析用户意图，输出结构化 `ParsedIntent`。
2. **Master** — 基于上下文和意图，生成 `MasterPlan`（调用列表 + 生命周期操作）。
3. **Sub-agents** — 按计划执行子 Agent，同层并发，上下文隔离。
4. **Compression** — 后处理压缩，生成 scene_summary + events + structured_events + foreshadowing + state_changes。

---

## 创作者复用方式（P3 预留）

| 包类型 | 用途 | 面向用户 |
|---|---|---|
| `Character Pack` | 角色卡内容包 | 普通创作者 |
| `World Pack` | 世界书内容包 | 普通创作者 |
| `Agent Graph Pack` | 行为包 | 高级创作者 |
| `Plugin Pack` | 能力包 | 插件开发者 |

---

## 角色卡渲染运行时（当前实现）

复杂角色卡当前以 `ConclaveCardPackage` + iframe sandbox 渲染。运行时提供受控的 TavernHelper/MVU 兼容、宿主消息上下文、共享存档桥接和右侧开场白选择。

详见 [角色卡渲染运行时](card-rendering-runtime.md)。

---

## 角色卡兼容重构（目标架构）

角色卡兼容将从“导入器 + 多处 regex 重放 + 多个宿主补丁”收敛为统一运行时模型：导入器只做原始数据提取和兼容分析，前端成为唯一显示语义执行入口，动态变量采用 canonical state + card projection + runtime-local state 三层模型。

详见 [角色卡兼容运行时重构架构](card-runtime-refactor-architecture.md)。

---

## Artifact Renderer（长期模型）

防止 LLM 生成代码污染主 DOM 或拖垮长会话性能。采用三层渲染模型：

1. **数据驱动 UI** — 普通物品/状态变化用 JSON diff + 内置组件渲染。
2. **主题化组件** — 需要图片和特效时，声明 renderer/theme/props，用白名单组件。
3. **自定义 Artifact** — iframe 沙箱化 HTML/CSS/JS，有资源预算和权限 manifest。

详见 [Artifact Renderer 规范](artifact-renderer.md)。

---

## 技术选型

详见 [技术选型文档](tech-selection.md)。

---

## 路线图

详细实施顺序见 [项目实现优先级](implementation-priority.md)。

- **P0** ✅ 规范文档（数据库、内容包、Artifact、测试、文档同步）
- **P1** ✅ 最小可运行 MVP（后端骨架、前端骨架、Single Agent Runtime、Provider Adapter、5 层记忆）
- **P2** ✅ 平台核心差异化（Dynamic Master、DAG 并行、Agent 生命周期、结构化事件召回、SSE 流式、消息管理）
- **P3** 高级创作者能力（Consistency 检查、Artifact Renderer、SillyTavern 迁移）
- **P4** 插件与生态（插件系统、图包分发）
