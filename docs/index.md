# 多 Agent RP / 写作平台架构文档

> 一个可自托管的网页平台：普通创作者像使用 SillyTavern 一样导入角色卡和世界书，高级创作者可以扩展 Agent 图、插件节点和渲染能力。

`Rust 后端候选` · `自研 RP Runtime` · `Agent Graph` · `插件代码节点` · `沙箱化前端渲染`

---

**架构重点**

- **内容包** — 角色卡、世界书、开场白、关系、模式配置
- **行为包** — 导演、NPC、写手、裁判、记忆、工具节点图
- **能力包** — 插件节点、外部工具、检索器、渲染组件
- **运行时** — 权限、上下文隔离、记忆、trace、模型路由

---

- [文档中心](docs.md)
- [技术选型](tech-selection.md)
- [长期记忆](long-context-memory.md)
- [Agent Runtime](agent-runtime.md)
- [Agent 边界](agent-boundaries.md)
- [实现优先级](implementation-priority.md)
- [数据库与 API](database-api.md)
- [内容包](content-packages.md)
- [Artifact Renderer](artifact-renderer.md)
- [测试与评测](testing.md)
- [文档同步](docs-sync.md)

---

## 框架结论

平台核心不建议直接绑定 LangGraph、AutoGen、CrewAI、OpenAI Agents SDK 或 DSPy。更稳的做法是自研 **RP Agent Runtime**，外部框架作为参考、适配器或局部能力。

**新增文档：** [技术选型文档](tech-selection.md) 已单独整理，重点讨论 Rust 后端、React 前端和 Artifact Renderer。[长期记忆与叙事一致性架构](long-context-memory.md) 专门处理百万字级长文本、人物不 OOC、细节和伏笔不丢的问题。[Agent Runtime 规范](agent-runtime.md) 定义多 Agent 每轮如何执行。[Agent 边界与权限架构](agent-boundaries.md) 负责定义每个 Agent 能看什么、能做什么、能写什么。[项目实现优先级](implementation-priority.md) 负责把当前架构拆成 P0-P4 的落地顺序。

### 自研核心

角色、世界书、权限、记忆、导演裁决和上下文隔离是 RP 专用问题，需要由平台自己掌控。

### 借鉴框架

借鉴 LangGraph 的状态图与 handoff，借鉴 OpenAI Agents SDK 的 tracing、guardrails 和工具调用。

### 避免误用

DSPy 更适合提示词优化和评测；CrewAI 更像任务流；AutoGen 更适合原型和研究，不适合直接承载 RP 内核。

---

## 总体架构

- **🔵 Web Client** — 聊天、小说写作、角色卡编辑、世界书编辑、Agent 图编辑、trace 查看、沙箱渲染预览。
- **🟢 Backend API** — 会话、内容包、Agent 图、插件、模型配置、记忆检索、流式输出和运行日志。
- **🟠 RP Runtime Core** — 世界规则裁决、用户权限、上下文装配、角色可见性、节点调度、状态变更、trace 记录。
- **🔴 Adapters & Sandboxes** — LLM provider adapter、插件沙箱、前端渲染沙箱、向量库、文件资源和外部工具。

---

## Agent 图设计

多 Agent 不是群聊，而是受控编排。每轮输入会进入导演或路由节点，再按世界模式决定是否调用裁判、NPC、写手、记忆和插件节点。

**流程：**

1. **Input** — 用户行为、创作指令或角色台词。
2. **Director** — 判断权限、目标、参与节点和世界约束。
3. **Judge / NPC** — 裁决世界事实，召唤相关 NPC。
4. **Writer** — 合成叙事文本，保持风格和可读性。
5. **Memory** — 异步抽取事实、更新关系和长期记忆。

### 内置节点

- `DirectorNode`：导演总控和权限裁决。
- `WorldJudgeNode`：世界规则、能力、时间线裁判。
- `NpcNode`：角色扮演，只读取自己可见的信息。
- `WriterNode`：叙事合成，不擅自改变事实。
- `MemoryNode`：摘要、事件、关系和状态更新。
- `ToolNode`：插件或外部工具调用。

### 高级节点开放

- 普通模式自动生成默认图。
- 高级模式允许修改节点、连线、条件和模型。
- 插件代码节点必须声明权限，并在沙箱内运行。
- 所有节点调用都进入 trace，便于回放和调试。

---

## 创作者复用方式

| 包类型 | 用途 | 面向用户 | 关键内容 |
|---|---|---|---|
| `Character Pack` | 角色卡内容包 | 普通创作者 | 公开设定、隐藏设定、语气、目标、关系、知识边界。 |
| `World Pack` | 世界书内容包 | 普通创作者 | 地点、势力、时间线、规则、导演强度、用户叙事权限。 |
| `Agent Graph Pack` | 行为包 | 高级创作者 | 节点、连线、条件、模型、工具权限、上下文可见性。 |
| `Plugin Pack` | 能力包 | 插件开发者 | 新节点类型、工具、检索器、渲染组件、权限 manifest。 |

---

## LLM 前端代码渲染卡顿问题

不要把 LLM 每轮输出的 HTML/CSS/JS 直接追加到主聊天 DOM 里运行。多轮后卡顿通常来自 DOM 节点膨胀、重复脚本执行、事件监听器泄漏、动画计时器泄漏、全局样式污染和大段代码反复重新编译。

### 推荐方案：沙箱化渲染单元

- 每个可视化消息用独立 `iframe sandbox` 或 Web Component 容器。
- 主聊天列表只保留轻量占位和缩略状态。
- 离开视口的渲染单元自动冻结、卸载或转成截图。
- 重新进入视口时再懒加载恢复。

### 推荐方案：Artifact 模型

- LLM 不在每条消息里重复输出完整前端代码。
- 第一次创建 artifact，后续只输出 patch、props 或 state diff。
- 平台负责版本管理、编译缓存和回滚。
- 聊天消息引用 artifact 版本，而不是复制整份代码。

### 推荐方案：资源预算

- 限制单个渲染卡片的 DOM 数量、JS 大小、运行时间和内存。
- 禁用或代理危险 API：网络、存储、摄像头、顶层跳转。
- 长时间动画、定时器和监听器必须由 runtime 托管。
- 超过预算自动降级为静态预览。

### 推荐方案：组件白名单

- 优先让 LLM 输出 JSON UI schema，而不是任意 JS。
- 平台用受控组件渲染角色面板、状态栏、地图、物品栏。
- 高级角色卡才允许自定义代码组件。
- 自定义代码必须进入插件权限系统。

**首版建议：** 实现 `Artifact Renderer`。聊天消息只保存 artifact id 和版本号；渲染层使用虚拟列表；每个 artifact 在 iframe 中运行；离屏后卸载 iframe 并保留截图或静态 HTML 快照。

---

## 动态 UI / Artifact 演进模型

这属于架构层面。角色卡和世界书不仅会影响文字输出，也可能影响界面形态：新增物品、地图、NPC 头像、任务面板、战斗状态、好感度组件，甚至特殊视觉效果。平台需要支持 UI 变化，但不能让每轮对话都重写完整前端代码。

### 1. 数据驱动 UI

普通变化优先作为状态变化处理。例如新增物品只写入 `items.add`，平台用内置物品栏组件渲染。

- 适合物品、任务、关系、地点、属性。
- 性能最好，安全性最高。
- 普通角色卡默认使用这一层。

### 2. 主题化组件

当物品或角色需要图片、稀有度、边框、光效时，仍然不写 JS，而是声明 `renderer`、`theme` 和 `props`。

- 适合奇幻物品卡、人物状态卡、地图标记。
- 平台提供白名单组件和主题。
- LLM 只填数据，不直接控制 DOM。

### 3. 自定义 Artifact

当内置组件无法表达时，高级角色卡或插件可以创建自定义 HTML/CSS/JS artifact，并进入 iframe 沙箱渲染。

- 适合特殊小游戏、复杂动态面板、独特角色 UI。
- 需要权限 manifest 和资源预算。
- 后续更新优先使用 patch 或 state diff。

| 场景 | LLM 推荐输出 | 平台处理方式 | 是否允许代码 |
|---|---|---|---|
| 新增普通物品 | `{"items.add":[{"id":"silver_key","name":"银钥匙"}]}` | 合并 state diff，用内置物品栏渲染。 | 否 |
| 新增带图片物品 | `{"image":"assets/items/key.png","renderer":"item_card"}` | 校验资源路径，使用白名单卡片组件。 | 否 |
| 特殊稀有物品样式 | `{"theme":"dark_fantasy","effects":["pulse"]}` | 使用平台内置主题和受控动画。 | 否 |
| 复杂交互面板 | `{"artifact_id":"combat_panel","patch":{...}}` | 更新 artifact 版本，在 iframe 沙箱中渲染。 | 高级模式允许 |

### 状态变化示例

新增一个之前不存在的物品时，推荐让 LLM 输出结构化 diff，而不是整段 HTML。

```json
{"items.add":[{"id":"blood_moon_shard","name":"血月碎片","rarity":"legendary","renderer":"glowing_item_card","image":"assets/items/blood_moon_shard.png"}]}
```

### 架构原则

- UI 可以变化，但优先表现为数据变化。
- 图片和资源归内容包管理，不能任意读取本地路径。
- 样式优先使用平台主题，复杂代码才进入 artifact。
- 每个 artifact 都有版本、预算、权限和生命周期。

---

## 技术选型讨论起点

### Rust 后端可行

- `axum`：API、SSE/WebSocket、静态文件服务。
- `sqlx`：SQLite / PostgreSQL 数据访问。
- `serde`：内容包、Agent 图、trace 的结构化格式。
- `tokio`：异步 LLM 调用、记忆任务、插件沙箱调度。

### 前端候选

- React：生态大，节点编辑器、虚拟列表、artifact 预览都好找库。
- Svelte：轻量，适合本地部署体验，但生态选择少一些。
- Solid：性能好，团队熟悉度通常不如 React。
- 建议首选 React + TypeScript，除非你强烈偏轻量框架。

---

## 路线图

详细实施顺序见 [项目实现优先级](implementation-priority.md)。

### V1 文档与原型

定义内容包格式、默认 Agent 图、Rust API 草案、artifact 渲染方案和基础 UI 信息架构。

### V2 Runtime

实现 Director、NPC、Writer、Memory、Trace、模型适配器和世界书权限裁决。

### V3 插件与市场

开放插件代码节点、权限 manifest、包导入导出、版本兼容和安全审核。

---

*当前文档用于技术选型和架构讨论，后续可拆分为 API 设计、数据模型、插件规范、前端渲染规范和实施计划。*
