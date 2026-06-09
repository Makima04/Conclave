# 角色卡渲染运行时

> 定义当前前端如何渲染导入后的角色卡 UI，尤其是 SillyTavern 风格 HTML 卡、沙盒 API、共享存档、开场白选择和性能约束。本文描述当前实现，不是理想化远期方案。

`Character Card` · `Conclave Package` · `Sandbox Runtime` · `SillyTavern Compatibility` · `Shared Saves` · `Iframe Performance`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [卡片导入标准化](card-import-normalization.md)
- [Artifact Renderer](artifact-renderer.md)

---

## 当前主路径

聊天消息渲染由 `MessageContent` 路由：

1. `render_mode = text`：只渲染格式化文本，不挂载 iframe。
2. `render_mode = schema`：只渲染平台 schema/status/cover，不执行卡片 HTML app。
3. `render_mode = sandbox`：优先执行原始沙盒 HTML。
4. `render_mode = auto`：优先使用导入期生成的 `characterCard.conclave_package.ui`，再回退到 ST regex sandbox、schema/status/text。

复杂 HTML 卡当前以 iframe 运行，入口包括：

- `frontend/src/pages/components/PlatformPackageRenderer.tsx`
- `frontend/src/pages/components/SandboxHtmlRenderer.tsx`
- `frontend/src/pages/components/TavernHelperRuntimeHost.tsx`
- `frontend/src/pages/sandbox-document.ts`

`ConclaveCardPackage` 是当前产品主路径；“完全转成平台 schema”是长期方向，不是当前已经完成的状态。

当角色卡在 `extensions.tavern_helper.scripts` 声明启用脚本时，聊天页会挂载一个隐藏的 TavernHelper 脚本宿主 iframe。宿主只负责执行卡片声明的脚本并提供通用 ST/TavernHelper/MVU 桥接，不解析某张卡的变量名，也不替代作者脚本绘制 UI。若脚本自己创建浮动 iframe、状态栏、相册或自动正则，这些 UI 由脚本自身负责。

---

## 新会话开局

新建会话没有消息时，如果绑定了角色卡，聊天区会渲染一个虚拟 assistant opening preview：

- 内容为 `characterCard.first_mes || '【GameStart】'`。
- runtime 中的 `currentMessageId` 是 `opening-preview`。
- 用于让 `[开局]` 触发的 HTML app 在空会话首屏直接显示。

右侧输入栏提供开场白选择：

- 来源：`first_mes` + `alternate_greetings`。
- 会话开始前可切换和应用。
- 一旦已有 `turn_number > 0` 的消息，开场白选择禁用，避免覆盖已有对话。

---

## 沙盒兼容 API

`sandbox-document.ts` 注入兼容层，供 ST 风格卡调用：

| API | 当前行为 |
|---|---|
| `getCurrentMessageId()` | 返回当前宿主消息 id。 |
| `getLastMessageId()` | 返回会话快照中最后一条消息 id。 |
| `getChatMessages()` | 返回宿主会话消息快照。 |
| `getChatMessage(id)` | 返回指定消息，缺省为当前消息。 |
| `getVariables()` | 返回会话变量快照。 |
| `getAllVariables()` | 返回按 ST 常见作用域组织的变量快照。 |
| `setVariables(vars)` | 通过 `card-sandbox-action:setVariables` 请求宿主写变量。 |
| `applyGreeting(index)` | 空会话时同步切换并应用宿主开场白。 |
| `setChatMessage(...)` | 用于开局/草稿等卡片动作。 |
| `setChatMessages(...)` | 识别 opening swipe 并映射到宿主开场白切换。 |
| `triggerSlash(command)` | 支持 `/send` / `继续书写` 等简单命令桥接。 |
| `TavernHelper.*` | 代理到上述 API；未知方法上报 `missingApi`。 |
| `eventOn/eventOff/eventEmit/waitGlobalInitialized` | 提供 MVU/事件初始化兼容。 |
| `Mvu.getMvuData/replaceMvuData/insertVariables` | 提供消息变量和会话变量读写桥接。 |
| `tavern_events` | 提供 ST 常见事件名常量。 |
| `substituteMacros` | 提供基础 `{{user}}` / `{{char}}` 宏替换。 |
| `localStorage/sessionStorage` | 可用时使用浏览器实现，不可用时使用内存 shim。 |
| `indexedDB` | 可用时使用浏览器实现，不可用时使用内存 shim。 |

兼容层不能为了单张卡无限新增私有 API。新增 API 前必须确认它能服务一类卡，并写入本文或导入标准化文档。

TavernHelper 脚本宿主使用 iframe 执行卡片声明的脚本，并在 `StatusPlaceHolderImpl` 占位处挂载。宿主保持 `allow-scripts` 隔离；若某类卡明确需要同源 iframe 权限，应先评估通用安全边界再扩展权限。

---

## 共享存档

SillyTavern 卡常把存档写进同源 `localStorage` / `IndexedDB`，所以不同聊天能互相读取。平台 iframe 是隔离的，不能天然共享这些存档。

当前做法：

1. 宿主按 `world_pack_id` 拉取同一卡/同世界最近会话。
2. 每个会话合成为轻量 `SandboxSharedSave`。
3. 沙盒预填 ST 常见存档索引：
   - `localStorage['islandmilfcode:save-index:v2']`
   - `localStorage['islandmilfcode:save-payload:v2:<saveId>']`
   - IndexedDB store `save-index` / `save-payload` 的等价行。
4. 点击 `data-action="load-save"` 时，沙盒向宿主发送 `loadSaveSession`。
5. 宿主收到跨会话 save 后导航到 `/chat/<sessionId>`。

重要约束：

- 不阻止卡自己的 `load-save` click handler。当前会话存档需要让卡自己的 `enterSave()` 正常执行。
- 注入 payload 保持轻量，不塞完整历史消息，避免大 JSON 让 iframe 初始化卡住。
- 不因为存在共享存档就强制替换可用的浏览器 IndexedDB；只在 IndexedDB 不可用时使用内存 shim。
- 当前实现只保证读档列表和宿主跳转。各卡私有的完整内部存档状态不由平台伪造。

---

## 性能策略

目标是让复杂卡尽量接近 SillyTavern 的流畅度，同时不破坏兼容。

当前策略：

- iframe 懒挂载：使用 `IntersectionObserver`，接近视口再创建。
- 流式输出强制 `renderMode="text"`：避免 token streaming 时不断重建卡 UI。
- resize 节流：`ResizeObserver` 通过 `requestAnimationFrame` 合并，高度变化小于 8px 不通知宿主。
- 消息级 HTML app iframe 展示高度限制在 360-720px，超出内容在 iframe 内滚动，避免长页面卡片撑开聊天流。
- runtime JSON 缓存：沙盒内 `getChatMessages/getChatMessage` 从预序列化字符串 clone，减少重复 stringify。
- 点击 telemetry 默认关闭：只有 URL 含 `xrpDebugTelemetry` 才上报普通 UI 点击。
- 空会话 opening preview runtime memo 化，减少右侧栏状态变化导致 iframe 重建。
- 共享存档只加载同世界最近一批会话，历史会话只在会话/世界变化时刷新。

低风险优化优先级：

1. 减少父 React 状态变化导致 iframe `srcDoc` 改变。
2. 减少沙盒初始注入 JSON 体积。
3. 减少跨 iframe `postMessage` 频率。
4. 避免多条历史消息同时挂载复杂 iframe。

高风险优化暂缓：

- 强制冻结/替换卡自己的 IndexedDB。
- 改写卡 bundle 的动画、定时器或内部状态机。
- 使用静态快照代替当前可交互 iframe。
- 在运行时解析并改写卡作者 JS。

---

## 验收测试

| 场景 | 通过标准 |
|---|---|
| 空会话打开复杂卡 | 首屏显示卡作者 HTML app，而不是黑屏或纯文本。 |
| 开场白选择 | 右侧栏能切换主开场/备选开场；会话开始后禁用。 |
| 读档列表 | 卡内“读取存档”能显示同世界会话合成的存档。 |
| 当前会话读档 | 点击当前会话存档后，卡自己的界面进入对应状态。 |
| 跨会话读档 | 点击其他会话存档后，宿主导航到目标 `/chat/<sessionId>`。 |
| 普通卡按钮 | 非 `load-save` 的按钮不被宿主误拦截。 |
| 流式输出 | 生成过程中不挂载复杂 iframe，避免卡顿。 |
| 长会话滚动 | 离屏复杂卡不会持续触发 resize 风暴。 |

---

## 修改注意事项

- 改 `sandbox-document.ts` 时先考虑是否会影响所有 HTML 卡。
- 改 shared save 时优先保持轻量和可中断，避免把会话全量数据塞进 iframe。
- 改 `PlatformPackageRenderer` / `SandboxHtmlRenderer` 时避免让 `srcDoc` 因无关状态变化重建。
- 需要用户视觉验证时，让用户刷新当前页面后测试，不要求自动浏览器工具必须接管。
