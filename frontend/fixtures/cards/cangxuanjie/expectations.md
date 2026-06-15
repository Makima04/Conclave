# 苍玄界 — 回归预期

卡片文件：`3.X.png`

## 开场白渲染

- [ ] 开场白 HTML app 正常渲染（无白屏）
- [ ] 开场白中的交互按钮/选项可点击

## 浮动 UI

- [ ] "灵"浮动按钮出现在父页面（宿主 DOM，不在 iframe 内）
- [ ] 点击"灵"浮动按钮后，小界面正常渲染且有内容（不空白）
- [ ] 小界面依赖的 `Vue` / `z` / MVU 相关全局可用，console 不出现 `ReferenceError: Vue is not defined` 或 `ReferenceError: z is not defined`
- [ ] 浮动按钮跨消息持久（发送新消息后不消失）
- [ ] 切换开场白 swipe 后浮动按钮不消失
- [ ] 切换会话后浮动按钮被清理（不残留）

## 变量

- [ ] 卡片 JS 调用 `getVariables()` 返回同步结果（不是 Promise）
- [ ] 变量写入后宿主聊天列表自动刷新

## 样式

- [ ] iframe 高度自适应内容（无截断）
- [ ] 无 MIN/MAX 高度钳制（高度 >720px 时不被截断）
- [ ] 100vh 不导致 iframe 溢出

## Swipe

- [ ] 卡内 UI 调用 `setChatMessage({swipe_id}, 0)` 正确切换开场白

## 已知历史 bug（应已修复）

- 浮动"灵"按钮不显示（v3 脚本库注入消息 iframe 导致，M3 修复）
- 点击"灵"后小界面空白（脚本宿主未加载 `content` 字段或缺少 Vue/Zod 运行环境）
- 浮动按钮切换开场白后消失（脚本 iframe 被重建导致，M3 修复）
- 父页面浮层残留（cleanupIframeParentRuntimeUi 生命周期误删，M3 修复）
