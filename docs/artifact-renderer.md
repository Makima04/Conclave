# Artifact Renderer 规范

> 定义 LLM 生成的 UI 内容如何安全、高效地渲染：三层渲染模型、Artifact 生命周期、UI Schema、iframe 沙箱、资源预算和快照策略。角色卡 HTML app 的当前运行时细节见 [角色卡渲染运行时](card-rendering-runtime.md)。

`Artifact` · `iframe Sandbox` · `State Diff` · `Resource Budget` · `Snapshot` · `UI Schema`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [数据库与 API](database-api.md)
- [长期记忆](long-context-memory.md)
- [Agent Runtime](agent-runtime.md)
- [Agent 边界](agent-boundaries.md)

---

## 目标

- LLM 输出不直接注入主聊天 DOM，所有 UI 变化通过受控渲染通道。
- 支持从简单状态更新到复杂自定义 UI 的渐进式渲染能力。
- 每个渲染单元有独立的资源预算，长会话不会因 DOM 堆积而卡顿。
- 离屏渲染单元可安全卸载并恢复，不影响用户体验。
- 自定义代码在 iframe 沙箱中运行，无法访问主页面 DOM。LLM artifact 默认不开放持久存储或网络；导入角色卡 sandbox 另有受控兼容层。

---

## 三层渲染模型

LLM 输出的 UI 变化按复杂度分为三层。普通角色卡使用前两层，只有高级场景才允许第三层。

### 第一层：数据驱动 UI

LLM 输出结构化 state diff，平台用内置组件渲染。

**适用场景：** 物品增减、属性变化、任务状态更新、关系变化、位置切换。

**LLM 输出格式：**

```json
{
  "type": "state_diff",
  "changes": {
    "items.add": [{ "id": "blood_moon_shard", "name": "血月碎片", "rarity": "legendary" }],
    "character.player.hp": { "from": 80, "to": 65 },
    "quests.update": [{ "id": "find_archive", "status": "in_progress" }]
  }
}
```

**平台处理：** 合并到结构化状态，使用内置组件（物品栏、属性面板、任务列表）渲染。不执行任何代码。

**安全性：** 最高。无代码执行，纯数据更新。

### 第二层：主题化组件

LLM 声明使用哪个渲染器、主题和 props，平台校验后渲染。

**适用场景：** 奇幻物品卡片、角色状态面板、地图标记、战斗状态、好感度组件。

**LLM 输出格式：**

```json
{
  "type": "component_declaration",
  "renderer": "item_card",
  "theme": "dark_fantasy",
  "props": {
    "name": "血月碎片",
    "description": "在旧档案馆深处找到的神秘碎片",
    "rarity": "legendary",
    "image": "assets/items/blood_moon_shard.png",
    "effects": [{ "type": "pulse", "color": "#cc3333" }]
  }
}
```

**平台处理：** 校验 `renderer` 是否在白名单内，校验 `props` 是否符合渲染器 schema，校验资源路径是否在当前内容包范围内，使用平台主题系统渲染。

**安全性：** 高。渲染器是平台内置的，LLM 只填数据，不控制 DOM 结构。

### 第三层：自定义 Artifact

LLM 提供完整 HTML/CSS/JS，在 iframe 沙箱中运行。

**适用场景：** 特殊小游戏、复杂交互面板、独特角色 UI、自定义可视化。

**LLM 输出格式：**

```json
{
  "type": "artifact_patch",
  "artifact_id": "combat_panel",
  "patch_type": "full",
  "payload": {
    "html": "<div id='combat'>...</div>",
    "css": "#combat { ... }",
    "js": "/* 受限 JS */"
  }
}
```

**平台处理：** 创建或更新 artifact 版本，在 iframe sandbox 中渲染，通过 `postMessage` 通信。

**安全性：** 需要权限声明和资源预算控制。默认不允许，需内容包或用户显式授权。

### 层级选择

| 场景 | 推荐层 | LLM 输出 | 平台处理 | 是否允许代码 |
|---|---|---|---|---|
| 新增普通物品 | 第一层 | `state_diff` | 内置物品栏渲染。 | 否 |
| 新增带图物品 | 第二层 | `component_declaration` | 白名单卡片组件。 | 否 |
| 特殊视觉效果 | 第二层 | `component_declaration` + theme | 平台主题和受控动画。 | 否 |
| 复杂交互面板 | 第三层 | `artifact_patch` | iframe 沙箱渲染。 | 受限 |

---

## Artifact 生命周期

### 创建

1. LLM 首次输出 `type: "artifact_patch"` 且 `patch_type: "full"`。
2. Runtime 校验：目标节点是否有 `render_custom_artifact` 权限。
3. 校验通过后创建 artifact 记录，写入 `artifacts` 表（参照 [数据库与 API](database-api.md)）。
4. 前端收到 `artifact_update` SSE 事件，创建 iframe 并加载内容。

### 版本更新

1. LLM 后续输出引用同一 `artifact_id` 的 patch。
2. `patch_type` 可以是 `state_diff`、`json_patch` 或 `props`。
3. 平台基于上一版本应用 patch，生成新版本。
4. 前端通过 `postMessage` 将 patch 推送至 iframe，无需重建。

### 离屏卸载

当 artifact 滚出视口或用户切换会话：

1. 保存当前 iframe 的静态 HTML 快照（`innerHTML` + 计算样式）。
2. 销毁 iframe，释放 JS 运行环境和事件监听器。
3. 用快照替代 iframe 位置，作为静态预览展示。

### 恢复

当用户滚动回 artifact 位置或切回会话：

1. 用最新版本的完整 artifact 内容重建 iframe。
2. 通过 `postMessage` 发送最新状态，让 iframe 恢复到卸载前的状态。
3. 替换静态快照。

### 销毁

会话删除或用户手动移除 artifact 时，从 `artifacts` 表软删除，清理文件系统中的资源。

---

## UI Schema 定义

### State Diff（第一层）

```json
{
  "type": "state_diff",
  "changes": {
    "<path>": <value> | { "from": <old>, "to": <new> }
  }
}
```

- `path` 使用点分隔路径：`character.player.inventory`、`world_state.current_location`。
- `add` 后缀表示追加到数组：`items.add`。
- `update` 后缀表示更新数组中匹配元素：`quests.update`（按 `id` 匹配）。
- `remove` 后缀表示从数组中移除：`items.remove`。
- Runtime 合并 state diff 到当前状态快照，校验路径合法性。

### Component Declaration（第二层）

```json
{
  "type": "component_declaration",
  "renderer": "<whitelisted_renderer_name>",
  "theme": "<theme_name>",
  "props": { ... }
}
```

- `renderer` 必须在平台白名单内：`item_card`、`character_panel`、`map_marker`、`quest_tracker`、`relationship_graph`、`status_bar`、`notification_toast`。
- `theme` 必须是平台已注册的主题：`default`、`dark_fantasy`、`sci_fi`、`modern`、`minimal`。
- `props` 结构由渲染器 schema 定义，平台在渲染前校验。

### Artifact Patch（第三层）

全量创建：

```json
{
  "type": "artifact_patch",
  "artifact_id": "<id>",
  "patch_type": "full",
  "payload": {
    "html": "<div>...</div>",
    "css": "...",
    "js": "..."
  }
}
```

增量更新：

```json
{
  "type": "artifact_patch",
  "artifact_id": "<id>",
  "patch_type": "state_diff",
  "payload": { ... }
}
```

或：

```json
{
  "type": "artifact_patch",
  "artifact_id": "<id>",
  "patch_type": "json_patch",
  "payload": [
    { "op": "replace", "path": "/hp", "value": 65 },
    { "op": "add", "path": "/effects/-", "value": { "type": "bleed" } }
  ]
}
```

- `json_patch` 遵循 RFC 6902。
- `state_diff` 是平台自定义格式，语义与第一层相同但作用于 artifact 内部状态。
- `props` patch 直接替换 artifact 的 props 对象。

---

## iframe 沙箱规范

### sandbox 属性

```html
<iframe
  sandbox="allow-scripts allow-same-origin"
  referrer-policy="no-referrer"
  loading="lazy"
></iframe>
```

| 属性 | 说明 |
|---|---|
| `allow-scripts` | 允许 JS 执行，artifact 需要交互能力。 |
| `allow-same-origin` | 允许 iframe 内容被视为同源，用于 CSS 和资源加载。与 `allow-scripts` 组合时需配合 CSP 限制。 |
| 不允许 `allow-top-navigation` | 阻止 iframe 跳转主页面。 |
| 不允许 `allow-popups` | 阻止弹窗。 |
| 不允许 `allow-forms` | 阻止表单提交，避免意外网络请求。 |

### 补充安全层

在 iframe sandbox 基础上，通过 Content-Security-Policy 和 JS 代理进一步限制：

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self' blob:;
           script-src 'unsafe-inline';
           style-src 'unsafe-inline';
           img-src 'self' data: blob:;
           connect-src 'none';
           font-src 'self' data:;
           frame-src 'none';">
```

### postMessage 通信协议

主页面与 iframe 之间只通过 `postMessage` 通信，双向都做 origin 校验。

**主页面 → iframe：**

| 消息类型 | 数据 | 说明 |
|---|---|---|
| `init` | `{ state, props, theme }` | iframe 创建时发送初始状态。 |
| `state_update` | `{ state }` | 状态更新，来自 state diff 合并。 |
| `patch` | `{ patch_type, payload }` | 增量 patch。 |
| `resize` | `{ width, height }` | 容器尺寸变化。 |
| `visibility` | `{ visible: true/false }` | 可见性变化。 |

**iframe → 主页面：**

| 消息类型 | 数据 | 说明 |
|---|---|---|
| `ready` | `{}` | iframe 加载完成，请求初始状态。 |
| `state_change` | `{ changes }` | 用户交互导致的状态变化，请求平台合并。 |
| `resize_request` | `{ width, height }` | iframe 请求调整容器大小。 |
| `error` | `{ code, message }` | iframe 内错误报告。 |
| `log` | `{ level, message }` | 调试日志，仅开发模式下处理。 |

### 可用 API 白名单

iframe 内 JS 可用的 Web API：

| API | 可用 | 说明 |
|---|---|---|
| `document` | 是 | iframe 内的 DOM 操作。 |
| `window.postMessage` | 是 | 与主页面通信。 |
| `requestAnimationFrame` | 是 | 动画。 |
| `setTimeout` / `setInterval` | 是 | 受平台托管，超时自动清理。 |
| `fetch` | 否 | `connect-src 'none'` 阻止。 |
| `XMLHttpRequest` | 否 | 同上。 |
| `localStorage` / `sessionStorage` | LLM artifact 默认否；角色卡 sandbox 可 shim | LLM 输出不应持久化存储。ST 风格角色卡见 `card-rendering-runtime.md`。 |
| `IndexedDB` | LLM artifact 默认否；角色卡 sandbox 可 shim | 仅用于受控兼容，不作为通用 artifact 能力。 |
| `navigator.geolocation` | 否 | 无权限。 |
| `getUserMedia` | 否 | 无权限。 |
| `window.open` | 否 | `allow-popups` 未启用。 |
| `location.assign` / `location.replace` | 否 | `allow-top-navigation` 未启用。 |

### 禁止行为

- 访问主页面 DOM（`window.parent.document`）。
- LLM artifact 读写 `localStorage`、`sessionStorage`、`IndexedDB`。
- 发起网络请求（`fetch`、`XHR`、`WebSocket`）。
- 打开新窗口或弹窗。
- 跳转主页面。
- 访问摄像头、麦克风、地理位置。
- 加载外部脚本（CSP `script-src` 限制为 `'unsafe-inline'`）。

---

## 资源预算

每个 artifact 有独立的资源预算，超出时自动降级。

### 预算限制

| 资源 | 限制 | 说明 |
|---|---|---|
| DOM 节点数 | 1000 | iframe 内 DOM 元素总数。 |
| JS 大小 | 200KB | artifact 的 JS 代码大小（压缩后）。 |
| CSS 大小 | 100KB | artifact 的 CSS 大小。 |
| HTML 大小 | 500KB | artifact 的 HTML 内容大小。 |
| 单次 JS 执行时间 | 50ms | `setTimeout` 和 `requestAnimationFrame` 回调的执行时间上限。 |
| 总运行时间 | 无限（受心跳监控） | 但如果连续 3 次心跳（3 秒）无响应，标记为无响应。 |
| 内存 | 50MB | iframe 运行时内存（通过 Performance API 估算）。 |
| 动画帧率 | 30fps | `requestAnimationFrame` 限制。 |
| 定时器数量 | 10 | `setTimeout` + `setInterval` 总数。 |

### 超预算降级策略

```text
检测到超预算
  ├─ DOM 超限 → 截断渲染，显示"内容过复杂"提示
  ├─ JS/CSS 超限 → 拒绝加载，显示静态预览
  ├─ 单次执行超时 → 暂停 JS 执行 1 秒，允许恢复
  ├─ 连续无响应 → 冻结 iframe，显示"无响应"提示和重启按钮
  ├─ 内存超限 → 销毁 iframe，显示静态快照
  └─ 定时器超限 → 拒绝新定时器，记录 trace
```

### 预算配置

预算可在会话级或内容包级配置：

```json
{
  "artifact_budget": {
    "max_dom_nodes": 1000,
    "max_js_bytes": 204800,
    "max_css_bytes": 102400,
    "max_html_bytes": 512000,
    "max_single_execution_ms": 50,
    "max_memory_mb": 50,
    "max_fps": 30,
    "max_timers": 10
  }
}
```

---

## 快照策略

### 触发条件

| 条件 | 行为 |
|---|---|
| artifact 滚出视口 | 保存快照，卸载 iframe。 |
| 用户切换会话 | 保存快照，卸载 iframe。 |
| 标签页进入后台 | 保存快照，冻结 iframe。 |
| 资源预算超限 | 保存快照，销毁 iframe。 |

### 快照格式

```json
{
  "type": "artifact_snapshot",
  "artifact_id": "combat_panel",
  "version": 4,
  "snapshot_html": "<div id='combat' style='...'>...</div>",
  "snapshot_css": "...",
  "timestamp": "2026-06-04T12:00:00Z"
}
```

- `snapshot_html`：iframe 内 `document.documentElement.outerHTML` + 内联计算样式。
- 快照是纯静态 HTML，不包含 JS 运行环境。
- 快照存储在前端内存中，不持久化到数据库（artifact 内容已持久化在 `artifacts` 表）。

### 恢复流程

```text
artifact 进入视口
  ├─ 有快照 → 先展示快照（即时可见）
  │         → 后台创建 iframe，加载最新版本
  │         → iframe ready 后替换快照
  └─ 无快照 → 直接创建 iframe 加载
```

### 最大同时活跃 artifact

- 同时运行的 iframe 数量限制为 5 个。
- 超过限制时，最久未交互的 artifact 自动转为快照。

---

## 白名单渲染器

平台内置的第二层渲染器：

| 渲染器 | 用途 | 核心 props |
|---|---|---|
| `item_card` | 物品卡片 | `name`, `description`, `rarity`, `image`, `effects` |
| `character_panel` | 角色状态面板 | `name`, `portrait`, `hp`, `mp`, `status`, `buffs` |
| `map_marker` | 地图标记 | `location`, `coordinates`, `icon`, `label` |
| `quest_tracker` | 任务追踪 | `quests[]`, `title`, `status`, `objectives` |
| `relationship_graph` | 关系图 | `characters[]`, `relationships[]` |
| `status_bar` | 状态栏 | `label`, `value`, `max`, `color`, `icon` |
| `notification_toast` | 通知提示 | `message`, `type`, `duration` |

白名单可在平台配置中扩展，但新增渲染器需要代码实现和安全审查。

---

## 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| LLM 输出恶意 JS | 在 iframe 内执行恶意代码。 | sandbox 属性 + CSP 限制 + postMessage 通信 + 资源预算。主页面 DOM 不可访问。 |
| iframe 逃逸 | 通过 `allow-same-origin` + `allow-scripts` 组合绕过沙箱。 | 不使用 `allow-top-navigation`、`allow-popups`、`allow-forms`；CSP 阻止外部脚本和网络请求。 |
| DOM 堆积导致卡顿 | 长会话创建大量 artifact iframe。 | 虚拟列表 + 离屏卸载 + 最大同时活跃数限制 + 快照替代。 |
| 状态 patch 冲突 | 多个节点同时 patch 同一 artifact。 | artifact patch 通过 Runtime 串行化，每个版本基于上一版本。 |
| 资源预算被绕过 | artifact 代码动态分配内存或创建隐藏节点。 | 预算检查在主页面侧执行，iframe 内代码无法感知或绕过。 |
| 快照质量丢失 | 静态快照无法还原动画和交互状态。 | 快照只用于过渡展示，用户停留后立即重建 iframe 恢复完整体验。 |

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| 第一层 state diff 渲染 | LLM 输出 `state_diff` 后，内置组件正确显示物品、属性或任务变化。 |
| 第二层白名单渲染器 | LLM 输出 `component_declaration` 后，校验 renderer 和 props，使用白名单组件渲染。 |
| 第二层非法渲染器 | LLM 引用不在白名单的 renderer 时，拒绝渲染，回退到第一层或显示错误。 |
| 第三层 iframe 沙箱隔离 | LLM artifact 内 JS 无法访问 `window.parent.document`、持久存储和网络。 |
| postMessage 通信 | 主页面发送 `init` 和 `state_update`，iframe 正确接收并响应 `ready` 和 `state_change`。 |
| 离屏卸载与恢复 | artifact 滚出视口后 iframe 被卸载，滚回后恢复，用户无感知中断。 |
| 资源预算 DOM 超限 | artifact DOM 超过 1000 节点时截断渲染并显示提示。 |
| 资源预算 JS 超限 | artifact JS 超过 200KB 时拒绝加载，显示静态预览。 |
| 最大同时活跃数 | 超过 5 个活跃 artifact 时，最久未交互的自动转为快照。 |
| 多节点 patch 同一 artifact | patch 按序应用，每个版本基于上一版本，不出现覆盖冲突。 |
| 长会话 500 轮后性能 | artifact 总数增长但活跃 iframe 数受控，聊天滚动流畅。 |
| LLM 无法注入主 DOM | 任何层的 LLM 输出都不直接插入主聊天 DOM，只通过受控通道渲染。 |
