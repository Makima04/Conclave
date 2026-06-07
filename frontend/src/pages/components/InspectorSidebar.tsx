import React from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_SESSION_CONFIG } from '../../api/types';
import type {
  CharacterCard,
  Preset,
  ProviderConfig,
  RenderMode,
  SessionConfig,
  UserPersona,
  UserSettingMergeStrategy,
  WorldBook,
} from '../../api/types';
import type { PlatformCardSchema } from '../card-schema-types';
import { describeModelRef, ModelPicker } from '../../settings/modelSelection';
import type { UserPersonaPreset } from '../../settings/sessionDefaults';

// --- helpers (duplicated from Chat.tsx; small and self-contained) ---

function shortText(value: string, max = 180): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function formatLogPayload(payload: any): string {
  if (!payload || typeof payload !== 'object') return payload == null ? '' : String(payload);
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function logSeverity(action: string, payload: any): string {
  if (action === 'runtimeError' || action === 'missingApi') return ' error';
  if (action === 'diagnostic' && ['error', 'unhandledrejection'].includes(String(payload?.event || ''))) return ' error';
  if (action === 'diagnostic' && String(payload?.level || '') === 'warn') return ' warn';
  if (action === 'submitText' || action === 'formSubmit' || action === 'triggerSlash') return ' success';
  return '';
}

// --- props ---

export type InspectorTab = 'params' | 'worldbook' | 'preset' | 'agents' | 'render' | 'user' | 'debug';

export interface InspectorSidebarProps {
  // inspector UI state
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  setInspectorTab: React.Dispatch<React.SetStateAction<InspectorTab>>;
  setInspectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  paramsEditing: boolean;
  setParamsEditing: React.Dispatch<React.SetStateAction<boolean>>;
  userEditing: boolean;
  setUserEditing: React.Dispatch<React.SetStateAction<boolean>>;

  // session identity
  sessionId: string | undefined;

  // config & data
  config: SessionConfig;
  setConfig: React.Dispatch<React.SetStateAction<SessionConfig>>;
  configDirty: boolean;
  characterCard: CharacterCard | null;
  providers: ProviderConfig[];
  worldBooks: WorldBook[];
  presets: Preset[];
  activeWorldBookId: string;
  sessionResourceSaving: 'worldbook' | 'preset' | null;
  renderMode: RenderMode;
  userPersona: UserPersona;
  userPresets: UserPersonaPreset[];
  sessionMode: string;
  messages: { id: string }[];
  sandboxActionLog: Array<{ time: number; action: string; payload: any }>;

  // streaming / status flags
  streaming: boolean;
  recovering: boolean;
  memoryPending: boolean;
  stateUpdating: boolean;

  // derived
  flatVariables: Array<{ key: string; value: any }>;
  activeWorldBook: WorldBook | null;
  activePreset: Preset | null;
  activePresetMissing: boolean;
  cardHasStatusRenderer: boolean;
  cardHasComplexUi: boolean;
  cardHasGameStart: boolean;
  debugPlatformSchema: PlatformCardSchema | null;

  // callbacks from useChatSession
  saveConfig: () => Promise<void>;
  updateConfig: <K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) => void;
  updateRenderMode: (value: RenderMode) => void;
  updateUserPersona: (key: keyof UserPersona, value: string) => void;
  updateUserSettingMergeStrategy: (value: UserSettingMergeStrategy) => void;
  updateSessionWorldBook: (worldBookId: string) => Promise<void>;
  updateSessionPreset: (presetId: string) => Promise<void>;
  applyUserPersonaPreset: (value: string) => Promise<void>;
  applyGlobalDefaultsToSession: () => Promise<void>;
  saveCurrentSessionAsGlobalDefaults: () => void;
  loadSessionResources: () => Promise<void>;
}

// --- component ---

export function InspectorSidebar(props: InspectorSidebarProps) {
  const navigate = useNavigate();

  const {
    inspectorOpen, inspectorTab, setInspectorTab, setInspectorOpen,
    paramsEditing, setParamsEditing, userEditing, setUserEditing,
    sessionId,
    config, setConfig, configDirty,
    characterCard, providers, worldBooks, presets,
    activeWorldBookId, sessionResourceSaving,
    renderMode, userPersona, userPresets, sessionMode,
    messages, sandboxActionLog,
    streaming, recovering, memoryPending, stateUpdating,
    flatVariables,
    activeWorldBook, activePreset, activePresetMissing,
    cardHasStatusRenderer, cardHasComplexUi, cardHasGameStart,
    debugPlatformSchema,
    saveConfig, updateConfig, updateRenderMode,
    updateUserPersona, updateUserSettingMergeStrategy,
    updateSessionWorldBook, updateSessionPreset,
    applyUserPersonaPreset, applyGlobalDefaultsToSession,
    saveCurrentSessionAsGlobalDefaults, loadSessionResources,
  } = props;

  return (
    <>
      {/* Narrow-screen backdrop */}
      {inspectorOpen && <div className="inspector-backdrop" onClick={() => setInspectorOpen(false)} />}

      <nav className="inspector-rail" aria-label="工作区工具栏">
        {([
          ['params', '参数', '参'],
          ['worldbook', '世界书', '书'],
          ['preset', '预设', '预'],
          ...(sessionMode === 'multi_agent' ? [['agents', 'Agents', 'Ag'] as const] : []),
          ['render', '渲染', '渲'],
          ['user', 'User', '人'],
          ['debug', '调试', '试'],
        ] as const).map(([key, label, icon]) => (
          <button
            key={key}
            className={`inspector-rail-btn${inspectorTab === key ? ' active' : ''}`}
            title={label}
            onClick={() => {
              setInspectorTab(key);
              setInspectorOpen(current => inspectorTab === key ? !current : true);
            }}
          >
            <span>{icon}</span>
            <small>{label}</small>
          </button>
        ))}
      </nav>

      <aside className={`inspector${inspectorOpen ? ' inspector--open' : ''}`}>
        <div className="inspector-titlebar">
          <strong>{({ params: '参数', worldbook: '世界书', preset: '预设', agents: 'Agents', render: '渲染', user: 'User', debug: '调试' } as Record<string, string>)[inspectorTab] || '参数'}</strong>
          <button type="button" onClick={() => setInspectorOpen(false)} title="关闭">×</button>
        </div>
        <div className="inspector-content">

          {/* ===== 参数 Tab ===== */}
          {inspectorTab === 'params' && (
            <>
              <div className="inspector-section">
                <div className="inspector-section-title">会话覆盖</div>
                <p className="inspector-hint">本页设置只影响当前会话；新会话会复制首页全局默认。</p>
                <div className="inspector-action-stack">
                  <button className="inspector-btn primary" onClick={saveConfig} disabled={!configDirty}>保存当前会话设置</button>
                  <button className="inspector-btn" onClick={applyGlobalDefaultsToSession}>恢复全局默认</button>
                  <button className="inspector-btn" onClick={saveCurrentSessionAsGlobalDefaults}>保存为全局模板</button>
                </div>
              </div>
              <div className="inspector-section">
                <div className="inspector-section-title">模型参数</div>
                {!paramsEditing ? (
                  <>
                    <div className="inspector-summary-grid">
                      <div className="summary-metric"><span>Temp</span><strong>{config.temperature}</strong></div>
                      <div className="summary-metric"><span>Top P</span><strong>{config.top_p}</strong></div>
                      <div className="summary-metric"><span>Token</span><strong>{config.max_tokens}</strong></div>
                      <div className="summary-metric"><span>上下文</span><strong>{config.max_context_turns}</strong></div>
                    </div>
                    <div className="debug-row"><span className="debug-key">流式输出</span><span className="debug-value">{config.stream ? '开启' : '关闭'}</span></div>
                    <div className="debug-row"><span className="debug-key">变量工具模型</span><span className="debug-value">{describeModelRef(config.variable_tool_model, providers, '复用主模型')}</span></div>
                    <div className="debug-row"><span className="debug-key">系统提示词</span><span className="debug-value">{config.system_prompt?.trim() ? '已自定义' : '默认'}</span></div>
                    <button className="inspector-btn primary full-width" onClick={() => setParamsEditing(true)}>编辑参数</button>
                  </>
                ) : (
                  <>
                    <div className="config-grid">
                      <div className="config-field"><label>上下文轮数</label><input type="number" value={config.max_context_turns} onChange={e => updateConfig('max_context_turns', Number(e.target.value))} min={1} max={200} /></div>
                      <div className="config-field"><label>Temperature</label><input type="number" value={config.temperature} onChange={e => updateConfig('temperature', Number(e.target.value))} min={0} max={2} step={0.1} /></div>
                      <div className="config-field"><label>Top P</label><input type="number" value={config.top_p} onChange={e => updateConfig('top_p', Number(e.target.value))} min={0} max={1} step={0.05} /></div>
                      <div className="config-field"><label>最大 Token</label><input type="number" value={config.max_tokens} onChange={e => updateConfig('max_tokens', Number(e.target.value))} min={1} max={128000} /></div>
                      <div className="config-field"><label>频率惩罚</label><input type="number" value={config.frequency_penalty} onChange={e => updateConfig('frequency_penalty', Number(e.target.value))} min={-2} max={2} step={0.1} /></div>
                      <div className="config-field"><label>存在惩罚</label><input type="number" value={config.presence_penalty} onChange={e => updateConfig('presence_penalty', Number(e.target.value))} min={-2} max={2} step={0.1} /></div>
                    </div>
                    <div className="config-field"><label>流式输出</label><button type="button" className={`toggle-btn ${config.stream ? 'on' : 'off'}`} onClick={() => updateConfig('stream', !config.stream)}>{config.stream ? '开启' : '关闭'}</button></div>
                    <div className="config-field"><ModelPicker label="变量工具模型" value={config.variable_tool_model} providers={providers} defaultText="复用主模型配置" onChange={value => updateConfig('variable_tool_model', value)} /></div>
                  </>
                )}
              </div>
              {paramsEditing && (
                <>
                  <div className="inspector-section">
                    <div className="inspector-section-title">系统提示词</div>
                    <div className="config-field"><textarea value={config.system_prompt} onChange={e => updateConfig('system_prompt', e.target.value)} placeholder="留空使用默认提示词" rows={4} /></div>
                  </div>
                  <div className="config-actions">
                    {configDirty && <span className="config-dirty">未保存</span>}
                    <button className="inspector-btn primary" onClick={() => { saveConfig(); setParamsEditing(false); }} disabled={!configDirty}>保存</button>
                    <button className="inspector-btn" onClick={() => setParamsEditing(false)}>完成</button>
                    <button className="inspector-btn" onClick={() => { setConfig({ ...DEFAULT_SESSION_CONFIG }); }}>恢复默认</button>
                  </div>
                </>
              )}
            </>
          )}

          {/* ===== 世界书 Tab ===== */}
          {inspectorTab === 'worldbook' && (
            <>
              <div className="inspector-section">
                <div className="inspector-section-title">当前会话世界书</div>
                <div className="inspector-field">
                  <label>世界书</label>
                  <select
                    value={activeWorldBookId}
                    onChange={e => updateSessionWorldBook(e.target.value)}
                    disabled={sessionResourceSaving === 'worldbook'}
                  >
                    <option value="">不使用世界书</option>
                    {worldBooks.map(book => (
                      <option key={book.id} value={book.id}>
                        {book.name} ({book.entry_count}条)
                      </option>
                    ))}
                  </select>
                </div>
                {sessionResourceSaving === 'worldbook' && <p className="inspector-hint">正在保存当前会话世界书...</p>}
                {activeWorldBook ? (
                  <div className="resource-summary-card">
                    <strong>{activeWorldBook.name}</strong>
                    <span>{activeWorldBook.entry_count} 条条目 · {activeWorldBook.has_character_card ? '含角色卡' : '无角色卡'}</span>
                    {activeWorldBook.description && <p>{shortText(activeWorldBook.description, 84)}</p>}
                  </div>
                ) : (
                  <div className="resource-empty">当前会话没有绑定世界书。</div>
                )}
                <div className="inspector-action-stack">
                  <button className="inspector-btn" onClick={() => navigate('/worldbooks', { state: { from: `/chat/${sessionId}` } })}>打开世界书管理</button>
                  <button className="inspector-btn" onClick={loadSessionResources}>刷新列表</button>
                </div>
              </div>
              {characterCard && (
                <div className="inspector-section">
                  <div className="inspector-section-title">角色卡预览</div>
                  <div className="resource-summary-card compact">
                    <strong>{characterCard.name}</strong>
                    <span>{[characterCard.creator, characterCard.character_version && `v${characterCard.character_version}`].filter(Boolean).join(' · ') || '未设置作者'}</span>
                    <p>{shortText(characterCard.description || characterCard.personality || characterCard.scenario || '没有简介', 96)}</p>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ===== 预设 Tab ===== */}
          {inspectorTab === 'preset' && (
            <div className="inspector-section">
              <div className="inspector-section-title">当前会话预设</div>
              <div className="inspector-field">
                <label>提示词预设</label>
                <select
                  value={config.active_preset_id || ''}
                  onChange={e => updateSessionPreset(e.target.value)}
                  disabled={sessionResourceSaving === 'preset'}
                >
                  <option value="">不使用预设</option>
                  {presets.map(preset => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} ({preset.module_count}模块)
                    </option>
                  ))}
                </select>
              </div>
              {sessionResourceSaving === 'preset' && <p className="inspector-hint">正在保存当前会话预设...</p>}
              {activePreset ? (
                <div className="resource-summary-card">
                  <strong>{activePreset.name}</strong>
                  <span>{activePreset.module_count} 个模块 · {activePreset.parse_status === 'done' ? '已解析' : activePreset.parse_status === 'parsing' ? '解析中' : activePreset.parse_status === 'error' ? '解析失败' : '未解析'}</span>
                  <p>切换后会影响下一次生成时注入的提示词模块。</p>
                </div>
              ) : activePresetMissing ? (
                <div className="resource-empty">当前保存的预设不存在，请重新选择。</div>
              ) : (
                <div className="resource-empty">当前会话没有启用预设。</div>
              )}
              <div className="inspector-action-stack">
                <button className="inspector-btn" onClick={() => navigate('/presets', { state: { from: `/chat/${sessionId}` } })}>打开预设管理</button>
                <button className="inspector-btn" onClick={loadSessionResources}>刷新列表</button>
              </div>
            </div>
          )}

          {/* ===== Agents Tab ===== */}
          {inspectorTab === 'agents' && sessionMode === 'multi_agent' && (
            <div className="inspector-section">
              <div className="inspector-section-title">Agent 管理</div>
              <p style={{ fontSize: '13px', color: 'var(--text-3)', marginBottom: '12px' }}>管理此会话的多 Agent 角色、调度策略和状态。</p>
              <button className="inspector-btn primary" onClick={() => navigate(`/chat/${sessionId}/agents`)}>打开 Agent 管理</button>
            </div>
          )}

          {/* ===== 渲染 Tab ===== */}
          {inspectorTab === 'render' && (
            <>
              <div className="inspector-section">
                <div className="inspector-section-title">渲染模式</div>
                <div className="render-mode-group">
                  {([['auto','Auto','作者原始 UI 优先，失败走平台兜底'],['schema','Schema','只用平台 Schema，不执行原始 JS'],['sandbox','Sandbox','优先执行作者原始沙盒 UI'],['text','Text','纯文本，无 UI 渲染']] as const).map(([mode, label, desc]) => (
                    <label key={mode} className={`render-mode-option${renderMode === mode ? ' selected' : ''}`}>
                      <input type="radio" name="renderMode" value={mode} checked={renderMode === mode} onChange={() => updateRenderMode(mode)} />
                      <div><div className="render-mode-label">{label}</div><div className="render-mode-desc">{desc}</div></div>
                    </label>
                  ))}
                </div>
              </div>
              <div className="inspector-section">
                <div className="inspector-section-title">角色卡检测</div>
                <div className="debug-row"><span className="debug-key">状态栏 Renderer</span><span className="debug-value">{cardHasStatusRenderer ? '✓' : '—'}</span></div>
                <div className="debug-row"><span className="debug-key">复杂角色卡 UI</span><span className="debug-value">{cardHasComplexUi ? '✓' : '—'}</span></div>
                <div className="debug-row"><span className="debug-key">GameStart</span><span className="debug-value">{cardHasGameStart ? '✓' : '—'}</span></div>
              </div>
              {debugPlatformSchema && (
                <div className="inspector-section">
                  <div className="inspector-section-title">平台布局</div>
                  <div className="debug-row"><span className="debug-key">主卡宽度</span><span className="debug-value">{debugPlatformSchema.layout.mainCardWidth}px</span></div>
                  <div className="debug-row"><span className="debug-key">舞台高度</span><span className="debug-value">{debugPlatformSchema.layout.stageMinHeight}px</span></div>
                  <div className="debug-row"><span className="debug-key">侧卡缩放</span><span className="debug-value">{debugPlatformSchema.layout.sideCardScale}</span></div>
                  <div className="debug-row"><span className="debug-key">背景压暗</span><span className="debug-value">{debugPlatformSchema.layout.backgroundDim}</span></div>
                </div>
              )}
            </>
          )}

          {/* ===== User Tab ===== */}
          {inspectorTab === 'user' && (
            <div className="inspector-section">
              <div className="inspector-section-title">User Persona</div>
              {!userEditing ? (
                <>
                  <div className="inspector-field">
                    <label>套用 User 配置</label>
                    <select value="" onChange={e => applyUserPersonaPreset(e.target.value)}>
                      <option value="">选择后套用到当前会话</option>
                      <option value="global">全局默认 User</option>
                      {userPresets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                    </select>
                  </div>
                  <div className="user-summary-card">
                    <div className="user-summary-avatar">
                      {userPersona.avatar ? <img src={userPersona.avatar} alt={userPersona.name || 'User'} /> : <span>{(userPersona.name || '用').charAt(0)}</span>}
                    </div>
                    <div>
                      <strong>{userPersona.name || '默认用户'}</strong>
                      <span>{userPersona.address || '未设置称呼'}</span>
                    </div>
                  </div>
                  <div className="debug-row"><span className="debug-key">背景</span><span className="debug-value">{userPersona.background.trim() ? shortText(userPersona.background, 18) : '未设置'}</span></div>
                  <div className="debug-row"><span className="debug-key">风格</span><span className="debug-value">{userPersona.style.trim() ? shortText(userPersona.style, 18) : '未设置'}</span></div>
                  <div className="debug-row"><span className="debug-key">覆盖策略</span><span className="debug-value">{config.user_setting_merge_strategy === 'worldbook_overrides_user' ? '世界书优先' : '用户优先'}</span></div>
                  <button className="inspector-btn primary full-width" onClick={() => setUserEditing(true)}>编辑 User</button>
                </>
              ) : (
                <>
                  <div className="inspector-field">
                    <label>套用 User 配置</label>
                    <select value="" onChange={e => applyUserPersonaPreset(e.target.value)}>
                      <option value="">选择后填入下方表单</option>
                      <option value="global">全局默认 User</option>
                      {userPresets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                    </select>
                  </div>
                  <div className="inspector-field"><label>名称</label><input type="text" value={userPersona.name} onChange={e => updateUserPersona('name', e.target.value)} placeholder="你的名字" /></div>
                  <div className="inspector-field"><label>头像 URL</label><input type="url" value={userPersona.avatar} onChange={e => updateUserPersona('avatar', e.target.value)} placeholder="https://..." /></div>
                  <div className="inspector-field"><label>称呼</label><input type="text" value={userPersona.address} onChange={e => updateUserPersona('address', e.target.value)} placeholder="角色如何称呼你" /></div>
                  <div className="inspector-field"><label>背景 / 设定</label><textarea value={userPersona.background} onChange={e => updateUserPersona('background', e.target.value)} placeholder="用户角色的背景设定" rows={3} /></div>
                  <div className="inspector-field"><label>默认扮演风格</label><textarea value={userPersona.style} onChange={e => updateUserPersona('style', e.target.value)} placeholder="写作/扮演的风格偏好" rows={3} /></div>
                  <div className="inspector-field">
                    <label>User 与世界书冲突时</label>
                    <select value={config.user_setting_merge_strategy} onChange={e => updateUserSettingMergeStrategy(e.target.value as UserSettingMergeStrategy)}>
                      <option value="user_overrides_worldbook">用户设定优先</option>
                      <option value="worldbook_overrides_user">世界书设定优先</option>
                    </select>
                  </div>
                  <button className="inspector-btn primary full-width" onClick={() => { saveConfig(); setUserEditing(false); }}>保存会话 User</button>
                </>
              )}
            </div>
          )}

          {/* ===== 调试 Tab ===== */}
          {inspectorTab === 'debug' && (
            <>
              <div className="inspector-section">
                <div className="inspector-section-title">会话状态</div>
                <div className="debug-row"><span className="debug-key">渲染模式</span><span className="debug-value">{renderMode}</span></div>
                <div className="debug-row"><span className="debug-key">消息数量</span><span className="debug-value">{messages.length}</span></div>
                <div className="debug-row"><span className="debug-key">变量数量</span><span className="debug-value">{flatVariables.length}</span></div>
                <div className="debug-row"><span className="debug-key">会话状态</span><span className="debug-value">{streaming ? '流式传输中' : recovering ? '恢复中' : memoryPending ? '记忆整理中' : stateUpdating ? '变量更新中' : '空闲'}</span></div>
              </div>
              <div className="inspector-section">
                <div className="inspector-section-title">角色卡</div>
                <div className="debug-row"><span className="debug-key">状态栏</span><span className="debug-value">{cardHasStatusRenderer ? '是' : '否'}</span></div>
                <div className="debug-row"><span className="debug-key">复杂 UI</span><span className="debug-value">{cardHasComplexUi ? '是' : '否'}</span></div>
                <div className="debug-row"><span className="debug-key">GameStart</span><span className="debug-value">{cardHasGameStart ? '是' : '否'}</span></div>
              </div>
              {sandboxActionLog.length > 0 && (
                <div className="inspector-section">
                  <div className="inspector-section-title">Sandbox Timeline ({sandboxActionLog.length})</div>
                  <div className="sandbox-log">
                    {sandboxActionLog.map((entry, i) => (
                      <div key={i} className={`sandbox-log-entry${logSeverity(entry.action, entry.payload)}`}>
                        <div className="sandbox-log-head">
                          <span className="log-action">{entry.action}</span>
                          <span className="log-time">{new Date(entry.time).toLocaleTimeString()}</span>
                        </div>
                        {entry.payload && Object.keys(entry.payload).length > 0 && (
                          <div className="sandbox-log-payload">{formatLogPayload(entry.payload).slice(0, 900)}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </aside>
    </>
  );
}
