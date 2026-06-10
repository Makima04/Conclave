# 导入器架构

> 导入器负责把 SillyTavern / 外部角色卡忠实转换为平台原生 `Conclave Card Package`。导入器的哲学与 SillyTavern 一致：**先完整、稳定地收进来，语义解释留给运行时。**

`Importer` · `Pipeline` · `RawCardSource` · `Faithful Preservation`

---

- [文档中心](docs.md)
- [卡片导入标准化](card-import-normalization.md)
- [内容包规范](content-packages.md)
- [角色卡渲染运行时](card-rendering-runtime.md)

---

## 设计哲学

对比 SillyTavern 的导入链：

| 层 | SillyTavern | 本平台 |
|---|---|---|
| PNG/JSON 解析 | `character-card-parser.js`：只读 metadata，原样取出卡 JSON | `png_parser.rs`：同 |
| 卡结构整理 | `characters.js`：深合并 extensions，`character_book` 原样挂到 `data.character_book` | `ExternalCard`：同 |
| 校验 | `TavernCardValidator.js`：只校验字段存在，不解释语义 | 不单独校验 |
| InitVar 解析 | **不做** — 留给运行时或插件 | **不做** — 留给 `state_initializer` |
| UI 分析 | 不在导入期做 | 导入期做 regex、HTML 拆分、JS 分析（平台特有） |

核心原则：

1. **忠实保存**：`character_book`、`extensions`、`first_mes` 原文进入 `raw_source`。
2. **确定性分析**：regex 执行、HTML 拆分、JS 启发式分析、资源扫描是导入器的平台特有增值，但不修改原始数据。
3. **语义延迟**：`InitVar`、`<UpdateVariable>` 等状态初始化语义由运行时 `state_initializer` 解析。
4. **两条真相**：`variables`（来自 JS 静态分析）和 `raw_source`（原文）共存，后者不是唯一真相源但保证不丢信息。

---

## Pipeline 架构

导入器和解析器职责解耦：

```text
  ┌──────────────────────────────────────────────────────────┐
  │                   orchestrator.rs                         │
  │                                                          │
  │  PNG/JSON bytes ──> parse_source ──> ExternalCard         │
  │                            │                              │
  │                            ├──> analyzer::run_analysis    │
  │                            │        └──> AnalysisResult   │
  │                            │                              │
  │                            ├──> package_builder::build    │
  │                            │        └──> ConclaveCardPackage
  │                            │                              │
  │                            └──> report::build_report      │
  │                                     └──> ImportReport     │
  └──────────────────────────────────────────────────────────┘
```

### 导入器 (`orchestrator.rs`)

只负责**忠实解析**：

- 解析 PNG/JSON 源文件 → `ExternalCard`
- 协调分析器和包构建器
- 生成导入报告
- 不做任何语义解释（不解析 InitVar、不执行 regex）

### 解析器 (`analyzer.rs`)

负责**确定性分析**（可独立运行、可重跑）：

1. Regex 执行（`regex_executor`）
2. HTML 拆分（`html_splitter`）
3. 资源扫描（`resource_scanner`）
4. JS 分析（`js_analyzer`）
5. 动作抽取（`action_extractor`）
6. 变量抽取 — 仅 JS 静态分析（`variable_extractor`）
7. 状态适配器生成（`state_adapter`）
8. 兼容性报告

输出 `AnalysisResult`：

```rust
struct AnalysisResult {
    regex_result: RegexExecutionResult,
    html_split: HtmlAppSplit,
    resources: ResourceManifest,
    js_analysis: JsAnalysisReport,
    actions: Vec<ActionDeclaration>,
    variables: Vec<VariableDeclaration>,
    state_schema: CardStateSchema,
    state_adapter: CardStateAdapter,
    extraction_layers: ExtractionLayers,
    compatibility: CompatibilityReport,
    stages: Vec<StageResult>,
    diagnostics: Vec<ImportDiagnostic>,
    rule_traces: Vec<RuleTrace>,
}
```

### 包构建器 (`package_builder.rs`)

接收 `ExternalCard` + `AnalysisResult`，输出 `ConclaveCardPackage`。

### 解耦好处

| 好处 | 说明 |
|---|---|
| 导入器可独立跑 | 只保存原始数据，不需要等分析完成 |
| 解析器可独立重跑 | 卡片入库后，解析器升级可重新分析，不需要重新导入 |
| 输出独立演进 | `RawCardSource` 和 `AnalysisResult` 各自版本化 |
| 符合 ST 哲学 | 导入器 = ST 的 `character-card-parser.js`，只管收卡 |

## 导入器：解析源

### PNG 解析 (`png_parser.rs`)

- 读取 `tEXt`/`iTXt` chunks → base64 decode → JSON。
- 优先 `ccv3`（v3），回退 `chara`（v2）。
- `extensions` 深合并，`character_book` 原样挂入。

### JSON 解析 (`json_parser.rs`)

- 按 ST v2/v3 字段识别，规范化到 `ExternalCard`。

输出 `ExternalCard`：

```rust
struct ExternalCard {
    name: String,
    first_mes: String,              // 原文
    alternate_greetings: Vec<String>,
    extensions: serde_json::Value,  // 原样，含 character_book
    // ... 其他标准字段
}
```

---

## 解析器：确定性分析

以下阶段全部在 `analyzer.rs` 中，可独立于导入器运行。

### 1. Regex 执行 (`regex_executor`)

- 从 `extensions.regex_scripts` 提取 ST regex 脚本。
- 按 `findRegex` 对 `first_mes` 执行替换。
- 支持普通 regex、`/pattern/flags`、ST 特殊语法。
- 不匹配时不强行追加，记录 `regex_no_match` 诊断。

### 2. HTML 拆分 (`html_splitter`)

- 识别完整 HTML 文档（`<!doctype>`、`<html>`）。
- 拆分 `<style>` → CSS、`<script>` → JS。
- 保留 entry node（如 `<div id="app">`）。
- 自动剥离 markdown code fence。

### 3. 资源扫描 (`resource_scanner`)

- 扫描 `<img src>`、CSS `url()`、`<audio>`、`<video>` 等。
- 当前只检测 URL，资源复制/代理待实现。

### 4. JS 分析 (`js_analyzer`)

- 启发式 API 检测（非完整 parser）。
- 分类：`platform_native`、`browser_shim`、`unsupported`、`dangerous`。
- 动态 `import()` 扫描。
- 括号平衡检查。

### 5. 动作抽取 (`action_extractor`)

- 从 HTML/JS 抽取可见动作：`button[data-action]`、`form` submit、`setChatMessage` 等。

### 6. 变量抽取 (`variable_extractor`)

- **仅从 JS 静态分析** 提取变量声明（`getVariables`、`setVariables`、`stat_data` 等）。
- **不解析 InitVar** — character_book entries 和 opening text 保存到 `raw_source`。

### 7. 状态适配器 (`state_adapter`)

- 从变量声明构建 `CardStateSchema` + `CardStateAdapter`。
- 识别平台 canonical path（`world.current_time`、`relationships.*.score` 等）。
- 不确定字段标记 `custom/manual_review`。

### Stage 9: 包构建 (`package_builder`)

- 汇总所有产物为 `ConclaveCardPackage`。
- 忠实保存 `raw_source`：character_book、first_mes、alternate_greetings、extensions。

---

## RawCardSource

`raw_source` 是导入器的"只进不出"存储：原始卡数据完整保留，不在导入期做任何语义解释。

```rust
struct RawCardSource {
    /// character_book entries as-is（可能含 InitVar、world info 等）
    character_book: Option<serde_json::Value>,
    /// first_mes 原文（可能含 <UpdateVariable><initvar>…）
    first_mes: String,
    /// alternate_greetings 原文
    alternate_greetings: Vec<String>,
    /// extensions 原样（regex_scripts、tavern_helper 等）
    extensions: serde_json::Value,
}
```

运行时消费 `raw_source` 的方式：

1. `state_initializer::load_initial_variables()` 从 `world_book_entries` + `character_cards` 表读取 InitVar 源。
2. `state_initializer::parse_init_variables()` 解析 `<UpdateVariable><initvar>` 标签和 YAML/JSON 格式。
3. 解析结果 merge 到会话状态，再由 `card_state_adapter` 做平台规范化。

这保证了：
- 导入器不丢失任何信息。
- 运行时可以根据需要重新解析（如卡片更新后）。
- 解析逻辑只存在一处（`state_initializer`），不需要在导入器和运行时各维护一份。

---

## ConclaveCardPackage 完整结构

```json
{
  "manifest": {
    "pack_type": "character",
    "id": "char_xxx",
    "name": "...",
    "version": "0.1.0",
    "source": "sillytavern",
    "source_hash": "sha256:...",
    "importer_version": "0.1.0"
  },
  "greetings": [{ "id": "opening_default", "label": "默认开场", "content": "..." }],
  "ui": { "type": "html_app", "html": "...", "css": [], "js": [], "assets": [] },
  "runtime_hints": { "st_regex_scripts_present": true, "opening_regex_matched": true, "..." : "..." },
  "extraction_layers": { "state_signals": [], "ui_signals": [], "action_signals": [], "unresolved_signals": [] },
  "variables": [{ "path": "statusData.world", "type": "object", "source": "js_analysis" }],
  "state_schema": { "roots": [], "fields": [] },
  "state_adapter": { "adapter_version": "0.1.0", "read_rules": [], "write_rules": [], "variable_rules": [], "warnings": [] },
  "actions": [],
  "compatibility": { "required_apis": [], "unsupported_apis": [], "warnings": [], "api_mappings": [] },
  "raw_source": {
    "character_book": { "entries": [{ "comment": "[InitVar]", "content": "<initvar>...</initvar>" }] },
    "first_mes": "<UpdateVariable><initvar>...</initvar></UpdateVariable>",
    "alternate_greetings": [],
    "extensions": { "regex_scripts": [], "character_book": {} }
  }
}
```

---

## 源码位置

### 导入器（忠实解析）

| 模块 | 文件 | 职责 |
|---|---|---|
| 编排器 | `backend/src/importer/orchestrator.rs` | 解析源 → 调分析器 → 构建包 → 生成报告 |
| PNG 解析 | `backend/src/importer/png_parser.rs` | 读取 PNG metadata，输出 `ExternalCard` |
| JSON 解析 | `backend/src/importer/json_parser.rs` | 解析 JSON 卡格式 |
| 包构建 | `backend/src/importer/package_builder.rs` | ExternalCard + AnalysisResult → ConclaveCardPackage |
| 类型定义 | `backend/src/importer/types.rs` | `ExternalCard`、`AnalysisResult`、`RawCardSource` 等 |

### 解析器（确定性分析）

| 模块 | 文件 | 职责 |
|---|---|---|
| **分析器** | **`backend/src/importer/analyzer.rs`** | **分析 pipeline 主入口，可独立于导入器运行** |
| Regex 执行 | `backend/src/importer/regex_executor.rs` | ST regex_scripts 执行 |
| HTML 拆分 | `backend/src/importer/html_splitter.rs` | 完整文档拆分 |
| 资源扫描 | `backend/src/importer/resource_scanner.rs` | URL 检测 |
| JS 分析 | `backend/src/importer/js_analyzer.rs` | API 检测、语法检查 |
| 动作抽取 | `backend/src/importer/action_extractor.rs` | HTML/JS 动作声明 |
| 变量抽取 | `backend/src/importer/variable_extractor.rs` | JS 变量声明（不含 InitVar） |
| 状态适配 | `backend/src/importer/state_adapter.rs` | CardStateSchema + Adapter 生成 |

### 运行时 InitVar 解析

| 模块 | 文件 | 职责 |
|---|---|---|
| 状态初始化 | `backend/src/runtime/state_initializer.rs` | `parse_init_variables()` + 会话状态初始化 |
| 状态适配器 | `backend/src/runtime/card_state_adapter.rs` | 平台状态规范化、读写规则执行 |

---

## 与 SillyTavern 的差异

| 维度 | SillyTavern | 本平台 |
|---|---|---|
| 导入时 InitVar 解析 | 不做 | 不做（对齐） |
| character_book 保存 | 原样 | 原样 + `raw_source` 双份保存 |
| regex 执行 | 运行时执行 | **解析器** `analyzer.rs` 中执行（用于 UI 分析） |
| HTML/JS 拆分 | 不做 | **解析器**中做（平台特有） |
| 状态适配器 | 不需要（ST 直接用全局变量） | **解析器**中生成（平台需要 canonical path） |
| 导入报告 | 无 | 结构化 `ImportReport` |
| 导入器/解析器解耦 | 无此概念 | `orchestrator.rs`（导入）+ `analyzer.rs`（分析）分离 |

导入器只做忠实保存（与 ST 对齐）。平台额外的分析工作（regex、HTML 拆分、JS 分析、状态适配器）全部在 `analyzer.rs` 中，可独立运行和重跑。
