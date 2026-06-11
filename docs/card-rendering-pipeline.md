# 卡牌渲染流水线

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

## 已解决的问题

| 日期 | 问题 | 修复 |
|------|------|------|
| 2026-06-11 | "灵"悬浮按钮不显示（苍玄界卡牌） | 注入 `tavern_helper.scripts` 作为 `type="module"` 脚本到 iframe |
| 2026-06-11 | iframe 缺 jQuery/Vue/FontAwesome/Tailwind | 注入 ST 标准第三方库 CDN |
| 2026-06-11 | `100vh` 导致 iframe 布局溢出 | CSS 替换 `vh` → `calc(... * var(--TH-viewport-height))` + 运行时设置 CSS 变量 |
| 2026-06-11 | `sandbox="allow-scripts"` 限制功能 | 移除 sandbox 属性，Blob URL 已提供 origin 隔离 |
