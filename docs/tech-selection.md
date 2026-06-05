# 技术选型文档

> 本平台的核心不是普通聊天，而是百万字级长文本 / 多轮对话下仍然保持细节、人格、伏笔、世界状态和叙事连续性。技术选型必须围绕这个目标服务。

`Rust Backend` · `React Frontend` · `Layered Memory` · `Artifact Renderer` · `Agent Trace` · `Long-form Consistency`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [长期记忆](long-context-memory.md)
- [Agent Runtime](agent-runtime.md)

---

## 核心问题

100 轮、200 轮、40 万字、80 万字甚至百万字的 RP / 小说写作，不能依赖"把历史全文塞进上下文"。上下文越长，模型注意力越分散，角色越容易 OOC，NPC 越容易扁平化，伏笔和旧细节越容易丢。

**专项文档：** [长期记忆与叙事一致性架构](long-context-memory.md) 已单独展开，技术选型需要服从那套记忆与状态管理设计。

### 细节不丢

旧事件、承诺、物品、伤势、地点、关系变化必须被抽取成可检索事实和结构化状态。

### 人格不漂移

角色人格、语气、目标、禁忌和知识边界要作为稳定 profile，每轮上下文只注入相关部分。

### 伏笔不遗忘

伏笔、未兑现承诺、隐藏秘密、长期目标需要单独登记，不应只藏在聊天摘要里。

> **关键判断：** 这是一个"长篇叙事状态管理系统"，不是简单聊天 UI。Agent、RAG、摘要、数据库和前端渲染都要服务于长篇一致性。

---

## 推荐技术栈

| 层 | 推荐 | 原因 | 替代方案 |
|---|---|---|---|
| 后端 | `Rust + axum + tokio` | 性能稳定，适合本地部署、长任务、流式输出、插件沙箱和多平台分发。 | Python FastAPI 更快原型，但长期性能和单体分发弱一些。 |
| 数据库 | `SQLite + sqlx` | 本地部署简单，适合角色卡、世界书、会话、trace、状态快照。 | 服务端多人版切 PostgreSQL。 |
| 检索 | `SQLite FTS first` | 先用关键词检索解决大部分旧细节召回，避免过早引入复杂向量库。 | 后续接 Qdrant / LanceDB 做向量记忆。 |
| 前端 | `React + TypeScript + Vite` | 节点编辑器、虚拟列表、代码编辑器、复杂面板生态成熟。 | Svelte / Solid 更轻，但生态成本更高。 |
| 节点图 | `React Flow` | 适合高级创作者编辑 Agent Graph。 | 自研成本较高，不建议 V1 做。 |
| 长列表 | `TanStack Virtual` | 聊天记录和 artifact 历史必须虚拟化，避免 100+ 轮后 DOM 堆积。 | React Virtuoso 也可。 |
| 代码编辑 | `Monaco Editor` | 适合 prompt、JSON schema、插件代码和 artifact 调试。 | CodeMirror 更轻。 |
| 桌面版 | `Tauri later` | 先把 Web 版打稳，再用 Tauri 包装跨平台桌面。 | Electron 更重，但兼容性一致。 |

---

## 长期记忆与一致性架构

长篇 RP 的记忆不能只有一层。推荐做成分层记忆系统，每层服务不同目的。

1. **Recent Context / 最近上下文** — 最近几轮完整对话，保证当前互动自然衔接。
2. **Rolling Summary / 滚动摘要** — 章节级、场景级摘要，压缩不重要的过渡内容。
3. **Structured State / 结构化状态** — 人物位置、伤势、物品、关系、目标、已知秘密、世界时间。不能只靠自然语言摘要。
4. **Event Ledger / 事件账本** — 关键事件按时间线记录，可检索、可引用、可追责。
5. **Foreshadowing Registry / 伏笔登记表** — 未揭示秘密、未兑现承诺、长期谜团、未来回收点。需要状态：open、hinted、resolved、abandoned。
6. **Character Profile Memory / 角色人格记忆** — 角色核心人格、口癖、底线、欲望、恐惧、关系变化和 OOC 红线。
7. **Retrieval Memory / 检索记忆** — 关键词 + 向量召回旧细节，但召回结果必须经过导演或记忆 Agent 过滤。

> **建议：** V1 至少实现 Recent Context、Rolling Summary、Structured State、Event Ledger 和 Foreshadowing Registry。向量记忆可以后置。

---

## Rust 后端职责

### 核心模块

- `runtime`：Agent Graph 执行、节点调度、上下文装配。
- `memory`：摘要、事件、状态、伏笔、检索。
- `packages`：角色卡、世界书、Agent Graph、插件包导入导出。
- `providers`：OpenAI、OpenRouter、Ollama、vLLM、LM Studio adapter。
- `artifacts`：artifact 版本、patch、资源和快照。
- `trace`：每轮调用链、输入、输出、检索、成本、裁决记录。

### API 形态

- `POST /sessions/:id/messages`：发送用户输入，返回流式响应。
- `GET /sessions/:id/trace/:turn`：查看本轮 Agent trace。
- `POST /packages/import`：导入角色卡、世界书、图包。
- `GET /artifacts/:id/:version`：读取 artifact 版本。
- `POST /artifacts/:id/patch`：应用 artifact patch。

---

## 前端职责

### 聊天与写作

虚拟列表、流式输出、角色头像、消息分支、章节视图、小说模式和 RP 模式切换。

### 创作者工具

角色卡编辑、世界书编辑、关系图、伏笔表、事件时间线、Agent 节点图。

### 调试工具

trace 回放、上下文包预览、检索命中、OOC 检查结果、artifact 版本历史。

---

## Artifact Renderer 技术策略

角色卡带前端、LLM 输出 UI、多轮后卡顿的问题，应该由 Artifact Renderer 统一解决。

### 推荐实现

- 聊天消息只保存 artifact 引用，不直接嵌入完整代码。
- 普通 UI 用 JSON schema / props / state diff。
- 高级 UI 用 iframe sandbox 渲染。
- iframe 与主页面只通过 `postMessage` 通信。
- 离屏 artifact 卸载或转为快照。

### 资源控制

- 限制 JS 大小、DOM 数量、运行时间和内存预算。
- 限制本地资源访问，只允许读取内容包内 assets。
- 禁用顶层跳转、弹窗、同源访问和危险 API。
- 插件代码节点必须声明权限。

---

## 选型结论

### V1 应该确定

- Rust + axum + tokio + sqlx + SQLite。
- React + TypeScript + Vite。
- React Flow + TanStack Virtual + Monaco Editor。
- Artifact Renderer：iframe sandbox + state diff。
- 长期记忆：结构化状态 + 事件账本 + 伏笔登记表。

### V1 不建议做

- 不要一开始绑定 LangGraph / AutoGen / CrewAI。
- 不要一开始做复杂插件市场。
- 不要把向量库作为唯一记忆方案。
- 不要让 LLM 每轮输出完整前端代码。
- 不要把百万字历史直接塞进模型上下文。
