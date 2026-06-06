import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import type { ProviderConfig, RenderMode, SessionConfig, UserPersona } from '../api/types';
import { ModelPicker } from '../settings/modelSelection';
import {
  applyUserPersonaToConfig,
  loadDefaultUserPersonaPresetId,
  loadGlobalSessionDefaults,
  loadUserPersonaPresets,
  resetGlobalSessionDefaults,
  saveDefaultUserPersonaPresetId,
  saveGlobalSessionDefaults,
  saveUserPersonaPresets,
  type UserPersonaPreset,
} from '../settings/sessionDefaults';

export default function Settings() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [settingsTab, setSettingsTab] = useState<'models' | 'params' | 'agents' | 'render' | 'user'>('models');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [globalDefaults, setGlobalDefaults] = useState<SessionConfig>(() => loadGlobalSessionDefaults());
  const [defaultsDirty, setDefaultsDirty] = useState(false);
  const [userPresets, setUserPresets] = useState<UserPersonaPreset[]>(() => loadUserPersonaPresets());
  const [selectedUserPresetId, setSelectedUserPresetId] = useState(() => loadDefaultUserPersonaPresetId());
  const [userPresetTitle, setUserPresetTitle] = useState('');

  // Model fetching state
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState('');

  const navigate = useNavigate();

  useEffect(() => {
    const selected = userPresets.find(p => p.id === selectedUserPresetId);
    if (selected) {
      setUserPresetTitle(selected.title);
      setGlobalDefaults(prev => applyUserPersonaToConfig(prev, selected.persona));
    } else {
      setUserPresetTitle('');
    }
  }, [selectedUserPresetId]);

  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    try {
      const data = await api.listProviders();
      setProviders(data.items);
    } catch (err) {
      console.error('Failed to load providers:', err);
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setName('');
    setBaseUrl('');
    setApiKey('');
    setModel('');
    setIsDefault(true);
    setEditingId(null);
    setModelList([]);
    setFetchError('');
  }

  function startEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setName(p.name);
    setBaseUrl(p.base_url);
    setApiKey('');
    setModel(p.model);
    setIsDefault(p.is_default === 1);
    setModelList([]);
    setFetchError('');
  }

  async function handleFetchModels() {
    if (!baseUrl) return;
    setFetchingModels(true);
    setFetchError('');
    setModelList([]);
    try {
      const data = await api.fetchModels(baseUrl, apiKey || undefined);
      setModelList(data.models);
      if (data.models.length === 0) {
        setFetchError('未获取到模型，请检查 URL 和 API Key。');
      }
    } catch (err: any) {
      setFetchError(err.message || '获取失败');
    } finally {
      setFetchingModels(false);
    }
  }

  async function handleSubmit() {
    if (!name || !baseUrl || !model) return;
    try {
      if (editingId) {
        await api.updateProvider(editingId, { name, base_url: baseUrl, ...(apiKey ? { api_key: apiKey } : {}), model, is_default: isDefault });
      } else {
        await api.createProvider({ name, base_url: baseUrl, api_key: apiKey, model, is_default: isDefault });
      }
      resetForm();
      loadProviders();
    } catch (err) {
      console.error('Failed to save provider:', err);
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await api.updateProvider(id, { is_default: true });
      loadProviders();
    } catch (err) {
      console.error('Failed to set default:', err);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteProvider(id);
      if (editingId === id) resetForm();
      loadProviders();
    } catch (err) {
      console.error('Failed to delete provider:', err);
    }
  }

  function updateGlobalDefault<K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) {
    setGlobalDefaults(prev => ({ ...prev, [key]: value }));
    setDefaultsDirty(true);
  }

  function updateGlobalUserPersona(key: keyof SessionConfig['user_persona'], value: string) {
    setGlobalDefaults(prev => ({
      ...prev,
      user_persona: { ...prev.user_persona, [key]: value },
    }));
    setUserPresets(prev => {
      const selected = prev.find(p => p.id === selectedUserPresetId);
      if (!selected) return prev;
      return prev.map(p => p.id === selectedUserPresetId ? {
        ...p,
        persona: { ...p.persona, [key]: value },
      } : p);
    });
    setDefaultsDirty(true);
  }

  function handleSaveDefaults() {
    if (selectedUserPresetId) {
      saveUserPersonaPresets(userPresets);
      saveDefaultUserPersonaPresetId(selectedUserPresetId);
    }
    saveGlobalSessionDefaults(globalDefaults);
    setGlobalDefaults(loadGlobalSessionDefaults());
    setUserPresets(loadUserPersonaPresets());
    setDefaultsDirty(false);
  }

  function handleResetDefaults() {
    setGlobalDefaults(resetGlobalSessionDefaults());
    setDefaultsDirty(false);
  }

  function handleSelectUserPreset(id: string) {
    setSelectedUserPresetId(id);
    const selected = userPresets.find(p => p.id === id);
    if (selected) {
      setGlobalDefaults(prev => applyUserPersonaToConfig(prev, selected.persona));
      setDefaultsDirty(true);
    }
  }

  function handleCreateUserPreset() {
    const id = `user-${Date.now()}`;
    const persona: UserPersona = { ...globalDefaults.user_persona };
    const title = persona.name || '新用户配置';
    const next = [...userPresets, { id, title, persona }];
    setUserPresets(next);
    setSelectedUserPresetId(id);
    setUserPresetTitle(title);
    setDefaultsDirty(true);
  }

  function handleUpdateUserPresetTitle(value: string) {
    setUserPresetTitle(value);
    setUserPresets(prev => prev.map(p => p.id === selectedUserPresetId ? { ...p, title: value || '未命名用户' } : p));
    setDefaultsDirty(true);
  }

  function handleDeleteUserPreset() {
    if (!selectedUserPresetId) return;
    const next = userPresets.filter(p => p.id !== selectedUserPresetId);
    const nextSelected = next[0]?.id || '';
    setUserPresets(next);
    setSelectedUserPresetId(nextSelected);
    saveUserPersonaPresets(next);
    saveDefaultUserPersonaPresetId(nextSelected);
    if (next[0]) {
      setGlobalDefaults(prev => applyUserPersonaToConfig(prev, next[0].persona));
    }
    setDefaultsDirty(true);
  }

  if (loading) return <div className="loading">加载中...</div>;

  return (
    <div className="settings">
      <div className="chat-header">
        <button className="back-btn" onClick={() => navigate('/')}>返回</button>
        <h2>设置</h2>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置导航">
          {([
            ['models', '模型', '模型供应商与默认模型'],
            ['params', '参数', '新会话默认采样与提示词'],
            ['agents', 'Agents', '多 Agent 默认调度'],
            ['render', '渲染', '角色卡默认渲染策略'],
            ['user', 'User', '默认用户设定'],
          ] as const).map(([key, label, desc]) => (
            <button key={key} className={settingsTab === key ? 'active' : ''} onClick={() => setSettingsTab(key)}>
              <strong>{label}</strong>
              <span>{desc}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {settingsTab !== 'models' && (
            <div className="settings-savebar">
              <span>{defaultsDirty ? '全局默认有未保存改动' : '新建会话会复制当前全局默认'}</span>
              <div>
                <button onClick={handleSaveDefaults} disabled={!defaultsDirty}>保存全局默认</button>
                <button className="cancel-btn" onClick={handleResetDefaults}>恢复内置默认</button>
              </div>
            </div>
          )}

          {settingsTab === 'params' && (
            <div className="provider-form">
              <h3>默认参数</h3>
              <p className="form-hint">这些值只作为新会话初始快照，已有会话需要在会话内单独调整。</p>
              <div className="global-default-grid">
                <div className="form-field"><label>Temperature</label><input type="number" value={globalDefaults.temperature} min={0} max={2} step={0.1} onChange={e => updateGlobalDefault('temperature', Number(e.target.value))} /></div>
                <div className="form-field"><label>Top P</label><input type="number" value={globalDefaults.top_p} min={0} max={1} step={0.05} onChange={e => updateGlobalDefault('top_p', Number(e.target.value))} /></div>
                <div className="form-field"><label>最大 Token</label><input type="number" value={globalDefaults.max_tokens} min={1} max={128000} onChange={e => updateGlobalDefault('max_tokens', Number(e.target.value))} /></div>
                <div className="form-field"><label>上下文轮数</label><input type="number" value={globalDefaults.max_context_turns} min={1} max={200} onChange={e => updateGlobalDefault('max_context_turns', Number(e.target.value))} /></div>
              </div>
              <div className="global-default-grid">
                <div className="form-field"><label>频率惩罚</label><input type="number" value={globalDefaults.frequency_penalty} min={-2} max={2} step={0.1} onChange={e => updateGlobalDefault('frequency_penalty', Number(e.target.value))} /></div>
                <div className="form-field"><label>存在惩罚</label><input type="number" value={globalDefaults.presence_penalty} min={-2} max={2} step={0.1} onChange={e => updateGlobalDefault('presence_penalty', Number(e.target.value))} /></div>
                <div className="form-field"><label>流式输出</label><button type="button" className={`toggle-btn ${globalDefaults.stream ? 'on' : 'off'}`} onClick={() => updateGlobalDefault('stream', !globalDefaults.stream)}>{globalDefaults.stream ? '开启' : '关闭'}</button></div>
              </div>
              <div className="form-field"><label>系统提示词</label><textarea value={globalDefaults.system_prompt} onChange={e => updateGlobalDefault('system_prompt', e.target.value)} rows={7} placeholder="留空使用后端默认提示词" /></div>
            </div>
          )}

          {settingsTab === 'agents' && (
            <div className="provider-form">
              <h3>默认 Agents</h3>
              <p className="form-hint">用于新建多 Agent 会话的默认调度参数。</p>
              <div className="global-default-grid">
                <ModelPicker label="Master 模型" value={globalDefaults.master_model} providers={providers} defaultText="使用默认模型配置" onChange={value => updateGlobalDefault('master_model', value)} />
                <ModelPicker label="Sub Agent 模型" value={globalDefaults.sub_agent_model} providers={providers} defaultText="使用默认模型配置" onChange={value => updateGlobalDefault('sub_agent_model', value)} />
                <ModelPicker label="压缩模型" value={globalDefaults.compression_model} providers={providers} defaultText="使用 Sub Agent 模型" onChange={value => updateGlobalDefault('compression_model', value)} />
                <div className="form-field"><label>User 自动模式</label><select value={globalDefaults.user_auto_mode} onChange={e => updateGlobalDefault('user_auto_mode', e.target.value)}><option value="ask">Ask</option><option value="auto">Auto</option><option value="manual">Manual</option></select></div>
              </div>
              <div className="global-default-grid">
                <div className="form-field"><label>最大活跃 Agent</label><input type="number" value={globalDefaults.max_active_agents} min={1} max={64} onChange={e => updateGlobalDefault('max_active_agents', Number(e.target.value))} /></div>
                <div className="form-field"><label>冷却轮数</label><input type="number" value={globalDefaults.cooldown_turns} min={0} max={200} onChange={e => updateGlobalDefault('cooldown_turns', Number(e.target.value))} /></div>
                <div className="form-field"><label>变量解析</label><button type="button" className={`toggle-btn ${globalDefaults.parser_enabled ? 'on' : 'off'}`} onClick={() => updateGlobalDefault('parser_enabled', !globalDefaults.parser_enabled)}>{globalDefaults.parser_enabled ? '开启' : '关闭'}</button></div>
              </div>
            </div>
          )}

          {settingsTab === 'render' && (
            <div className="provider-form">
              <h3>默认渲染</h3>
              <p className="form-hint">复杂角色卡默认优先保留作者原始 UI；单个会话仍可在会话侧栏覆盖。</p>
              <div className="render-mode-group settings-render-group">
                {([['auto','Auto','作者原始 UI 优先，失败走平台兜底'],['sandbox','Sandbox','优先执行作者原始沙盒 UI'],['schema','Schema','只用平台 Schema，不执行原始 JS'],['text','Text','纯文本，无 UI 渲染']] as const).map(([mode, label, desc]) => (
                  <label key={mode} className={`render-mode-option${globalDefaults.render_mode === mode ? ' selected' : ''}`}>
                    <input type="radio" name="globalRenderMode" value={mode} checked={globalDefaults.render_mode === mode} onChange={() => updateGlobalDefault('render_mode', mode as RenderMode)} />
                    <div><div className="render-mode-label">{label}</div><div className="render-mode-desc">{desc}</div></div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {settingsTab === 'user' && (
            <div className="provider-form">
              <h3>User 配置</h3>
              <p className="form-hint">可以维护多个用户配置；新会话默认复制当前选中的全局用户，也可以在新建或会话内切换。</p>
              <div className="user-preset-toolbar">
                <div className="form-field">
                  <label>当前全局 User</label>
                  <select value={selectedUserPresetId} onChange={e => handleSelectUserPreset(e.target.value)}>
                    <option value="">直接编辑全局默认</option>
                    {userPresets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                </div>
                <button type="button" onClick={handleCreateUserPreset}>新建用户配置</button>
                <button type="button" className="cancel-btn" onClick={handleDeleteUserPreset} disabled={!selectedUserPresetId}>删除当前</button>
              </div>
              {selectedUserPresetId && (
                <div className="form-field">
                  <label>配置名称</label>
                  <input value={userPresetTitle} onChange={e => handleUpdateUserPresetTitle(e.target.value)} placeholder="用于下拉选择的名称" />
                </div>
              )}
              <div className="global-default-grid">
                <div className="form-field"><label>名称</label><input value={globalDefaults.user_persona.name} onChange={e => updateGlobalUserPersona('name', e.target.value)} placeholder="默认用户名称" /></div>
                <div className="form-field"><label>头像 URL</label><input value={globalDefaults.user_persona.avatar} onChange={e => updateGlobalUserPersona('avatar', e.target.value)} placeholder="https://..." /></div>
                <div className="form-field"><label>称呼</label><input value={globalDefaults.user_persona.address} onChange={e => updateGlobalUserPersona('address', e.target.value)} placeholder="角色如何称呼你" /></div>
              </div>
              <div className="form-field"><label>背景 / 设定</label><textarea value={globalDefaults.user_persona.background} onChange={e => updateGlobalUserPersona('background', e.target.value)} rows={5} /></div>
              <div className="form-field"><label>默认扮演风格</label><textarea value={globalDefaults.user_persona.style} onChange={e => updateGlobalUserPersona('style', e.target.value)} rows={5} /></div>
            </div>
          )}

          {settingsTab === 'models' && (
            <>
              <div className="provider-form">
                <h3>{editingId ? '编辑模型' : '添加模型'}</h3>
                <p className="form-hint">兼容 OpenAI、OpenRouter、Ollama、vLLM、LM Studio 等 OpenAI 兼容接口</p>
                <div className="global-default-grid two-col">
                  <div className="form-field"><label>名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="如：OpenAI、Ollama 本地" /></div>
                  <div className="form-field"><label>Base URL</label><input value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setModelList([]); setFetchError(''); }} placeholder="https://api.openai.com/v1" /></div>
                  <div className="form-field"><label>API Key</label><input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={editingId ? '留空则保留已保存 Key' : 'sk-...（本地模型可留空）'} type="password" /></div>
                  <div className="form-field"><label>模型名称</label><div className="model-input-row"><input value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o-mini" /><button className="fetch-btn" onClick={handleFetchModels} disabled={!baseUrl || fetchingModels}>{fetchingModels ? '获取中...' : '获取模型列表'}</button></div></div>
                </div>
                {fetchError && <p className="fetch-error">{fetchError}</p>}
                {modelList.length > 0 && (
                  <div className="model-list">
                    <label>选择模型：</label>
                    <div className="model-grid">
                      {modelList.map(m => <button key={m} className={`model-chip ${model === m ? 'selected' : ''}`} onClick={() => setModel(m)}>{m}</button>)}
                    </div>
                  </div>
                )}
                <div className="form-field checkbox"><label><input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />设为默认模型</label></div>
                <div className="form-actions"><button onClick={handleSubmit} disabled={!name || !baseUrl || !model}>{editingId ? '更新' : '添加'}</button>{editingId && <button className="cancel-btn" onClick={resetForm}>取消</button>}</div>
              </div>
              <div className="provider-list">
                <h3>已配置模型</h3>
                {providers.length === 0 ? <p className="empty">暂未配置任何模型，请在上方添加。</p> : providers.map(p => (
                  <div key={p.id} className={`provider-card ${p.is_default ? 'default' : ''}`}>
                    <div className="provider-info" style={{ cursor: p.is_default ? 'default' : 'pointer' }} onClick={() => !p.is_default && handleSetDefault(p.id)}>
                      <h4>{p.name}{p.is_default ? <span className="badge">默认</span> : <span className="badge" style={{ background: 'var(--line)', color: 'var(--muted)' }}>点击设为默认</span>}</h4>
                      <span className="meta">{p.model} @ {p.base_url}{p.api_key_set ? ' · Key 已保存' : ''}</span>
                    </div>
                    <div className="provider-actions"><button className="edit-btn" onClick={() => startEdit(p)}>编辑</button><button className="delete-btn" onClick={() => handleDelete(p.id)}>删除</button></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
