# 文档维护规则

> 定义项目文档的唯一来源、更新触发条件、索引维护和检查建议。当前正式文档只维护 Markdown；旧的 `docs/html/` 手写副本已删除。

`Docs` · `Markdown` · `AGENT.md` · `Documentation` · `CI`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [实现优先级](implementation-priority.md)

---

## 当前策略

`docs/*.md` 是唯一正式文档来源。

不再手写维护 `docs/html/*.html`，原因：

- 手写 HTML 容易和 Markdown 漂移。
- 当前没有稳定生成脚本保证同步。
- 旧 HTML 文档已经描述了过时实现。
- 对协作 Agent 来说，单一 Markdown 来源更容易检索和修改。

如果以后需要 HTML 版本，必须通过生成脚本从 Markdown 生成，并把脚本和生成规则写入本文。

---

## 更新触发

| 变更内容 | 必须更新 |
|---|---|
| Runtime 行为变更 | `agent-runtime.md`，必要时 `dynamic-master-architecture.md` |
| Agent 权限或上下文可见性变更 | `agent-boundaries.md` |
| 长期记忆、状态、事件、伏笔、角色成长变更 | `long-context-memory.md` |
| 技术栈、依赖、数据库、前端框架变更 | `tech-selection.md` |
| API 端点或数据模型变更 | `database-api.md` |
| 内容包格式、导入导出、迁移逻辑变更 | `content-packages.md`、`card-import-normalization.md` |
| 角色卡渲染、sandbox、共享存档、开场白、iframe 性能变更 | `card-rendering-runtime.md` |
| Artifact 渲染、安全预算、沙箱策略变更 | `artifact-renderer.md` |
| 测试覆盖或性能基准变更 | `testing.md` |
| 实现顺序、阶段目标、MVP 范围变更 | `implementation-priority.md` |
| 新增、删除或重命名文档 | `docs.md`、`index.md`、`AGENT.md` |
| 新增顶层目录或重要模块 | `AGENT.md` |

---

## 新增文档流程

1. 创建 `docs/<name>.md`。
2. 使用统一结构：标题、摘要、标签、导航、目标/现状、关键设计、风险、验收测试。
3. 更新 `docs/docs.md` 的当前文档和阅读顺序。
4. 更新 `docs/index.md` 的相关入口。
5. 更新 `AGENT.md` 的阅读顺序和“改某功能先读哪篇”。
6. 用 `rg "<name>|旧文件名"` 检查引用是否完整。

---

## 删除文档流程

1. 用 `rg "deleted-file-name"` 确认所有引用。
2. 删除 Markdown 文件。
3. 删除所有引用或替换为新文档。
4. 更新 `docs/docs.md`、`docs/index.md`、`AGENT.md`。
5. 如删除的是生成物目录，更新本文的同步策略说明。

---

## 链接检查

推荐检查：

```sh
rg -n "\]\([^)]+\.md\)" docs AGENT.md README.md CLAUDE.md
find docs -maxdepth 1 -name "*.md" -print
```

检查重点：

- 所有 Markdown 链接指向存在文件。
- 文档中心列出的文件都存在。
- 实际存在的 `docs/*.md` 都在文档中心出现。
- AGENT.md / CLAUDE.md 不引用已删除的 `docs/html/`。

---

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 文档仍引用旧 HTML | Agent 读错入口。 | 删除 `docs/html/` 后用 `rg "docs/html|html/"` 清理引用。 |
| 文档描述理想架构而非当前实现 | 后续修改会按错误假设做。 | 明确区分“当前实现”和“长期目标”。 |
| 新增功能未补文档 | 维护者无法理解行为边界。 | 代码变更后按更新触发表检查。 |
| 文档过度详细且不维护 | 信息噪音增加。 | 删除或重写不再对应实现的旧文档。 |

---

## 验收

| 场景 | 通过标准 |
|---|---|
| 文档索引 | `docs/docs.md` 包含所有 `docs/*.md`。 |
| HTML 旧引用 | `AGENT.md`、`CLAUDE.md` 和 `docs/*.md` 不再要求维护 `docs/html/`。 |
| 新文档链接 | 新增文档能从 `docs/docs.md` 和 `docs/index.md` 到达。 |
| 当前实现一致性 | 角色卡渲染、共享存档、开场白选择等行为有文档描述。 |
