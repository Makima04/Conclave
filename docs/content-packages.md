# 内容包规范

> 定义平台四种内容包（Character Pack、World Pack、Agent Graph Pack、Plugin Pack）的结构、manifest schema、资源约定、版本规则、导入导出流程和校验机制。内容包是创作者入口，也是 SillyTavern 迁移的基础。

`Content Pack` · `Character Pack` · `World Pack` · `Agent Graph Pack` · `Manifest` · `SemVer` · `Import Export`

---

- [文档中心](docs.md)
- [架构首页](index.md)
- [数据库与 API](database-api.md)
- [Agent Runtime](agent-runtime.md)
- [Agent 边界](agent-boundaries.md)
- [长期记忆](long-context-memory.md)

---

## 目标

- 为四种内容包提供统一的结构和校验规范，让创作者、导入工具和 Runtime 都能以相同方式处理内容包。
- 普通创作者可以通过 Character Pack 和 World Pack 快速开始 RP，不需要理解 Agent 图。
- 高级创作者可以通过 Agent Graph Pack 自定义编排逻辑。
- SillyTavern 角色卡、世界书和预设有明确的迁移路径。
- 所有内容包可导入、可导出、可校验、可版本管理。

---

## 通用规范

### Manifest Schema

每个内容包的根目录必须包含 `manifest.json`。Manifest 是包的身份声明和元数据索引。

```json
{
  "pack_type": "character",
  "id": "char_archivist",
  "name": "档案管理员",
  "version": "1.2.0",
  "author": "creator_name",
  "description": "旧档案馆的守护者，知晓古老文献和血月仪式的部分真相。",
  "platform_version": ">=0.1.0",
  "dependencies": [],
  "assets": [
    "assets/portrait.png",
    "assets/voice_sample.mp3"
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pack_type` | `character`、`world`、`graph`、`plugin` | 是 | 包类型，决定目录结构和校验规则。 |
| `id` | string | 是 | 全局唯一标识，建议格式 `<type>_<name>`，只允许 `[a-z0-9_]`。 |
| `name` | string | 是 | 人类可读名称。 |
| `version` | string | 是 | SemVer 格式，见下方版本规则。 |
| `author` | string | 否 | 创作者标识。 |
| `description` | string | 否 | 一句话描述。 |
| `platform_version` | string | 否 | 兼容的平台版本范围，SemVer range 格式。不声明则假定兼容当前版本。 |
| `dependencies` | string[] | 否 | 依赖的其他包 id，如 Agent Graph Pack 依赖特定 Character Pack。 |
| `assets` | string[] | 否 | 包内资源文件路径列表，用于导入时完整性校验。 |

### 版本规则

- 使用 Semantic Versioning：`MAJOR.MINOR.PATCH`。
- `MAJOR`：不兼容的结构变更（如删除必需字段、改变目录结构）。
- `MINOR`：向后兼容的功能新增（如新增可选字段、新增资源目录）。
- `PATCH`：向后兼容的修复（如修正文本、替换资源）。
- 导入时检查版本兼容性：如果包声明了 `platform_version`，平台按 SemVer range 匹配。

### 资源文件约定

- 所有资源放在 `assets/` 目录下，manifest 中声明的路径相对于包根目录。
- 图片：`png`、`jpg`、`webp`，单文件不超过 5MB。
- 音频：`mp3`、`ogg`、`wav`，单文件不超过 20MB。
- 视频：不建议内嵌，后续可通过插件系统引用外部链接。
- 字体：`woff2`，不超过 2MB。
- 资源路径只允许引用包内文件，不允许绝对路径或 `..` 逃逸。
- 资源总大小建议不超过 100MB，超过时导入流程显示警告。

### ZIP 包结构

内容包导出为 ZIP 文件，结构如下：

```text
char_archivist_v1.2.0.zip
  manifest.json
  public.md
  hidden.md
  personality.json
  relationships.json
  assets/
    portrait.png
    voice_sample.mp3
```

- ZIP 根目录直接包含 `manifest.json`，不嵌套额外目录层。
- 导入时解压到平台内部存储路径，按 `pack_type/id/version/` 组织。

---

## Character Pack — 角色包

角色包定义一个 NPC 或用户角色的完整信息，是 RP 最基础的内容单元。

### 目录结构

```text
character/
  manifest.json          # 包元数据，pack_type = "character"
  public.md              # 公开设定：外貌、身份、公开背景、说话风格
  hidden.md              # 隐藏设定：秘密、真实动机、隐藏知识
  personality.json       # PersonalityCore + 可演化 PersonalityState 初始值
  relationships.json     # 初始关系图
  greeting.md            # 开场白
  example_dialogues.md   # 示例对话（可选）
  assets/                # 头像、语音、背景图等资源
```

### personality.json

定义角色的人格核心和初始可演化状态。参照 [长期记忆 — 角色成长与不 OOC 的边界](long-context-memory.md)。

```json
{
  "core": {
    "values": ["knowledge_preservation", "loyalty_to_institution"],
    "fears": ["loss_of_memory", "being_forgotten"],
    "desires": ["uncover_blood_moon_truth"],
    "speech_style": "正式、偶尔引用古籍，语速缓慢",
    "knowledge_boundary": ["archive_layout", "ancient_scripts", "blood_moon_partial"],
    "ooc_redlines": ["sudden_betrayal_without_cause", "casual_violence", "modern_slang"]
  },
  "initial_state": {
    "mood": "calm_vigilant",
    "trust_player": 0.3,
    "short_term_goals": ["assess_player_intent"],
    "behavioral_tendencies": ["cautious_but_polite", "deflects_personal_questions"]
  }
}
```

### relationships.json

```json
{
  "player": {
    "trust": 0.3,
    "affection": 0.1,
    "fear": 0.0,
    "respect": 0.5,
    "notes": "初次见面，保持职业距离"
  },
  "elder_scholar": {
    "trust": 0.8,
    "affection": 0.6,
    "fear": 0.1,
    "respect": 0.9,
    "notes": "师徒关系，但对某些决定有分歧"
  }
}
```

### 公开与隐藏设定分离

- `public.md`：NPC 自己知道且愿意分享的信息，也包含用户可直接看到的角色描述。
- `hidden.md`：NPC 不会主动透露的秘密、真实动机、隐藏知识边界。
- Runtime 在构建 NPC 的 `ContextBundle` 时，`public.md` 全量注入，`hidden.md` 按条件注入（只有 NPC 已知的秘密才进入上下文）。
- Director 和 Consistency Agent 可以读取 `hidden.md` 用于裁决和检查。

---

## World Pack — 世界包

世界包定义 RP 世界的地点、势力、规则、时间线和导演强度配置。

### 目录结构

```text
world/
  manifest.json          # 包元数据，pack_type = "world"
  lore/
    public/              # 公开世界知识：地理、历史、文化、势力概况
      geography.md
      history.md
      factions.md
    hidden/              # 隐藏世界知识：未揭示的真相、幕后势力、秘密规则
      blood_moon_ritual.md
      true_history.md
  timeline.json          # 世界时间线：已发生的大事件
  rules.json             # 世界规则：能力体系、物理规则、魔法约束、战斗系统
  director_config.json   # 导演强度、叙事风格和用户权限配置
  assets/                # 地图、势力徽章、世界概念图
```

### rules.json

定义世界规则约束，WorldJudge Agent 据此裁决用户行为和 NPC 能力。

```json
{
  "power_system": {
    "type": "knowledge_based",
    "rules": [
      "力量来源于对古老文献的理解深度",
      "没有代价的魔法不存在",
      "血月仪式需要特定钥匙和时间窗口"
    ]
  },
  "combat": {
    "enabled": true,
    "system": "narrative",
    "lethality": "medium",
    "rules": ["战斗结果由叙事合理性决定，非数值计算"]
  },
  "timeline": {
    "frozen": false,
    "allow_user_time_skip": false,
    "max_auto_advance": "1_scene"
  },
  "hard_constraints": [
    "已死角色不能复活，除非世界规则明确允许",
    "时间不能倒流",
    "角色不能出现在两个地点"
  ]
}
```

### director_config.json

配置导演行为和用户叙事权限。

```json
{
  "director_strength": "collaborative",
  "user_narrative_authority": "character_actions",
  "auto_resolve_minor_conflicts": true,
  "foreshadowing_density": "normal",
  "npc_autonomy": "moderate",
  "description": "用户控制角色行动，导演控制世界反应和剧情走向。"
}
```

| 字段 | 说明 |
|---|---|
| `director_strength` | `passive`（用户主导）、`collaborative`（协作）、`strict`（导演主导）。 |
| `user_narrative_authority` | `full`（用户可叙述一切）、`character_actions`（用户只能控制自己角色）、`limited`（受限）。 |
| `npc_autonomy` | `low`（被动响应）、`moderate`（有独立行为）、`high`（主动推动剧情）。 |

---

## Agent Graph Pack — 行为包

Agent Graph Pack 定义自定义节点图，让高级创作者控制编排逻辑。

### 目录结构

```text
graph/
  manifest.json          # 包元数据，pack_type = "graph"
  graph.json             # 节点图定义：节点、边、条件
  prompts/               # 自定义 prompt 模板
    director_system.md
    npc_archivist.md
    writer_narrative.md
  config.json            # 运行时配置：循环限制、token 预算、超时
  assets/                # 图相关资源
```

### graph.json

定义节点和边。参照 [Agent Runtime — 节点与边](agent-runtime.md)。

```json
{
  "nodes": [
    {
      "id": "director",
      "type": "DirectorNode",
      "config": {
        "prompt_template": "prompts/director_system.md"
      }
    },
    {
      "id": "world_judge",
      "type": "WorldJudgeNode",
      "config": {}
    },
    {
      "id": "npc_archivist",
      "type": "NpcNode",
      "config": {
        "character_id": "archivist",
        "prompt_template": "prompts/npc_archivist.md"
      }
    },
    {
      "id": "writer",
      "type": "WriterNode",
      "config": {
        "prompt_template": "prompts/writer_narrative.md"
      }
    },
    {
      "id": "memory",
      "type": "MemoryNode",
      "config": {}
    }
  ],
  "edges": [
    { "from": "director", "to": "world_judge", "type": "sequence" },
    { "from": "world_judge", "to": "npc_archivist", "type": "condition", "condition": "judge_result.facts_valid" },
    { "from": "npc_archivist", "to": "writer", "type": "sequence" },
    { "from": "writer", "to": "memory", "type": "sequence" }
  ],
  "entry": "director",
  "max_loop_count": 2,
  "max_total_nodes": 8
}
```

### config.json

```json
{
  "max_loop_count": 2,
  "max_total_nodes_per_turn": 8,
  "max_parallel_nodes": 2,
  "max_turn_runtime_ms": 30000,
  "max_token_budget_per_turn": 4096,
  "required_permissions": ["read_public_lore"]
}
```

### 权限声明

Agent Graph Pack 可以在 `config.json` 中声明所需权限。平台在导入时检查权限，运行时强制执行。

| 权限 | 说明 |
|---|---|
| `read_public_lore` | 读取公开世界知识。 |
| `read_hidden_lore` | 读取隐藏世界知识，需用户授权。 |
| `write_memory` | 提交记忆候选变更。 |
| `custom_prompts` | 使用自定义 prompt 模板。 |
| `parallel_execution` | 启用并行节点。 |

---

## Plugin Pack — 能力包

Plugin Pack 为平台扩展新节点类型、工具、检索器或渲染组件。V1 只做高层定义，详细规范留待插件系统规范（待补）。

### 目录结构

```text
plugin/
  manifest.json          # 包元数据，pack_type = "plugin"
  permissions.json       # 权限 manifest
  nodes/                 # 自定义节点实现
  tools/                 # 工具定义
  assets/
```

### permissions.json

```json
{
  "requested_permissions": ["read_public_lore", "render_custom_artifact"],
  "network_access": false,
  "file_access": "none",
  "memory_write": false,
  "description": "需要读取公开知识和渲染自定义 artifact。"
}
```

### 安全边界

- Plugin Pack 默认没有读取隐藏设定、网络访问、文件访问或写入记忆的权限。
- 所有权限必须在 `permissions.json` 中显式声明。
- 用户导入时看到权限列表并逐项授权。
- 运行时由平台强制执行权限，插件代码节点在沙箱内运行。

---

## 导入流程

导入内容包时执行以下校验链：

```text
1. 解压 ZIP
   └─ 检查 ZIP 结构是否合法，不含路径逃逸（../）

2. Manifest 校验
   └─ 必填字段完整、id 格式合法、version 是有效 SemVer

3. 平台兼容性
   └─ 检查 platform_version 是否满足

4. Schema 校验
   └─ 按 pack_type 检查必需文件是否存在
   └─ JSON 文件格式正确
   └─ Markdown 文件非空

5. 依赖检查
   └─ manifest.dependencies 中的包是否已导入

6. 权限声明
   └─ Plugin Pack 和 Agent Graph Pack 的权限是否被用户授权

7. 资源完整性
   └─ manifest.assets 中声明的文件全部存在
   └─ 文件大小和格式符合约定

8. 写入
   └─ 写入 content_packs 表
   └─ 解压到 storage_path
   └─ 返回导入报告（warnings + errors）
```

### 校验错误分级

| 级别 | 行为 | 示例 |
|---|---|---|
| `error` | 阻止导入 | manifest 缺少必填字段、依赖包未导入、权限未授权。 |
| `warning` | 允许导入但提示 | 资源文件偏大、版本过旧、缺少可选文件。 |

---

## 导出流程

```text
1. 读取 content_packs 表和 storage_path
2. 按包类型校验内部一致性
3. 打包为 ZIP（保持目录结构）
4. 以 <id>_v<version>.zip 命名返回
```

- 导出的 ZIP 可被同一平台或其他兼容平台重新导入。
- 导出不包含运行时数据（trace、state、memory），只包含创作者原始内容。

---

## SillyTavern 迁移映射

SillyTavern 的角色卡、世界书和预设可以通过结构化映射转换为平台内容包。

### 角色卡 → Character Pack

| SillyTavern 字段 | Character Pack 文件 | 说明 |
|---|---|---|
| `description` | `public.md` | 角色公开描述。 |
| `personality` | `personality.json` → `core` | 核心人格特征。 |
| `mes_example` | `example_dialogues.md` | 示例对话。 |
| `first_mes` | `greeting.md` | 开场白。 |
| `system_prompt` | `personality.json` → `core.system_prompt` | 系统提示词。 |
| `creator_notes` | `manifest.json` → `description` | 创作者备注。 |
| `tags` | `manifest.json` → `tags`（扩展字段） | 标签。 |
| `alternate_greetings` | `greeting.md` 多版本 | 备选开场白。 |

**隐藏设定迁移：** SillyTavern 的 `description` 和 `personality` 通常混合公开和隐藏信息。迁移工具尝试分离，但无法可靠分离时，将全部内容放入 `public.md`，并在迁移报告中提示用户手动整理 `hidden.md`。

### 世界书 → World Pack

| SillyTavern 字段 | World Pack 文件 | 说明 |
|---|---|---|
| 世界书条目（公开） | `lore/public/*.md` | 按条目名拆分为独立文件。 |
| 世界书条目（隐藏/选择性插入） | `lore/hidden/*.md` | 需要特定条件才插入的条目。 |
| 条目触发条件 | `lore/` 目录下条目 metadata | 保留原始选择性插入逻辑。 |

**迁移风险：** SillyTavern 世界书条目的选择性插入逻辑与平台 ContextBundle 可见性机制不完全对应。迁移后建议用户审查 `lore/hidden/` 目录的划分是否合理。

### 预设 → 会话配置

| SillyTavern 字段 | 平台对应 | 说明 |
|---|---|---|
| 模型配置 | `sessions.config.model` | 模型名和 API 设置。 |
| 采样参数 | `sessions.config.sampling` | temperature、top_p 等。 |
| 系统提示词 | `sessions.config.system_prompt` | 全局系统提示词。 |
| Prompt 模板 | Agent Graph Pack `prompts/` | 高级用户可将预设模板转为图包的 prompt 文件。 |

### 迁移报告

导入 SillyTavern 内容后，平台生成迁移报告：

```json
{
  "source": "sillytavern",
  "character_pack_id": "char_migrated_npc",
  "world_pack_id": "world_migrated",
  "warnings": [
    "hidden.md 需要手动整理：无法可靠分离公开和隐藏设定",
    "世界书选择性插入逻辑已简化为 hidden/ 目录划分",
    "部分预设参数已忽略：max_context（平台自动管理上下文）"
  ],
  "unmigratable": [
    "SillyTavern 扩展脚本（需通过 Plugin Pack 重新实现）",
    "自定义 CSS 主题（需通过 Artifact Renderer 重新配置）"
  ]
}
```

---

## 风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 公开/隐藏设定划分不当 | NPC 泄露不该知道的秘密，或过于封闭导致无法自然交流。 | 导入后提供可见性预览工具，让用户检查 NPC 在特定场景能看到哪些信息。 |
| 资源文件体积失控 | 导入包过大，影响本地存储和加载速度。 | 资源大小限制 + 导入时警告 + 运行时懒加载。 |
| Agent Graph Pack prompt 注入 | 恶意 prompt 可能绕过权限、泄露隐藏信息或操纵其他 Agent。 | prompt 模板只在节点自己的 ContextBundle 内使用，不能访问其他节点的上下文；所有输出经过 Runtime schema 校验。 |
| 版本兼容性断裂 | 新版平台不兼容旧包格式，或旧平台无法解析新包。 | manifest 声明 `platform_version`，导入时严格检查；不兼容时阻止导入并提示原因。 |
| SillyTavern 迁移信息丢失 | 自动迁移无法完美分离公开/隐藏信息，触发条件逻辑简化。 | 迁移报告明确列出无法自动处理的部分，引导用户手动审查。 |
| 依赖包缺失 | Agent Graph Pack 引用的 Character Pack 未导入。 | 导入时检查依赖，缺失时阻止导入并列出缺失依赖。 |

---

## 验收测试

| 测试场景 | 通过标准 |
|---|---|
| 导入合法 Character Pack | ZIP 解压、manifest 校验、schema 校验通过，写入 `content_packs` 表，可被会话引用。 |
| 导入缺少 manifest 的 ZIP | 返回 `error`，阻止导入，明确提示缺少 `manifest.json`。 |
| 导入含路径逃逸的 ZIP | 返回 `error`，阻止导入，提示不安全路径。 |
| Agent Graph Pack 权限声明 | 导入时展示所需权限列表，用户未授权时阻止导入。 |
| 角色包公开/隐藏分离 | NPC ContextBundle 包含 `public.md` 内容，不包含 `hidden.md` 中 NPC 未知的秘密。 |
| 版本兼容性检查 | 声明 `platform_version: ">=2.0.0"` 的包在平台 1.x 版本导入时被拒绝。 |
| 导出再导入一致性 | 导出的 ZIP 重新导入后，所有文件和 manifest 内容与原始包一致。 |
| SillyTavern 角色卡迁移 | 导入 SillyTavern 格式角色卡后，生成 Character Pack，迁移报告列出警告和不可迁移项。 |
| 依赖检查 | Agent Graph Pack 声明依赖但目标 Character Pack 未导入时，返回缺失依赖错误。 |
| 资源完整性校验 | manifest 声明的资源文件缺失时，返回 `warning` 或 `error`（取决于缺失文件是否必需）。 |
