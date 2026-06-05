# 文档同步规则

> 定义项目文档的同步矩阵、更新触发条件、Markdown ↔ HTML 一致性要求和自动化检查建议。防止实现进度与文档描述长期漂移。

`Docs Sync` · `Markdown` · `HTML` · `AGENT.md` · `Documentation` · `CI`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [实现优先级](implementation-priority.md)

---

## 目标

- 项目实际代码、目录结构、Markdown 文档、HTML 文档和 AGENT.md 五者始终描述同一状态。
- 任何变更都有明确的文档更新触发规则，不依赖开发者记忆。
- 新增文档时有标准化流程，不会遗漏索引更新。
- 文档内链接始终有效，不存在死链。

---

## 同步层次

文档同步有四个层次，每一层都必须保持一致。

| 层次 | 包含 | 一致性要求 |
|---|---|---|
| 代码 ↔ 文档 | 代码实现、架构决策、模块边界 | 代码变更后，对应文档描述必须反映实际行为。 |
| Markdown ↔ HTML | `docs/*.md` 和 `docs/html/*.html` | 内容完全一致，HTML 是 Markdown 的视觉化呈现。 |
| 文档 ↔ 索引 | 文档文件和 `docs.md`、`index.md` | 文档中心和架构首页列出所有已存在文档，不存在未索引的文档。 |
| 索引 ↔ AGENT.md | `docs.md`、目录结构和 `AGENT.md` | AGENT.md 的项目结构索引、阅读顺序和待补规范与实际状态一致。 |

---

## 同步矩阵

以下矩阵定义每种变更类型需要更新哪些文件。

### 代码变更

| 变更内容 | 必须更新的文档 | 必须更新的索引 |
|---|---|---|
| Runtime 行为变更 | `agent-runtime.md` + HTML | — |
| Agent 权限或上下文可见性变更 | `agent-boundaries.md` + HTML | — |
| 长期记忆、状态、事件、伏笔、角色成长变更 | `long-context-memory.md` + HTML | — |
| 技术栈、依赖、数据库、前端框架变更 | `tech-selection.md` + HTML | — |
| 内容包格式或校验逻辑变更 | `content-packages.md` + HTML | — |
| Artifact 渲染行为或沙箱规则变更 | `artifact-renderer.md` + HTML | — |
| API 端点或数据模型变更 | `database-api.md` + HTML | — |
| 测试覆盖或性能基准变更 | `testing.md` + HTML | — |
| 实现顺序或阶段目标变更 | `implementation-priority.md` + HTML | `docs.md` + HTML、`AGENT.md` |

### 文档变更

| 变更内容 | 必须同步 |
|---|---|
| 新增文档 | 1. 创建 `docs/<name>.md`<br>2. 创建 `docs/html/<name>.html`<br>3. 更新 `docs/docs.md` 当前文档列表<br>4. 更新 `docs/html/docs.html` 当前文档列表<br>5. 更新 `docs/index.md` 相关链接<br>6. 更新 `docs/html/index.html` 相关链接<br>7. 更新 `AGENT.md` 阅读顺序和项目结构索引 |
| 删除文档 | 同新增文档的反向操作，所有引用必须清除。 |
| 重命名文档 | 同删除 + 新增，所有交叉引用更新。 |
| 文档内容变更 | 同步更新对应的 HTML 版本。 |

### 目录结构变更

| 变更内容 | 必须更新 |
|---|---|
| 新增顶层目录 | `AGENT.md` 项目结构索引。 |
| 新增重要子目录 | `AGENT.md` 计划结构（如 `backend/migrations/`）。 |
| 新增 schema 文件 | 相关规范文档 + `AGENT.md` 待补规范状态。 |

---

## Markdown ↔ HTML 同步规则

### 一对一映射

每个 `docs/*.md` 文件对应一个 `docs/html/*.html` 文件。当前映射：

| Markdown | HTML |
|---|---|
| `docs/docs.md` | `docs/html/docs.html` |
| `docs/index.md` | `docs/html/index.html` |
| `docs/long-context-memory.md` | `docs/html/long-context-memory.html` |
| `docs/agent-runtime.md` | `docs/html/agent-runtime.html` |
| `docs/agent-boundaries.md` | `docs/html/agent-boundaries.html` |
| `docs/tech-selection.md` | `docs/html/tech-selection.html` |
| `docs/implementation-priority.md` | `docs/html/implementation-priority.html` |
| `docs/database-api.md` | `docs/html/database-api.html` |
| `docs/content-packages.md` | `docs/html/content-packages.html` |
| `docs/artifact-renderer.md` | `docs/html/artifact-renderer.html` |
| `docs/testing.md` | `docs/html/testing.html` |
| `docs/docs-sync.md` | `docs/html/docs-sync.html` |

### 同步时机

- **先 Markdown 后 HTML：** 修改内容时先编辑 Markdown，再同步 HTML。HTML 是 Markdown 的派生呈现。
- **同时提交：** Markdown 和 HTML 的变更在同一个 commit 中提交。不允许只改 Markdown 不改 HTML 的 commit 存在于主分支。
- **内容一致：** HTML 版本必须包含与 Markdown 相同的信息段落、表格、代码块和交叉引用。差异只在视觉样式（CSS）。

### HTML 模板规范

所有 HTML 文档使用统一设计系统：

- 相同的 CSS 变量（`--bg`、`--panel`、`--ink`、`--accent` 等）。
- 相同的布局结构：`header` → `nav`（sticky）→ `main` → `section.band`。
- 响应式断点：`max-width: 900px`。
- 导航栏链接到相关文档（HTML 版本之间互链，不链到 Markdown）。
- 表格使用 `.matrix` 样式。
- 卡片使用 `.card` 样式，可选 `.tint`、`.blue`、`.warn` 色彩。

---

## 索引文件维护

### docs.md / docs.html — 文档中心

文档中心是所有文档的入口索引。必须反映 `docs/` 目录的实际文件。

**维护规则：**

- 当前文档：列出所有 `docs/*.md` 文件（不含 `docs.md` 自身）。
- 待补文档：列出计划中但尚未创建的文档，格式与当前文档一致。
- 建议阅读顺序：包含所有当前文档，按依赖关系排序。
- 文档从"待补"移到"当前"时，同时更新当前文档列表和待补文档列表。

### index.md / index.html — 架构首页

架构首页是项目总览。新增文档时检查是否需要在总览中添加引用。

**维护规则：**

- 框架结论部分的"新增文档"段落列出所有文档。
- 导航链接区域包含所有相关文档。
- 不承载过深细节，细节由各独立文档承担。

### AGENT.md

AGENT.md 是 LLM 编程 Agent 的协作协议。必须反映最新状态。

**需要更新的场景：**

| 触发 | 更新内容 |
|---|---|
| 新增文档 | 阅读顺序、项目结构索引、对应"改 XX"指引。 |
| 新增顶层目录 | 项目结构索引的"当前结构"和"计划结构"。 |
| 新增 schema | 工程约束 → 类型和 schema 部分。 |
| 完成待补文档 | "后续待补规范"列表移除已完成项。 |
| 新增模块 | 模块职责边界新增对应章节。 |
| 项目阶段变化 | "当前项目状态"更新。 |

---

## 自动化建议

以下自动化检查可以在 CI 中配置，减少人工同步遗漏。

### 文档结构检查

```text
检查 docs/*.md 和 docs/html/*.html 是否一一对应。
检查 docs.md 中列出的文档是否全部存在。
检查 docs.md 中的待补文档列表是否仍有对应的 docs/*.md 文件。
```

### 链接检查

```text
检查所有 Markdown 文件中的 [text](file.md) 链接是否指向存在的文件。
检查所有 HTML 文件中的 <a href="file.html"> 链接是否指向存在的文件。
检查锚点链接（#section-id）是否在目标文件中存在。
```

### 同时修改检查

```text
如果 commit 修改了 docs/foo.md 但未修改 docs/html/foo.html，发出警告。
如果 commit 修改了 docs/html/foo.html 但未修改 docs/foo.md，发出警告。
```

### AGENT.md 一致性检查

```text
检查 AGENT.md 项目结构索引中的文件是否全部存在。
检查 AGENT.md 阅读顺序中的文件是否全部存在。
检查 AGENT.md 待补规范列表中是否有文档已经创建。
```

---

## 文档生命周期

### 新增文档流程

```text
1. 确认文档属于哪个模块（Runtime / Memory / Boundary / Artifact / Content Package / API / Testing / Plugin）。
2. 在 docs.md 的"待补文档"中确认已登记（如未登记，先登记）。
3. 编写 docs/<name>.md，包含：标题、摘要、标签、导航链接、目标、关键设计、风险、验收测试。
4. 编写 docs/html/<name>.html，内容与 Markdown 一致，遵循 HTML 模板规范。
5. 更新 docs/docs.md：从"待补文档"移到"当前文档"，更新阅读顺序。
6. 更新 docs/html/docs.html：同上。
7. 更新 docs/index.md：在相关位置添加引用。
8. 更新 docs/html/index.html：同上。
9. 更新 AGENT.md：阅读顺序、项目结构索引、如适用则更新模块职责边界和待补规范。
10. 检查所有新文件中的链接是否正确。
11. 单独 commit，消息说明新增了什么文档。
```

### 修改文档流程

```text`
1. 读取目标文档和相关文档，确认变更范围。
2. 编辑 docs/<name>.md。
3. 同步编辑 docs/html/<name>.html。
4. 如变更影响其他文档的交叉引用，同步更新。
5. 如变更影响 docs.md、index.md 或 AGENT.md，同步更新。
6. 运行链接检查。
7. commit，消息说明变更内容和原因。
```

### 删除文档流程

```text
1. 确认没有其他文档引用该文档（grep 检查所有 .md 和 .html 文件）。
2. 如有引用，先更新引用文档移除引用。
3. 删除 docs/<name>.md 和 docs/html/<name>.html。
4. 更新 docs/docs.md 和 docs/html/docs.html：从当前文档列表移除。
5. 更新 docs/index.md 和 docs/html/index.html：移除引用。
6. 更新 AGENT.md：移除阅读顺序条目和项目结构索引。
7. commit。
```

---

## 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 同步规则本身过时 | 规则描述的文件结构与实际不符。 | 每次新增文档时检查本文档的映射表是否需要更新。 |
| HTML 维护成本高 | 手写 HTML 容易出错或遗漏内容。 | 后续可引入 Markdown → HTML 自动转换工具；当前阶段手动同步。 |
| AGENT.md 更新遗漏 | LLM Agent 读到过时信息，做出错误决策。 | CI 自动检查 AGENT.md 与实际文件的一致性。 |
| 交叉引用断裂 | 文档间链接指向已删除或重命名的文件。 | CI 链接检查，每次 PR 运行。 |
| 大量文档后阅读顺序混乱 | 新增文档后阅读顺序未更新。 | docs.md 和 AGENT.md 阅读顺序在新增文档时必须更新，作为文档新增流程的强制步骤。 |

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| `docs/*.md` 与 `docs/html/*.html` 一一对应 | 每个 Markdown 文件有对应 HTML 文件，无多余或缺失。 |
| docs.md 当前文档列表与实际文件一致 | `docs.md` 列出的所有文档在 `docs/` 目录中存在，反向亦然。 |
| AGENT.md 阅读顺序文件全部存在 | 阅读顺序中列出的每个文件路径都指向实际存在的文件。 |
| AGENT.md 待补规范与 docs.md 待补文档一致 | 两个列表描述同一组待补文档。 |
| 所有文档内链接有效 | 无死链，所有 `[text](file.md)` 和 `<a href="file.html">` 指向存在的文件。 |
| 新增文档后所有索引已更新 | docs.md、index.html、AGENT.md 均反映新文档的存在。 |
| Markdown 和 HTML 同一 commit 提交 | 不出现只改 Markdown 不改 HTML 的 commit。 |
| CI 检查通过 | 文档结构检查、链接检查、同时修改检查均无错误。 |
