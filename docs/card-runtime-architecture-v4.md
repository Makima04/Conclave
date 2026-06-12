# 角色卡运行时架构 v4 — ST 同源直连运行时（设计文档）

> 状态：**设计已评审，待实施**。本文档是迁移的"标准答案"，实施期间所有渲染相关改动以本文档为准；实现与文档出现偏差时，先回头改文档再写代码。
>
> v3 现状架构见 [card-rendering-pipeline.md](card-rendering-pipeline.md)（迁移完成后该文档将被重写）。

## 1. 背景与诊断

### 1.1 症状

渲染 SillyTavern 前端角色卡反复出 bug——修好一张卡另一张又坏。git 历史可证（9309215 / 3141f44 / f8a841c / 09ece68 / 6fa0042 等连续修卡提交），归纳为 7 类反复 bug：脚本注入顺序、父 DOM 残留、样式隔离、变量双层不同步、宏展开时机、message 数据字段规范化、开场白 swipe 映射。

### 1.2 根因：与参照实现的三个架构错位

参照实现 = SillyTavern + 酒馆助手（JS-Slash-Runner v4.8.11），本地源码：
- ST 本体：`/Users/makima/program/SillyTavern-release`
- 酒馆助手：`/Users/makima/program/SillyTavern-release/public/scripts/extensions/third-party/JS-Slash-Runner`（下文简写 `JSR`）

| # | 错位 | 参照实现（已核实源码） | 当前 v3 实现 | 导致的 bug 类 |
|---|------|----------------------|-------------|--------------|
| 1 | **API 调用模型** | 同源 blob iframe；`JSR/src/iframe/predefine.js` 直接把 `window.parent` 的 TavernHelper / lodash / SillyTavern **merge 进 iframe window**，`getVariables()` 等是**同步函数** | postMessage RPC（`iframe-bridge.ts` 708 行），所有 API 被异步化成 Promise；变量靠 `variablesUpdated` push 到 `__xpVariables` 缓存 | 卡片 `const v = getVariables()` 拿到 Promise 直接坏；缓存过期；状态栏显示旧值；API 面永远补不全 |
| 2 | **脚本库宿主** | 卡片 JS 脚本库跑在**独立常驻隐藏 iframe**（`TH-script--{name}--{id}`，`JSR/src/panel/script/Iframe.vue`），生命周期 = 会话，与消息 iframe 完全解耦；浮动 UI 由它在 parent DOM 创建，跨消息持久 | 脚本以 `<script type="module">` + cacheBuster 注入**每个消息 iframe**（`card-content.tsx`） | "灵"浮动按钮消失、父 DOM 残留、`cleanupIframeParentRuntimeUi` 硬编码选择器打补丁 |
| 3 | **高度自适应** | iframe 内 `ResizeObserver(document.body)` → 直接 `frameElement.style.height = scrollHeight + 'px'`（同源特权，`JSR/src/iframe/adjust_iframe_height.js`），**无上限钳制** | postMessage `sandbox-resize` + MIN=360 / MAX=720 硬编码钳制 + viewportFit 计算（`IframeHtmlRuntimeHost.tsx`） | 样式不对、卡片被截断、高度抖动 |

### 1.3 附带问题：特判堆积

以下逻辑在 ST 生态中本是**卡片自带 regex 脚本的职责**，v3 把它们抢到平台管线里做，于是每张新卡都需要新特判（违反 CLAUDE.md / AGENT.md "禁止单卡特判、必须服务一类卡"方针）：

- `st-opening-ui.ts`：硬编码 4 种开场白 HTML 触发正则（`\[attachment\]`、`\[开局\]`、`【GameStart】`、`【游戏开始】`）
- `st-status-ui.ts`：`<StatusPlaceHolderImpl/>` 占位符、`<正文>` 中文标签闭合特判
- `MessageContent.tsx` / `message-html.tsx`：`stripTextOnlyCustomTags` 硬编码中文标签清单（`<inner>`、`<正文>`、`<initvar>`…）
- `backend/routes/messages.rs`（WIP）：`best_snapshot_variables` 含 `时幼微` 等单卡关键词评分
- `iframe-bridge.ts`：`_wrapMessageData` 硬编码 message 字段映射

### 1.4 结论

不再修补 bridge，**整体迁移到与参照实现一致的同源直连架构**：卡片作者面向 ST + 酒馆助手写代码，我们提供一个"足够像"的运行环境，机制照抄而不是重新发明。

已确认决策：
1. **直接替换**，不做新旧双轨；
2. iframe 内第三方库**沿用 CDN**（与酒馆助手一致）；
3. 用户提供**问题卡片集**做回归 fixtures；
4. 采用与 ST 一致的**同源信任模型**（卡片 JS 可直接访问宿主 window，自托管单用户场景）。

## 2. 设计原则

1. **机制照抄参照实现**：每个机制必须能指出移植来源（文件 + 行为），不自创协议。
2. **单一事实源**：会话内存态集中在 `StRuntimeStore`，消息/变量规范化只发生在 store 加载边界这一处。
3. **同步 API 同步实现**：参照实现里是同步函数的（变量读写、getChatMessages），我们也必须同步——这是同源直连的全部意义。
4. **特判出平台**：状态栏渲染、自定义标签清洗、开场白 UI 触发，回归卡片自带 regex 脚本的职责；平台只提供忠实的 regex 引擎与 messageFormatting 管线。
5. **未实现的 API 显式失败**：stub 必须 `console.warn` + throw，让 CardRenderLab 能观测到缺口；禁止静默吞掉。
6. **通用机制修复**：回归中发现的兼容缺口只允许在 st-runtime 层以服务一类卡的方式修，禁止回到单卡特判。

## 3. 目标架构总览

```
宿主页面 (React, http://localhost:5173)
│
├── window 全局（installStGlobals(), 应用启动时安装一次）
│     _ (lodash)   $ / jQuery   YAML   showdown   toastr(facade)   z (zod)
│     ├── window.TavernHelper   完整 API 对象 + _bind 模式
│     └── window.SillyTavern    context 代理（getContext()）
│
├── StRuntimeStore — 会话内存态唯一事实源
│     ├── chat: ST 形状消息数组
│     │     { message_id, name, role, is_hidden, message, swipes[], swipe_id,
│     │       variables[swipe_id], data, extra }
│     ├── 变量 scopes:
│     │     chat      ←→ 后端 session_variables（debounced PUT）
│     │     message   ←→ 消息 metadata（debounced PATCH）
│     │     global / character ←→ localStorage（v4 暂存，见 §11）
│     ├── regex 脚本（runtime assets + 卡片 extensions，按 id 去重）
│     ├── 角色卡数据（getCharData 用）
│     └── 写 = 同步改内存 + emit store 事件 + debounced flush 到 REST
│
├── eventSource — tavern_events 全集
│     SSE/turn 生命周期 → GENERATION_STARTED / GENERATION_ENDED /
│     MESSAGE_RECEIVED / MESSAGE_SWIPED / CHAT_CHANGED / ...
│
├── 脚本 iframe × N   TH-script--{name}--{id}（常驻隐藏，会话/角色切换时销毁）
│     └── 浮动按钮/状态栏等挂 parent DOM，跨消息持久
│
└── 消息 iframe × N   TH-message--{messageId}--{n}（blob URL，同源）
      └── head 注入顺序（照抄 JSR createSrcContent）:
          meta → <base href> → reset style → CDN 库 → predefine.js
          → adjust_viewport.js → adjust_iframe_height.js → <body>卡片HTML
```

postMessage 仅保留一条：宿主 resize 时向 iframe 发 `{ type: 'TH_UPDATE_VIEWPORT_HEIGHT' }`（照抄 `JSR/src/panel/render/Iframe.vue:34-36`）。其余全部通信走同源直接函数调用。

新代码集中在 `frontend/src/pages/st-runtime/`：

```
st-runtime/
├── store.ts               StRuntimeStore
├── tavern-helper.ts       getTavernHelper() — API 对象 + _bind
├── events.ts              eventSource + tavern_events/iframe_events 常量
├── globals.ts             installStGlobals()
├── iframe-doc.ts          createSrcContent 移植（消息/脚本两种变体）
├── iframe-scripts/        predefine.js / adjust_viewport.js /
│                          adjust_iframe_height.js / parent_jquery.js
│                          （?raw import + URL.createObjectURL，照抄 JSR script_url.ts）
├── message-formatting.ts  ST messageFormatting 管线移植（M4）
├── StMessageIframe.tsx    消息 iframe React 薄壳
└── StScriptIframeHost.tsx 脚本常驻 iframe 宿主（M3）
```

## 4. 核心机制详解

### 4.1 宿主全局与 TavernHelper（移植自 `JSR/src/function/index.ts`）

`installStGlobals()` 在应用启动时（进入含卡片的会话前）安装：

| 全局 | 来源 | 说明 |
|------|------|------|
| `window._` | npm `lodash`（已有依赖） | predefine.js 第一行就是 `window._ = window.parent._`，必须先于一切存在 |
| `window.$` / `jQuery` | npm `jquery`（新增） | 脚本 iframe 经 `parent_jquery.js` 继承宿主 `$`，浮动 UI 脚本用它操作 parent DOM |
| `window.YAML` | npm `yaml`（新增） | predefine merge 清单成员 |
| `window.showdown` | npm `showdown`（新增） | predefine merge 清单成员；M4 起 messageFormatting 也用它 |
| `window.toastr` | 现有 Toast 组件 facade | 实现 `success/info/warning/error(message, title?, options?)` 四方法即可 |
| `window.z` | 现有 `zod-v3-umd.js` | predefine merge 清单成员（卡片脚本常用 zod 校验变量） |
| `window.TavernHelper` | `st-runtime/tavern-helper.ts` | 见下 |
| `window.SillyTavern` | getContext 代理 | 返回 store 快照：`{ chat, characters, name1, name2, chat_metadata, eventSource, ... , getContext }`，按 fixtures 需求增量补字段 |
| `window.Mvu` | **不内置** | Mvu 由卡片自带脚本在 parent 上定义；predefine.js 已有透传 getter（`_.has(window.parent,'Mvu')` 时 defineProperty 代理）。v3 bridge 里的 Mvu shim 删除 |
| `window.EjsTemplate` | **不内置**（遗留差距） | 显式 stub：访问时 warn + throw |

`TavernHelper` 对象结构照抄 `JSR/src/function/index.ts` 的 `getTavernHelper()`：

- **普通成员**：不依赖调用方身份的函数，直接挂对象上。iframe 里经 predefine `_.omit(TavernHelper, '_bind')` merge 到全局，卡片可裸调 `getVariables()`。
- **`_bind` 成员**：依赖调用方 iframe 身份的函数（`_eventOn`、`_getVariables`、`_getCurrentMessageId`…）。predefine 对每个成员 `.bind(window)`（iframe 的 window）后以去前导下划线名注入（`_eventOn` → `eventOn`）。实现侧用 `this` 解析身份：`_getIframeName.call(this)` 读 `frameElement.id`，`getMessageId` 用正则 `/^TH-message--(\d+)--\d+(_\d+)?$/` 解析楼层号（照抄 `JSR/src/function/util.ts`）。
- **`_th_impl`**：日志桥（`_init/_log/_clearLog/writeExtensionField`）。v4 用 console 转发 + CardRenderLab 收集实现。

API 分组与实现策略（M1 范围 = 表中"实现"列非 stub 的行）：

| 分组 | 关键函数 | v4 实现 |
|------|---------|---------|
| variables | `getVariables` / `insertOrAssignVariables` / `replaceVariables` / `updateVariablesWith` / `insertVariables` / `deleteVariable` / `getAllVariables` | **同步**读写 store；`getVariables` 返回深拷贝（参照 `JSR/src/function/variables.ts` 的 `klona`，我们用 `structuredClone`）；scope 语义见 §4.6 |
| chat_message | `getChatMessages` / `setChatMessage` / `setChatMessages` / `createChatMessages` / `deleteChatMessages` | 读 store.chat（同步）；写经 store 方法 → 调现有 REST（switchVariant / apply_opening / 消息编辑），swipe 语义见 §4.7 |
| event | `eventOn/Once/Emit/EmitAndWait/MakeFirst/MakeLast/RemoveListener/ClearEvent/ClearListener/ClearAll` + `tavern_events` / `iframe_events` 常量 | `st-runtime/events.ts`，常量全集照抄 `JSR/src/function/event.ts` |
| generate | `generate` / `generateRaw` / `stopAllGeneration` | 接现有 SSE 发送管线（`useMessageStream` 的提交入口） |
| util | `getMessageId` / `getLastMessageId` / `substitudeMacros` / `errorCatched` | 照抄 `JSR/src/function/util.ts`；`substitudeMacros` 走 macro-engine |
| tavern_regex | `getTavernRegexes` / `replaceTavernRegexes` / `updateTavernRegexesWith` / `formatAsTavernRegexedString` | 读写 store.regexScripts；format 调 `st-rendering-engine.getRegexedString` |
| lorebook / worldbook | `getLorebookEntries` / `setLorebookEntries` / `getLorebookSettings` … | 映射现有 worldbooks REST（v3 bridge 已有等价实现，迁移语义） |
| slash | `triggerSlash` | 最小命令集（v3 bridge 已支持的子集），其余 warn + throw |
| raw_character | `getCharData` / `getCharAvatarPath` | 读 store 角色卡数据 |
| audio / preset / character CRUD / import_raw / extension / inject / script buttons | — | **显式 stub**（warn + throw），按 fixtures 需求增量实现 |

### 4.2 StRuntimeStore（单一事实源）

```ts
// st-runtime/store.ts — 概念签名
class StRuntimeStore {
  // 状态
  chat: StChatMessage[];                  // ST 形状，规范化只在加载边界做一次
  chatVariables: Record<string, any>;     // scope: chat
  globalVariables: Record<string, any>;   // scope: global（localStorage）
  characterVariables: Record<string, any>;// scope: character（localStorage）
  regexScripts: RegexScript[];
  character: CharacterCard | null;
  userName: string;

  // 生命周期
  async load(sessionId: string): Promise<void>;  // list_messages + get_variables
                                                 // + runtime-assets + charactercard
  dispose(): void;                               // flush 未写盘数据 + 清监听

  // 读（全部同步）
  getMessages(range): StChatMessage[];
  getVariables(scope, opts): Record<string, any>;

  // 写（同步改内存 + emit + debounced flush）
  setVariables(scope, data, opts): void;
  setChatMessage(fields, messageId, opts): Promise<void>; // swipe 切换需后端往返
  // ...

  // 订阅（React 接 useSyncExternalStore；eventSource 桥接 tavern_events）
  subscribe(listener): () => void;
}
```

要点：

- **规范化只此一处**：后端 `Message`（`content`/`variants`/`variant_index`/`metadata`）→ ST 形状（`message`/`swipes`/`swipe_id`/`variables[swipe_id]`/`data`）的映射在 `load()` 内完成。v3 的 `_wrapMessageData`、`swipes_data` 散补全部删除。开场白（turn 0）= `message_id 0` + swipes（主开场白 swipe 0、alternates 1..n，复用后端 09ece68 的 0-based 映射与 `apply_opening`）。
- **持久化**（仿 ST `saveChatConditionalDebounced`，debounce ~1s）：
  - chat 变量 → `PUT /api/sessions/{id}/variables`（现有路由）
  - message 变量 → 消息 `metadata` JSON（需后端补一个 PATCH 路由，见 §7）
  - global / character 变量 → `localStorage`（key 含 character id；遗留差距见 §11）
- **可靠性**：flush 失败 toast 报错 + 重试一次；`beforeunload` / `dispose()` 时强制同步 flush。
- **React 集成**：`useSyncExternalStore` 订阅 store 版本号；卡片经 TavernHelper 写 store 后，宿主聊天列表自动重渲染——v3 的 `onMessagesChanged` 回调链删除。

### 4.3 事件系统（移植自 `JSR/src/function/event.ts`）

- `eventSource`：`on/once/emit/emitAndWait/makeFirst/makeLast/removeListener/clearEvent/clearListener/clearAll`。
- `tavern_events` 常量全集照抄（~60 个）；`iframe_events` 照抄（`MESSAGE_IFRAME_RENDER_STARTED/ENDED`、`GENERATION_STARTED/ENDED`…）。
- 平台事件映射（在 `useMessageStream` 的 SSE 处理点 emit）：

| 平台时机 | emit 的 tavern_events |
|---------|----------------------|
| 用户消息提交 | `MESSAGE_SENT` |
| turn 开始（SSE 首包） | `GENERATION_STARTED` |
| turn 结束（writer 完成） | `GENERATION_ENDED`、`MESSAGE_RECEIVED` |
| swipe / variant 切换 | `MESSAGE_SWIPED` |
| 消息编辑/删除 | `MESSAGE_EDITED` / `MESSAGE_DELETED` |
| 会话切换 | `CHAT_CHANGED` |
| 消息 iframe 挂载/load | `MESSAGE_IFRAME_RENDER_STARTED` / `_ENDED` |

- iframe 侧监听器登记在宿主 eventSource 上；消息 iframe 卸载、脚本 iframe `pagehide` 时按 iframe 身份清理（predefine.js 已有 `$(window).on('pagehide', () => eventClearAll())`）。

### 4.4 消息 iframe（移植自 `JSR/src/panel/render/iframe.ts` + `Iframe.vue`）

`st-runtime/iframe-doc.ts` 的 `createMessageSrcContent(content)`：

1. **vh 窄替换** `replaceVhInContent`：**只处理 `min-height` 的四种形态**（CSS 声明、内联 style、`.style.minHeight =`、`setProperty('min-height',…)`），`100vh` → `var(--TH-viewport-height)`、其余 → `calc(var(--TH-viewport-height) * N/100)`。照抄 JSR；v3 的全量 `replaceViewportUnits` 删除（过度替换本身会改坏卡片样式）。
2. **文档骨架**（顺序照抄，不得调整）：

```html
<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${window.location.origin}"/>          <!-- blob URL 必须 -->
<style> /* reset：box-sizing、html/body margin 0 + overflow hidden、
          .user_avatar/.char_avatar 背景图 */ </style>
<!-- CDN 块，照抄 third_party_message.html：
     FontAwesome CSS、tailwindcss、jquery、jquery-ui(+css)、
     jquery-ui-touch-punch、vue、vue-router
     （保留现有 bootcdn→cdnjs 域名重写） -->
<script src="${predefine_url}"></script>
<script src="${adjust_viewport_url}"></script>
<script src="${adjust_iframe_height_url}"></script>
</head><body>
${content}   <!-- 卡片 HTML，messageFormatting 之后的产物 -->
</body></html>
```

3. 三个注入脚本用 Vite `?raw` import + `URL.createObjectURL` 生成稳定 URL（照抄 `JSR/src/iframe/script_url.ts`，模块级创建不 revoke）。`predefine.js` 按 JSR 原文移植，merge 清单去掉 `EjsTemplate`（stub）。

`StMessageIframe.tsx`（对应 `Iframe.vue`）：

- iframe 属性：`id`/`name` = `TH-message--{messageId}--{n}`、`loading="lazy"`、`frameborder="0"`、**无 sandbox 属性**、`src` = blob URL。
- blob URL 生命周期：内容变化时 revoke 旧建新；组件卸载时 revoke。
- 宿主 `window` resize → 向 iframe postMessage `TH_UPDATE_VIEWPORT_HEIGHT`。
- 挂载时 emit `MESSAGE_IFRAME_RENDER_STARTED`，`onLoad` 时 emit `MESSAGE_IFRAME_RENDER_ENDED`。
- **没有**：th_api 分发、sandbox-resize 监听、高度钳制、viewportFit 计算。

### 4.5 高度自适应

- `adjust_iframe_height.js`（照抄）：`ResizeObserver(document.body)` → `frameElement.style.height = scrollHeight + 'px'`。同源所以 iframe 内能直接摸 `frameElement`。无 MIN/MAX。
- `adjust_viewport.js`（照抄）：`html` 上设 `--TH-viewport-height: ${parent.innerHeight}px`，并监听 `TH_UPDATE_VIEWPORT_HEIGHT` 刷新。
- `chat.css` 删除对卡片 iframe 的 `max-height` / MIN / MAX 钳制（`.sandbox-renderer-shell`、`--xrp-frame-max-height` 相关规则）。

### 4.6 变量系统（语义对照 `JSR/src/function/variables.ts`）

| scope | 参照实现存储 | v4 存储 | 同步性 |
|-------|------------|---------|--------|
| `chat` | `chat_metadata.variables` | store.chatVariables ←→ `session_variables` 表 | 同步读写，debounced flush |
| `message` | `chat[i].variables[swipe_id]` | store.chat[i].variables[swipe_id] ←→ 消息 metadata | 同步读写，debounced flush |
| `global` | `extension_settings.variables.global` | localStorage `st-vars-global` | 同步 |
| `character` | character settings store | localStorage `st-vars-char-{cardId}` | 同步 |
| `script` | script runtime store | store 内存（脚本 iframe 身份解析） | 同步 |

`getAllVariables()` 合并顺序照抄：global ← character ← (script) ← chat ← message（消息 iframe 时含本楼层）。

**后端双层（`session_variables` ↔ `state_snapshots`）**：现有 mirror / reconcile 机制（09ece68 + WIP）保留——它服务的是 Runtime Agent 上下文与小界面状态栏，属后端内部一致性。v4 前端只认 `session_variables` 这一个接口；WIP 中 `best_snapshot_variables` 的单卡关键词评分删除（§7）。

### 4.7 消息与 swipe 语义

- `getChatMessages(range, opts)` 返回 ST 形状（`message_id/name/role/is_hidden/message/swipes/swipe_id/variables/data/extra`），从 store.chat 同步取。
- `setChatMessage({ swipe_id }, message_id)`：
  - `message_id == 0`（开场白）→ store 调后端 `POST /api/sessions/{id}/opening`（apply_opening，0-based swipe 复用 09ece68）
  - 普通 assistant 消息 → store 调 `switchVariant`（swipe_id 0 ↔ variant_index -1 的映射进 store，不再散在 `useMessageStream`）
- v3 的 `card-sandbox-action` / `th_api` postMessage 路径、`handleCardSandboxAction` 中的 swipe 分支全部删除，由 store 方法替代。

### 4.8 脚本库常驻 iframe（移植自 `JSR/src/panel/script/Iframe.vue`）

`StScriptIframeHost.tsx`：

- 对每个启用的 `tavern_helper_scripts`（runtime assets / 卡片 extensions）渲染一个隐藏 iframe：`id`/`name` = `TH-script--{scriptName}--{scriptId}`、`display:none`、blob URL。
- srcdoc 用脚本变体 `createScriptSrcContent`（对照 `third_party_script.html`）：**不含** FontAwesome/tailwind/jquery/vue CDN，改为 `parent_jquery.js`（`window.$ = window.parent.$`）+ `predefine.js`，body 内是 `<script>${脚本代码}</script>`。
- 生命周期：会话加载完成（store.load 后）创建；`sessionId` 或角色卡变更时销毁重建；浮动 UI 残留清理（`cleanupIframeParentRuntimeUi` 的选择器清单）**只保留这一处**调用点（收敛 6fa0042 行为）。
- 浮动按钮/状态栏由脚本经继承的 `$` 挂到 parent DOM，跨消息持久——v3 "每个消息 iframe 重注入脚本 + cacheBuster"的机制连根删除。

### 4.9 消息格式化管线（M4，移植自 ST `script.js:1753` messageFormatting）

`st-runtime/message-formatting.ts`，顺序严格对齐：

```
原始消息文本
 1. substituteParams           宏展开（macro-engine，变量来自 store）
 2. getRegexedString(AI_OUTPUT, { isMarkdown: true, depth })
                               depth = 非系统消息倒序索引（现有引擎已支持）
 3. showdown.makeHtml          Markdown → HTML（对齐 ST 渲染语义）
 4. encodeStyleTags            <style> → <custom-style> + encodeURIComponent
 5. DOMPurify.sanitize         ADD_TAGS: ['custom-style']
 6. decodeStyleTags('.mes-text ')  恢复 <style> 并加选择器作用域前缀
→ inline HTML
```

复用现有资产：`st-rendering-engine.ts`（regex 引擎）、`stylescape.ts`（样式作用域）、`macro-engine.ts`（扩充宏：`getvar/setvar/getglobalvar/lastMessageId/messageId/random/roll/date/time`…按 fixtures 需求）。

**渲染检测**对齐 `JSR/src/util/is_frontend.ts`：

- 代码围栏（`<pre><code>`）内容满足 `isFrontend(text)`（含 `html>` / `<head>` / `<body` 之一）→ 该围栏替换为消息 iframe（iframe 内容 = 围栏内原文，**不经 DOMPurify**——这正是 ST 生态里交互卡的标准载体）。
- 整条消息是完整 HTML 文档 → 整体走 iframe（v3 已有，保留作兜底）。
- 其余 → inline 管线。
- v3 宽松的 `hasScript` 检测标记 deprecated，fixtures 验证后收紧。

**特判删除**（职责回归卡片 regex 脚本）：`st-opening-ui.ts` 整文件、`st-status-ui.ts` 整文件、`renderMarkdownDecorators` / `stripTextOnlyCustomTags` 的硬编码标签清洗、`CustomStatusRenderer` 默认接线（schema 状态栏保留给显式 `render_mode === 'schema'`）。

**性能**：仿 `JSR/src/panel/render/Streaming.vue` 的 `calcToRender`——只对最近 N 条消息建 iframe（默认 ~5，可设），更早的折叠为占位（点击展开重建）。

## 5. 与参照实现逐机制映射表

| 机制 | 参照源码 | v4 落点 |
|------|---------|---------|
| iframe 内全局注入 | `JSR/src/iframe/predefine.js` | `st-runtime/iframe-scripts/predefine.js`（近原文移植） |
| 高度自适应 | `JSR/src/iframe/adjust_iframe_height.js` | 同名照抄 |
| 视口变量 | `JSR/src/iframe/adjust_viewport.js` + `Iframe.vue:34-36` | 同名照抄 + `StMessageIframe` resize 转发 |
| 脚本 iframe jQuery 继承 | `JSR/src/iframe/parent_jquery.js` | 同名照抄 |
| srcdoc 组装 + vh 替换 | `JSR/src/panel/render/iframe.ts` | `st-runtime/iframe-doc.ts` |
| CDN 库清单（消息/脚本两种） | `JSR/src/iframe/third_party_message.html` / `third_party_script.html` | `iframe-doc.ts` 内常量 |
| 脚本 URL（?raw + blob） | `JSR/src/iframe/script_url.ts` | `iframe-doc.ts` 顶部 |
| blob URL 生命周期 / 命名 / 渲染事件 | `JSR/src/panel/render/Iframe.vue` | `StMessageIframe.tsx` |
| 脚本常驻 iframe | `JSR/src/panel/script/Iframe.vue` | `StScriptIframeHost.tsx` |
| 渲染窗口（只渲染最近 N 楼） | `JSR/src/panel/render/Streaming.vue` calcToRender | `Chat.tsx` 消息列表 |
| TavernHelper API 面 + `_bind` | `JSR/src/function/index.ts` | `st-runtime/tavern-helper.ts` |
| iframe 身份解析 | `JSR/src/function/util.ts` `_getIframeName`/`getMessageId` | `tavern-helper.ts` |
| 变量 scope 语义 | `JSR/src/function/variables.ts` | `store.ts` |
| 事件系统 + 常量 | `JSR/src/function/event.ts` | `events.ts` |
| 渲染检测 | `JSR/src/util/is_frontend.ts` | `message-html.tsx` 重写 |
| messageFormatting 顺序 | `SillyTavern-release/public/script.js:1753` | `message-formatting.ts` |
| regex 引擎 | `SillyTavern-release/public/scripts/extensions/regex/engine.js` | 已有 `st-rendering-engine.ts`（保留） |
| 样式作用域 | `SillyTavern-release/public/scripts/chats.js` encode/decodeStyleTags | 已有 `stylescape.ts`（保留） |

## 6. 删除清单与理由

| 删除项 | 理由 |
|--------|------|
| `iframe-bridge.ts`（708 行，全部） | postMessage RPC 模型整体废弃；同步 API 无法在 RPC 上实现 |
| `IframeHtmlRuntimeHost.tsx`（479 行） | th_api 分发 / sandbox-resize / viewportFit / 高度钳制全部不再需要；薄壳由 `StMessageIframe` 替代 |
| `sandbox-host-bridge.ts` | 旧 bridge 协议 |
| `card-content.tsx` 大部 | buildIframeDocument / headBridge（Zod、waitGlobalInitialized、updateTavernRegexesWith stubs）/ Mvu shim / buildTavernHelperScriptTags / 全量 vh 替换——被 §4.1/4.4/4.8 替代；仍被引用的工具（`cleanCardDisplayText` 等）迁 `card-utils.ts` |
| `st-opening-ui.ts` | 开场白 HTML 触发特判——统一为 message 0 + swipes，初始 UI 是 turn 0 渲染的自然结果 |
| `st-status-ui.ts` | 状态栏占位/`<正文>` 闭合特判——状态栏是卡片 regex 脚本的职责 |
| `st-init-variables.ts` | swipes_data 构造并入 store 规范化 |
| `MessageContent.tsx` 的 `renderMarkdownDecorators` 等 | 硬编码标签清单清洗——交给卡片 regex 脚本 + messageFormatting |
| `st-regex-scripts.ts` 的内容去重键 | 改脚本 `id` 去重（无 id 不去重）；内容键丢 placement 维度会误删脚本 |
| `useMessageStream` 的 `card-sandbox-action`/`th_api` 处理 | store 直连替代 |
| postMessage 协议（`th_api`/`th_api_response`/`variablesUpdated`/`runtimeUpdated`/`sandbox-resize`/`rendered`/`setVariables`/`card-sandbox-action`/`cleanup-floating-ui`） | 全部废弃，仅留 `TH_UPDATE_VIEWPORT_HEIGHT` |
| `backend/routes/messages.rs` WIP 的 `best_snapshot_variables` 关键词评分 | 含单卡硬编码（`时幼微` 等）；store 单一事实源后无此需求 |
| `runtime-host-protocol.test.ts` | 协议随宿主删除；重写为 store 单测 |

## 7. 后端配合改动（最小）

1. **消息级变量持久化**：复用 `messages.metadata` JSON 字段，新增 `PATCH /api/sessions/{id}/messages/{mid}/metadata`（`routes/messages.rs`，无需 migration）。store 把 `variables[swipe_id]` 写进 metadata 的 `st_variables` 键。
2. **删除** `best_snapshot_variables` 评分逻辑（见 §6）。
3. 其余路由（messages / variables / runtime-assets / worldbooks / opening / switchVariant）**原样复用**；`session_variables` ↔ `state_snapshots` mirror/reconcile 机制不动。

## 8. 迁移里程碑概览

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| M-1 | 本设计文档 + 文档指引更新 | 用户评审通过 |
| M0 | WIP commit + 切分支 `feat/st-same-origin-runtime`；`frontend/fixtures/cards/` 约定 + 用户提供问题卡片集；`CardRenderLab.tsx`（`/lab`，dev only）记录迁移前基线 | `/lab` 渲染 ≥1 张 fixture 卡并捕获 console error |
| M1 | st-runtime 核心：store / tavern-helper / events / globals；新依赖 jquery + showdown + yaml | store 单测过；宿主 console 同步 `getVariables()` |
| M2 | 消息 iframe 同源直连：iframe-scripts / iframe-doc / StMessageIframe；删 bridge 三件套；改 MessageContent/Chat/useMessageStream 接线 | fixture 卡 iframe 内同步 API 可用、高度不被钳制 |
| M3 | 脚本常驻 iframe：StScriptIframeHost；Chat 接线；清理点收敛 | "苍玄界"浮动按钮跨消息持久、切开场白不消失、切会话被清理 |
| M4 | messageFormatting 管线 + is_frontend 检测 + 宏扩充 + regex 去重修复 + 删特判文件 + 渲染窗口 | regex 测试全过 + 管线顺序测试；状态栏卡靠自带 regex 正常显示 |
| M5 | 清尾（grep 无协议残留）+ 文档重写 + 后端 PATCH 路由 + 删评分逻辑 | cargo check + npm build + 全测试过 |
| M6 | 全量回归：CardRenderLab 逐卡过问题卡片集 | 每卡结果记入 `expectations.md`，全绿 |

每个里程碑 = 一次独立 commit（可单独 revert），均需 `cd frontend && npm test && npm run build`（涉后端加 `cargo check`）通过。

## 9. 回归策略

- `frontend/fixtures/cards/{card-name}/`：卡片 JSON/PNG + `expectations.md`（预期行为：开场白渲染 / 交互 / 变量读写 / 浮动 UI / swipe / 样式）。
- `CardRenderLab.tsx`（`/lab`）：列出 fixtures → 渲染开场白与模拟消息 → 侧栏聚合 console error / 未实现 API 命中（§2.5 的 stub warn 在此可见）。
- 验收口径：**修一类问题必须在 fixtures 全集上过一遍**，禁止只验证手头那张卡。

## 10. 风险与回退

| 风险 | 缓解 |
|------|------|
| 直接替换中途不可用 | 里程碑独立 commit 可单独 revert；M2 前旧管线完整可用 |
| showdown 改变非卡片消息观感 | 仅卡片消息路径用 showdown；调试页等保持 react-markdown |
| debounced flush 丢数据 | 失败 toast + 重试一次；`beforeunload`/dispose 强制 flush |
| 多 iframe 性能 | M4 渲染窗口（最近 N 楼） |
| 卡片依赖未实现 API | stub 显式 warn + throw，CardRenderLab 可见，按 fixtures 增量补 |
| CDN 不可达（离线/墙内） | 已知限制（用户已确认沿用 CDN）；保留 bootcdn→cdnjs 重写；后续可选 vendor 化 |

## 11. 遗留差距（设计内明确接受）

| 差距 | 现状 | 后续 |
|------|------|------|
| `EjsTemplate` | stub（warn + throw） | 有 fixtures 依赖时引入 ejs |
| global / character 变量 | localStorage 暂存，不跨设备 | 后续如需，加后端表 + 路由 |
| `triggerSlash` | 最小命令集 | 按 fixtures 增量 |
| audio / preset / character CRUD / import_raw / extension / inject API | stub | 按 fixtures 增量 |
| 流式期间 iframe 渲染（JSR 的 during_streaming 模式） | v4 流式期间只渲染文本，turn 完成后建 iframe | 后续优化 |
| regex 脚本 GLOBAL/PRESET 类型 | 仅卡片 + runtime assets 的 scoped 脚本 | 平台暂无全局 regex 管理界面 |
