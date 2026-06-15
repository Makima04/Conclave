# Card Runtime Regression Log

本日志记录角色卡运行时踩过的回归链。效果验收写入 `frontend/fixtures/cards/*/expectations.md`，机制保护写入自动测试，架构规则写入 `docs/card-runtime-architecture-v4.md`。

## REG-001 苍玄界 "灵" 小界面空白

引入改动：v4 迁移中将 tavern_helper 脚本从旧 bridge/headBridge 管线迁到同源 iframe runtime。

影响范围：苍玄界卡片的父页面浮动 "灵" 按钮可见时，点击后打开的小界面空白或脚本未完整初始化。

直接原因：
- fixture `/lab` 只读取 `code` / `script` 字段，苍玄界脚本实际存放在 `content` 字段，导致常驻脚本 iframe 执行空脚本。
- 真实聊天页仍把 tavern_helper 脚本拼进消息 iframe 文档，未使用 `createScriptSrcContent`，因此没有脚本 iframe 专用的 Vue / Zod 运行环境。

连锁影响：
- `MagVarUpdate` / 状态栏 bundle 依赖的 `Vue`、`z`、MVU 初始化链缺失。
- 脚本 iframe 卸载时如果调用全局 `eventClearAll()`，可能误清空其他脚本 iframe 的事件监听，导致按钮存在但后续交互失效。

修复方式：
- `CardRenderLab` 和聊天页都通过 `normalizeTavernHelperScripts()` 读取 `content` / `code` / `script`，并过滤 disabled/empty 脚本。
- 聊天页改用 `StScriptIframeHost` 运行 tavern_helper 脚本，不再用消息 iframe 承载脚本库。
- `TavernHelper.eventClearAll()` 收敛为清理当前 iframe 注册的订阅，不再清空全局 `eventSource`。

防复发：
- `frontend/src/pages/st-runtime/tavern-helper.test.ts` 覆盖 `content` 字段脚本读取和 scoped `eventClearAll()` 行为。
- `frontend/fixtures/cards/cangxuanjie/expectations.md` 增加 "灵" 小界面渲染和 Vue/Zod console 错误验收项。
