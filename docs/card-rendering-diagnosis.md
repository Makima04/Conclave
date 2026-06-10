# 角色卡渲染/解析/变量 全面对比与故障诊断报告

> 生成日期：2026-06-10
> 对比对象：SillyTavern（酒馆助手 JS-Slash-Runner） vs multi-agent-rp-platform
> 目标：定位角色卡 UI 渲染不正确、无法互动、变量无法读取的根因，并制定修复路线图

---

## 一、架构差异总览

| 维度 | SillyTavern + 酒馆助手 | 本项目 | 差距评估 |
|------|------------------------|--------|---------|
| 前端框架 | jQuery + DOM 克隆 | React + Hooks | 本项目更现代 |
| Markdown 引擎 | Showdown（字符串→HTML） | ReactMarkdown + remarkGfm（React 元素） | 本项目更安全 |
| 宏系统 | 双引擎：旧(Regex链 60+宏) / 新(Chevrotain CST) | 6 条 `.replace()` 链 | **严重缺失** |
| 正则脚本 | 狯立扩展，按 placement 6 阶段执行，LRU 缓存 | ST 兼容子集，无缓存，phase 过滤有 bug | **功能不完整** |
| HTML 运行时 | 无沙箱，直接 DOM 注入 | iframe 沙箱 + postMessage 协议 | 本项目更安全 |
| 安全过滤 | DOMPurify + style 作用域隔离 | 自实现 sanitize + 无 style 隔离 | 各有优劣 |
| 状态管理 | 全局变量 + jQuery data | SQLite → StateAdapter → React → Sandbox Bridge | 本项目更结构化 |
| 变量系统 | 4 作用域 + 6 种变量宏 + 酒馆助手 MacroLike | 投影系统 + 20 种沙箱 action | **宏缺失** |
| 扩展钩子 | EventEmitter 110+ 事件 | postMessage 20 种 action | **钩子不足** |
| 事件渲染后 | `CHARACTER_MESSAGE_RENDERED` 等 | 无显式渲染后事件 | **缺失** |

---

## 二、渲染管线对比

### 2.1 SillyTavern 管线

```
chat[] (JSONL)
  → messageTemplate.clone()          // jQuery 克隆 DOM 模板
  → updateMessageElement()            // 填充头像/名字/时间戳
  → getMessageTextHTML()
    → substituteParams()              // 宏替换 {{user}} {{char}} 等 60+ 种
    → getRegexedString()              // 正则脚本（按 placement 分阶段）
    → fixMarkdown()                   // 修复不配对的 * _ "
    → converter.makeHtml()            // Showdown MD→HTML
    → encodeStyleTags + DOMPurify     // 样式隔离 + XSS 消毒
    → decodeStyleTags(.mes_text)      // 还原样式，限定作用域
  → .mes_text.html(html)              // 注入 DOM
  → hljs.highlightElement()           // 代码高亮
  → eventSource.emit(RENDERED)        // 扩展钩子
```

### 2.2 本项目管线

```
sessionState (React Hook)
  → resolveCardRenderPlan()           // 三层决策: text / html_app / sandbox_html
  |
  ├─ [text 路径]
  |   → cleanCardDisplayText()        // 清理 <StatusPlaceHolderImpl/> 等标签
  |   → substituteStMacros()          // 6 条 replace: {{user}} {{char}} <user> <char>
  |   → applyCardDisplayRegexScriptsToParts()  // ST regex 脚本
  |   → renderInlineDecorators()      // <inner> → .schema-inner-thought
  |   → ReactMarkdown + remarkGfm     // MD→React 元素
  |
  ├─ [html_app 路径]
  |   → buildSandboxDocument()        // 注入 Vue3 + DOM Shim + Host Bridge
  |   → IframeHtmlRuntimeHost         // iframe sandbox 隔离
  |   → postMessage 双向通信          // 20 种 action 白名单
  |
  └─ [sandbox_html 路径]
      → sanitizeSandboxHtml()         // 两级安全过滤
      → dangerouslySetInnerHTML       // 或 iframe 渲染
```

---

## 三、宏/解析系统对比（核心差异）

### 3.1 SillyTavern 宏系统

**旧引擎**（`macros.js`）：
- 60+ 种宏，每个是 `{ regex, replace }` 对象
- 三阶段执行：`preEnvMacros` → `envMacros` → `postEnvMacros`
- 宏语法：`{{user}}` `{{char}}` `{{random:a,b,c}}` `{{roll:3d20}}` `{{setvar::k::v}}` `{{getvar::k}}` `{{time}}` `{{date}}` `{{pick:a,b,c}}` 等

**新引擎**（`macros/engine/`，基于 Chevrotain）：
- 完整的词法分析器 + CST 语法解析器 + CST 遍历器
- 支持：条件 `{{if}}`、嵌套宏、变量简写 `{{$var}}`、标志 `{{!}}` `{{?}}` `{{~}}`、过滤器管道 `{{>macro|filter}}`、注释 `{{//}}`
- 宏注册表 + 类型验证 + 文档浏览器

**酒馆助手额外**：
- `MacroLike` 系统 — 自定义正则匹配式宏
- 内置变量宏：`{{get_message_variable::...}}` `{{get_chat_variable::...}}` 等

### 3.2 本项目宏系统

```typescript
// st-regex-executor.ts:96
.substituteStMacros(text, userName, charName)
  .replace(/\{\{user\}\}/gi, userName)
  .replace(/\{\{char\}\}/gi, charName)
  .replace(/<user>/gi, userName)
  .replace(/<\/user>/gi, '')
  .replace(/<char>/gi, charName)
  .replace(/<\/char>/gi, '')
```

**只支持 6 种宏**：`{{user}}` `{{char}}` `<user>` `<char>` `<\/user>` `<\/char>`

> **差距：SillyTavern 有 60+ 种宏 + Chevrotain CST 解析器；本项目只有 6 条字符串替换。**

---

## 四、正则脚本系统对比

| 维度 | SillyTavern | 本项目 |
|------|-------------|--------|
| 脚本格式 | ST regex_scripts (findRegex + replaceString + flags) | **完全兼容** ST 格式 |
| Placement 分类 | 6 种：MD_DISPLAY, USER_INPUT, AI_OUTPUT, SLASH_COMMAND, WORLD_INFO, REASONING | 复用 ST 枚举值 |
| Depth 过滤 | minDepth / maxDepth | 支持 |
| markdownOnly / promptOnly | 支持 | 支持 |
| findRegex 宏替换 | `substituteParamsExtended(findRegex)` — 完整宏展开 | 不展开 findRegex 中的宏 |
| replaceString 宏替换 | `substituteParams(replaceWith)` — 完整宏展开 | 仅 `substituteStMacros`（6 种） |
| Regex 缓存 | `RegexProvider` LRU 缓存 1000 个 | 无缓存（每次 new RegExp） |
| 后端实现 | 纯前端 | Rust 对称实现（导入时预处理） |
| 前端 phase 过滤 bug | 无 | `isMarkdown: true` 硬编码导致普通脚本被跳过 |

---

## 五、SillyTavern 有但本项目缺失的能力

| # | 缺失能力 | ST 实现 | 本项目现状 | 影响范围 |
|---|---------|---------|-----------|---------|
| 1 | **完整宏系统** | 60+ 种宏 + Chevrotain CST 解析器 | 6 种 | 所有带宏的角色卡 |
| 2 | **变量操作宏** | `{{getvar}}` `{{setvar}}` `{{incvar}}` `{{addvar}}` | 无 | 依赖变量的角色卡 |
| 3 | **正则缓存** | `RegexProvider` LRU 1000 个 | 每次 `new RegExp()` | 高频场景性能 |
| 4 | **findRegex 宏展开** | `substituteParamsExtended(findRegex)` | 不展开 | 动态正则匹配 |
| 5 | **Style 作用域隔离** | `encodeStyleTags` + `.mes_text` 前缀 | 无 | 样式泄漏 |
| 6 | **渲染后事件钩子** | `CHARACTER_MESSAGE_RENDERED` 等 110+ 事件 | 无 | 扩展性 |
| 7 | **正则 escape 回退** | 后端有 `regex::escape()`，前端无 | 前端无 | 字面量匹配失败 |
| 8 | **jQuery shim 完整性** | 原生 jQuery | 缺 `$.ajax` `$.extend` `animate` `width/height` | 卡片 JS 报错 |

---

## 六、HTML/安全处理对比

| 维度 | SillyTavern | 本项目 |
|------|-------------|--------|
| Markdown→HTML | Showdown（字符串转换） | ReactMarkdown（React 元素树） |
| XSS 防护 | DOMPurify + 自定义钩子（style 标签编解码、CSS 类白名单） | 自实现 sanitizeSandboxHtml（2 级过滤） |
| Style 隔离 | `<style>` → `<custom-style>` URI 编码 → decode 时加 `.mes_text` 前缀 | 无 style 作用域隔离 |
| HTML 沙箱 | 无，直接注入 DOM | iframe sandbox + postMessage 协议 |
| 代码高亮 | highlight.js | CodeBlock 自定义组件 |

---

## 七、状态与变量系统对比

| 维度 | SillyTavern | 本项目 |
|------|-------------|--------|
| 变量存储 | 全局 `extension_settings.variables` + chat_metadata | 后端 SQLite + 状态适配器 |
| 变量作用域 | 4 层：global / character / chat / message | 投影系统：card_variables <-> platform_state |
| 变量宏 | `{{setvar::k::v}}` `{{getvar::k}}` `{{incvar::k}}` `{{addvar::k::v}}` | 无变量宏，通过沙箱 `requestHost('readVariables')` 读写 |
| 双向映射 | 无，变量直接读写 | read_rules / write_rules 双向投影 |
| 写入约束 | 无约束 | SandboxVariableContract 白名单约束 |
| AI 写入 | 无自动提取 | VariableExtraction 自动从 AI 回复提取变量变更 |

---

## 八、本项目自身 Bug 清单

### 8.1 渲染不正确的 Bug

| # | Bug | 文件:行号 | 根因 | 修复难度 |
|---|-----|----------|------|---------|
| R1 | **普通 regex 脚本被 phase 过滤跳过** | `card-content.tsx:155` + `st-regex-executor.ts:121` | 硬编码 `isMarkdown: true`，普通脚本只在 `!isMarkdown` 时执行 | 低 |
| R2 | **`shouldBootHtmlApp` 的 triggerMatch 死代码** | `card-runtime-resolver.ts:53-57` | 计算了 triggerMatch 但 return 中未使用 | 低 |
| R3 | **`{{char}}` 替换为空而非角色名** | `card-content.tsx:199` | `cleanCardDisplayText` 硬编码 `''`，与 `substituteStMacros` 不一致 | 低 |
| R4 | **regex replaceString 中宏不替换** | `card-content.tsx:162-166` | 未传 `userName`/`charName` 给 `expandStRegexReplacement` | 低 |
| R5 | **60+ ST 宏仅实现 6 种** | `st-regex-executor.ts:96-104` | 宏系统未实现 | 中-高 |
| R6 | **`sanitizeHtmlFragment` 移除 jQuery CDN link** | `card-content.tsx:108` | 正则匹配 `<link>` 而非 `<script>`，误删 CSS | 低 |
| R7 | **`javascript:` 替换为无值** | `card-content.tsx:107` | `href="void(0)"` 变成导航链接 | 低 |
| R8 | **`sanitizeSandboxHtml` 的 jQuery link 误删** | `card-content.tsx:108` | 移除 `code.jquery.com` 的 `<link>` 标签（应只移除 `<script>`） | 低 |

### 8.2 无法正常互动的 Bug

| # | Bug | 文件:行号 | 根因 | 修复难度 |
|---|-----|----------|------|---------|
| I1 | **`ALLOWED_ACTIONS` 缺少 `generateRaw`** | `MessageHtmlAppRenderer.tsx:15-36` | 白名单未包含生成请求，被静默拒绝后 20 秒超时 | 低 |
| I2 | **文本路径 sanitize 移除 `on*` 事件** | `card-content.tsx:111` | `sanitizeHtmlFragment` 清除所有事件属性 | 低 |
| I3 | **文本路径 sanitize 移除 `<script>`** | `card-content.tsx:115` | 依赖 JS 的交互逻辑无法执行 | 中（需设计安全方案） |
| I4 | **`removeUiTriggers` 无条件清除匹配文本** | `card-content.tsx:209-220` | 触发文本消失但对应 HTML 未正确渲染 | 低 |
| I5 | **`requestHost` 20 秒超时太短** | `sandbox-host-bridge.ts:13-15` | LLM 生成常超过 20 秒 | 低 |

### 8.3 变量无法读取/写入的 Bug

| # | Bug | 文件:行号 | 根因 | 修复难度 |
|---|-----|----------|------|---------|
| V1 | **`useMemo` 缺少 `variables` 依赖** | `MessageHtmlAppRenderer.tsx:53-56` | 变量变化不触发沙箱重建，卡片显示过期数据 | 低 |
| V2 | **沙箱/宿主路径规范化不一致** | `sandbox-variable-runtime.ts` vs `sandbox-variable-bridge.ts` | 沙箱内剥离 `stat_data.` 前缀，宿主端不剥离 | 中 |
| V3 | **`getValueAtPath`/`setValueAtPath` 空路径段处理不一致** | `sandbox-variable-bridge.ts:27 vs 49` | 读取不过滤空段，写入过滤空段 | 低 |
| V4 | **`approve_proposal` 绕过 state_adapter** | `memory/state.rs:464-500` | 直接写 raw state，不做反向投影 | 中 |
| V5 | **write_rule 不匹配时静默丢弃** | `card_state_adapter.rs:144-148` | 无日志、无拒绝反馈 | 低 |
| V6 | **`primary_value` 单元素数组不展开** | `card_state_adapter.rs:484-491` | 读写不对称：读出 `["val"]`，写回 `val` | 低 |
| V7 | **`writableProjectionPaths` 拒绝写入无反馈** | `sandbox-variable-runtime.ts:322-326` | 只有 diagnostic 日志，卡片脚本不知道写入失败 | 低 |

### 8.4 后端变量链路的额外问题

| # | Bug | 文件:行号 | 根因 | 修复难度 |
|---|-----|----------|------|---------|
| VB1 | **关键词分类误判** | `state_adapter.rs:116-192` | `datetime_format` 会匹配 `time` 关键词被误分类为 `StateFieldRole::Time` | 中 |
| VB2 | **`collection_platform_path` 路径碰撞** | `state_adapter.rs:283-289` | `targets[0].affinity` 和 `targets[1].affinity` 生成相同的 `relationships.affinity.score` | 中 |
| VB3 | **`sanitize_segment` 空值碰撞** | `state_adapter.rs:299-308` | `some_array[0].value` 和 `some_array[1].value` 都得到 `"unknown"` | 中 |
| VB4 | **`CollectionById`/`JsonBlob` transform 是空操作** | `types.rs:339-346` + `card_state_adapter.rs:445-449` | 定义了但未实现，匹配到 `_` 通配分支 | 低 |
| VB5 | **`strip_known_card_root` 只处理 `variables.` 和 `stat_data.`** | `card_state_adapter.rs:504-508` | 其他根前缀（如 `mvu.`）不剥离 | 低 |
| VB6 | **`is_safe_key` 阻止 `meta` 开头的合法变量** | `variable_update.rs:287-305` | `metadata.room.description` 被误阻止 | 低 |
| VB7 | **No contract = unguarded writes** | `card_state_adapter.rs:130-135` | 无 state_adapter 时任何路径都可写入 | 低 |
| VB8 | **Non-writable 字段不反向投影** | `card_state_adapter.rs:369-387` | 只有 write_rules 中的字段会从 platform_state 投回 variables | 中 |

### 8.5 前后端正则执行不一致

| # | 差异 | 前端行为 | 后端行为 | 影响 |
|---|------|---------|---------|------|
| RX1 | 非法正则回退 | catch 返回 null，放弃 | `regex::escape()` 转义后重试 | 字面量 findRegex 前端失败后端成功 |
| RX2 | `{{match}}` 处理 | 转为 `$0` 后通过回调替换 | 不转换，字面量残留 | 前后端输出不同 |
| RX3 | `strip_code_fences` 尾部换行 | 保留 `\n` | `trim_end_matches('\n')` 移除 | 微小差异 |
| RX4 | `scriptName` 必须性 | 不要求 | `filter_map` 中要求，无则丢弃 | 部分脚本后端丢弃前端执行 |

---

## 九、沙箱运行时的额外问题

| # | 问题 | 文件:行号 | 说明 |
|---|------|----------|------|
| S1 | postMessage Race Condition | `IframeHtmlRuntimeHost.tsx:138-141` | `onLoad` 在脚本执行完成前触发，首次变量更新可能丢失 |
| S2 | documentHtml 变化时变量更新被丢弃 | `IframeHtmlRuntimeHost.tsx:58-60` | `loaded` 重置为 false 期间的变量变化不会推送 |
| S3 | DOM Shim 缺失 jQuery 方法 | `sandbox-dom-shim.ts:22-96` | 缺 `$.ajax` `$.extend` `animate` `width` `height` `offset` `position` |
| S4 | `append()` 使用 `cloneNode(true)` | `sandbox-dom-shim.ts:78` | 事件监听器不会被复制，先绑定后 append 的事件丢失 |
| S5 | 高度阈值抖动 | `sandbox-document.ts:187` | 8px 阈值太小，浏览器亚像素渲染导致频繁 resize |
| S6 | `normalizeSandboxHtml` 多 body 标签 | `sandbox-document.ts:29` | 非贪婪匹配只取第一个 `</body>` 前的内容 |
| S7 | Vue 3 全量 bundle 内联体积 | `sandbox-document.ts:16` | 约 130KB+，每个 iframe 都内联一份 |

---

## 十、解决优先级路线图

### P0 — 立即修复（1-2 天，直接解决用户可感知的故障）

> **状态**: ✅ 全部完成 (2026-06-10)

| 序号 | 任务 | 修改文件 | 预计改动 |
|------|------|---------|---------|
| **P0-1** ✅ | 修复 regex 脚本 phase 过滤：`applyCardDisplayRegexScriptsToParts` 传入 `isMarkdown: false` | `card-content.tsx:155` | 1 行 |
| **P0-2** ✅ | `ALLOWED_ACTIONS` 添加 `generateRaw` | `MessageHtmlAppRenderer.tsx:15-36`, `SandboxHtmlRenderer.tsx:10-31` | 2 行 |
| **P0-3** ✅ | `useMemo` 添加 `variables` 依赖 | `MessageHtmlAppRenderer.tsx:53-56` | 1 行 |
| **P0-4** ✅ | `shouldBootHtmlApp` 使用 `triggerMatch` | `card-runtime-resolver.ts:52-58` | 3 行 |
| **P0-5** ✅ | `expandStRegexReplacement` 传入 `userName`/`charName` | `card-content.tsx:162-166` | 5 行 |
| **P0-6** ✅ | `cleanCardDisplayText` 的 `{{char}}` 替换为实际角色名 | `card-content.tsx:199` | 3 行 |
| **P0-7** ✅ | `requestHost` 超时从 20s 改为 120s（或按 action 类型区分） | `sandbox-host-bridge.ts:13-15` | 5 行 |
| **P0-8** ✅ | `javascript:` 替换为 `javascript:void(0);` 而非空字符串 | `card-content.tsx:107` | 1 行 |

**预期效果**：修复后，大部分 ST 角色卡的 regex 脚本能正确执行，html_app 卡片能正常启动，沙箱变量能实时更新，生成按钮能正常工作。

### P1 — 短期补齐（3-5 天，大幅提高卡片兼容性）

| 序号 | 任务 | 说明 |
|------|------|------|
| **P1-1** | 实现核心 ST 宏（`{{time}}` `{{date}}` `{{getvar}}` `{{setvar}}` `{{random}}` `{{pick}}` `{{roll}}` `{{lastMessage}}`） | 至少覆盖互动小说/TRPG 卡片最常用的 15 种宏 |
| **P1-2** | findRegex 也做宏展开 | 参考 ST 的 `substituteParamsExtended(findRegex)` |
| **P1-3** | 前端 `parseFindRegex` 添加 regex escape 回退 | 与后端对齐，防止字面量匹配失败 |
| **P1-4** | 统一沙箱/宿主路径规范化 | 宿主端也剥离 `stat_data.` 等前缀 |
| **P1-5** | 添加 Regex 缓存 | LRU 缓存，避免重复编译 |
| **P1-6** | 文本路径下对 sandbox_html 内容保留 `on*` 事件 | `sanitizeHtmlFragment` 用于 `dangerouslySetInnerHTML` 的内容需要区分场景 |
| **P1-7** | jQuery shim 补齐 `$.ajax` `$.extend` `width()` `height()` | 提高卡片 JS 兼容性 |
| **P1-8** | write_rule 不匹配时添加 console.warn 日志 | 辅助调试变量写入失败 |

**预期效果**：修复后，绝大多数中文 TRPG / 互动小说角色卡能正确渲染和互动，变量系统可靠性大幅提升。

### P2 — 中期增强（1-2 周，接近 ST 兼容度）

| 序号 | 任务 | 说明 |
|------|------|------|
| **P2-1** | 实现 Chevrotain 宏解析器子集（`{{if}}` 条件、嵌套宏、`{{$var}}` 变量简写） | 参考 ST 新引擎 |
| **P2-2** | Style 标签作用域隔离 | 参考 ST 的 `encodeStyleTags` + `.mes_text` 前缀方案 |
| **P2-3** | 渲染后事件钩子 | 沙箱内 `MESSAGE_RENDERED` 等事件，供卡片脚本感知渲染完成 |
| **P2-4** | `approve_proposal` 通过 state_adapter 重新归一化 | 修复提案审批后变量不一致 |
| **P2-5** | `primary_value` / `restore_card_value` 单元素数组对称处理 | 修复读写不对称 |
| **P2-6** | 后端 `RegexScript` 补齐 `placement`/`trimStrings`/`substituteRegex` 字段 | 前后端行为完全对齐 |
| **P2-7** | `extensions` 类型从 `any` 改为具体接口 | 编译时类型安全 |
| **P2-8** | `state_adapter` 关键词分类改用精确匹配 + 权重排序 | 减少变量误分类 |

**预期效果**：接近 SillyTavern 的卡片兼容度，支持高级宏语法，变量系统完全可靠。

### P3 — 长期演进（持续优化）

| 序号 | 任务 | 说明 |
|------|------|------|
| **P3-1** | 宏注册表 API（类似 ST 的 `MacroRegistry.registerMacro`） | 供扩展注册自定义宏 |
| **P3-2** | 酒馆助手 `MacroLike` 系统兼容 | `registerMacroLike(regex, replace)` |
| **P3-3** | 110+ 事件系统 | 对齐 ST 的完整事件模型 |
| **P3-4** | 正则脚本用户编辑 UI | 允许用户在运行时自定义正则脚本 |
| **P3-5** | 多维数组路径支持（`arr[0][1]`） | 完善路径操作 |

---

## 十一、P0 修复快速验证矩阵

| P0 修复 | 验证方法 |
|---------|---------|
| P0-1 phase 过滤 | 导入一个未设置 `markdownOnly` 的 regex 脚本卡片 → 脚本应执行 |
| P0-2 generateRaw | 沙箱内点击生成按钮 → 应正常触发 AI 生成 |
| P0-3 useMemo variables | 修改沙箱变量 → 卡片应实时反映新值 |
| P0-4 triggerMatch | AI 回复包含 `【GameStart】` → html_app 应启动 |
| P0-5 userName/charName | regex replaceString 含 `{{user}}` → 应显示用户名而非字面量 |
| P0-6 {{char}} 替换 | 卡片正文含 `{{char}}` → 应显示角色名而非空白 |
| P0-7 超时 | 沙箱内 generateRaw → 不应在 20 秒后超时 |
| P0-8 javascript: | 卡片含 `javascript:void(0)` 的按钮 → 点击不应导航 |

---

## 十二、关键源文件索引

### 前端渲染链路
- `frontend/src/pages/card-runtime-resolver.ts` — 渲染决策（text / html_app / sandbox_html）
- `frontend/src/pages/card-content.tsx` — 文本渲染管道 + sanitize + regex 脚本应用
- `frontend/src/pages/st-regex-executor.ts` — ST regex 脚本执行引擎
- `frontend/src/pages/sandbox-document.ts` — sandbox HTML 文档构建器
- `frontend/src/pages/sandbox-dom-shim.ts` — jQuery/DOM shim
- `frontend/src/pages/sandbox-host-bridge.ts` — 沙箱请求桥接
- `frontend/src/pages/sandbox-variable-bridge.ts` — 变量路径操作（宿主端）
- `frontend/src/pages/sandbox-variable-runtime.ts` — 变量运行时（沙箱内）
- `frontend/src/pages/runtime-host-protocol.ts` — 宿主-沙箱通信协议

### 前端组件
- `frontend/src/pages/Chat.tsx` — 顶层会话页面
- `frontend/src/pages/components/MessageHtmlAppRenderer.tsx` — 消息级 HTML 应用渲染器
- `frontend/src/pages/components/IframeHtmlRuntimeHost.tsx` — iframe 沙箱宿主
- `frontend/src/pages/components/DirectHtmlRuntimeHost.tsx` — 直接 DOM 注入宿主
- `frontend/src/pages/components/PersistentCardRuntimeHost.tsx` — 会话级持久宿主

### 后端状态/变量链路
- `backend/src/runtime/card_state_adapter.rs` — 状态适配器（read_rules / write_rules / projection）
- `backend/src/runtime/variable_update.rs` — AI 回复变量提取
- `backend/src/importer/state_adapter.rs` — 导入时 state_adapter 生成
- `backend/src/importer/regex_executor.rs` — 后端 regex 脚本执行器
- `backend/src/importer/orchestrator.rs` — 导入编排器
- `backend/src/importer/types.rs` — 导入类型定义
- `backend/src/importer/package_builder.rs` — 包构建器
- `backend/src/memory/state.rs` — 提案系统

### SillyTavern 参考（对比用）
- `public/script.js:1753` — `messageFormatting()` 核心渲染管线
- `public/script.js:2922` — `substituteParams()` 宏替换入口
- `public/scripts/macros.js:610` — `evaluateMacros()` 旧引擎
- `public/scripts/macros/engine/MacroEngine.js` — 新引擎
- `public/scripts/extensions/regex/engine.js` — 正则脚本引擎
- `public/scripts/extensions/third-party/JS-Slash-Runner/` — 酒馆助手扩展
