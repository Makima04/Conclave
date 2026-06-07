# 卡片导入标准化规范

> 定义 SillyTavern 等外部角色卡如何在导入期转换为平台原生卡包。复杂兼容、修复和转译应尽量前移到导入流程；当前运行时仍保留受控 sandbox 兼容层，详见 [角色卡渲染运行时](card-rendering-runtime.md)。

`Card Import` · `SillyTavern Migration` · `Conclave Card Package` · `Normalization` · `Controlled Runtime Compatibility`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [内容包规范](content-packages.md)
- [Artifact Renderer 规范](artifact-renderer.md)
- [角色卡渲染运行时](card-rendering-runtime.md)

---

## 目标

- 把外部角色卡导入为平台自己的 `Conclave Card Package`，让运行时只面对稳定协议。
- 避免前端长期补 `SillyTavern`、`TavernHelper`、`Mvu`、`regex_scripts`、`indexedDB` 等兼容补丁。
- 允许导入期做重活：解析、执行规则、拆分资源、转译 JS、生成 schema、记录兼容报告。
- 保留原始卡作为审计和回退材料，但默认会话不直接运行原始卡。
- 让失败可诊断：导入报告必须说明哪些能力已转换、哪些能力降级、哪些能力需要人工确认。

---

## 架构决策

**主路径：导入期标准化。**

```text
原始 PNG / JSON / ST 角色卡
  -> 解析 metadata
  -> 执行确定性迁移规则
  -> 拆分 UI / 资源 / 开场 / 变量 / 动作
  -> 可选 LLM 语义标注
  -> 生成 Conclave Card Package
  -> 运行时渲染平台格式
```

运行时只支持平台协议：

```text
Conclave Card Package
  -> Conclave Renderer
  -> Conclave Variable Store
  -> Conclave Action Bridge
```

这样新增外部卡时，优先修导入器和转译器，而不是污染聊天运行时。

---

## 运行时 ST Sandbox：受控兼容，不是无限兼容

以下方案不再视为产品主路径，但当前作为复杂卡可用性的受控兼容层存在：

```text
每次渲染消息时
  -> 运行 ST regex_scripts
  -> 把作者原始 HTML/CSS/JS 放进 iframe
  -> 不断补 TavernHelper / Mvu / ST API shim
  -> 根据 runtimeError 继续打补丁
```

风险：

- 前端运行时会逐步变成半个 SillyTavern，维护边界失控。
- 每张复杂卡都可能引入新的浏览器 API、ST 扩展 API、存储模型或脚本语法。
- 运行时错误发生在用户聊天界面中，调试成本高，失败体验差。
- 沙盒兼容层越厚，安全审计越困难。
- 卡片 JS bundle 可能包含浏览器/语法兼容问题，应该在导入期转译，而不是在会话中失败。

允许用途：

- 导入标准化失败时的可用渲染。
- 迁移工具开发阶段的对照渲染。
- HTML app 类型 `ConclaveCardPackage` 的运行容器。
- 收集缺口报告，反哺导入器规则。

运行时兼容层必须有边界：只新增通用 shim，不为单张卡无限补私有协议。共享存档、开场白选择和性能策略见 [角色卡渲染运行时](card-rendering-runtime.md)。

---

## Conclave Card Package

导入器输出平台原生卡包。建议结构：

```json
{
  "manifest": {
    "pack_type": "character",
    "id": "char_saekano_v009",
    "name": "路人女主的养成方法测试版v0.09",
    "version": "0.1.0",
    "source": "sillytavern",
    "source_hash": "sha256:...",
    "importer_version": "0.1.0"
  },
  "greetings": [
    {
      "id": "opening_default",
      "label": "默认开场",
      "content": "[开局]"
    }
  ],
  "ui": {
    "type": "html_app",
    "html": "ui/index.html",
    "css": ["ui/index.css"],
    "js": ["ui/index.js"],
    "entry": "app",
    "assets": []
  },
  "variables": [],
  "actions": [],
  "compatibility": {
    "required_apis": [],
    "unsupported_apis": [],
    "warnings": []
  }
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `manifest.source` | 原始来源，如 `sillytavern`、`rentry`、`custom_json`。 |
| `manifest.source_hash` | 原始卡内容 hash，用于去重、缓存和审计。 |
| `greetings` | 从 `first_mes` 和 `alternate_greetings` 转换而来。 |
| `ui.type` | `schema`、`html_app`、`text` 之一。 |
| `ui.html/css/js` | 已拆分、转译、资源重写后的平台 UI。 |
| `variables` | 平台变量 schema，不直接暴露 ST 内部存储结构。 |
| `actions` | 平台动作声明，如开始、读档、写变量、设置消息。 |
| `compatibility` | 导入报告，记录缺口和降级行为。 |

---

## 导入流程

### 1. 解析原始卡

PNG 卡：

- 读取 `tEXt` / `iTXt` chunks。
- 优先解析 `ccv3`，缺失时回退 `chara`。
- base64 decode 后解析 JSON。
- 保留原始 metadata 到 `source/original.json`。

JSON 卡：

- 按 ST v2 / v3 字段识别。
- 规范化到统一中间结构：

```ts
type ExternalCard = {
  name: string;
  description: string;
  firstMes: string;
  alternateGreetings: string[];
  extensions: Record<string, unknown>;
  assets: Array<{ id: string; url: string; kind: string }>;
};
```

### 2. 执行确定性规则

对 `extensions.regex_scripts`：

- 支持 ST 的 `findRegex` 语义。
- 支持普通 regex source，如 `"\\[开局\\]"`。
- 支持 `/pattern/flags` 形式。
- 按 ST 的启用状态、placement 和顺序执行。
- 不匹配的复杂 HTML 不得强行追加。

输出：

```ts
type RegexExecutionResult = {
  matched: boolean;
  output: string;
  scriptsUsed: string[];
  diagnostics: string[];
};
```

### 3. 拆分 UI

如果输出是完整 HTML 应用：

- 识别 `<!doctype>`、`<html>`、`<head>`、`<body>`。
- 拆分 `<style>` 为 `ui/index.css`。
- 拆分 `<script>` 为 `ui/index.js`。
- 保留 `<div id="app">` 等入口节点。
- 不在运行时二次包装成嵌套文档。

如果输出是简单 HTML：

- 转为平台 `schema` 或 `html_fragment`。
- 移除不需要执行的脚本。

如果无法安全识别：

- 降级为 `text` 或 `raw_preview`，并写入 compatibility warnings。

### 4. 资源重写

导入器应扫描：

- `<img src>`
- CSS `url(...)`
- `<audio src>`
- `<video src>`
- JS 中明显的静态资源 URL

处理策略：

- 包内资源复制到 `assets/`。
- 远程资源可选择下载、代理、或保留 URL。
- 所有资源写入 manifest。
- 不允许绝对本地路径和 `..` 逃逸路径。

### 5. JS 转译与隔离

导入期可以使用 esbuild / Babel 对卡片 JS 做一次转译：

- 目标浏览器由平台决定。
- 保留 source map 到导入报告。
- 报告无法转译的语法。
- 将动态 `import(...)`、远程脚本、危险 API 标记为 compatibility warning。

运行时只加载转译后的 `ui/index.js`，不直接运行原始 bundle。

### 6. 动作抽取

导入器应从 HTML/JS 中抽取可见动作：

```ts
type CardAction = {
  id: string;
  label: string;
  kind: "start" | "load_save" | "set_message" | "set_variable" | "open_panel" | "unknown";
  selector?: string;
  source?: "html" | "js" | "llm";
};
```

确定性抽取优先：

- `button[data-action]`
- `form[data-action]`
- `aria-label`
- 明确的 `setChatMessage` / `setChatMessages` 调用

LLM 可辅助：

- 给未知按钮打语义标签。
- 总结动作目的。
- 生成 fallback schema。

LLM 不得负责执行 JS 或决定安全权限。

### 7. 变量抽取

导入器应识别：

- `getVariables`
- `setVariables`
- `updateVariablesWith`
- `Mvu` / `stat_data`
- 明显的状态初始化对象

输出平台变量 schema：

```ts
type CardVariable = {
  path: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  defaultValue?: unknown;
  label?: string;
  source?: string;
};
```

变量 schema 是平台运行时契约，不能直接依赖 ST 的内部全局对象。

---

## LLM 的位置

LLM 只用于语义理解和补全，不用于执行或安全判断。

适合交给 LLM：

- 解释按钮语义。
- 把变量路径翻译成用户可读标签。
- 识别开场 UI 的业务流程。
- 生成平台 fallback schema。
- 总结 unsupported API 的人工处理建议。

不适合交给 LLM：

- 执行 regex。
- 执行 JS。
- 判断代码是否安全。
- 直接重写大型 bundle。
- 代替确定性 parser 做结构提取。

---

## 运行时要求

长期目标是运行时不以 ST 兼容为核心。当前运行时负责：

- 渲染 `Conclave Card Package` 中声明的 UI，包括 HTML app iframe。
- 提供平台变量存储。
- 执行平台 action bridge。
- 隔离 HTML app。
- 记录运行时错误。

运行时允许的外部兼容：

- 只读预览原始卡。
- 受控 sandbox 兼容层。
- ST 常见存储和 TavernHelper/MVU shim。
- 宿主级共享存档桥接。

运行时兼容层不应新增：

- 针对单张卡的解析器。
- 为某张卡补的专用 API。
- 对 ST 插件生态的无限 shim。
- 无报告、无开关的隐式远程资源加载。

---

## 导入报告

每次导入必须生成 `import-report.json`：

```json
{
  "status": "success",
  "source": "sillytavern",
  "source_hash": "sha256:...",
  "steps": [
    { "name": "parse_png_metadata", "status": "success" },
    { "name": "execute_regex_scripts", "status": "success" },
    { "name": "split_html_app", "status": "success" },
    { "name": "transpile_js", "status": "warning", "message": "dynamic import preserved" }
  ],
  "required_apis": ["localStorage", "indexedDB", "getVariables"],
  "unsupported_apis": [],
  "warnings": ["Remote audio URL preserved"],
  "fallback": null
}
```

失败时：

```json
{
  "status": "fallback",
  "fallback": "raw_sandbox_preview",
  "reason": "JS parse failed after transpilation",
  "unsupported_apis": ["unknownExtensionApi"]
}
```

---

## v0.09 卡片样本结论

`/Users/makima/Downloads/v0.09.png` 暴露出的通用问题：

- `first_mes` 是 `[开局]`。
- `findRegex` 是 `"\\[开局\\]"`，应按 ST regex source 匹配，而不是字面字符串。
- `replaceString` 是完整 HTML/CSS/JS 应用，导入期应拆分为 `ui/index.html`、`ui/index.css`、`ui/index.js`。
- 卡片 JS 依赖 `localStorage`、`indexedDB`、`getVariables`、`setChatMessages`、`waitGlobalInitialized('Mvu')`。
- 卡片 JS 可能存在浏览器语法兼容问题，应在导入期用 JS parser / transpiler 处理。

该样本应作为导入器回归测试，不应通过在聊天运行时继续补专用兼容逻辑解决。

---

## 验收测试

### 导入测试

- PNG `chara` / `ccv3` metadata 能正确解析。
- `first_mes` 和 `alternate_greetings` 能转换为 greetings。
- `regex_scripts` 中 `"\\[开局\\]"` 能匹配 `[开局]`。
- 未匹配的复杂 HTML 不会被追加。
- 完整 HTML 应用能被拆分为 HTML/CSS/JS 文件。
- 资源 URL 能被识别并写入 manifest。

### 转译测试

- JS parser 能报告语法错误位置。
- 可转译语法被导入期转译。
- 不可转译语法进入 import-report warnings/errors。
- 动态 import 和远程脚本被标记。

### 运行时测试

- 原生 `Conclave Card Package` 不依赖 ST 全局 API。
- UI action 只通过平台 action bridge。
- 变量读写只通过平台变量存储。
- 原始 ST sandbox fallback 关闭时，平台仍可显示 fallback UI 或错误报告。

---

## 实施顺序

1. 新增导入器中间结构 `ExternalCard` 和 `ConclaveCardPackage`。
2. 实现 PNG metadata 解析。
3. 实现 ST regex executor，并移动到导入流程使用。
4. 实现 HTML app 拆分。
5. 实现资源扫描与重写。
6. 实现 JS parser / transpiler。
7. 实现 action / variable 抽取。
8. 生成 import-report。
9. 前端运行时改为优先加载平台卡包。
10. 将 ST runtime sandbox 标记为 fallback，并默认不作为主路径。
