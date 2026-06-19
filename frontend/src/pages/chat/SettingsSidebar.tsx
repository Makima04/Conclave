import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../../api/client';
import type { Preset, Session, SessionConfig, WorldBookDetail } from '../../api/types';
import { useProviders } from '../../contexts/AppContext';
import { ModelPicker, describeModelRef } from '../../settings/modelSelection';
import { CategoryRail, type CategoryItem } from './CategoryRail';

export interface SettingsSidebarProps {
  session: Session;
  /** Optimistic + debounced config patch (see useChatSessionState.patchConfig). */
  onConfigChange: (patch: Partial<SessionConfig>) => void;
  active: string | null;
  onSelectActive: (key: string | null) => void;
  saving?: boolean;
}

type CategoryKey = 'models' | 'params' | 'persona' | 'worldbook' | 'preset' | 'agents';

const SAMPLING_FIELDS: Array<{
  key: keyof SessionConfig;
  label: string;
  step: number;
  min: number;
  max: number;
}> = [
  { key: 'temperature', label: 'Temperature', step: 0.05, min: 0, max: 2 },
  { key: 'top_p', label: 'Top P', step: 0.05, min: 0, max: 1 },
  { key: 'max_tokens', label: 'Max Tokens', step: 128, min: 256, max: 32768 },
  { key: 'frequency_penalty', label: 'Frequency Penalty', step: 0.1, min: -2, max: 2 },
  { key: 'presence_penalty', label: 'Presence Penalty', step: 0.1, min: -2, max: 2 },
];

/**
 * Left column: a 56px category rail + an expanding panel. Mode is locked at
 * creation. The rail reuses the homepage icon look; the panel swaps content by
 * the active category. Multi-agent hides the master/sub/compression pickers
 * here (they moved into the Agent manager as session-level fallbacks).
 */
export function SettingsSidebar({ session, onConfigChange, active, onSelectActive, saving }: SettingsSidebarProps) {
  const config = session.config;
  const mode = session.mode;
  const { providers } = useProviders();
  const navigate = useNavigate();
  const isMulti = mode === 'multi_agent';

  const [presets, setPresets] = useState<Preset[]>([]);
  const [worldBook, setWorldBook] = useState<WorldBookDetail | null>(null);
  const [entryUpdates, setEntryUpdates] = useState<Record<string, string>>({});
  const [wbError, setWbError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPresets()
      .then(res => {
        if (!cancelled) setPresets(res.items || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session.world_pack_id) {
      setWorldBook(null);
      return;
    }
    let cancelled = false;
    setWbError(null);
    api
      .getWorldBook(session.world_pack_id!)
      .then(detail => {
        if (!cancelled) setWorldBook(detail);
      })
      .catch(e => {
        if (!cancelled) setWbError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [session.world_pack_id]);

  const update = useCallback(
    <K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) => {
      onConfigChange({ [key]: value } as Partial<SessionConfig>);
    },
    [onConfigChange],
  );

  const defaultModelLabel = useMemo(() => describeModelRef('', providers, '全局默认模型'), [providers]);

  const items: CategoryItem[] = [
    { key: 'models', label: '模型', icon: '🤖' },
    { key: 'params', label: '参数', icon: '🎛' },
    { key: 'persona', label: '角色', icon: '🧑' },
    { key: 'worldbook', label: '世界书', icon: '📚' },
    { key: 'preset', label: '预设', icon: '📦' },
    ...(isMulti ? [{ key: 'agents' as const, label: 'Agent', icon: '👥' }] : []),
  ];

  function renderPanel() {
    switch (active as CategoryKey | null) {
      case 'models':
        return (
          <>
            <header className="chat-panel-head">
              <span className="chat-section-title">模型</span>
              <span className="chat-mode-badge" title="会话模式在创建时确定，不可切换">
                {isMulti ? '多 Agent' : '单 Agent'} · 锁定
              </span>
            </header>
            <ModelPicker
              label={isMulti ? '会话主模型 (Chat)' : '对话 LLM (Chat)'}
              value={config.model}
              providers={providers}
              defaultText={defaultModelLabel}
              onChange={value => void update('model', value)}
            />
            <ModelPicker
              label="变量解析 LLM (Variable Tool)"
              value={config.variable_tool_model}
              providers={providers}
              defaultText={defaultModelLabel}
              onChange={value => void update('variable_tool_model', value)}
            />
            {saving && <div className="chat-settings-hint">保存中…</div>}
          </>
        );
      case 'params':
        return (
          <>
            <div className="chat-section-title">参数 · 会话级</div>
            <label className="chat-field">
              <span>上下文轮数 (max_context_turns)</span>
              <input
                type="number"
                min={1}
                max={100}
                value={config.max_context_turns}
                onChange={e => void update('max_context_turns', Number(e.target.value) || 20)}
              />
            </label>
            {SAMPLING_FIELDS.map(field => (
              <label className="chat-field" key={String(field.key)}>
                <span>{field.label}</span>
                <input
                  type="number"
                  step={field.step}
                  min={field.min}
                  max={field.max}
                  value={config[field.key] as number}
                  onChange={e => void update(field.key, Number(e.target.value) as never)}
                />
              </label>
            ))}
            <label className="chat-field chat-field-grow">
              <span>System Prompt</span>
              <textarea
                rows={4}
                value={config.system_prompt}
                placeholder="留空使用默认系统提示词"
                onChange={e => void update('system_prompt', e.target.value)}
              />
            </label>
            <label className="chat-field">
              <span>渲染模式</span>
              <select
                value={config.render_mode}
                onChange={e => void update('render_mode', e.target.value as SessionConfig['render_mode'])}
              >
                <option value="auto">auto</option>
                <option value="schema">schema</option>
                <option value="sandbox">sandbox</option>
                <option value="text">text</option>
              </select>
            </label>
          </>
        );
      case 'persona':
        return (
          <>
            <div className="chat-section-title">玩家角色 (Persona)</div>
            <label className="chat-field">
              <span>名称</span>
              <input
                type="text"
                value={config.user_persona.name}
                onChange={e => void update('user_persona', { ...config.user_persona, name: e.target.value })}
              />
            </label>
            <label className="chat-field">
              <span>头像 URL</span>
              <input
                type="text"
                value={config.user_persona.avatar}
                onChange={e => void update('user_persona', { ...config.user_persona, avatar: e.target.value })}
              />
            </label>
            <label className="chat-field chat-field-grow">
              <span>背景设定</span>
              <textarea
                rows={3}
                value={config.user_persona.background}
                onChange={e => void update('user_persona', { ...config.user_persona, background: e.target.value })}
              />
            </label>
          </>
        );
      case 'preset':
        return (
          <>
            <div className="chat-section-title">预设</div>
            <label className="chat-field">
              <span>激活预设</span>
              <select
                value={config.active_preset_id ?? ''}
                onChange={e => void update('active_preset_id', e.target.value || undefined)}
              >
                <option value="">（无）</option>
                {presets.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        );
      case 'worldbook':
        return (
          <>
            <div className="chat-section-title">世界书条目</div>
            {wbError && <div className="chat-settings-error">加载失败: {wbError}</div>}
            {!worldBook && !wbError && <div className="chat-settings-hint">未绑定世界书</div>}
            {worldBook && (
              <div className="chat-wb-entries">
                {(worldBook.entries || []).map(entry => (
                  <div key={entry.id} className="chat-wb-entry">
                    <label className="chat-toggle-row">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        disabled={Boolean(entryUpdates[entry.id])}
                        onChange={async () => {
                          setEntryUpdates(prev => ({ ...prev, [entry.id]: 'saving' }));
                          try {
                            await api.updateWorldBookEntry(worldBook.id, entry.id, { enabled: !entry.enabled });
                            const refreshed = await api.getWorldBook(worldBook.id);
                            setWorldBook(refreshed);
                          } catch (e) {
                            setWbError(e instanceof Error ? e.message : String(e));
                          } finally {
                            setEntryUpdates(prev => {
                              const next = { ...prev };
                              delete next[entry.id];
                              return next;
                            });
                          }
                        }}
                      />
                      <span>{entry.comment || entry.keys.join(', ') || '(无标题)'}</span>
                    </label>
                    <small>优先级 {entry.priority}{entry.constant ? ' · 常驻' : ''}</small>
                  </div>
                ))}
              </div>
            )}
          </>
        );
      case 'agents':
        // Agent 管理（配置）+ 运行时已融合到独立「Agent 工作台」大页面。
        // 点击此分类导航过去，不再在 280px 浮层里编辑。
        return (
          <div className="chat-panel-head" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <span className="chat-section-title">Agent</span>
            <p className="chat-settings-hint">配置与每轮运行时详情已移至独立工作台。</p>
            <button
              type="button"
              onClick={() => navigate(`/chat/${session.id}/inspector`)}
              style={{ background: '#3b6fb0', border: 'none', color: '#fff', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
            >
              打开 Agent 工作台 →
            </button>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <div className="chat-settings-shell">
      <CategoryRail items={items} active={active} onSelect={onSelectActive} />
      <div className={`chat-category-panel${active ? '' : ' is-empty'}`}>
        {active ? renderPanel() : <div className="chat-panel-empty-hint">选择左侧图标查看设置</div>}
      </div>
    </div>
  );
}
