import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../api/client';
import type { AgentConfig, ProviderConfig, SessionConfig, WorldBookDetail, ParsedWorldBookEntry } from '../../api/types';
import type { SubAgent } from '../../api/client';
import { ModelPicker, describeModelRef } from '../../settings/modelSelection';

export interface AgentManagerPanelProps {
  sessionId: string;
  providers: ProviderConfig[];
  /** Session config — drives the session-level fallback models. */
  config: SessionConfig;
  onConfigChange: (patch: Partial<SessionConfig>) => void;
  /** Loaded world book detail for the fixed-context routing view (read-only). */
  worldBook: WorldBookDetail | null;
}

const AGENT_TYPES = ['npc', 'writer', 'director', 'user', 'state', 'master', 'parser'];

const STATUS_COLORS: Record<string, string> = {
  active: '#3b9e6b',
  cooldown: '#b8862a',
  inactive: '#666',
};

type TabKey = 'model' | 'params' | 'context';

const PARAM_FIELDS: Array<{ key: keyof AgentConfig & keyof SessionConfig; label: string; step: number; min: number; max: number }> = [
  { key: 'temperature', label: 'Temperature', step: 0.05, min: 0, max: 2 },
  { key: 'top_p', label: 'Top P', step: 0.05, min: 0, max: 1 },
  { key: 'max_tokens', label: 'Max Tokens', step: 128, min: 256, max: 32768 },
  { key: 'max_context_turns', label: '上下文轮数', step: 1, min: 1, max: 100 },
  { key: 'frequency_penalty', label: 'Frequency Penalty', step: 0.1, min: -2, max: 2 },
  { key: 'presence_penalty', label: 'Presence Penalty', step: 0.1, min: -2, max: 2 },
];

interface AgentDraft {
  label: string;
  context: string;
  config: AgentConfig;
}

/** Does this parsed world-book entry get injected into the given agent's context? */
function entryRoutesToAgent(entry: ParsedWorldBookEntry, agent: SubAgent): boolean {
  if (!entry.enabled) return false;
  if (entry.category === 'user') return false; // user-category entries feed persona, not agent context
  switch (entry.visibility) {
    case 'public':
      return true;
    case 'writer_only':
      return agent.agent_type === 'writer' || agent.agent_type === 'director';
    case 'gm_only':
      return agent.agent_type === 'director';
    default:
      if (entry.visibility.startsWith('character:')) {
        const target = entry.visibility.slice('character:'.length);
        return agent.agent_type === 'npc' && agent.character_id === target;
      }
      return false;
  }
}

/**
 * In-panel agent management. Each card expands to 3 tabs (model / params /
 * fixed-context); a session-level fallback-models section sits on top. All
 * edits are session-scoped (persisted via the agent config JSON / session config).
 */
export function AgentManagerPanel({ sessionId, providers, config, onConfigChange, worldBook }: AgentManagerPanelProps) {
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showFallback, setShowFallback] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newType, setNewType] = useState('npc');
  const [newLabel, setNewLabel] = useState('');
  const [newContext, setNewContext] = useState('');
  const [newModel, setNewModel] = useState('');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [tab, setTab] = useState<Record<string, TabKey>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const fallbackModelLabel = useMemo(() => describeModelRef('', providers, '全局默认模型'), [providers]);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAgents(sessionId);
      setAgents(Array.isArray(data?.items) ? data.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  function beginExpand(agent: SubAgent) {
    if (expandedId === agent.id) {
      setExpandedId(null);
      setDraft(null);
      return;
    }
    setExpandedId(agent.id);
    setDraft({
      label: agent.label || '',
      context: agent.context || '',
      config: {
        ...(agent.config || {}),
        // State agent's variable-update call needs thinking OFF (DeepSeek thinking mode
        // rejects tool_choice → HTTP 400). Surface the default so it's visible/overridable.
        thinking_enabled:
          agent.config?.thinking_enabled ?? (agent.agent_type === 'state' ? false : undefined),
      },
    });
    setTab(prev => ({ ...prev, [agent.id]: prev[agent.id] || 'model' }));
  }

  async function saveDraft(agent: SubAgent) {
    if (!draft) return;
    setSavingId(agent.id);
    try {
      // Drop empty/zero values so unset fields fall back to session defaults.
      const cleanConfig: AgentConfig = {};
      const src = draft.config;
      if (src.model?.trim()) cleanConfig.model = src.model.trim();
      if (src.temperature != null) cleanConfig.temperature = src.temperature;
      if (src.top_p != null) cleanConfig.top_p = src.top_p;
      if (src.max_tokens != null) cleanConfig.max_tokens = src.max_tokens;
      if (src.max_context_turns != null) cleanConfig.max_context_turns = src.max_context_turns;
      if (src.frequency_penalty != null) cleanConfig.frequency_penalty = src.frequency_penalty;
      if (src.presence_penalty != null) cleanConfig.presence_penalty = src.presence_penalty;
      if (src.recall_mode) cleanConfig.recall_mode = src.recall_mode;
      if (src.max_recall_events != null) cleanConfig.max_recall_events = src.max_recall_events;
      if (src.thinking_enabled != null) cleanConfig.thinking_enabled = src.thinking_enabled;
      if (src.reasoning_effort) cleanConfig.reasoning_effort = src.reasoning_effort;

      await api.updateAgent(sessionId, agent.id, {
        label: draft.label || undefined,
        context: draft.context || undefined,
        config: cleanConfig,
      });
      await loadAgents();
      setExpandedId(null);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  async function handleCreate() {
    try {
      await api.createAgent(sessionId, {
        agent_type: newType,
        label: newLabel || undefined,
        context: newContext || undefined,
        model: newModel || undefined,
      });
      setShowCreate(false);
      setNewLabel('');
      setNewContext('');
      setNewModel('');
      await loadAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleAction(agent: SubAgent, action: 'cooldown' | 'restore' | 'delete') {
    if (action === 'delete' && !confirm('确定要删除此 Agent？')) return;
    try {
      if (action === 'cooldown') await api.cooldownAgent(sessionId, agent.id);
      if (action === 'restore') await api.restoreAgent(sessionId, agent.id);
      if (action === 'delete') await api.deleteAgent(sessionId, agent.id);
      await loadAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <div className="chat-agent-loading">加载 Agent…</div>;

  return (
    <div className="chat-agent-panel">
      {error && <div className="chat-settings-error">{error}</div>}

      {/* ---- session-level fallback models (moved from the 🤖 category) ---- */}
      <div className="chat-agent-fallback">
        <button type="button" className="chat-agent-section-toggle" onClick={() => setShowFallback(s => !s)}>
          {showFallback ? '▾' : '▸'} 回退默认模型
        </button>
        {showFallback && (
          <div className="chat-agent-fallback-body">
            <p className="chat-settings-hint">agent 未单独设置模型时回退到此。</p>
            <ModelPicker
              label="Master 模型"
              value={config.master_model}
              providers={providers}
              defaultText={fallbackModelLabel}
              onChange={value => void onConfigChange({ master_model: value })}
            />
            <ModelPicker
              label="子 Agent 模型"
              value={config.sub_agent_model}
              providers={providers}
              defaultText={fallbackModelLabel}
              onChange={value => void onConfigChange({ sub_agent_model: value })}
            />
            <ModelPicker
              label="压缩/记忆模型"
              value={config.compression_model}
              providers={providers}
              defaultText={fallbackModelLabel}
              onChange={value => void onConfigChange({ compression_model: value })}
            />
          </div>
        )}
      </div>

      <button type="button" className="chat-agent-create-btn" onClick={() => setShowCreate(s => !s)}>
        {showCreate ? '取消' : '+ 新建 Agent'}
      </button>

      {showCreate && (
        <div className="chat-agent-create-form">
          <label className="chat-field">
            <span>类型</span>
            <select value={newType} onChange={e => setNewType(e.target.value)}>
              {AGENT_TYPES.map(t => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="chat-field">
            <span>标签</span>
            <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="显示名" />
          </label>
          <ModelPicker label="模型" value={newModel} providers={providers} defaultText="使用回退默认" onChange={setNewModel} />
          <label className="chat-field chat-field-grow">
            <span>上下文</span>
            <textarea rows={3} value={newContext} onChange={e => setNewContext(e.target.value)} />
          </label>
          <button type="button" onClick={() => void handleCreate()}>
            创建
          </button>
        </div>
      )}

      <div className="chat-agent-list">
        {agents.length === 0 ? (
          <p className="chat-agent-empty">暂无 Agent。多 Agent 会话会自动初始化默认 Agent。</p>
        ) : (
          agents.map(agent => {
            const isOpen = expandedId === agent.id && draft !== null;
            const activeTab = tab[agent.id] || 'model';
            const effectiveModel = describeModelRef(
              draft?.config.model || agent.config?.model || config.sub_agent_model || '',
              providers,
              '回退/全局默认',
            );
            const routedEntries = (worldBook?.parsed_entries || []).filter(e => entryRoutesToAgent(e, agent));
            return (
              <div key={agent.id} className={`chat-agent-card${agent.fixed ? ' is-fixed' : ''}${isOpen ? ' is-open' : ''}`}>
                <button type="button" className="chat-agent-card-head" onClick={() => beginExpand(agent)}>
                  <span className="chat-agent-type">{agent.agent_type}</span>
                  {agent.fixed && <span className="chat-agent-fixed-tag">fixed</span>}
                  <span className="chat-agent-label-inline">{agent.label || agent.id.slice(0, 8)}</span>
                  <span className="chat-agent-status" style={{ backgroundColor: STATUS_COLORS[agent.status] || '#666' }}>
                    {agent.status}
                  </span>
                  <span className="chat-agent-chevron">{isOpen ? '▾' : '▸'}</span>
                </button>

                {isOpen && (
                  <div className="chat-agent-card-body">
                    <div className="chat-agent-tabs">
                      {(['model', 'params', 'context'] as TabKey[]).map(t => (
                        <button
                          key={t}
                          type="button"
                          className={`chat-agent-tab${activeTab === t ? ' active' : ''}`}
                          onClick={() => setTab(prev => ({ ...prev, [agent.id]: t }))}
                        >
                          {t === 'model' ? '模型' : t === 'params' ? '参数' : '固定上下文'}
                        </button>
                      ))}
                    </div>

                    {activeTab === 'model' && (
                      <div className="chat-agent-tab-body">
                        <ModelPicker
                          label="模型"
                          value={draft!.config.model || ''}
                          providers={providers}
                          defaultText="使用回退默认"
                          onChange={value => setDraft(d => (d ? { ...d, config: { ...d.config, model: value } } : d))}
                        />
                        <div className="chat-agent-effective">生效: {effectiveModel}</div>
                      </div>
                    )}

                    {activeTab === 'params' && (
                      <div className="chat-agent-tab-body">
                        <p className="chat-settings-hint">覆盖会话级默认（未改动时回退到右侧默认值）。</p>
                        {PARAM_FIELDS.map(field => {
                          const override = draft!.config[field.key] as number | undefined;
                          // per-agent 未设 → 显示会话级默认值，避免空框；draft.config 仍为 undefined，saveDraft 会跳过它（保持回退）。
                          const inherited = config[field.key] as number | undefined;
                          const isOverride = override != null;
                          return (
                            <label className="chat-field" key={String(field.key)}>
                              <span>
                                {field.label}
                                {!isOverride && inherited != null && (
                                  <small className="chat-field-inherit"> · 会话默认</small>
                                )}
                              </span>
                              <input
                                type="number"
                                step={field.step}
                                min={field.min}
                                max={field.max}
                                value={override ?? inherited ?? ''}
                                className={isOverride ? '' : 'is-inherited'}
                                onChange={e => {
                                  const v = e.target.value;
                                  setDraft(d =>
                                    d
                                      ? {
                                          ...d,
                                          config: { ...d.config, [field.key]: v === '' ? undefined : (Number(v) as number) },
                                        }
                                      : d,
                                  );
                                }}
                              />
                            </label>
                          );
                        })}
                        <label className="chat-field">
                          <span>思考模式 (Thinking)</span>
                          <input
                            type="checkbox"
                            checked={Boolean(draft!.config.thinking_enabled)}
                            onChange={e =>
                              setDraft(d =>
                                d
                                  ? { ...d, config: { ...d.config, thinking_enabled: e.target.checked } }
                                  : d,
                              )
                            }
                          />
                          <small className="chat-settings-hint">
                            {agent.agent_type === 'state'
                              ? 'State 默认关：变量更新调用带 tool_choice，thinking 模式会拒绝它。'
                              : '开启后注入 thinking 参数（DeepSeek 等）。留空=用模型默认。'}
                          </small>
                        </label>
                        <label className="chat-field">
                          <span>思考强度 (Effort)</span>
                          <select
                            value={draft!.config.reasoning_effort ?? ''}
                            disabled={!draft!.config.thinking_enabled}
                            onChange={e =>
                              setDraft(d =>
                                d
                                  ? {
                                      ...d,
                                      config: {
                                        ...d.config,
                                        reasoning_effort: e.target.value || undefined,
                                      },
                                    }
                                  : d,
                              )
                            }
                          >
                            <option value="">默认</option>
                            <option value="low">low</option>
                            <option value="high">high</option>
                            <option value="max">max</option>
                          </select>
                        </label>
                      </div>
                    )}

                    {activeTab === 'context' && (
                      <div className="chat-agent-tab-body">
                        <FixedContextTab agent={agent} routedEntries={routedEntries} />
                        <label className="chat-field chat-field-grow">
                          <span>agent.context（角色档案 / 补充 lore）</span>
                          <textarea
                            rows={5}
                            value={draft!.context}
                            onChange={e => setDraft(d => (d ? { ...d, context: e.target.value } : d))}
                          />
                        </label>
                      </div>
                    )}

                    <div className="chat-agent-edit-actions">
                      <button type="button" disabled={savingId === agent.id} onClick={() => void saveDraft(agent)}>
                        {savingId === agent.id ? '保存中…' : '保存'}
                      </button>
                      <button type="button" onClick={() => { setExpandedId(null); setDraft(null); }}>
                        取消
                      </button>
                      {!agent.fixed && agent.status === 'active' && (
                        <button type="button" onClick={() => void handleAction(agent, 'cooldown')}>
                          冷却
                        </button>
                      )}
                      {!agent.fixed && agent.status === 'cooldown' && (
                        <button type="button" onClick={() => void handleAction(agent, 'restore')}>
                          恢复
                        </button>
                      )}
                      {!agent.fixed && (
                        <button type="button" onClick={() => void handleAction(agent, 'delete')}>
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Read-only fixed-context routing + editable agent.context. */
function FixedContextTab({
  agent,
  routedEntries,
}: {
  agent: SubAgent;
  routedEntries: ParsedWorldBookEntry[];
}) {
  let note: string | null = null;
  if (agent.agent_type === 'user') note = '镜像会话 user_persona（在 🧑 角色面板编辑，运行时同步到此 agent）。';
  else if (agent.agent_type === 'parser') note = '基础提示词固定在 parser.rs，下方 agent.context 会追加其后。';
  else if (['master', 'writer', 'director', 'state'].includes(agent.agent_type)) note = '全局系统 agent；agent.context 作为补充上下文注入。';

  return (
    <>
      {note && <p className="chat-agent-fixed-note">{note}</p>}
      <div className="chat-section-title-mini">会注入本 agent 的世界书条目</div>
      {routedEntries.length === 0 ? (
        <p className="chat-settings-hint">无匹配条目（常驻/keyword 触发时按上表 visibility 路由）。</p>
      ) : (
        <div className="chat-agent-routed">
          {routedEntries.map((entry, i) => (
            <div key={i} className="chat-wb-entry">
              <div>{entry.comment || entry.keys.join(', ') || '(无标题)'}</div>
              <small>
                {entry.visibility}
                {entry.constant ? ' · 常驻' : ''} · 优先级 {entry.priority}
              </small>
            </div>
          ))}
        </div>
      )}
      <p className="chat-settings-hint">预设模块按其 target_agents 注入（绑定预设后自动生效）。</p>
    </>
  );
}
