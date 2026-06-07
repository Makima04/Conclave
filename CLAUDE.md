# CLAUDE.md

## 工作流程

- 回答任何代码相关问题或进行代码修改前，先调用 `codegraph_status` 确认索引健康，再用 `codegraph_explore` 查询相关符号和上下文。
- 优先使用 codegraph 工具而非手动 grep/find 来定位代码。
