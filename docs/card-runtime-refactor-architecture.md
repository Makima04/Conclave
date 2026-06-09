# 角色卡兼容运行时重构架构

> 定义角色卡从导入到前端渲染再到动态变量回流渲染的整体重构方案。本文是目标架构文档，描述我们接下来要收敛的单一运行时模型，而不是当前分散补丁实现的复述。

`Card Import` · `SillyTavern Compatibility` · `Frontend Regex Runtime` · `Canonical State` · `Card Projection` · `Runtime Adapter`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [卡片导入标准化](card-import-normalization.md)
- [角色卡渲染运行时](card-rendering-runtime.md)

---

## 目标

当前角色卡兼容链路把 SillyTavern 语义拆散在导入器、前端 regex 重放、消息级 sandbox、会话级 TavernHelper 宿主和变量桥接中。结果是：

- 同一张卡在不同渲染路径上语义不一致。
- 一处修复容易在另一处回归。
- 变量、事件、开场白、状态栏和脚本能力互相隐式耦合。

本次重构的目标不是继续为单卡补丁，而是把角色卡兼容收敛成一个统一架构：

1. 导入器只做原始数据提取和兼容分析，不做最终显示语义裁决。
2. SillyTavern 风格 regex 显示语义只保留一个执行入口。
3. 所有卡片脚本只运行在一个统一的运行时模型上。
4. 动态变量采用 canonical state + card projection 模型，而不是把 ST 变量直接当平台真相源。

---

## 总体原则

### 1. 单一真相源

- 平台真实状态的真相源是 backend canonical state。
- 卡片显示语义的真相源是 frontend card runtime。
- 卡片变量只是 projection，不是平台真实状态本体。

### 2. 导入期保守，运行时决策

导入器不再根据一次 regex 命中结果强行决定整张卡的最终 UI 形态。导入器负责保留原始能力信息，运行时再依据当前 greeting、消息、变量投影和脚本能力做显示决策。

### 3. 兼容层优先于平台花活

SillyTavern 兼容层先追求一套稳定、可回归的作者侧运行时语义，再在上层叠加平台 schema、长期状态和工具驱动变量系统。

### 4. 明确拒绝未知写入

卡片脚本不能把任意未声明变量直接写成平台真实状态。未映射、未知、仅 UI 用的路径必须留在 runtime-local 层或被拒绝持久化。

---

## 端到端链路

### 阶段 1：导入

输入：

- 角色卡原始文件（PNG/JSON）
- `first_mes`
- `alternate_greetings`
- `extensions.regex_scripts`
- `extensions.tavern_helper.scripts`
- 其他 metadata / 资源 / JS

输出：

- `raw card data`
- `compatibility report`
- `resource manifest`
- `state_schema`
- `state_adapter`
- `runtime boot hints`

导入器职责：

- 提取原始字段和脚本资源。
- 扫描 regex、TavernHelper、MVU、变量读写和资源依赖。
- 生成平台 canonical state 与卡片变量之间的 `state_adapter`。
- 标记需要的 bridge API、可疑脚本能力和潜在兼容风险。

导入器不负责：

- 不执行最终显示语义。
- 不根据单条 opening 内容做强 `ui_type` 裁决。
- 不做单卡中文字段名硬编码。
- 不把卡片私有变量直接升级为平台真实状态定义。

### 阶段 2：运行时装载

前端读取：

- 原始 opening / alternate greetings
- TavernHelper scripts
- 原始 regex scripts
- `state_adapter`
- 当前 session canonical state

然后构建：

- `session runtime`
- `message runtime`
- `card projection`
- `sandbox bridge APIs`

这里的关键是：无论卡片以状态栏、message sandbox、HTML app 还是 opening preview 形式出现，底层都共享同一套 runtime contract。

### 阶段 3：显示语义执行

显示语义只在前端执行一次，入口是统一的 `card runtime renderer`。

它负责：

- 对 opening / alternate greeting / assistant message 执行 ST 风格 regex 显示语义。
- 根据内容决定是纯文本、正文 + 状态栏、还是完整 sandbox UI。
- 将 `card projection` 注入到脚本运行时。
- 输出用户实际看到的 UI。

后端不再参与显示期 regex 执行，只保留分析和导入报告能力。

### 阶段 4：状态变化

状态变化可能来自两种来源：

1. LLM / State tool
2. 卡片脚本 `setVariables` / `replaceMvuData` / 交互事件

两者都不能直接改“显示变量本体”。它们都必须经过 adapter 层，最后落到 canonical state 或 runtime-local state。

### 阶段 5：重新投影与再渲染

canonical state 变化后：

1. backend 持久化 canonical state
2. frontend 收到更新后的 session state
3. `state_adapter` 生成新的 card projection
4. 运行时发出变量更新事件
5. 卡片 UI 局部刷新

因此“变量改了后卡片显示变化”不再是前端本地变量表直接驱动，而是 canonical state -> projection -> re-render 的闭环。

---

## 模块边界

### 导入器

建议保留职责：

- 原始数据提取
- 资源扫描
- 能力分析
- 兼容报告
- `state_adapter` 生成

建议下放职责：

- 显示期 regex 执行
- greeting 级最终渲染裁决
- UI 主路径强行分类

### Frontend Card Runtime

这是显示语义的唯一执行点。

职责：

- 执行 ST 风格 regex 显示语义
- 管理 message/session 两种挂载场景
- 提供统一 sandbox bridge
- 管理 card projection 和 runtime-local state
- 负责 diagnostics / unsupported capability surfacing

### Canonical State Layer

这是平台状态真相源。

职责：

- 存储平台真实世界状态
- 接收 tool 写入
- 提供 frontend 所需的结构化状态快照

不负责：

- 直接暴露给卡片脚本作为裸变量表

### Card Projection Layer

这是 canonical state 到卡片变量世界的映射层。

职责：

- 生成 `getVariables()`、`getAllVariables()`、`getMvuData()` 所需视图
- 支持 state adapter 映射规则
- 在 canonical state 更新后稳定地重建 projection

### Card Variable Adapter

这是脚本反向写状态时的收口点。

职责：

- 接收 `setVariables` / `replaceMvuData` / `updateVariablesWith`
- 判定写入是 canonical、projection 可写还是 runtime-local
- 拒绝未知或未声明路径的持久化写入

---

## Regex 运行时架构

### 决策

ST 风格 regex 显示语义只保留前端单点执行，不再由后端和前端各执行一套。

### 原因

- regex 是显示语义，依赖当前 greeting、当前消息、当前 projection 和当前 render mode。
- 如果后端也执行显示 regex，前端迟早仍需要局部重算，最终会重新出现双实现漂移。
- 当前问题的根源之一就是同一协议在多处半实现。

### 性能策略

前端单点执行不代表每次 render 裸跑：

- 只在“内容进入显示系统”时执行，而不是 React 每次重绘时执行。
- 结果按 `card revision + message/swipe + render mode + projection version` 做缓存。
- 长文本或重脚本路径允许 worker 化。
- 变量变化只触发依赖 projection 的局部重算。

### 非目标

- 不追求每个 backend API 都能得到 regex 后文本。
- 不把 regex 结果当数据库正式内容持久化。

---

## 统一运行时模型

### 模型

只保留一种 card runtime contract，允许两种挂载场景：

- `session runtime`
- `message runtime`

两者共享：

- 同一套 bridge API
- 同一套 event bus
- 同一套 variable adapter
- 同一套 diagnostics
- 同一套 projection contract

### 挂载差异

`session runtime` 适合：

- 状态栏
- 常驻脚本
- 全会话浮层

`message runtime` 适合：

- opening preview
- 单条消息 UI
- message-scoped app

差异只在生命周期和挂载位置，不在语义实现。

---

## 动态变量架构

### 与 SillyTavern 的区别

SillyTavern 更接近“变量存储即状态本体”。

本项目的目标模型不同：

- backend canonical state 才是平台状态真相源
- card variables 是给作者脚本和 UI 用的兼容 projection
- LLM tool 改的是 canonical state
- card script 改的是 adapter 暴露的受控变量界面

这不是兼容问题，而是架构升级。

### 三层状态

#### 1. Canonical State

平台真实状态。

- 由 tool / backend 写入
- 持久化
- 用于长期记忆、事件、剧情一致性

#### 2. Card Projection

给卡片脚本读取的变量视图。

- 来源是 canonical state 映射
- 可包含 ST 常见 `variables/stat_data/MVU` 形态
- 每次 canonical state 更新后重新生成

#### 3. Runtime-local State

仅前端运行时使用的状态。

- UI 折叠
- 当前 tab
- 局部草稿
- 非持久面板状态

这层不能污染 canonical state。

### 写入权限边界

#### Canonical writable

只允许 backend tool 和 adapter 明确映射后的写入落到这里。

#### Projected writable

卡片脚本写入命中 `state_adapter.write_rules` 时，可以转换成 canonical patch 提交。

#### Runtime-local only

UI 类变量只保留在前端，不落库。

#### Unknown / undeclared

默认拒绝持久化，只记 diagnostic。

### 事件流

1. LLM tool 或脚本发出变量变化请求
2. adapter 解析并分类
3. canonical patch 写入后端，或 runtime-local 写入前端
4. frontend 更新 projection version
5. runtime 发出 `VARIABLE_UPDATE_ENDED`
6. 卡片 UI 局部刷新

因此 `VARIABLE_UPDATE_ENDED` 的语义应收敛为：

`projection refreshed`

而不是：

`frontend local variable table is truth`

---

## 兼容目标

本次重构的目标不是完整复刻 SillyTavern 全生态，而是达到作者侧主路径兼容。

### L1：展示兼容

- `first_mes`
- `alternate_greetings`
- AI output regex
- 换行与 Markdown 主路径
- placeholder / inner thought / 正文共存

### L2：交互兼容

- TavernHelper 常用入口
- `getVariables / setVariables`
- `getMvuData / replaceMvuData`
- `Generate / submitText / setChatMessage / setChatMessages`
- 常见按钮与状态栏交互闭环

### L3：状态兼容

- canonical state -> projection 稳定同步
- tool 写状态后卡 UI 正确刷新
- 卡片脚本受控写回
- 未声明变量不污染平台真实状态

本次重构完成标准建议至少到 L3。

非目标：

- 所有第三方 ST 扩展完全复刻
- 任意私有 hack 无条件兼容
- 所有 slash ecosystem 行为完全等价

---

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 导入器降权后短期表现变化 | 旧卡可能从错误“看似能跑”变成显式降级。 | 用 compatibility report + diagnostics 替代静默失败。 |
| 前端单点 regex 成为热点 | 长文本或复杂卡可能卡主线程。 | 缓存、阈值触发 worker、局部重算。 |
| projection 规则过弱 | 卡片读到的变量不符合作者预期。 | 强化 state_adapter 和 fixture 卡回归。 |
| 脚本写状态权限过松 | UI 私有变量污染平台状态。 | 默认拒绝未知路径，只允许声明映射。 |
| 宿主统一时破坏现有行为 | 会话级和消息级卡片同时回归。 | 先抽统一 contract，再迁移挂载壳。 |

---

## 迁移步骤

1. 冻结新增单卡补丁。
2. 让导入器只输出分析结果、adapter 和 boot hints，不再承担显示语义执行。
3. 建立统一 frontend regex runtime。
4. 抽象统一 card runtime contract，迁移 session/message 两类宿主。
5. 抽离 projection layer 和 variable adapter。
6. 将脚本变量写入全部改走 adapter。
7. 用 fixture 卡建立回归测试矩阵。

---

## 验收测试

| 场景 | 通过标准 |
|---|---|
| opening 主开场/备选开场 | 所有 greeting 经过同一套前端 regex 语义，切换后显示一致。 |
| 状态栏卡按钮 | 常见按钮点击后能通过统一 bridge 触发真实交互，不再因宿主不同失效。 |
| 长文本卡 | 不丢换行，不因错误 regex 路径退成单段文本。 |
| HTML app 卡 | 不因导入期误判而渲染成残缺 fragment。 |
| LLM tool 改变量 | canonical state 更新后，卡片 projection 自动刷新并重渲染。 |
| 卡片脚本改变量 | 已声明映射路径能受控回写；未知路径不会污染真实状态。 |
| session/message 两类宿主 | 同一张卡在两类挂载场景下核心语义一致。 |

