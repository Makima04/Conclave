# 卡牌渲染流水线

> ⚠️ **本文档描述 v3 现状架构（postMessage bridge 模型）**。该架构已确认存在根本性错位（同步 API 被异步化、脚本库误注入消息 iframe、高度钳制），正在迁移到 v4 同源直连运行时。
>
> **目标架构与迁移计划见 [card-runtime-architecture-v4.md](card-runtime-architecture-v4.md)**。迁移期间新改动以 v4 文档为准；迁移完成后本文档将被重写。

## 概述

本系统完全适配 SillyTavern (ST) + JS-Slash-Runner 渲染流水线。核心思路是，卡牌作者已经按照 ST 运行时写好了 HTML/CSS/JS，我们只需要提供一个足够像 ST 的运行环境。

## 流水线

```
卡牌 regex_scripts 转换
       │
       ▼
┌─ 检测渲染路径 ───────────────────────┐
│                                       │
│  含 <script> 或完整 HTML 文档        │
│  → iframe (JS-Slash-Runner 路径)      │
│                                       │
│  纯文本/简单 HTML                     │
│  → DOMPurify + style scope + 内联     │
│  (ST 路径)                            │
└───────────────────────────────────────┘
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `message-html.tsx` | 统一入口 `renderMessageHtml()`：先跑 regex scripts，再检测 iframe vs inline 路径 |
| `card-content.tsx` | `renderCardIframeHtml()` 构建完整 HTML 文档；`buildIframeDocument()` 注入 ST 标准库和 `tavern_helper` 脚本 |
| `IframeHtmlRuntimeHost.tsx` | 渲染 Blob URL 到 iframe，处理 postMessage 通信（`th_api`、变量同步、sandbox-resize） |
| `iframe-bridge.ts` | `buildIframeBridgeScript()` 注入 TavernHelper API shim、Mvu shim、`_` lodash-like 工具 |
| `MessageContent.tsx` | React 组件，根据 `RenderOutput.type` 决定走 iframe 还是内联路径 |
| `st-init-variables.ts` | 前端预览用的 `<UpdateVariable><initvar>` / JSON 初始变量解析，给 opening swipes 构造 `swipes_data` |
| `st-rendering-engine.ts` | ST 兼容的正则引擎 `getRegexedString()`（移植自 ST 的 `engine.js`） |

## iframe 注入的资源

### ST 标准第三方库

| 库 | CDN | 原因 |
|---|-----|------|
| Font Awesome 6.4 | cdnjs | 图标字体，卡牌 CSS 大量使用 `fa-*` class |
| Tailwind CSS 2.2 | jsDelivr | 工具类 CSS，卡牌布局依赖 |
| jQuery 3.6 | cdnjs | `$()` 选择器，几乎所有卡牌 JS 都依赖 |
| Vue 2.7 | cdnjs | 数据绑定，部分卡牌用 Vue 构建交互界面 |

### 自定义注入

| 脚本 | 位置 | 作用 |
|------|------|------|
| Bridge Shim | 内联 `<script>` 在 body 末尾 | `TavernHelper` API、`Mvu`、`_`、`eventEmit/On/Once` |
| VH 替换脚本 | 内联 `<script>` | 设置 `--TH-viewport-height` CSS 变量，配合 `100vh → calc(...)` 替换 |
| `tavern_helper.scripts` | 如果是 `import` 语句 → `<script type="module">`，否则 → `<script defer>` | 卡牌的辅助脚本，如浮动按钮、状态栏、CG 相册、自动正则 |

### 预处理

- **CDN URL 重写**：`bootcdn.net` → `cdnjs/cdnjs.cloudflare.com`（避免浏览器广告拦截器屏蔽）
- **Viewport 单位替换**：CSS 中的 `100vh` → `calc(100 * var(--TH-viewport-height) / 100)`（防止 iframe 内 viewport 高度错误导致溢出）

## 对比 ST（已知差距）

以下差异影响较小，大多数卡牌不依赖：

| # | 环节 | 差异 | 影响 |
|---|------|------|------|
| 1 | Showdown/Markdown | inline 路径不做 Markdown→HTML 转换 | 纯文本消息的 `**bold**` 等不渲染 |
| 2 | regex 脚本类型 | 只执行 scoped scripts，不执行 global/preset | 隔离性更好，不影响卡牌主逻辑 |
| 3 | DOMPurify hooks | 缺外部媒体拦截和未知元素换行 | 安全微增 |
| 4 | predefine.js 全局变量 | 缺 `YAML`、`z`、`showdown`、`toastr`、`SillyTavern` | 极少卡牌会调用这些 |

## iframe 通信协议

iframe 通过 `postMessage` 与父窗口通信：

### iframe → 父窗口

| type | 用途 |
|------|------|
| `th_api` | 调用后端 API（getChatMessages, setVariables 等），含 `requestId` 用于异步响应 |
| `sandbox-resize` | 报告 iframe 内容高度变化 |
| `rendered` | 通知父窗口 DOM 已就绪 |
| `setVariables` | 卡牌请求修改变量 |
| `card-sandbox-action` | 卡牌触发自定义 action |

### 父窗口 → iframe

| type | 用途 |
|------|------|
| `th_api_response` | API 调用结果，含 `requestId` 匹配请求 |
| `variablesUpdated` | 推送最新变量数据到 iframe 内的 `window.__xpVariables` |
| `th_event` | 推送事件到 iframe |
| `runtimeUpdated` | 推送 ST-like runtime 快照，包含 messages/currentMessage/sharedSaves/submission 等 |

## 开场白预览与运行时生命周期

空会话进入角色卡时，聊天区会先挂载 opening preview。若卡牌存在 HTML app / `tavern_helper.scripts`，预览 iframe 负责展示初始 UI；当用户通过卡内按钮调用 ST API（如 `setChatMessage({ swipe_id }, 0)`）时，父窗口把 `message_id: 0` 映射为 opening preview，并切换或应用对应开场白。

每个 opening swipe 都会暴露给 iframe：

- `swipes`：主开场白 + alternate greetings 原文。
- `swipe_id`：当前开场白的 0 基下标，与 ST 消息 swipe 语义一致。
- `swipes_data`：从对应开场白中的 `<UpdateVariable><initvar>` 或 JSON 初始变量解析出的变量快照，叠加当前会话变量后传入。
- `variables` / `data.stat_data` / `data.display_data`：当前 active swipe 的变量快照。

选择并写入开场白后，正文消息只渲染可见文本；原始初始 UI 不再附着在 turn 0 正文里。需要继续执行的 TavernHelper 辅助脚本由隐藏 runtime host 承载，该 host 不参与布局，仅负责脚本副作用和父窗口通信。

卡牌脚本可能把浮动按钮或状态栏挂到父页面 DOM。宿主在以下时机清理已知父页面浮层 DOM，避免切换会话或退出到首页后残留：

- iframe 文档重建前；
- iframe 主动发送 `cleanup-floating-ui`；
- `Chat` 组件卸载、`sessionId` 改变或角色卡改变时。

## 变量状态双层存储与同步机制

角色卡运行时涉及两层后端存储，职责不同：

| 表 | 职责 | 写入方 | 读取方 |
|---|---|---|---|
| `session_variables` | 卡片变量接口 / 投影缓存（canonical → projection 映射后的变量） | 前端 `setVariables` / `apply_opening` / `persist_normalized_changes_tx` | `/variables` API、iframe bridge `th_api` |
| `state_snapshots` | 运行时结构化状态快照，包含 `variables`、`platform_state`、记忆数据等 | Runtime 压缩 Agent、`mirror_variables_to_state_snapshot_tx`、`reconcile_session_variables_snapshot` | `/state` API、小界面状态栏、Runtime 上下文构建 |

### 写入路径

卡片变量变更的完整写入链路：

1. 前端通过 `th_api` → `setVariables` 或 `/variable-changes` 提交变更。
2. 后端 `card_state_adapter::persist_normalized_changes_tx` 将变更 deep-set 到 `session_variables.variables`。
3. **同一事务内**调用 `mirror_variables_to_state_snapshot_tx`：读取最新 `state_snapshots`，将 `variables` 字段替换为最新投影值，写入新版本快照（`committed_by = 'variable_projection'`）。

开场白切换（`apply_opening`）的写入链路：

1. `state_initializer::initialize_session_state_from_content` 从开场白内容初始化状态。
2. `apply_opening` 从最新 `state_snapshots` 读取 `variables`，upsert 到 `session_variables`。
3. 后续 `/state` 读取时，reconcile 机制检测到 `session_variables.updated_at > state_snapshots.created_at`，自动合并。

### 读取时 reconcile

`GET /state` 在返回数据前执行 `reconcile_session_variables_snapshot`：

1. 比较 `session_variables.updated_at` 与最新 `state_snapshots.created_at`。
2. 若 `session_variables` 更新（即投影缓存比快照新），将 `variables` 合并进最新快照并写入新版本（`committed_by = 'variable_projection_reconcile'`）。
3. 这保证了即使写入路径未执行 mirror（如旧分叉会话、直接数据库修改），`/state` 仍能返回最新变量。

### 之前的问题

切换开场白后，正文内容已更新，但 `state_snapshots.variables` 仍残留旧开场白的人物变量（如上一次开场白的角色名"沈慕微"）。前端 `/variables` 接口返回正确值（从 `session_variables` 读取），但 `/state` 返回旧值（从 `state_snapshots` 读取），导致小界面状态栏显示过期数据。

根因：`session_variables` 和 `state_snapshots` 的 `variables` 字段各自独立演化，缺少同步机制。

## 开场白切换与 swipe_id 映射

开场白切换使用 0-based 下标，与 ST 的 `swipe_id` 语义一致：

- `selectedGreetingIndex = -1` 表示主开场白（`first_mes`），对应 `swipe_id = 0`。
- `selectedGreetingIndex = 0` 表示第一个 alternate greeting，对应 `swipe_id = 1`。
- 前端 `greetingOptions` 中 `value: index - 1`，使下标从 `-1` 开始；传入 iframe 时映射为 0-based `swipe_id`。

之前的问题：`swipe_id` 映射未统一为 0-based，导致卡内 UI 请求 `setChatMessage({ swipe_id }, 0)` 时指向错误的开场白。

## 浮动状态栏宿主生命周期

卡牌脚本可将浮动按钮或状态栏挂载到父页面 DOM（如 `document.body`）。宿主（floating status host）负责管理这些浮层的生命周期。

`runtimeUpdated` 事件推送 ST-like runtime 快照到 iframe。当 Runtime 更新触发 iframe 文档重建时，宿主必须保留而不被销毁——它管理的是父页面 DOM 节点，不是 iframe 内容。

之前的问题：Runtime 更新导致 iframe 文档重建时，父级 floating status host 被误删，浮动状态栏消失。修复后，runtimeUpdated 不再触发父级宿主的卸载，仅更新 iframe 内的运行时快照。

## 已解决的问题

| 日期 | 问题 | 修复 |
|------|------|------|
| 2026-06-11 | "灵"悬浮按钮不显示（苍玄界卡牌） | 注入 `tavern_helper.scripts` 作为 `type="module"` 脚本到 iframe |
| 2026-06-11 | iframe 缺 jQuery/Vue/FontAwesome/Tailwind | 注入 ST 标准第三方库 CDN |
| 2026-06-11 | `100vh` 导致 iframe 布局溢出 | CSS 替换 `vh` → `calc(... * var(--TH-viewport-height))` + 运行时设置 CSS 变量 |
| 2026-06-11 | `sandbox="allow-scripts"` 限制功能 | 移除 sandbox 属性，Blob URL 已提供 origin 隔离 |
| 2026-06-12 | 退出会话后父页面浮层残留 | 会话/角色卡切换和 iframe 重建时清理父页面 runtime UI |
| 2026-06-12 | 卡内初始 UI 无法切换开场白 | 将空会话 `message_id: 0` 映射为 opening preview，并等待 `setChatMessage` 操作完成 |
| 2026-06-12 | 不同开场白变量预览一致 | 为每个 opening swipe 构造 `swipes_data`，当前 swipe 使用对应变量快照 |
| 2026-06-12 | 切换开场白后小界面状态栏显示旧值 | `persist_normalized_changes_tx` 写入 `session_variables` 后同步 mirror 到 `state_snapshots`；`/state` 读取时 reconcile 检测时间戳差异自动合并 |
| 2026-06-12 | 开场白切换混入默认 InitVar | `apply_opening` 不再将世界书默认变量覆盖开场白内容中解析出的变量 |
| 2026-06-12 | `swipe_id` 映射偏移 | 统一为 0-based：主开场白 = 0，alternate greetings = 1, 2, ... |
| 2026-06-12 | `runtimeUpdated` 误删父级 floating status host | Runtime 更新仅推送快照到 iframe，不触发父页面宿主的卸载 |
