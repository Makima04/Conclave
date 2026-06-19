# Card Runtime Regression Log

本日志记录角色卡运行时踩过的回归链。效果验收写入 `frontend/fixtures/cards/*/expectations.md`，机制保护写入自动测试，架构规则写入 `docs/card-runtime-architecture-v4.md`。

## REG-001 苍玄界 "灵" 小界面空白

引入改动：v4 迁移中将 tavern_helper 脚本从旧 bridge/headBridge 管线迁到同源 iframe runtime。

影响范围：苍玄界卡片的父页面浮动 "灵" 按钮可见时，点击后打开的小界面空白或脚本未完整初始化。

直接原因：
- fixture `/lab` 只读取 `code` / `script` 字段，苍玄界脚本实际存放在 `content` 字段，导致常驻脚本 iframe 执行空脚本。
- 真实聊天页仍把 tavern_helper 脚本拼进消息 iframe 文档，未使用 `createScriptSrcContent`，因此没有脚本 iframe 专用的 Vue / Zod 运行环境。

连锁影响：
- `MagVarUpdate` / 状态栏 bundle 依赖的 `Vue`、`z`、MVU 初始化链缺失。
- 脚本 iframe 卸载时如果调用全局 `eventClearAll()`，可能误清空其他脚本 iframe 的事件监听，导致按钮存在但后续交互失效。

修复方式：
- `CardRenderLab` 和聊天页都通过 `normalizeTavernHelperScripts()` 读取 `content` / `code` / `script`，并过滤 disabled/empty 脚本。
- 聊天页改用 `StScriptIframeHost` 运行 tavern_helper 脚本，不再用消息 iframe 承载脚本库。
- `TavernHelper.eventClearAll()` 收敛为清理当前 iframe 注册的订阅，不再清空全局 `eventSource`。

防复发：
- `frontend/src/pages/st-runtime/tavern-helper.test.ts` 覆盖 `content` 字段脚本读取和 scoped `eventClearAll()` 行为。
- `frontend/fixtures/cards/cangxuanjie/expectations.md` 增加 "灵" 小界面渲染和 Vue/Zod console 错误验收项。

## REG-002 MVU 卡对话中状态栏数值不更新

引入改动：单智能体流式提交路径将 `finalize_turn_with_options` 的 `persist_inline_variable_updates` 参数绑定为 `is_multi_agent_commit`（单智能体恒为 `false`），意图让单智能体只走 `update_variables` 工具调用那条变量写入路。

影响范围：MVU 类卡片（如「变身少女，空庭调教日记」）在对话过程中，浮动状态栏 / 卡片区块里的动态数值（灵魂特质、身体烙印、侍奉者的成长之路……）始终停留在初始值，不随对话变化。

直接原因（双重丢失）：
- MVU 卡的 worldbook 指令是 *「You must output `<UpdateVariable>…</UpdateVariable>`」*（`worldbook_parser.rs`），叙事 LLM 遵守该指令输出内联 `<UpdateVariable>` 块，**不会**调用 `update_variables` 工具。
- **① 后端不持久化**：单智能体路径里 `persist_inline_variable_updates=false`，`turn_finalizer.rs` 的 `persist_extraction_tx` 不执行 → 解析出的变量变更被丢弃。而工具路（`propose_single_agent_variable_changes`）对 MVU 卡基本不工作：卡片不说工具协议，且 `writable_state` 未被喂入时 `propose_variable_changes` 在 `variable_tool_agent.rs:147-152` 直接 `return None`。
- **② 前端也捞不回**：`turn_finalizer.rs:65-70` 把 `assistant_content` 设为已剥掉 `<UpdateVariable>` 块的 `display_text` 存库；`st_host_render.rs` 渲染读的是这条剥过块的 `message.content`，前端 iframe MVU runtime 无法从消息历史里重放更新。

对比：多智能体路径 `finalize_turn` 写死 `persist_inline_variable_updates=true`（`turn_finalizer.rs:45`），所以多智能体不犯此错。

修复方式：
- `backend/src/routes/messages.rs`（流式）与 `backend/src/runtime/executor.rs`（非流式单智能体）的 `finalize_turn_with_options(..., persist_inline_variable_updates)` 实参由 `false`/`is_multi_agent_commit` 改为 `true`。两条路径的内联 `<UpdateVariable>` 现在都经由 `persist_extraction_tx` 写入 `session_variables`，与多智能体行为对齐。
- 前端无需改动：`StHost.tsx` 在每轮结束后已调用 `loadAll()` + `store.reloadChatVariables()`（`api.readSessionVariables` → `_chatVariables` → 卡片宏 / 状态栏读取），原本就在等数据落库。

防复发：
- 非 MVU 的单智能体卡不会回归：叙事 LLM 被约束「不输出 `<UpdateVariable>`」（`executor.rs` runtime constraint），`variable_update::extract()` 返回空 `changes`，`persist_extraction_tx` 在 `turn_finalizer.rs:46` `if changes.is_empty() { return Ok(()); }` 提前返回，纯 no-op。
- 关键不变量：`<UpdateVariable>` 的解析始终在后端 `variable_update.rs::extract()` 完成，前端不做变量提取（见 `card-runtime-architecture-v4.md` §12.1），本修复只是补齐单智能体的持久化开关。

## REG-003 变量更新 State 节点 thinking+tool_choice HTTP 400 → 状态栏不更新

引入改动：多智能体 DAG 的 `state` 节点（变量更新）模型走 `agent.config.model → sub_agent_model → 默认值`，且 `ChatRequest` 无任何 thinking 控制机制。

影响范围：MVU 卡（如「变身少女，空庭调教日记」）对话中状态栏数值永不更新。

直接原因（查库确认，非敏感词拦截）：
- `traces` 表 `state` 节点报 `HTTP 400: {"error":{"message":"Thinking mode does not support this tool_choice"}}`，`type: invalid_request_error`。吐敏感正文的 writer/user 节点均正常 → 排除内容审核。
- State 节点用 `deepseek-v4-flash`（thinking 模式）+ `tool_choice`（函数调用）；DeepSeek thinking 模式拒绝 `tool_choice` → 每轮 400 → 变量不写入。`session_variables` 里只剩开场 `<initvar>` 初始种子（`内心想法:"Yes"`、`已通过考核:[]` 占位值）。

修复方式（三层）：
1. **state 节点尊重 `variable_tool_model`** — `graph.rs:271` 优先级改为 `agent.config.model → (State 专属) variable_tool_model → sub_model`。让这个简单确定性的变量更新调用可独立指向非 thinking 模型。
2. **thinking 参数化** — 新增 `provider/thinking.rs`：`ThinkingConfig` 集中持有 DeepSeek 请求格式知识（`{"thinking":{"type":"enabled|disabled"}}` + `reasoning_effort`），调用点只表达意图。`ChatRequest` 加 `thinking`/`reasoning_effort` 字段并派生 `Default`（16 处字面量补 `..Default::default()`，未来加参数零改动）。`AgentConfig` 加 `thinking_enabled`/`reasoning_effort`（JSON 列，无 migration）。
3. **state 默认关 thinking** — `execute_sub_agent`（DAG）对 `AgentType::State` 且未设时按 `false` 注入；`variable_tool_agent.rs::propose_variable_changes`（单智能体工具调用）强制 `ThinkingConfig::disabled()`。

前端：`AgentManagerPanel` params tab 加「思考模式」开关 + effort 下拉（无/low/high/max），state agent 默认显示关。

防复发：
- 调用 LLM 的全部维度（provider/url/key via `model_ref`、采样参数 via `AgentConfig`、thinking via `ThinkingConfig`）现已统一为参数注入；唯一曾经硬编码的 thinking 已收进 `provider/thinking.rs`。
- 加 thinking 控制是为支持 thinking 模型跑 tool_choice；若未来某 provider 换格式（如 Anthropic `output_config`），只改 `provider/thinking.rs`，不动调用点。

## REG-004 多 agent streaming 路径漏调 snapshot → 状态栏开场永远"角色数据缺失"

引入改动：对话走 SSE streaming（前端 `/stream` 实际热路径），`execute_turn_stream`（`executor.rs:1086`）把 `graph::execute_multi_agent_turn` 的 `TurnCommit` 透传回 route 层，持久化责任由 route 层承担。

影响范围：MVU 卡（如「变身少女的绝对隶属调教日记」，新会话 turn 1 开场）状态栏报 `角色数据缺失`、数值永远空。

直接原因（5 层叠加根因的最后一层）：
1. state agent 无破限 → 内置 `STATE_JAILBREAK_PROMPT`（`variable_tool_agent.rs`），多 agent 路径在 `sub_agent.rs::build_contextual_system_prompt` 注入 State-only section。
2. tool schema 不递归展开嵌套对象 → 模型给的 path 少中间层（`<user>.调教值` 而非 `<user>.精神状态数值.调教值`）→ 全被存在性校验过滤。`variable_to_schema` 改递归。
3. `tool_state_for_context` 没解包 `variables` 外层 → 存在性校验恒失败。改为解包。
4. `card_state_adapter::set_by_path` 写 MVU 数组槽位（`称号[0]`）时 `ensure_array_index` 打在父 cursor 上，把父 `<user>` Object 整个炸成数组 → variables 从 6350 塌到 277。改为 `ensure_object(cursor,key)` + `ensure_array_index(slot,idx)`。
5. **本条**：上述 4 层修好后 state agent 正常产出，`session_variables.variables` 健康（6590 字节、`<user>` 为 object），但 `messages.metadata.stat_data` 仍空。根因——`snapshot_variables_to_message_metadata` 只在 `executor.rs:592`（非 streaming `execute_turn`）和 `executor.rs:865`（单 agent）调了，**多 agent streaming 路径的持久化点在 `routes/messages.rs` 的 `finalize_turn_with_options` + `tx.commit()` 之后，那里漏调**。turn 1（开场白）state agent 合理地提交空 `changes`（`{"changes": []}`），store 有值但镜像不进 metadata → 状态栏读不到。

诊断方法：手跑同样的 UPDATE（`json_set` 写 `$.stat_data`/`$.display_data`）能正常把 metadata 从 `{}` 写到 13210 字节、affected=1 → 证明 SQL、数据、WHERE 子句全对，纯是代码里这个调用点缺失。

修复方式：
- `executor.rs`：`snapshot_variables_to_message_metadata` 由私有 `async fn` 改 `pub async fn`。
- `routes/messages.rs`：在多 agent streaming 持久化的 `tx.commit()` 之后（与 executor.rs 两条路径一致的位置）加 `executor::snapshot_variables_to_message_metadata(&pool, &session_id, turn_number)`。

防复发：
- variables → `messages.metadata.stat_data`/`display_data` 的镜像有 **三条** turn 提交路径（非 streaming 多 agent、单 agent、多 agent streaming），新增任何持久化路径都必须在 commit 后调一次 `snapshot_variables_to_message_metadata`。
- 排查"stat_data 空"先确认该 turn 走哪条路径，去对应 commit 点找调用；验证 SQL 见 `mvu-stat-snapshot-multi-agent-stream` 记忆。


