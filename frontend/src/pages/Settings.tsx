import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api/client';
import type { ProviderConfig } from '../api/types';

export default function Settings() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Model fetching state
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState('');

  const navigate = useNavigate();

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
    setApiKey(p.api_key);
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
        await api.updateProvider(editingId, { name, base_url: baseUrl, api_key: apiKey, model, is_default: isDefault });
      } else {
        await api.createProvider({ name, base_url: baseUrl, api_key: apiKey, model, is_default: isDefault });
      }
      resetForm();
      loadProviders();
    } catch (err) {
      console.error('Failed to save provider:', err);
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

  if (loading) return <div className="loading">加载中...</div>;

  return (
    <div className="settings">
      <div className="chat-header">
        <button className="back-btn" onClick={() => navigate('/')}>返回</button>
        <h2>模型设置</h2>
      </div>

      <div className="settings-content">
        <div className="provider-form">
          <h3>{editingId ? '编辑模型' : '添加模型'}</h3>
          <p className="form-hint">兼容 OpenAI、OpenRouter、Ollama、vLLM、LM Studio 等 OpenAI 兼容接口</p>

          <div className="form-field">
            <label>名称</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="如：OpenAI、Ollama 本地" />
          </div>

          <div className="form-field">
            <label>Base URL</label>
            <input value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setModelList([]); setFetchError(''); }} placeholder="https://api.openai.com/v1" />
          </div>

          <div className="form-field">
            <label>API Key</label>
            <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-...（本地模型可留空）" type="password" />
          </div>

          <div className="form-field">
            <label>模型名称</label>
            <div className="model-input-row">
              <input value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o-mini" />
              <button
                className="fetch-btn"
                onClick={handleFetchModels}
                disabled={!baseUrl || fetchingModels}
              >
                {fetchingModels ? '获取中...' : '获取模型列表'}
              </button>
            </div>
          </div>

          {fetchError && <p className="fetch-error">{fetchError}</p>}

          {modelList.length > 0 && (
            <div className="model-list">
              <label>选择模型：</label>
              <div className="model-grid">
                {modelList.map(m => (
                  <button
                    key={m}
                    className={`model-chip ${model === m ? 'selected' : ''}`}
                    onClick={() => setModel(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="form-field checkbox">
            <label>
              <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
              设为默认模型
            </label>
          </div>

          <div className="form-actions">
            <button onClick={handleSubmit} disabled={!name || !baseUrl || !model}>
              {editingId ? '更新' : '添加'}
            </button>
            {editingId && <button className="cancel-btn" onClick={resetForm}>取消</button>}
          </div>
        </div>

        <div className="provider-list">
          <h3>已配置模型</h3>
          {providers.length === 0 ? (
            <p className="empty">暂未配置任何模型，请在上方添加。</p>
          ) : (
            providers.map(p => (
              <div key={p.id} className={`provider-card ${p.is_default ? 'default' : ''}`}>
                <div className="provider-info">
                  <h4>
                    {p.name}
                    {p.is_default ? <span className="badge">默认</span> : null}
                  </h4>
                  <span className="meta">{p.model} @ {p.base_url}</span>
                </div>
                <div className="provider-actions">
                  <button className="edit-btn" onClick={() => startEdit(p)}>编辑</button>
                  <button className="delete-btn" onClick={() => handleDelete(p.id)}>删除</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
